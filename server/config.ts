import { z } from "zod";
import { isAbsolute } from "node:path";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LISTEN_HOST: z.string().min(1).default("127.0.0.1"),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
  GORELO_API_KEY: z.string().trim().min(1).max(512).optional(),
  OPENCODE_API_KEY: z.string().trim().min(1).max(512).optional(),
  ATTACHMENT_RETRY_DIR: z.string().trim().min(1).optional(),
  AUDIT_LOG_DIR: z.string().trim().min(1).optional(),
  ENTRA_TENANT_ID: z.string().uuid().optional(),
  ENTRA_CLIENT_ID: z.string().uuid().optional(),
  REQUIRE_ENTRA_AUTH: z.enum(["true", "false"]).default("false"),
  REQUIRE_SERVER_KEY: z.enum(["true", "false"]).default("false"),
  GORELO_BASE_URL: z.string().url().default("https://api.usw.gorelo.io"),
  CORS_ORIGIN: z.string().url().default("https://localhost:5173"),
  STATIC_DIR: z.string().min(1).optional(),
  HTTPS_CERT_FILE: z.string().min(1).optional(),
  HTTPS_KEY_FILE: z.string().min(1).optional(),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  if (Boolean(parsed.ENTRA_TENANT_ID) !== Boolean(parsed.ENTRA_CLIENT_ID) ||
      (parsed.REQUIRE_ENTRA_AUTH === "true" && (!parsed.ENTRA_TENANT_ID || !parsed.ENTRA_CLIENT_ID || parsed.DEMO_MODE === "true"))) {
    throw new Error("Entra authentication requires both tenant and client IDs and DEMO_MODE=false");
  }
  if (env.NODE_ENV === "production") {
    // Any hosted deployment, including AI-only configurations, must fail closed.
    // Local, caller-supplied keys and demo mode are development-only features.
    if (!parsed.GORELO_API_KEY || !parsed.ENTRA_CLIENT_ID || !parsed.ENTRA_TENANT_ID || parsed.DEMO_MODE === "true") {
      throw new Error("Production requires a server-managed Gorelo key, Entra authentication and DEMO_MODE=false");
    }
    if (!parsed.ATTACHMENT_RETRY_DIR || !isAbsolute(parsed.ATTACHMENT_RETRY_DIR) ||
        !parsed.AUDIT_LOG_DIR || !isAbsolute(parsed.AUDIT_LOG_DIR)) {
      throw new Error("Production requires absolute ATTACHMENT_RETRY_DIR and AUDIT_LOG_DIR paths on persistent storage");
    }
  }
  if (parsed.REQUIRE_SERVER_KEY === "true" && !parsed.GORELO_API_KEY) {
    throw new Error("GORELO_API_KEY is required when REQUIRE_SERVER_KEY=true");
  }
  const baseUrl = new URL(parsed.GORELO_BASE_URL);
  if (baseUrl.protocol !== "https:") throw new Error("GORELO_BASE_URL must use HTTPS");
  if (Boolean(parsed.HTTPS_CERT_FILE) !== Boolean(parsed.HTTPS_KEY_FILE)) {
    throw new Error("HTTPS_CERT_FILE and HTTPS_KEY_FILE must be configured together");
  }
  return {
    port: parsed.PORT,
    listenHost: parsed.LISTEN_HOST,
    demoMode: parsed.DEMO_MODE === "true",
    goreloApiKey: parsed.GORELO_API_KEY,
    openCodeApiKey: parsed.OPENCODE_API_KEY,
    attachmentRetryDir: parsed.ATTACHMENT_RETRY_DIR,
    auditDirectory: parsed.AUDIT_LOG_DIR,
    entraTenantId: parsed.ENTRA_TENANT_ID,
    entraClientId: parsed.ENTRA_CLIENT_ID,
    goreloBaseUrl: baseUrl.origin,
    corsOrigin: parsed.CORS_ORIGIN,
    staticDir: parsed.STATIC_DIR,
    httpsCertFile: parsed.HTTPS_CERT_FILE,
    httpsKeyFile: parsed.HTTPS_KEY_FILE,
  };
}
