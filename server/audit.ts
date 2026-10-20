import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type AuditActor = { mode: "entra"; tenantId: string; objectId: string } | { mode: "local" };
export type AuditOperation = "ticket.create" | "email.append" | "attachments.retry" | "attachments.recover";
export interface AuditEvent {
  timestamp: string;
  requestId: string;
  actor: AuditActor;
  operation: AuditOperation;
  target: { type: "ticket"; ticketId?: string };
  phase: "attempt" | "outcome";
  outcome?: "success" | "partial-success" | "indeterminate";
}
export interface AuditSink { write(event: AuditEvent): Promise<void> }
export interface PreparedAuditSink extends AuditSink { prepare(): Promise<void> }

// This error deliberately contains no underlying filesystem or connector detail.
export class AuditUnavailableError extends Error {
  constructor(public readonly mutationMayHaveOccurred: boolean) {
    super("Security audit logging is unavailable");
  }
}

export function createAuditSink(directory?: string): PreparedAuditSink {
  // Linux deployment contract: unsupported directory fsync fails closed rather
  // than silently weakening durability on another platform/filesystem.
  const syncDirectory = async (path: string) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  let initialized: Promise<void> | undefined;
  const initialize = async (path: string) => {
    const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory()) throw new Error("Audit directory must not be a symlink");
    await chmod(path, 0o700);
    // Also sync the parent of a precreated audit directory: the entrypoint may
    // have created it without persisting its directory entry before startup.
    const lastParent = dirname(resolve(firstCreated ?? path));
    let current = resolve(path);
    while (true) {
      await syncDirectory(current);
      if (current === lastParent) break;
      current = dirname(current);
    }
  };
  const persist = async (line?: string) => {
    if (!directory) {
      if (line !== undefined) await new Promise<void>((resolve, reject) => process.stdout.write(line, (error) => error ? reject(error) : resolve()));
      return;
    }
    // Share initialization across concurrent requests; an initialization sync
    // failure stays failed for this sink, including on subsequent attempts.
    await (initialized ??= initialize(directory));
    if (!(await lstat(directory)).isDirectory()) throw new Error("Audit directory must not be a symlink");
    await chmod(directory, 0o700);
    // Refuse symlink files and sync every record before allowing a write.
    const file = await open(join(directory, "security-audit.jsonl"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Audit target must be a regular file");
      await file.chmod(0o600);
      if (line !== undefined) await file.writeFile(line);
      await file.sync();
    } finally { await file.close(); }
    // File fsync alone cannot persist a newly created filename after power loss.
    await syncDirectory(directory);
  };
  return {
    async prepare() {
      try { await persist(); } catch { throw new AuditUnavailableError(false); }
    },
    async write(event) {
      await persist(`${JSON.stringify(event)}\n`);
    },
  };
}

export function auditActor(user: unknown, entraRequired: boolean): AuditActor {
  if (!entraRequired) return { mode: "local" };
  const identity = user as { tenantId?: unknown; objectId?: unknown } | undefined;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!identity || typeof identity.tenantId !== "string" || typeof identity.objectId !== "string" ||
      !uuid.test(identity.tenantId) || !uuid.test(identity.objectId)) throw new AuditUnavailableError(false);
  return { mode: "entra", tenantId: identity.tenantId, objectId: identity.objectId };
}

export async function auditedMutation<T>(sink: AuditSink, actor: AuditActor, requestId: string,
  operation: AuditOperation, ticketId: string | undefined, mutate: () => Promise<T>): Promise<T> {
  const base = { requestId, actor, operation, target: { type: "ticket" as const, ...(ticketId ? { ticketId } : {}) } };
  const record = async (phase: AuditEvent["phase"], outcome?: AuditEvent["outcome"]) => {
    await sink.write({ ...base, target: { ...base.target }, timestamp: new Date().toISOString(), phase, ...(outcome ? { outcome } : {}) });
  };
  try { await record("attempt"); } catch { throw new AuditUnavailableError(false); }
  let result: T;
  try { result = await mutate(); }
  catch (error) {
    try { await record("outcome", "indeterminate"); } catch { throw new AuditUnavailableError(true); }
    throw error;
  }
  if (!ticketId && result && typeof result === "object" && "ticketId" in result &&
      typeof result.ticketId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.ticketId)) base.target.ticketId = result.ticketId;
  const partial = result && typeof result === "object" && "partialFailures" in result &&
    Array.isArray(result.partialFailures) && result.partialFailures.length > 0;
  try { await record("outcome", partial ? "partial-success" : "success"); } catch { throw new AuditUnavailableError(true); }
  return result;
}

export const newAuditRequestId = () => randomUUID();
