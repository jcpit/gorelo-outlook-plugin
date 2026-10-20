import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { accessMiddleware } from "./access.js";
import { createApp } from "./app.js";
import { auditActor, auditedMutation, AuditUnavailableError, createAuditSink, type AuditEvent, type AuditSink } from "./audit.js";
import { loadConfig } from "./config.js";
import type { GoreloConnector } from "./goreloConnector.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mail = {
  subject: "PRIVATE SUBJECT", from: { name: "Private Sender", email: "sender@example.com" }, to: [], cc: [],
  receivedAt: "2026-09-29T10:00:00+10:00", bodyText: "PRIVATE BODY", attachments: [], groupId: 1, statusId: 1, typeId: 1,
};

async function serve(app: ReturnType<typeof express>, run: (base: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("all four mutations audit safe local actor, server correlation and targets without payloads or tokens", async () => {
  const events: AuditEvent[] = [];
  let calls = 0;
  const connector = {
    createTicket: async () => { calls++; return { ticketId: id }; },
    attachEmail: async () => { calls++; return {}; },
    retryAttachments: async () => { calls++; return {}; },
    recoverAttachments: async () => { calls++; return {}; },
  } as unknown as GoreloConnector;
  await serve(createApp(loadConfig({ GORELO_API_KEY: "PRIVATE API KEY" }), connector,
    { auditSink: { async write(event) { events.push(event); } } }), async (base) => {
    const requests: Array<[string, unknown]> = [
      ["/api/tickets", mail], [`/api/tickets/${id}/emails`, mail],
      [`/api/tickets/${id}/attachments/retry`, { token }], [`/api/tickets/${id}/attachments/recover`, { attachments: [] }],
    ];
    for (const [path, body] of requests) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: {
        "Content-Type": "application/json", "X-Request-ID": "caller-spoof", "X-User-Email": "spoof@example.com",
      }, body: JSON.stringify(body) });
      assert.ok(response.ok);
      const pair = events.slice(-2);
      assert.equal(pair[0]?.phase, "attempt");
      assert.equal(pair[1]?.outcome, "success");
      assert.equal(pair[0]?.requestId, response.headers.get("x-request-id"));
      assert.equal(pair[0]?.requestId, pair[1]?.requestId);
      assert.notEqual(pair[0]?.requestId, "caller-spoof");
      assert.deepEqual(pair[0]?.actor, { mode: "local" });
      assert.equal(pair[1]?.target.ticketId, id);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-frame-options"), null);
    }
  });
  assert.equal(calls, 4);
  assert.equal(new Set(events.map((event) => event.requestId)).size, 4);
  assert.deepEqual(events.filter((event) => event.phase === "attempt").map((event) => event.operation),
    ["ticket.create", "email.append", "attachments.retry", "attachments.recover"]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|spoof|sender@example|bbbbbbbb|contentBase64|authorization/i);
});

test("attempt logging fails closed before connector calls; outcome logging failure is explicitly indeterminate", async () => {
  for (const failAt of [1, 2]) {
    let records = 0;
    let calls = 0;
    const sink: AuditSink = { async write() { if (++records === failAt) throw new Error("PRIVATE sink error"); } };
    const connector = { retryAttachments: async () => { calls++; return {}; } } as unknown as GoreloConnector;
    await serve(createApp(loadConfig({ GORELO_API_KEY: "PRIVATE key" }), connector, { auditSink: sink }), async (base) => {
      const response = await fetch(`${base}/api/tickets/${id}/attachments/retry`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.retrySafe, failAt === 1);
      assert.equal(body.mutationStatus, failAt === 1 ? "not-started" : "indeterminate");
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE/);
    });
    assert.equal(calls, failAt === 1 ? 0 : 1);
  }
});

test("connector failure audit contains only classified indeterminate outcome, never arbitrary error", async () => {
  const events: AuditEvent[] = [];
  const error = new Error("PRIVATE token or upstream body");
  await assert.rejects(auditedMutation({ async write(event) { events.push(event); } }, { mode: "local" },
    "request", "ticket.create", undefined, async () => { throw error; }), error);
  assert.equal(events[1]?.outcome, "indeterminate");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|upstream/);
  assert.throws(() => auditActor(undefined, true));
});

test("partial mutation success records only the classification, never attachment failure details", async () => {
  const events: AuditEvent[] = [];
  await auditedMutation({ async write(event) { events.push(event); } }, { mode: "local" },
    "request", "ticket.create", undefined, async () => ({ ticketId: id, partialFailures: ["PRIVATE attachment name"] }));
  assert.equal(events[0]?.target.ticketId, undefined);
  assert.equal(events[1]?.target.ticketId, id);
  assert.equal(events[1]?.outcome, "partial-success");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|attachment name/);
});

