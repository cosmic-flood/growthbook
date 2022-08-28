import { IS_CLOUD, JWT_SECRET, SSO_CONFIG } from "../util/secrets";
import jwt from "express-jwt";
import jwks from "jwks-rsa";
import { NextFunction, Request, Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { markUserAsVerified, UserModel } from "../models/UserModel";
import {
  getDefaultPermissions,
  getOrganizationById,
  getPermissionsByRole,
  getRole,
  validateLogin,
} from "./organizations";
import { MemberRole } from "../../types/organization";
import { UserInterface } from "../../types/user";
import { AuditInterface } from "../../types/audit";
import { insertAudit } from "./audit";
import { getUserByEmail } from "./users";
import { hasOrganization } from "../models/OrganizationModel";
import { Issuer, IssuerMetadata } from "openid-client";
import { SSOConnectionParams } from "../../types/sso-connection";
import { getSSOConnectionById } from "../models/SSOConnectionModel";

type JWTInfo = {
  email?: string;
  verified?: boolean;
  name?: string;
  method?: string;
};

type IdToken = {
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  sub?: string;
};

// Self-hosted deployments use local auth
function getLocalJWTCheck() {
  if (!JWT_SECRET) {
    throw new Error("Must specify JWT_SECRET environment variable");
  }

  return jwt({
    secret: JWT_SECRET,
    audience: "https://api.growthbook.io",
    issuer: "https://api.growthbook.io",
    algorithms: ["HS256"],
  });
}

async function getUserFromJWT(token: IdToken): Promise<null | UserInterface> {
  if (!token.email) {
    throw new Error("Id token does not contain email address");
  }
  const user = await getUserByEmail(String(token.email));
  if (!user) return null;
  return user.toJSON();
}

function getOpenIdJWTCheck() {
  return (req: Request, res: Response, next: NextFunction) => {
    getOpenIdMiddleware(req)
      .then((middleware) => {
        middleware(req, res, next);
      })
      .catch(next);
  };
}

function getInitialDataFromJWT(user: IdToken): JWTInfo {
  const method = IS_CLOUD ? user.sub?.split("|")[0] || "" : "local";

  return {
    verified: user.email_verified || false,
    method,
    email: user.email || "",
    name: user.given_name || "",
  };
}

export function getJWTCheck() {
  // Cloud always uses SSO, self-hosted does too with the right env variables
  if (usingOpenId()) {
    return getOpenIdJWTCheck();
  }

  // For self-hosted, fall back to local authentication (no SSO)
  return getLocalJWTCheck();
}

export async function processJWT(
  // eslint-disable-next-line
  req: AuthRequest & { user: any },
  res: Response,
  next: NextFunction
) {
  const { email, name, verified, method } = getInitialDataFromJWT(req.user);

  req.email = email || "";
  req.name = name || "";
  req.verified = verified || false;
  req.loginMethod = method || "";
  req.permissions = getDefaultPermissions();

  // Throw error if permissions don't pass
  req.checkPermissions = (...permissions) => {
    for (let i = 0; i < permissions.length; i++) {
      if (!req.permissions[permissions[i]]) {
        throw new Error("You do not have permission to complete that action.");
      }
    }
  };

  const user = await getUserFromJWT(req.user);

  if (user) {
    req.email = user.email;
    req.userId = user.id;
    req.name = user.name;
    req.admin = !!user.admin;

    if (IS_CLOUD && user.verified && !req.verified) {
      return res.status(406).json({
        status: 406,
        message: "You must verify your email address before using GrowthBook",
      });
    }

    if (!user.verified && req.verified) {
      await markUserAsVerified(user.id);
    }

    if (req.headers["x-organization"]) {
      req.organization =
        (await getOrganizationById("" + req.headers["x-organization"])) ||
        undefined;

      if (req.organization) {
        // Make sure member is part of the organization
        if (
          !req.admin &&
          !req.organization.members.filter((m) => m.id === req.userId).length
        ) {
          return res.status(403).json({
            status: 403,
            message: "You do not have access to that organization",
          });
        }

        // Make sure this is a valid login method for the organization
        try {
          validateLogin(req, req.organization);
        } catch (e) {
          return res.status(403).json({
            status: 403,
            message: e.message,
          });
        }

        const role: MemberRole = req.admin
          ? "admin"
          : getRole(req.organization, user.id);
        req.permissions = getPermissionsByRole(role);
      } else {
        return res.status(404).json({
          status: 404,
          message: "Organization not found",
        });
      }
    }

    req.audit = async (data: Partial<AuditInterface>) => {
      await insertAudit({
        ...data,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        organization: req.organization?.id,
        dateCreated: new Date(),
      });
    };
  } else {
    req.audit = async () => {
      throw new Error("No user in request");
    };
  }

  next();
}

export function validatePasswordFormat(password?: string): string {
  if (!password) {
    throw new Error("Password cannot be empty");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  return password;
}

async function checkNewInstallation() {
  const doc = await hasOrganization();
  if (doc) {
    return false;
  }

  const doc2 = await UserModel.findOne();
  if (doc2) {
    return false;
  }

  return true;
}

let newInstallationPromise: Promise<boolean>;
export function isNewInstallation() {
  if (!newInstallationPromise) {
    newInstallationPromise = checkNewInstallation();
  }
  return newInstallationPromise;
}
export function markInstalled() {
  newInstallationPromise = new Promise((resolve) => resolve(false));
}

const ssoMiddlewares: Map<string, jwt.RequestHandler> = new Map();
async function getOpenIdMiddleware(req: Request) {
  const ssoConnection = await getOpenIdSettings(req);
  if (!ssoConnection) {
    throw new Error("Unknown SSO Connection");
  }
  const cacheKey = JSON.stringify(ssoConnection);
  const existing = ssoMiddlewares.get(cacheKey);
  if (existing) return existing;

  const metadata = await getMetadata(ssoConnection);

  const jwksUri = metadata.jwks_uri;
  const algorithms = metadata.id_token_signing_alg_values_supported;
  const issuer = metadata.issuer;

  if (!jwksUri || !algorithms || !issuer) {
    throw new Error(
      "Missing SSO metadata: 'issuer', 'jwks_uri', and/or 'id_token_signing_alg_values_supported'"
    );
  }

  const middleware = jwt({
    secret: jwks.expressJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri,
    }),
    audience: ssoConnection.clientId,
    issuer,
    algorithms,
  });
  ssoMiddlewares.set(cacheKey, middleware);
  return middleware;
}

