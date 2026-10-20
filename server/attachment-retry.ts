import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

type Attachment = { name: string; contentType: string; contentBase64: string };
type Reference = { Name: string; Url: string };
type FileState = "pending" | "uploaded" | "linked" | "uncertain";
type FileRecord = {
  hash: string; name: string; contentType: string; contentBase64?: string;
  state: FileState; reference?: Reference; reason?: string;
};
type Job = { token: string; ticketId: string; keyHash: string; files: FileRecord[]; updatedAt: string };
export type AttachmentResult = {
  partialFailures?: string[]; attachmentRetryToken?: string;
  retryableAttachmentCount?: number; uncertainAttachmentCount?: number;
};
type Request = (path: string, init?: RequestInit) => Promise<{ Data?: unknown }>;
const retentionMs = 7 * 24 * 60 * 60_000;

export class AttachmentRetryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function attachmentHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function keyHash(key: string): string { return createHash("sha256").update(key).digest("hex"); }
function is429(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 429;
}
function reason(error: unknown): string { return error instanceof Error ? error.message : "Unknown failure"; }

export class AttachmentRetryStore {
  private readonly memory = new Map<string, Job>();
  private readonly active = new Map<string, { result: Promise<AttachmentResult>; maintenance: boolean }>();

  constructor(private readonly directory?: string, private readonly now = Date.now) {
    const sweep = () => { void this.expire().catch(() => console.error("Attachment retry retention check failed")); };
    sweep(); setInterval(sweep, 60 * 60_000).unref();
  }

  private async expire(): Promise<void> {
    if (!this.directory) {
      for (const [token, job] of this.memory) if (!this.active.has(token)) this.expirePayload(job);
      return;
    }
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; }
    for (const name of names) {
      if (/^[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) {
        const path = join(this.directory, name);
        if (this.now() - (await stat(path)).mtimeMs > retentionMs) await unlink(path);
        continue;
      }
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const token = name.slice(0, -5);
      if (!this.active.has(token)) await this.exclusive(token, async () => {
        const job = await this.load(token, true); return job ? this.result(job) : {};
      }, true);
    }
  }

  private token(ticketId: string, key: string, attachments: Attachment[]): string {
    const hashes = [...new Set(attachments.map((a) => attachmentHash(Buffer.from(a.contentBase64, "base64"))))].sort();
    const value = createHash("sha256").update(JSON.stringify([ticketId, keyHash(key), hashes])).digest("hex").slice(0, 32);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }

  private expirePayload(job: Job): boolean {
    if (this.now() - Date.parse(job.updatedAt) <= retentionMs) return false;
    let changed = false;
    // Receipts never expire: dropping them would permit a blind duplicate upload.
    for (const file of job.files) {
      if (file.contentBase64 === undefined) continue;
      delete file.contentBase64; file.state = "uncertain";
      file.reason = "Retry data expired after seven days. Review the original file and Gorelo manually.";
      changed = true;
    }
    return changed;
  }