test("audit actor is derived from server-verified Entra identity, not spoofed identity headers", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const clientId = "22222222-2222-4222-8222-222222222222";
  const objectId = "33333333-3333-4333-8333-333333333333";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwt = await new SignJWT({ tid: tenantId, oid: objectId, ver: "2.0", azp: clientId,
    scp: "access_as_user", roles: ["Gorelo.User"] }).setProtectedHeader({ alg: "RS256", kid: "audit-test" })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`).setAudience(clientId).setSubject("subject")
    .setIssuedAt().setNotBefore("-5s").setExpirationTime("5m").sign(privateKey);
  const events: AuditEvent[] = [];
  const app = express();
  app.use(accessMiddleware(tenantId, clientId, createLocalJWKSet({ keys: [{ ...jwk, kid: "audit-test" }] })));
  app.post("/", async (_request, response) => {
    await auditedMutation({ async write(event) { events.push(event); } }, auditActor(response.locals.microsoftUser, true),
      "server-correlation", "email.append", id, async () => ({}));
    response.json({ ok: true });
  });
  await serve(app, async (base) => {
    assert.equal((await fetch(base, { method: "POST", headers: { "X-User-ID": objectId } })).status, 401);
    assert.equal(events.length, 0);
    assert.equal((await fetch(base, { method: "POST", headers: { Authorization: `Bearer ${jwt}`, "X-User-ID": "spoof" } })).status, 200);
  });
  assert.deepEqual(events[0]?.actor, { mode: "entra", tenantId, objectId });
  assert.doesNotMatch(JSON.stringify(events), /spoof|Bearer|eyJ/);
});

test("file audit sink persists JSONL privately, and rejects symlink files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "gorelo-audit-test-"));
  const directory = join(temporary, "audit");
  const event: AuditEvent = { timestamp: new Date().toISOString(), requestId: "test", actor: { mode: "local" },
    operation: "ticket.create", target: { type: "ticket" }, phase: "attempt" };
  try {
    await createAuditSink(directory).write(event);
    const file = join(directory, "security-audit.jsonl");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse((await readFile(file, "utf8")).trim()), event);
    const blocked = join(temporary, "symlink-audit");
    await createAuditSink(blocked).write(event);
    await rm(join(blocked, "security-audit.jsonl"));
    await symlink(file, join(blocked, "security-audit.jsonl"));
    await assert.rejects(createAuditSink(blocked).write(event));
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
    const directoryLink = join(temporary, "directory-link");
    await symlink(directory, directoryLink);
    await assert.rejects(createAuditSink(directoryLink).write(event));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("audit syncs new directories and trusted parent, then file and log directory before returning", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "gorelo-audit-sync-"));
  const directory = join(temporary, "new-parent", "audit");
  const probe = await open(temporary, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  const syncs: Array<{ directory: boolean; inode: number }> = [];
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    const info = await this.stat();
    syncs.push({ directory: info.isDirectory(), inode: info.ino });
    await originalSync.call(this);
  });
  try {
    await auditedMutation(createAuditSink(directory), { mode: "local" }, "sync-test", "ticket.create", undefined,
      async () => {
        const inodes = await Promise.all([directory, join(temporary, "new-parent"), temporary].map(async (path) => (await stat(path)).ino));
        assert.deepEqual(syncs.map((sync) => sync.directory), [true, true, true, false, true]);
        assert.deepEqual(syncs.slice(0, 3).map((sync) => sync.inode), inodes);
        assert.equal(syncs[4]?.inode, inodes[0]);
        return {};
      });
  } finally {
    t.mock.restoreAll();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("directory sync failures fail closed before business writes, including initialization failures", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "gorelo-audit-sync-failure-"));
  const probe = await open(temporary, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  t.mock.method(prototype, "sync", async function (this: FileHandle) {
    if ((await this.stat()).isDirectory()) throw new Error("PRIVATE forced directory sync failure");
    await originalSync.call(this);
  });
  try {
    for (const existing of [false, true]) {
      const directory = join(temporary, existing ? "existing" : "new");
      if (existing) await mkdir(directory);
      const sink = createAuditSink(directory);
      let businessCalls = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(auditedMutation(sink, { mode: "local" }, "sync-failure", "ticket.create", undefined,
          async () => { businessCalls++; return {}; }), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "Security audit logging is unavailable");
          return true;
        });
      }
      assert.equal(businessCalls, 0);
    }
  } finally {
    t.mock.restoreAll();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("precreated audit directory syncs its parent before ticket creation and parent sync failure blocks the connector", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "gorelo-audit-precreated-"));
  const probe = await open(temporary, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  try {
    for (const failParentSync of [false, true]) {
      const parent = join(temporary, failParentSync ? "failure" : "success");
      const directory = join(parent, "audit");
      await mkdir(directory, { recursive: true });
      const parentInode = (await stat(parent)).ino;
      const directoryInode = (await stat(directory)).ino;
      const syncs: Array<{ directory: boolean; inode: number }> = [];
      t.mock.method(prototype, "sync", async function (this: FileHandle) {
        const info = await this.stat();
        syncs.push({ directory: info.isDirectory(), inode: info.ino });
        if (failParentSync && info.ino === parentInode) throw new Error("Forced parent sync failure");
        await originalSync.call(this);
      });
      let connectorCalls = 0;
      const connector = { createTicket: async () => {
        connectorCalls++;
        assert.deepEqual(syncs.map((sync) => sync.directory), [true, true, false, true]);
        assert.equal(syncs[0]?.inode, directoryInode);
        assert.equal(syncs[1]?.inode, parentInode);
        assert.equal(syncs[3]?.inode, directoryInode);
        return { ticketId: id };
      } } as unknown as GoreloConnector;
      await serve(createApp(loadConfig({ GORELO_API_KEY: "synthetic-key" }), connector,
        { auditSink: createAuditSink(directory) }), async (base) => {
        const response = await fetch(`${base}/api/tickets`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...mail, attachments: [] }),
        });
        assert.equal(response.status, failParentSync ? 503 : 201);
        if (failParentSync) {
          const body = await response.json();
          assert.equal(body.mutationStatus, "not-started");
          assert.equal(body.retrySafe, true);
          assert.deepEqual(syncs.map((sync) => sync.inode), [directoryInode, parentInode]);
        }
      });
      assert.equal(connectorCalls, failParentSync ? 0 : 1);
      t.mock.restoreAll();
    }
  } finally {
    t.mock.restoreAll();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("audit preflight creates an empty private durable log, and subsequent writes contain no synthetic event", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "gorelo-audit-prepare-"));
  const directory = join(temporary, "audit");
  const file = join(directory, "security-audit.jsonl");
  const event: AuditEvent = { timestamp: new Date().toISOString(), requestId: "prepared", actor: { mode: "local" },
    operation: "ticket.create", target: { type: "ticket" }, phase: "attempt" };
  try {
    const sink = createAuditSink(directory);
    await sink.prepare();
    await sink.prepare();
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(file, "utf8"), "");
    await sink.write(event);
    assert.equal(await readFile(file, "utf8"), `${JSON.stringify(event)}\n`);
    await sink.prepare();
    assert.equal(await readFile(file, "utf8"), `${JSON.stringify(event)}\n`);
    await createAuditSink().prepare(); // Development stdout mode needs no file or synthetic record.
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("audit preflight fails closed generically on file or directory fsync failure", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "gorelo-audit-prepare-failure-"));
  const probe = await open(temporary, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalSync = prototype.sync;
  await probe.close();
  try {
    for (const failDirectory of [false, true]) {
      t.mock.method(prototype, "sync", async function (this: FileHandle) {
        if ((await this.stat()).isDirectory() === failDirectory) throw new Error("PRIVATE sync failure");
        await originalSync.call(this);
      });
      const sink = createAuditSink(join(temporary, failDirectory ? "directory" : "file"));
      await assert.rejects(sink.prepare(), (error: unknown) => {
        assert.ok(error instanceof AuditUnavailableError);
        assert.equal(error.mutationMayHaveOccurred, false);
        assert.equal(error.message, "Security audit logging is unavailable");
        return true;
      });
      let businessCalls = 0;
      await assert.rejects(auditedMutation(sink, { mode: "local" }, "prepared-failure", "ticket.create", undefined,
        async () => { businessCalls++; return {}; }), AuditUnavailableError);
      assert.equal(businessCalls, 0);
      t.mock.restoreAll();
    }
  } finally {
    t.mock.restoreAll();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("server startup exits generically before listening when audit preflight fails", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "gorelo-audit-startup-failure-"));
  const blockedDirectory = join(temporary, "private-path");
  await writeFile(blockedDirectory, "not a directory");
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(), timeout: 10000,
      env: { PATH: process.env.PATH, DEMO_MODE: "true", AUDIT_LOG_DIR: blockedDirectory },
    }), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout, /listening/);
      assert.match(result.stderr, /Security audit storage preflight failed; server not started/);
      assert.ok(!result.stderr.includes(blockedDirectory));
      assert.doesNotMatch(result.stderr, /EEXIST|ENOTDIR/);
      return true;
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
