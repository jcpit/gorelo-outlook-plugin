import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentRetryStore } from "./attachment-retry.js";
import { GoreloRequestError } from "./goreloConnector.js";

const id = "c79f7dbd-7060-490e-a377-4674b41906f6";
const first = { name: "same.png", contentType: "image/png", contentBase64: "b25l" };
const second = { ...first, contentBase64: "dHdv" };
const reference = { Name: "same.png", Url: "https://files.example.test/image" };

test("retry sends only rejected attachments; equal filenames don't merge different contents", async () => {
  const store = new AttachmentRetryStore();
  const uploads: string[] = []; let comments = 0; let reject = true;
  const request = async (path: string, init?: RequestInit) => {
    if (path === "/v1/attachments") {
      const text = await ((init!.body as FormData).get("file") as Blob).text(); uploads.push(text);
      if (text === "two" && reject) throw new GoreloRequestError("Rate limited", false, 429);
      return { Data: reference };
    }
    if (path.endsWith("/comments")) comments++;
    return {};
  };
  const result = await store.start(id, "key", [first, second, first], request);
  assert.equal(result.retryableAttachmentCount, 1);
  assert.equal(result.uncertainAttachmentCount, 0);
  assert.deepEqual(uploads, ["one", "two"]);
  reject = false;
  assert.deepEqual(await store.resume(id, result.attachmentRetryToken!, "key", request), {});
  assert.deepEqual(uploads, ["one", "two", "two"]);
  assert.equal(comments, 2);
  assert.deepEqual(await store.resume(id, result.attachmentRetryToken!, "key", request), {});
  assert.equal(uploads.length, 3);
});

test("unconfirmed uploads are never automatically replayed", async () => {
  const store = new AttachmentRetryStore(); let writes = 0;
  const request = async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; throw new GoreloRequestError("Connection lost", true); }
    return {};
  };
  const result = await store.start(id, "key", [first], request);
  assert.equal(result.retryableAttachmentCount, 0);
  assert.equal(result.uncertainAttachmentCount, 1);
  await store.resume(id, result.attachmentRetryToken!, "key", request);
  assert.equal(writes, 1);
});

test("rejected attachment comments reuse uploads and coalesce concurrent retries", async () => {
  const store = new AttachmentRetryStore(); let uploads = 0; let comments = 0; let reject = true;
  const request = async (path: string) => {
    if (path === "/v1/attachments") { uploads++; return { Data: reference }; }
    if (path.endsWith("/comments")) { comments++; if (reject) throw new GoreloRequestError("Rate limited", false, 429); }
    return {};
  };
  const result = await store.start(id, "key", [first], request);
  assert.equal(result.retryableAttachmentCount, 1);
  reject = false;
  await Promise.all([store.resume(id, result.attachmentRetryToken!, "key", request), store.resume(id, result.attachmentRetryToken!, "key", request)]);
  assert.equal(uploads, 1);
  assert.equal(comments, 2);
});

test("unconfirmed linking never creates duplicate attachment comments", async () => {
  const store = new AttachmentRetryStore(); let comments = 0;
  const request = async (path: string) => {
    if (path === "/v1/attachments") return { Data: reference };
    if (path.endsWith("/comments")) { comments++; throw new GoreloRequestError("Response lost", true); }
    return {};
  };
  const result = await store.start(id, "key", [first], request);
  assert.equal(result.uncertainAttachmentCount, 1);
  assert.equal(result.retryableAttachmentCount, 0);
  await store.resume(id, result.attachmentRetryToken!, "key", request);
  assert.equal(comments, 1);
});

