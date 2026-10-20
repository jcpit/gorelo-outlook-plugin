import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDescription, createApp } from "./app.js";
import { GoreloRequestError, type GoreloConnector } from "./goreloConnector.js";
import { attachEmailSchema, createTicketSchema } from "./schemas.js";
import { loadConfig } from "./config.js";

const validTicket = {
  subject: "Printer issue",
  from: { name: "Example <script>alert(1)</script>", email: "sender@example.com" },
  to: [{ name: "Service Desk", email: "support@example.com" }],
  cc: [],
  receivedAt: "2026-09-29T10:00:00+10:00",
  internetMessageId: "<message@example.com>",
  internetHeaders: "Message-ID: <message@example.com>\r\nX-Origin: original",
  outlookItemId: "outlook-item-123",
  conversationId: "thread-123",
  bodyHtml: "<p>Hello <strong>team</strong></p><script>alert(1)</script>",
  bodyText: "Hello team",
  attachments: [],
  groupId: 928,
  statusId: 1,
  typeId: 423,
};

test("ticket payload parsing applies defaults and validates sender metadata", () => {
  const parsed = createTicketSchema.parse(validTicket);
  assert.deepEqual(parsed.cc, []);
  assert.deepEqual(parsed.attachments, []);
  assert.equal(parsed.from.email, "sender@example.com");
});

test("ticket payload rejects contact attribution without a client", () => {
  const result = createTicketSchema.safeParse({ ...validTicket, contactId: 7351 });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.some((issue) => issue.path[0] === "clientId"), true);
  }
});

test('ticket CC contacts must be selected original recipients under a client', () => {
  const base = { ...validTicket, clientId: 40, cc: [{ name: 'Service Desk', email: 'support@example.com' }], ccRecipients: [{ email: 'support@example.com', firstName: 'Service', lastName: 'Desk' }] };
  assert.equal(createTicketSchema.safeParse(base).success, true);
  assert.equal(createTicketSchema.safeParse({ ...base, clientId: undefined }).success, false);
  assert.equal(createTicketSchema.safeParse({ ...base, ccRecipients: [...base.ccRecipients, ...base.ccRecipients] }).success, false);
  assert.equal(createTicketSchema.safeParse({ ...base, ccRecipients: [{ email: 'someone-else@example.com', firstName: 'Other', lastName: 'Person' }] }).success, false);
  assert.equal(createTicketSchema.safeParse({ ...base, cc: [], ccRecipients: base.ccRecipients }).success, true);
  assert.equal(createTicketSchema.safeParse({ ...base, cc: [], to: [{ name: 'Service Desk', email: 'support@example.com' }] }).success, true);
  assert.equal(createTicketSchema.safeParse({ ...base, cc: [], to: [{ name: 'Other', email: 'other@example.com' }] }).success, false);
  assert.equal(createTicketSchema.safeParse({ ...base, createSenderContact: true, contactId: undefined, requesterFirstName: '', requesterLastName: '' }).success, false);
});

test("attaching email accepts message fields without ticket-creation choices and rejects oversized files", () => {
  const { groupId: _group, statusId: _status, typeId: _type, ...mail } = validTicket;
  assert.equal(attachEmailSchema.safeParse(mail).success, true);
  assert.equal(attachEmailSchema.safeParse({ ...mail, from: { name: '', email: 'invalid' } }).success, false);
  assert.equal(attachEmailSchema.safeParse({ ...mail, attachments: [{ name: 'big.bin', contentType: 'application/octet-stream', contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }] }).success, false);
});