export function usingOpenId() {
  if (IS_CLOUD) return true;
  if (SSO_CONFIG) return true;
  return false;
}

async function getOpenIdSettings(
  req: Request
): Promise<null | SSOConnectionParams> {
  // Self-hosted SSO
  if (!IS_CLOUD) {
    if (SSO_CONFIG) {
      return SSO_CONFIG;
    }
    return null;
  }

  // Cloud Enterprise SSO
  if (req.headers["x-auth-source-id"]) {
    const ssoConnectionId = req.headers["x-auth-source-id"];
    const ssoConnection = await getSSOConnectionById(ssoConnectionId + "");
    if (!ssoConnection) {
      console.error("Could not find SSO connection - ", ssoConnectionId);
      return null;
    }
    return ssoConnection;
  }

  // Cloud Default SSO
  return {
    id: "gbcloud",
    authority: "https://growthbook.auth0.com",
    clientId: "5xji4zoOExGgygEFlNXTwAUs3y68zU4D",
  };
}

const metadataCache: Map<string, IssuerMetadata> = new Map();
async function getMetadata(
  params: SSOConnectionParams
): Promise<IssuerMetadata> {
  // Metadata included in SSO config
  if (params.metadata) {
    return params.metadata;
  }

  const authority = params.authority;
  if (!authority) {
    throw new Error("Must have either metadata OR authority for SSO config");
  }

  // Otherwise, need to discover them from the authority
  const existing = metadataCache.get(authority);
  if (existing) return existing;

  const issuer = await Issuer.discover(authority);
  const metadata = issuer.metadata;
  metadataCache.set(authority, metadata);

  return metadata;
}
