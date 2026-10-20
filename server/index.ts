import { createApp } from "./app.js";
import { createAuditSink } from "./audit.js";
import { loadConfig } from "./config.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:https";

const config = loadConfig();
if (config.staticDir && !existsSync(join(config.staticDir, "index.html"))) {
  throw new Error("Built frontend is missing from STATIC_DIR");
}
const auditSink = createAuditSink(config.auditDirectory);
try {
  // Verify mounted storage durability before accepting any HTTP requests.
  await auditSink.prepare();
} catch {
  throw new Error("Security audit storage preflight failed; server not started");
}
const app = createApp(config, undefined, { auditSink });

if (config.httpsCertFile && config.httpsKeyFile) {
  const cert = readFileSync(config.httpsCertFile);
  const key = readFileSync(config.httpsKeyFile);
  createServer({ cert, key }, app).listen(config.port, config.listenHost, () => {
    console.log(`Gorelo Outlook HTTPS service listening on port ${config.port}`);
  });
} else {
  app.listen(config.port, config.listenHost, () => {
    console.log(`Gorelo Outlook local API listening on ${config.listenHost}:${config.port}`);
  });
}