test("attach email route validates ticket and payload before calling the connector", async () => {
  const calls: unknown[][] = [];
  const connector = { attachEmail: async (...args: unknown[]) => { calls.push(args); return {}; } } as unknown as GoreloConnector;
  const server = createApp(loadConfig({ GORELO_API_KEY: 'test-secret' }), connector).listen(0, '127.0.0.1');
  try {
    const port = await new Promise<number>((resolve) => server.listening ? resolve((server.address() as { port: number }).port) : server.once('listening', () => resolve((server.address() as { port: number }).port)));
    const base = `http://127.0.0.1:${port}/api/tickets`;
    const mail = attachEmailSchema.parse(validTicket);
    const post = (id: string, body: unknown) => fetch(`${base}/${id}/emails`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('invalid', mail)).status, 400);
    assert.equal((await post('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { subject: 'missing fields' })).status, 400);
    assert.equal((await post('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mail)).status, 201);
    assert.equal(calls.length, 1);
    assert.match(String(calls[0]![3]), /Outlook email: Printer issue/);
    assert.doesNotMatch(String(calls[0]![3]), /<script>/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("attachment retry routes validate their existing-ticket target and narrow payloads", async () => {
  const calls: string[] = [];
  const connector = {
    retryAttachments: async (_key: string, id: string, token: string) => { calls.push(`retry:${id}:${token}`); return {}; },
    recoverAttachments: async (_key: string, id: string) => { calls.push(`recover:${id}`); return {}; },
    attachmentRetryStatus: async () => ({ retryableAttachmentCount: 1 }),
    createTicket: async () => { throw new Error("Must not create a ticket"); },
  } as unknown as GoreloConnector;
  const server = createApp(loadConfig({ GORELO_API_KEY: 'test-secret' }), connector).listen(0, '127.0.0.1');
  try {
    const port = await new Promise<number>((resolve) => server.listening ? resolve((server.address() as { port: number }).port) : server.once('listening', () => resolve((server.address() as { port: number }).port)));
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const base = `http://127.0.0.1:${port}/api/tickets`;
    const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(`${id}/attachments/retry`, { token })).status, 200);
    assert.equal((await post(`bad-id/attachments/retry`, { token })).status, 400);
    assert.equal((await post(`${id}/attachments/retry`, { token, subject: 'Not allowed' })).status, 400);
    assert.equal((await post(`${id}/attachments/recover`, { attachments: [] })).status, 200);
    assert.equal((await post(`${id}/attachments/recover`, validTicket)).status, 400);
    assert.equal((await fetch(`${base}/${id}/attachments/retry/${token}`)).status, 200);
    assert.equal(calls.length, 2);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("description preserves email metadata and removes executable HTML", () => {
  const description = buildDescription(createTicketSchema.parse(validTicket));
  assert.match(description, /sender@example\.com/);
  assert.match(description, /support@example\.com/);
  assert.match(description, /2026-09-29T10:00:00\+10:00/);
  assert.match(description, /message@example\.com/);
  assert.doesNotMatch(description, /X-Origin: original|Original message headers/);
  assert.match(description, /outlook-item-123/);
  assert.match(description, /thread-123/);
  assert.match(description, /<strong>team<\/strong>/);
  assert.doesNotMatch(description, /<script/i);
  assert.match(description, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("local proxy defaults to Gorelo's HTTPS API and the local add-in origin", () => {
  const configured = loadConfig({});
  assert.equal(configured.port, 3001);
  assert.equal(configured.listenHost, "127.0.0.1");
  assert.equal(configured.corsOrigin, "https://localhost:5173");
  assert.equal(configured.goreloBaseUrl, "https://api.usw.gorelo.io");
  assert.throws(() => loadConfig({ GORELO_BASE_URL: "http://example.invalid" }), /HTTPS/);
  assert.throws(() => loadConfig({ HTTPS_CERT_FILE: "/tmp/example.pem" }), /configured together/);
  assert.throws(() => loadConfig({ REQUIRE_SERVER_KEY: "true" }), /GORELO_API_KEY is required/);
  assert.throws(() => loadConfig({ GORELO_API_KEY: "  " }), /Too small/);
  const serverConfig = loadConfig({ GORELO_API_KEY: " server-secret ", REQUIRE_SERVER_KEY: "true", LISTEN_HOST: "0.0.0.0" });
  assert.equal(serverConfig.goreloApiKey, "server-secret");
  assert.equal(serverConfig.listenHost, "0.0.0.0");
});

test("auth mode is public and configured server key cannot be overridden by clients", async () => {
  const forwarded: string[] = [];
  const connector = { getOptions: async (key: string) => {
    forwarded.push(key);
    return { groups: [], statuses: [], types: [], clients: [] };
  } } as unknown as GoreloConnector;
  const api = createApp(loadConfig({ GORELO_API_KEY: "server-only-secret" }), connector).listen(0, "127.0.0.1");
  try {
    const port = await new Promise<number>((resolve) => {
      if (api.listening) resolve((api.address() as { port: number }).port);
      else api.once("listening", () => resolve((api.address() as { port: number }).port));
    });
    const base = `http://127.0.0.1:${port}/api`;
    const mode = await fetch(`${base}/auth-mode`);
    assert.equal(mode.status, 200);
    assert.deepEqual(await mode.json(), { serverManaged: true });
    const unauthorizedOverride = await fetch(`${base}/options`, { headers: { "X-Gorelo-Key": "attacker-key" } });
    assert.equal(unauthorizedOverride.status, 400);
    assert.doesNotMatch(await unauthorizedOverride.text(), /server-only-secret|attacker-key/);
    assert.equal((await fetch(`${base}/options`)).status, 200);
    assert.deepEqual(forwarded, ["server-only-secret"]);
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("demo mode remains keyless and reports client-managed auth mode", async () => {
  const api = createApp(loadConfig({ DEMO_MODE: "true" })).listen(0, "127.0.0.1");
  try {
    const port = await new Promise<number>((resolve) => {
      if (api.listening) resolve((api.address() as { port: number }).port);
      else api.once("listening", () => resolve((api.address() as { port: number }).port));
    });
    const base = `http://127.0.0.1:${port}/api`;
    assert.deepEqual(await (await fetch(`${base}/auth-mode`)).json(), { serverManaged: false });
    assert.equal((await fetch(`${base}/options`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/users`)).json(), { users: [] });
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("container mode serves the built pane without exposing it through API fallback", async () => {
  const staticDir = await mkdtemp(join(tmpdir(), "gorelo-static-test-"));
  await writeFile(join(staticDir, "index.html"), "<main>Gorelo UI</main>");
  await writeFile(join(staticDir, "icon.png"), "image-bytes");
  const app = createApp(loadConfig({ STATIC_DIR: staticDir })).listen(0, "127.0.0.1");
  try {
    const port = await new Promise<number>((resolve) => {
      if (app.listening) resolve((app.address() as { port: number }).port);
      else app.once("listening", () => resolve((app.address() as { port: number }).port));
    });
    const base = `http://127.0.0.1:${port}`;
    assert.match(await (await fetch(base)).text(), /Gorelo UI/);
    assert.equal(await (await fetch(`${base}/icon.png`)).text(), "image-bytes");
    assert.match(await (await fetch(`${base}/tickets`)).text(), /Gorelo UI/);
    const missingApi = await fetch(`${base}/api/not-a-route`, { headers: { "X-Gorelo-Key": "test-key" } });
    assert.equal(missingApi.status, 404);
    assert.doesNotMatch(await missingApi.text(), /Gorelo UI/);
  } finally {
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    await rm(staticDir, { recursive: true, force: true });
  }
});

test("an empty email body still creates an inspectable ticket description", () => {
  const parsed = createTicketSchema.parse({ ...validTicket, bodyHtml: "", bodyText: "" });
  assert.match(buildDescription(parsed), /Empty message/);
});

test("local API requires a key and rejects foreign browser origins", async () => {
  let forwardedKey = "";
  const connector = { getOptions: async (key: string) => {
    forwardedKey = key;
    return { groups: [], statuses: [], types: [], clients: [] };
  } } as unknown as GoreloConnector;
  const api = createApp(loadConfig({}), connector).listen(0, "127.0.0.1");
  try {
    const port = await new Promise<number>((resolve) => {
      if (api.listening) resolve((api.address() as { port: number }).port);
      else api.once("listening", () => resolve((api.address() as { port: number }).port));
    });
    const url = `http://127.0.0.1:${port}/api/options`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Origin: "https://another.example", "X-Gorelo-Key": "secret-test-value" } })).status, 403);
    const valid = await fetch(url, { headers: { Origin: "https://localhost:5173", "X-Gorelo-Key": "secret-test-value" } });
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get("cache-control"), "no-store");
    assert.equal(forwardedKey, "secret-test-value");
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("Jev classification stays optional, server-only, and input-limited", async () => {
  const connector = { getOptions: async () => ({
    groups: [{ id: 928, name: "IT Support" }], types: [{ id: 423, name: "Incident" }], statuses: [], clients: [],
  }) } as unknown as GoreloConnector;
  const api = createApp(loadConfig({ GORELO_API_KEY: "gorelo-test" }), connector).listen(0, "127.0.0.1");
  try {
    const port = await new Promise<number>((resolve) => {
      if (api.listening) resolve((api.address() as { port: number }).port);
      else api.once("listening", () => resolve((api.address() as { port: number }).port));
    });
    const url = `http://127.0.0.1:${port}/api/classify`;
    const headers = { "Content-Type": "application/json" };
    const absent = await fetch(url, { method: "POST", headers, body: JSON.stringify({ subject: "Printer", bodyText: "Offline" }) });
    assert.deepEqual(await absent.json(), { available: false });
    const invalid = await fetch(url, { method: "POST", headers, body: JSON.stringify({ subject: "Printer", bodyText: "Offline", secret: "not allowed" }) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("read routes validate parameters and forward the selected browse filters", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const connector = {
    getTickets: async (...args: unknown[]) => { calls.push({ method: "getTickets", args }); return { items: [], nextCursor: "next" }; },
    getTicket: async (...args: unknown[]) => { calls.push({ method: "getTicket", args }); return { id: args[1] }; },
    getTicketComments: async (...args: unknown[]) => { calls.push({ method: "getTicketComments", args }); return { items: [] }; },
    getAssets: async (...args: unknown[]) => { calls.push({ method: "getAssets", args }); return { items: [] }; },
    getAsset: async (...args: unknown[]) => { calls.push({ method: "getAsset", args }); return { id: args[2] }; },
    getContacts: async (...args: unknown[]) => { calls.push({ method: "getContacts", args }); return { contacts: [] }; },
    getUsers: async (...args: unknown[]) => { calls.push({ method: "getUsers", args }); return []; },
    matchContacts: async (...args: unknown[]) => { calls.push({ method: "matchContacts", args }); return { contacts: [] }; },
  } as unknown as GoreloConnector;
  const api = createApp(loadConfig({}), connector).listen(0, "127.0.0.1");
  try {
    const port = await new Promise<number>((resolve) => {
      if (api.listening) resolve((api.address() as { port: number }).port);
      else api.once("listening", () => resolve((api.address() as { port: number }).port));
    });
    const base = `http://127.0.0.1:${port}/api`;
    const headers = { "X-Gorelo-Key": "local-test-key" };
    const check = async (path: string) => fetch(`${base}${path}`, { headers });
    assert.equal((await check("/tickets?query=printer&clientId=40&contactId=12&cursor=page-1")).status, 200);
    assert.equal((await check("/tickets?contactId=invalid")).status, 400);
    assert.equal((await check("/tickets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).status, 200);
    assert.equal((await check("/tickets/aaaaaaaa-aaaa-9aaa-faaa-aaaaaaaaaaaa")).status, 200);
    assert.equal((await check("/tickets/not-a-uuid")).status, 400);
    assert.equal((await check("/tickets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/comments?cursor=comment-page")).status, 200);
    assert.equal((await check("/assets?kind=custom&clientId=40&query=firewall")).status, 200);
    assert.equal((await check("/assets?kind=agent&userEmail=ada%40example.com")).status, 400);
    assert.equal((await check("/assets?kind=custom&clientId=40&userEmail=ada%40example.com")).status, 400);
    assert.equal((await check("/assets/agent/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).status, 200);
    assert.equal((await check("/assets/agent/bbbbbbbb-bbbb-9bbb-fbbb-bbbbbbbbbbbb")).status, 200);
    assert.equal((await check("/assets/invalid/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).status, 400);
    assert.equal((await check("/matches?email=ada%40example.com")).status, 200);
    assert.equal((await check("/matches?email=invalid")).status, 400);
    assert.equal((await check("/contacts?clientId=40")).status, 200);
    assert.equal((await check("/users")).status, 200);
    assert.equal((await check("/contacts?clientId=invalid")).status, 400);
    assert.deepEqual(calls.map(({ method }) => method), [
      "getTickets", "getTicket", "getTicket", "getTicketComments", "getAssets", "getAsset", "getAsset", "matchContacts", "getContacts", "getUsers",
    ]);
    assert.deepEqual(calls[0]!.args, ["local-test-key", { query: "printer", clientId: 40, contactId: 12, cursor: "page-1" }]);
    assert.deepEqual(calls[3]!.args, ["local-test-key", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "comment-page"]);
    assert.deepEqual(calls[4]!.args, ["local-test-key", { kind: "custom", clientId: 40, query: "firewall" }]);
    assert.deepEqual(calls[5]!.args, ["local-test-key", "agent", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]);
    assert.deepEqual(calls[7]!.args, ["local-test-key", "ada@example.com"]);
    assert.deepEqual(calls[8]!.args, ["local-test-key", 40]);
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("rate-limited sender matching returns a useful retry message", async () => {
  const connector = { matchContacts: async () => { throw new GoreloRequestError("Gorelo request failed (HTTP 429)", false, 429); } } as unknown as GoreloConnector;
  const api = createApp(loadConfig({}), connector).listen(0, "127.0.0.1");
  try {
    const port = await new Promise<number>((resolve) => {
      if (api.listening) resolve((api.address() as { port: number }).port);
      else api.once("listening", () => resolve((api.address() as { port: number }).port));
    });
    const result = await fetch(`http://127.0.0.1:${port}/api/matches?email=ada%40example.com`, { headers: { "X-Gorelo-Key": "test-key" } });
    assert.equal(result.status, 429);
    assert.match((await result.json()).error, /rate-limiting.*retry/i);
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("ticket input accepts linked asset UUIDs and rejects malformed IDs", () => {
  const linked = createTicketSchema.parse({
    ...validTicket,
    agentAssetIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    customAssetIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  });
  assert.equal(linked.agentAssetIds.length, 1);
  assert.equal(linked.customAssetIds.length, 1);
  assert.equal(createTicketSchema.safeParse({ ...validTicket, agentAssetIds: ["aaaaaaaa-aaaa-9aaa-faaa-aaaaaaaaaaaa"] }).success, true);
  assert.equal(createTicketSchema.safeParse({ ...validTicket, agentAssetIds: ["not-a-uuid"] }).success, false);
});
