import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export function accessMiddleware(tenantId: string, clientId: string, keys?: JWTVerifyGetKey): RequestHandler {
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const keySet = keys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  return async (request, response, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(request.header("authorization") ?? "");
    if (!match) {
      response.status(401).json({ error: "Sign in with Microsoft to use the Gorelo integration.", retrySafe: true });
      return;
    }
    try {
      const { payload } = await jwtVerify(match[1], keySet, {
        issuer, audience: clientId, algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "nbf", "sub", "oid", "tid", "ver"],
      });
      if (payload.tid !== tenantId || payload.ver !== "2.0" || payload.azp !== clientId ||
          typeof payload.oid !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.oid) ||
          typeof payload.scp !== "string" || !payload.scp.split(" ").includes("access_as_user")) {
        response.status(403).json({ error: "A delegated Gorelo add-in access token is required.", retrySafe: true });
        return;
      }
      // The organisation-wide Gorelo key must not be available to all tenant
      // users or guests just because they can authenticate. Require assignment.
      if (!Array.isArray(payload.roles) || !payload.roles.includes("Gorelo.User")) {
        response.status(403).json({ error: "Your Microsoft account needs the Gorelo.User application role. Ask your administrator to assign access.", retrySafe: true });
        return;
      }
      response.locals.microsoftUser = { tenantId, objectId: payload.oid };
      next();
    } catch {
      response.status(401).json({ error: "Microsoft sign-in expired or the access token is invalid. Sign in again.", retrySafe: true });
    }
  };
}
