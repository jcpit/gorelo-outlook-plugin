import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const production = {
  NODE_ENV: "production",
  GORELO_API_KEY: "synthetic-gorelo-test-value",
  ENTRA_TENANT_ID: "00000000-0000-4000-8000-000000000001",
  ENTRA_CLIENT_ID: "00000000-0000-4000-8000-000000000002",
  ATTACHMENT_RETRY_DIR: "/app/retry-data",
  AUDIT_LOG_DIR: "/app/retry-data/audit",
};

test("production requires Entra and a server Gorelo key, including AI-only deployments", () => {
  for (const env of [
    { NODE_ENV: "production" },
    { NODE_ENV: "production", OPENCODE_API_KEY: "synthetic-ai-test-value" },
    { ...production, ENTRA_TENANT_ID: undefined, ENTRA_CLIENT_ID: undefined },
    { ...production, GORELO_API_KEY: undefined, OPENCODE_API_KEY: "synthetic-ai-test-value" },
    { ...production, DEMO_MODE: "true" },
  ]) assert.throws(() => loadConfig(env), /Production requires/);
});

test("production refuses missing or relative persistent-storage paths", () => {
  for (const env of [
    { ...production, ATTACHMENT_RETRY_DIR: undefined },
    { ...production, AUDIT_LOG_DIR: undefined },
    { ...production, ATTACHMENT_RETRY_DIR: "retry-data" },
    { ...production, AUDIT_LOG_DIR: "audit" },
  ]) assert.throws(() => loadConfig(env), /persistent storage/);
});

test("valid production config keeps credentials server-side and enables persistent state", () => {
  const config = loadConfig({ ...production, OPENCODE_API_KEY: "synthetic-ai-test-value" });
  assert.equal(config.demoMode, false);
  assert.equal(config.entraClientId, production.ENTRA_CLIENT_ID);
  assert.equal(config.attachmentRetryDir, "/app/retry-data");
  assert.equal(config.auditDirectory, "/app/retry-data/audit");
});

test("development retains explicit local and demo modes without persistent storage", () => {
  assert.equal(loadConfig({}).goreloApiKey, undefined);
  assert.equal(loadConfig({ DEMO_MODE: "true" }).demoMode, true);
});