  private async load(token: string, exclusive = false): Promise<Job | undefined> {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(token)) throw new AttachmentRetryError("Invalid attachment retry token");
    try {
      const stored = this.directory
        ? JSON.parse(await readFile(join(this.directory, `${token}.json`), "utf8")) as Job
        : this.memory.get(token);
      if (!stored) return undefined;
      const job = structuredClone(stored);
      // Keep receipts, but never retain failed email binaries indefinitely.
      if ((exclusive || !this.active.has(token)) && this.expirePayload(job)) {
        await this.save(job);
      }
      return job;
    }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      throw new AttachmentRetryError("Could not read the attachment retry record. Check Gorelo before retrying.", 503);
    }
  }

  private async save(job: Job): Promise<void> {
    job.updatedAt = new Date(this.now()).toISOString();
    if (!this.directory) {
      // Bound payload jobs, not receipts. Byte-free deduplication receipts grow
      // for this process's lifetime; evicting them would make replay unsafe.
      for (const [token, stored] of this.memory) if (!this.active.has(token)) this.expirePayload(stored);
      const hasPayload = (record: Job) => record.files.some((file) => file.contentBase64 !== undefined);
      if (!this.memory.has(job.token) && hasPayload(job) && [...this.memory.values()].filter(hasPayload).length >= 50)
        throw new AttachmentRetryError("Attachment retry storage is full", 503);
      this.memory.set(job.token, structuredClone(job));
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${job.token}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(job));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    // The write-ahead receipt must survive power loss before any remote write:
    // syncing file contents alone does not durably commit the atomic rename.
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private verify(job: Job | undefined, ticketId: string, key: string): asserts job is Job {
    if (!job || job.ticketId !== ticketId || job.keyHash !== keyHash(key)) throw new AttachmentRetryError("Attachment retry record not found for this ticket", 404);
  }

  private result(job: Job): AttachmentResult {
    const unfinished = job.files.filter((file) => file.state !== "linked");
    if (!unfinished.length) return {};
    return {
      attachmentRetryToken: job.token,
      retryableAttachmentCount: unfinished.filter((file) => file.state === "pending" || file.state === "uploaded").length,
      uncertainAttachmentCount: unfinished.filter((file) => file.state === "uncertain").length,
      partialFailures: unfinished.map((file) => `Attachment ${file.name}: ${file.reason || "Not yet attached"}`),
    };
  }

  async status(ticketId: string, token: string, key: string): Promise<AttachmentResult> {
    const job = await this.load(token); this.verify(job, ticketId, key);
    return this.result(job);
  }

  async existing(ticketId: string, key: string, attachments: Attachment[]): Promise<string | undefined> {
    const token = this.token(ticketId, key, attachments);
    const job = await this.load(token);
    if (job) { this.verify(job, ticketId, key); return token; }
    return undefined;
  }

  async start(ticketId: string, key: string, attachments: Attachment[], request: Request, linkedHashes = new Set<string>()): Promise<AttachmentResult> {
    if (!attachments.length) return {};
    const token = this.token(ticketId, key, attachments);
    return this.exclusive(token, async () => {
      let job = await this.load(token, true);
      if (job) this.verify(job, ticketId, key);
      else {
        const seen = new Set<string>();
        const files = attachments.flatMap((attachment): FileRecord[] => {
          const hash = attachmentHash(Buffer.from(attachment.contentBase64, "base64"));
          if (seen.has(hash)) return [];
          seen.add(hash);
          const linked = linkedHashes.has(hash);
          return [{ hash, name: attachment.name, contentType: attachment.contentType,
            ...(linked ? {} : { contentBase64: attachment.contentBase64 }), state: linked ? "linked" : "pending" }];
        });
        job = { token, ticketId, keyHash: keyHash(key), files, updatedAt: new Date(this.now()).toISOString() };
        await this.save(job);
      }
      return this.transfer(job, request);
    });
  }

  async resume(ticketId: string, token: string, key: string, request: Request): Promise<AttachmentResult> {
    // Authorise before joining an in-flight operation under the same token.
    const job = await this.load(token); this.verify(job, ticketId, key);
    return this.exclusive(token, async () => {
      const latest = await this.load(token, true); this.verify(latest, ticketId, key);
      await request(`/v1/tickets/${encodeURIComponent(ticketId)}`);
      return this.transfer(latest, request);
    });
  }

  private async exclusive(token: string, run: () => Promise<AttachmentResult>, maintenance = false): Promise<AttachmentResult> {
    const existing = this.active.get(token);
    if (existing) {
      // Maintenance is not a transfer: callers must run their operation after
      // the sweep, rather than mistaking its status for a completed retry.
      if (existing.maintenance) {
        await existing.result;
        return this.exclusive(token, run, maintenance);
      }
      return existing.result;
    }
    const result = run(); this.active.set(token, { result, maintenance });
    try { return await result; } finally { this.active.delete(token); }
  }

  private async transfer(job: Job, request: Request): Promise<AttachmentResult> {
    const deadline = this.now() + 25_000;
    for (const file of job.files.filter((file) => file.state === "pending")) {
      if (this.now() >= deadline) break;
      const form = new FormData();
      form.append("file", new Blob([Uint8Array.from(Buffer.from(file.contentBase64!, "base64"))], { type: file.contentType }), file.name);
      form.append("itemType", "Ticket"); form.append("itemId", job.ticketId);
      // A crash or lost response must never trigger a blind repeat of a write.
      file.state = "uncertain"; file.reason = "Upload was not confirmed. Review this file in Gorelo before retrying.";
      await this.save(job);
      try {
        const envelope = await request("/v1/attachments", { method: "POST", body: form });
        const reference = envelope.Data as Partial<Reference> | undefined;
        if (!reference || typeof reference.Name !== "string" || !reference.Name || typeof reference.Url !== "string" || !URL.canParse(reference.Url) || new URL(reference.Url).protocol !== "https:")
          throw new Error("Upload returned no attachment reference");
        file.reference = { Name: reference.Name, Url: reference.Url }; file.state = "uploaded";
        delete file.contentBase64; delete file.reason;
      } catch (error) {
        if (is429(error)) { file.state = "pending"; file.reason = reason(error); }
        else file.reason = `${reason(error)}. Review in Gorelo; automatic retry is disabled.`;
      }
      await this.save(job);
    }
    const uploaded = job.files.filter((file) => file.state === "uploaded");
    if (uploaded.length) {
      for (const file of uploaded) { file.state = "uncertain"; file.reason = "Attachment linking was not confirmed. Review the ticket conversation before retrying."; }
      await this.save(job);
      try {
        const references = uploaded.map((file) => file.reference!);
        const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
        await request(`/v1/tickets/${encodeURIComponent(job.ticketId)}/comments`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ Body: `<p>Attachments imported from Outlook:</p><ul>${references.map((r) => `<li><a href="${escape(r.Url)}">${escape(r.Name)}</a></li>`).join("")}</ul>`, ConversationTypeId: 2, Attachments: references }),
        });
        for (const file of uploaded) { file.state = "linked"; delete file.reason; }
      } catch (error) {
        for (const file of uploaded) {
          if (is429(error)) file.state = "uploaded";
          file.reason = `${reason(error)}${is429(error) ? "" : ". Review in Gorelo; automatic retry is disabled."}`;
        }
      }
      await this.save(job);
    }
    return this.result(job);
  }
}