test("retry receipts survive restarts, are key-scoped, and discard successful file bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outlook-retry-test-"));
  try {
    const store = new AttachmentRetryStore(directory);
    const result = await store.start(id, "key", [first], async () => { throw new GoreloRequestError("Rate limited", false, 429); });
    const path = join(directory, `${result.attachmentRetryToken}.json`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const restarted = new AttachmentRetryStore(directory);
    await assert.rejects(restarted.status(id, result.attachmentRetryToken!, "other-key"), /not found/);
    assert.equal((await restarted.status(id, result.attachmentRetryToken!, "key")).retryableAttachmentCount, 1);
    await restarted.resume(id, result.attachmentRetryToken!, "key", async (path) => path === "/v1/attachments" ? { Data: reference } : {});
    const record = JSON.parse(await readFile(path, "utf8"));
    assert.equal(record.files[0].contentBase64, undefined);
    assert.equal(record.files[0].state, "linked");
    assert.equal(record.key, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("memory capacity excludes completed receipts without losing duplicate protection", async () => {
  const store = new AttachmentRetryStore(undefined, () => Date.UTC(2026, 0, 1));
  let uploads = 0; let comments = 0;
  const request = async (path: string) => {
    if (path === "/v1/attachments") { uploads++; return { Data: reference }; }
    if (path.endsWith("/comments")) comments++;
    return {};
  };
  for (let index = 0; index < 60; index++) assert.deepEqual(await store.start(`${id}-${index}`, "key", [first], request), {});
  assert.equal(uploads, 60);
  assert.equal(comments, 60);
  assert.deepEqual(await store.start(`${id}-0`, "key", [first], request), {});
  const token = await store.existing(`${id}-0`, "key", [first]);
  assert.ok(token);
  await assert.rejects(store.resume("other-ticket", token, "key", request), /not found/);
  await assert.rejects(store.resume(`${id}-0`, token, "other-key", request), /not found/);
  assert.equal(uploads, 60);
  assert.equal(comments, 60);
});

test("memory bounds payload jobs and reclaims expired capacity without replay", async () => {
  let now = Date.UTC(2026, 0, 1);
  const store = new AttachmentRetryStore(undefined, () => now);
  let writes = 0;
  const request = async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; throw new GoreloRequestError("Rate limited", false, 429); }
    return {};
  };
  let token = "";
  for (let index = 0; index < 50; index++) {
    const result = await store.start(`${id}-${index}`, "key", [first], request);
    if (index === 0) token = result.attachmentRetryToken!;
  }
  await assert.rejects(store.start(`${id}-50`, "key", [first], request), /storage is full/);
  assert.equal(writes, 50, "capacity rejection must happen before a remote write");
  now += 8 * 24 * 60 * 60_000;
  await store.start(`${id}-50`, "key", [first], request);
  assert.equal(writes, 51);
  assert.equal((await store.resume(`${id}-0`, token, "key", request)).uncertainAttachmentCount, 1);
  await store.start(`${id}-0`, "key", [first], request);
  assert.equal(writes, 51, "expired receipt must still prevent replay");
});

for (const backend of ["memory", "disk"] as const) {
  test(`${backend} expires failed bytes after eight days but preserves uncertain and confirmed receipts`, async () => {
    const directory = backend === "disk" ? await mkdtemp(join(tmpdir(), "outlook-retry-expiry-")) : undefined;
    let now = Date.UTC(2026, 0, 1);
    try {
      let store = new AttachmentRetryStore(directory, () => now);
      let uploads = 0; let comments = 0;
      const request = async (path: string) => {
        if (path === "/v1/attachments") {
          uploads++;
          if (uploads === 1) throw new GoreloRequestError("Rate limited", false, 429);
          if (uploads === 2) throw new GoreloRequestError("Response lost", true);
          return { Data: reference };
        }
        if (path.endsWith("/comments")) comments++;
        return {};
      };
      const pending = await store.start(id, "key", [first], request);
      const uncertain = await store.start(`${id}-uncertain`, "key", [first], request);
      await store.start(`${id}-completed`, "key", [first], request);
      now += 8 * 24 * 60 * 60_000;
      if (directory) store = new AttachmentRetryStore(directory, () => now);
      assert.equal((await store.status(id, pending.attachmentRetryToken!, "key")).uncertainAttachmentCount, 1);
      assert.equal((await store.resume(`${id}-uncertain`, uncertain.attachmentRetryToken!, "key", request)).uncertainAttachmentCount, 1);
      for (const ticket of [id, `${id}-uncertain`, `${id}-completed`]) await store.start(ticket, "key", [first], request);
      assert.equal(uploads, 3);
      assert.equal(comments, 1);
      // Inspect only the test store's records to verify sensitive payload deletion.
      const records = directory
        ? await Promise.all([pending.attachmentRetryToken!, uncertain.attachmentRetryToken!].map(async (token) => JSON.parse(await readFile(join(directory, `${token}.json`), "utf8"))))
        : [...(store as unknown as { memory: Map<string, { files: { contentBase64?: string }[] }> }).memory.values()];
      for (const record of records) for (const file of record.files) assert.equal(file.contentBase64, undefined);
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  });
}

test("failed receipt persistence prevents any remote write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outlook-retry-save-"));
  try {
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "test fixture");
    const store = new AttachmentRetryStore(join(blocked, "records"));
    let calls = 0;
    await assert.rejects(store.start(id, "key", [first], async () => { calls++; return { Data: reference }; }));
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("upload and comment writes require their uncertain receipt to persist first", async () => {
  for (const failAt of [2, 4]) {
    const store = new AttachmentRetryStore();
    const persistence = store as unknown as { save: (job: unknown) => Promise<void> };
    const save = persistence.save.bind(store);
    let saves = 0; let uploads = 0; let comments = 0;
    persistence.save = async (job) => {
      if (++saves === failAt) throw new Error("Simulated persistence failure");
      await save(job);
    };
    await assert.rejects(store.start(id, "key", [first], async (path) => {
      if (path === "/v1/attachments") { uploads++; return { Data: reference }; }
      if (path.endsWith("/comments")) comments++;
      return {};
    }), /Simulated persistence failure/);
    assert.equal(uploads, failAt === 2 ? 0 : 1);
    assert.equal(comments, 0);
  }
});

test("disk receipts sync the file then directory before upload and linking", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "outlook-retry-sync-"));
  const handle = await open(directory, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const sync = prototype.sync;
  await handle.close();
  const events: string[] = [];
  const mock = context.mock.method(prototype, "sync", async function (this: FileHandle) {
    events.push((await this.stat()).isDirectory() ? "directory" : "file");
    await sync.call(this);
  });
  try {
    const store = new AttachmentRetryStore(directory);
    assert.deepEqual(await store.start(id, "key", [first], async (path) => {
      if (path === "/v1/attachments") { events.push("upload"); return { Data: reference }; }
      if (path.endsWith("/comments")) events.push("comment");
      return {};
    }), {});
    assert.deepEqual(events, ["file", "directory", "file", "directory", "upload", "file", "directory", "file", "directory", "comment", "file", "directory"]);
  } finally {
    mock.mock.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("file or directory sync failure prevents the corresponding remote write", async (context) => {
  for (const failAt of [3, 4, 7, 8]) {
    const directory = await mkdtemp(join(tmpdir(), "outlook-retry-sync-failure-"));
    const handle = await open(directory, "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    const sync = prototype.sync;
    await handle.close();
    let syncs = 0; let uploads = 0; let comments = 0;
    const mock = context.mock.method(prototype, "sync", async function (this: FileHandle) {
      if (++syncs === failAt) throw new Error("Simulated fsync failure");
      await sync.call(this);
    });
    try {
      const store = new AttachmentRetryStore(directory);
      await assert.rejects(store.start(id, "key", [first], async (path) => {
        if (path === "/v1/attachments") { uploads++; return { Data: reference }; }
        if (path.endsWith("/comments")) comments++;
        return {};
      }), /Simulated fsync failure/);
      assert.equal(uploads, failAt <= 4 ? 0 : 1);
      assert.equal(comments, 0);
    } finally {
      mock.mock.restore();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
