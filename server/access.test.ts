import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { accessMiddleware } from "./access.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tenantId = "00000000-0000-4000-8000-000000000001";
const clientId = "00000000-0000-4000-8000-000000000002";
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

test("Microsoft access validates identity, delegated permissions and explicit assignment", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { privateKey: attackerKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const app = express();
  let businessCalls = 0;
  app.use(accessMiddleware(tenantId, clientId, createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] })));
  app.all("/", (_req, res) => { businessCalls++; res.json(res.locals.microsoftUser); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const claims = {
    tid: tenantId, ver: "2.0", oid: "11111111-1111-4111-8111-111111111111", azp: clientId,
    scp: "access_as_user", roles: ["Gorelo.User"],
  };
  const sign = (overrides: JWTPayload = {}, key = privateKey) => new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer)
    .setAudience(clientId).setSubject("user-id").setIssuedAt().setNotBefore("-5s").setExpirationTime("5m")
    .sign(key);
  const send = (token: string) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { "cf-access-jwt-assertion": "ignored", "x-user-email": "operator@example.com" } })).status, 401);
    assert.equal((await send("forged")).status, 401);
    assert.equal((await send(await sign({}, attackerKey))).status, 401);
    for (const overrides of [{ roles: [] }, { roles: ["other-role"] }, { scp: "User.Read" }, { scp: undefined },
      { azp: "other-client" }, { tid: "other-tenant" }, { ver: "1.0" }, { oid: "not-an-object-id" }]) {
      assert.equal((await send(await sign(overrides))).status, 403);
    }
    // Sign with invalid registered JWT claims separately (the helper sets them).
    for (const overrides of [{ aud: "other-api" }, { iss: "https://attacker.example" },
      { exp: Math.floor(Date.now() / 1000) - 60 }, { nbf: Math.floor(Date.now() / 1000) + 300 }]) {
      const bad = await new SignJWT({ ...claims, sub: "user", iat: Math.floor(Date.now() / 1000),
        nbf: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 300,
        aud: clientId, iss: issuer, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
      assert.equal((await send(bad)).status, 401);
    }
    assert.equal(businessCalls, 0, "Rejected requests must never reach a business handler");
    const valid = await send(await sign());
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { tenantId, objectId: claims.oid });
    assert.equal(businessCalls, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("public pane and registration metadata never expose business APIs without a token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gorelo-entra-"));
  await writeFile(join(directory, "index.html"), "<html>Public sign-in shell</html>");
  const app = createApp(loadConfig({ ENTRA_TENANT_ID: tenantId, ENTRA_CLIENT_ID: clientId, REQUIRE_ENTRA_AUTH: "true", STATIC_DIR: directory }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/`)).status, 200);
    assert.deepEqual(await (await fetch(`${url}/api/auth-config`)).json(), {
      provider: "entra", tenantId, clientId, scope: `api://${clientId}/access_as_user`,
    });
    for (const path of ["/api/auth-mode", "/api/options", "/api/tickets", "/api/unknown", "/api/auth-config/../options"]) {
      for (const method of ["GET", "POST"]) assert.equal((await fetch(`${url}${path}`, { method })).status, 401);
    }
    const preflight = await fetch(`${url}/api/options`, { method: "OPTIONS", headers: { Origin: "https://localhost:5173" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.equal((await fetch(`${url}/api/options`, { headers: { Origin: "https://foreign.example" } })).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(() => loadConfig({ ENTRA_TENANT_ID: tenantId }));
  assert.throws(() => loadConfig({ REQUIRE_ENTRA_AUTH: "true" }));
  assert.throws(() => loadConfig({ ENTRA_TENANT_ID: tenantId, ENTRA_CLIENT_ID: clientId, REQUIRE_ENTRA_AUTH: "true", DEMO_MODE: "true" }));
  assert.throws(() => loadConfig({ NODE_ENV: "production", GORELO_API_KEY: "secret" }));
});
