import { mkdir, readdir, lchown, chmod, lstat } from "node:fs/promises";
import { join } from "node:path";

// Railway mounts volumes as root. Fix only this app's known storage paths,
// then permanently drop privileges before loading any HTTP/API code.
if (process.getuid?.() === 0) {
  const directory = process.env.ATTACHMENT_RETRY_DIR;
  if (directory) {
    if (directory !== "/app/retry-data") throw new Error("Unexpected retry volume path");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Retry storage must be a real directory");
    await lchown(directory, 1000, 1000);
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(entry.name)) {
        await lchown(join(directory, entry.name), 1000, 1000);
        await chmod(join(directory, entry.name), 0o600);
      }
    }
  }
  const auditDirectory = process.env.AUDIT_LOG_DIR;
  if (auditDirectory) {
    if (directory !== "/app/retry-data" || auditDirectory !== "/app/retry-data/audit") throw new Error("Unexpected audit volume path");
    await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
    if (!(await lstat(auditDirectory)).isDirectory()) throw new Error("Audit storage must be a real directory");
    await lchown(auditDirectory, 1000, 1000);
    await chmod(auditDirectory, 0o700);
    for (const entry of await readdir(auditDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === "security-audit.jsonl") {
        await lchown(join(auditDirectory, entry.name), 1000, 1000);
        await chmod(join(auditDirectory, entry.name), 0o600);
      }
    }
  }
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
await import("./index.js");
