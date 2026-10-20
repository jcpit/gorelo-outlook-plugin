import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "./config.js";
import { GoreloConnector, TicketCreateIndeterminateError } from "./goreloConnector.js";
import { attachEmailSchema, createTicketSchema } from "./schemas.js";

const config = { goreloBaseUrl: "https://api.example.test" } as AppConfig;
const ticket = createTicketSchema.parse({
  subject: "Printer issue",
  from: { name: "Sender", email: "sender@example.com" },
  to: [], cc: [], receivedAt: "2026-09-29T00:00:00Z", attachments: [],
  groupId: 10, statusId: 20, typeId: 30, clientId: 40, contactId: 50,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test('read caching coalesces server-key requests, isolates local keys, and invalidates after writes', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let reads = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes('/v1/assets/agents/')) { reads++; return jsonResponse({ IsSuccess: true, Data: { Id: 'asset-id', DisplayName: 'PC' } }); }
    return jsonResponse({ IsSuccess: true, Data: { Id: 'ticket-id' } });
  };
  const connector = new GoreloConnector({ ...config, goreloApiKey: 'server-key' }, async () => {});
  await Promise.all([connector.getAsset('server-key', 'agent', 'asset-id'), connector.getAsset('server-key', 'agent', 'asset-id')]);
  assert.equal(reads, 1);
  await connector.getAsset('other-key', 'agent', 'asset-id');
  await connector.getAsset('other-key', 'agent', 'asset-id');
  assert.equal(reads, 3);
  await connector.createTicket('server-key', ticket, '<p>Email</p>');
  await connector.getAsset('server-key', 'agent', 'asset-id');
  assert.equal(reads, 4);
});

test('429 backoff respects Retry-After for reads and uploads but never repeats ticket creation', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let reads = 0; let creates = 0; let uploads = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/v1/assets/agents/')) {
      if (++reads === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '0' } });
      return jsonResponse({ IsSuccess: true, Data: { Id: 'asset-id', DisplayName: 'PC' } });
    }
    if (url.endsWith('/v1/tickets')) { creates++; return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '0' } }); }
    throw new Error('Unexpected URL');
  };
  const connector = new GoreloConnector(config, async () => {});
  await connector.getAsset('key', 'agent', 'asset-id');
  assert.equal(reads, 2);
  await assert.rejects(connector.createTicket('key', ticket, '<p>Email</p>'), /429/);
  assert.equal(creates, 1);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/tickets')) return jsonResponse({ IsSuccess: true, Data: { Id: 'ticket-id' } });
    if (url.endsWith('/v1/attachments')) {
      if (++uploads === 1) return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '0' } });
      return jsonResponse({ IsSuccess: true, Data: { Name: 'mail.txt', Url: 'https://files.example.test/a' } });
    }
    return jsonResponse({ IsSuccess: true, Data: {} });
  };
  assert.deepEqual(await connector.createTicket('key', createTicketSchema.parse({ ...ticket, attachments: [{ name: 'mail.txt', contentType: 'text/plain', contentBase64: 'b25l' }] }), '<p>Email</p>'), { ticketId: 'ticket-id' });
  assert.equal(uploads, 2);
});

test('legacy recovery verifies file contents, avoids existing uploads, and never creates a ticket', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let uploads = 0; let comments = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('gorelofilesaue.blob.core.windows.net')) {
      assert.equal(new Headers(init?.headers).get('X-API-Key'), null);
      assert.equal(init?.redirect, 'error');
      return new Response('one');
    }
    if (url.includes('/comments?')) return jsonResponse({ IsSuccess: true, Data: [{ Attachments: [{ Name: 'same.png', Url: 'https://gorelofilesaue.blob.core.windows.net/test/one' }] }] });
    if (url.endsWith('/v1/attachments')) {
      uploads++; assert.equal(await ((init!.body as FormData).get('file') as Blob).text(), 'two');
      return jsonResponse({ IsSuccess: true, Data: { Name: 'same.png', Url: 'https://gorelofilesaue.blob.core.windows.net/test/two' } });
    }
    if (url.endsWith('/comments')) { comments++; return jsonResponse({ IsSuccess: true, Data: {} }); }
    if (url.endsWith('/v1/tickets')) throw new Error('Must not create a new ticket');
    return jsonResponse({ IsSuccess: true, Data: { Id: 'existing-id' } });
  };
  const connector = new GoreloConnector(config, async () => {});
  const attachments = [{ name: 'same.png', contentType: 'image/png', contentBase64: 'b25l' },
    { name: 'same.png', contentType: 'image/png', contentBase64: 'dHdv' }];
  assert.deepEqual(await connector.recoverAttachments('key', 'existing-id', attachments), {});
  assert.deepEqual(await connector.recoverAttachments('key', 'existing-id', attachments), {});
  assert.equal(uploads, 1); assert.equal(comments, 1);
});

test('attachEmail checks the ticket, uploads files and creates one non-threaded comment', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/tickets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) return jsonResponse({ IsSuccess: true, Data: { Id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    if (url.endsWith('/v1/attachments')) return jsonResponse({ IsSuccess: true, Data: { Name: 'email.txt', Url: 'https://files.example.test/email.txt' } });
    if (url.endsWith('/comments')) return jsonResponse({ IsSuccess: true, Data: { Id: 'comment-id' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const mail = attachEmailSchema.parse({ subject: 'Follow-up', from: { email: 'sender@example.com' }, to: [], receivedAt: '2026-09-29T00:00:00Z', attachments: [{ name: 'email.txt', contentType: 'text/plain', contentBase64: 'aGVsbG8=' }] });
  assert.deepEqual(await new GoreloConnector(config).attachEmail('key', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mail, '<p>Follow-up</p>'), {});
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.init?.method || 'GET', 'GET');
  const form = calls[1]?.init?.body as FormData;
  assert.equal(form.get('itemId'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(form.get('itemType'), 'Ticket');
  const body = JSON.parse(String(calls[2]?.init?.body));
  assert.deepEqual(body, { Body: '<p>Follow-up</p>', ConversationTypeId: 2, Attachments: [{ Name: 'email.txt', Url: 'https://files.example.test/email.txt' }] });
});

test('attachEmail does not claim a comment succeeded when the write is unconfirmed', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/comments')) throw new Error('connection dropped');
    return jsonResponse({ IsSuccess: true, Data: { Id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
  };
  const mail = attachEmailSchema.parse({ subject: 'Follow-up', from: { email: 'sender@example.com' }, to: [], receivedAt: '2026-09-29T00:00:00Z' });
  await assert.rejects(new GoreloConnector(config).attachEmail('key', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mail, '<p>Follow-up</p>'), TicketCreateIndeterminateError);
});

test("getOptions uses the API key and follows client/contact cursors", async (context) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("organization/groups")) return jsonResponse({ IsSuccess: true, Data: [{ Id: 1, Name: "Support" }] });
    if (url.includes("tickets/statuses")) return jsonResponse({ IsSuccess: true, Data: [{ Id: 2, Name: "New", Color: "#ffffff" }, { Id: 3, Name: "Invalid", Color: "expression(alert(1))" }] });
    if (url.includes("tickets/types")) return jsonResponse({ IsSuccess: true, Data: [{ Id: 3, Name: "Incident" }] });
    if (url.includes("/clients") && url.includes("Cursor=next")) return jsonResponse({ IsSuccess: true, Data: [{ Id: 5, Name: "Beta" }], DataContext: { Pagination: { NextCursor: null } } });
    if (url.includes("/clients")) return jsonResponse({ IsSuccess: true, Data: [{ Id: 4, Name: "Alpha" }], DataContext: { Pagination: { NextCursor: "next" } } });
    if (url.includes("/contacts")) return jsonResponse({ IsSuccess: true, Data: [{ Id: 6, FirstName: "Ada", LastName: "Lovelace" }], DataContext: { Pagination: { NextCursor: null } } });
    throw new Error(`Unexpected URL ${url}`);
  };

  const connector = new GoreloConnector(config);
  const result = await connector.getOptions("test-key", 40);

  assert.deepEqual(result.clients, [{ id: 4, name: "Alpha" }, { id: 5, name: "Beta" }]);
  assert.deepEqual(result.statuses, [{ id: 2, name: "New", color: "#ffffff" }, { id: 3, name: "Invalid" }]);
  assert.deepEqual(result.contacts, [{ id: 6, name: "Ada Lovelace" }]);
  assert.deepEqual(await connector.getContacts("test-key", 40), { contacts: [{ id: 6, name: "Ada Lovelace" }] });
  assert.equal(calls.some(({ url }) => url.includes("ClientIds=40")), true);
  assert.equal(calls.every(({ init }) => new Headers(init?.headers).get("X-API-Key") === "test-key"), true);
  assert.equal(calls.every(({ init }) => init?.redirect === "error"), true);
});

test("createTicket sends documented JSON, multipart upload, and attachment comment", async (context) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/tickets")) return jsonResponse({ IsSuccess: true, Data: { Id: "ticket-uuid" } });
    if (url.endsWith("/v1/attachments")) return jsonResponse({ IsSuccess: true, Data: { Name: "mail.txt", Url: "https://files.example.test/a?x=1&y=2" } });
    if (url.endsWith("/comments")) return jsonResponse({ IsSuccess: true, Data: { Id: "comment-uuid" } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const withAttachment = {
    ...ticket,
    attachments: [{ name: "mail.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" }],
  };

  const result = await new GoreloConnector(config).createTicket("secret-key", withAttachment, "<p>Email</p>");

  assert.deepEqual(result, { ticketId: "ticket-uuid" });
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    Title: "Printer issue", Description: "<p>Email</p>", GroupId: 10, StatusId: 20,
    TypeId: 30, ClientId: 40, ContactId: 50, CcContactIds: [], LeadAssigneeId: null, AgentAssetIds: [], CustomAssetIds: [],
    SendTicketCreatedEmail: false,
  });
  const uploadForm = calls[1].init?.body;
  assert.equal(uploadForm instanceof FormData, true);
  assert.equal((uploadForm as FormData).get("itemType"), "Ticket");
  assert.equal((uploadForm as FormData).get("itemId"), "ticket-uuid");
  const commentBody = JSON.parse(String(calls[2].init?.body));
  assert.equal(commentBody.ConversationTypeId, 2);
  assert.deepEqual(commentBody.Attachments, [{ Name: "mail.txt", Url: "https://files.example.test/a?x=1&y=2" }]);
  assert.match(commentBody.Body, /x=1&amp;y=2/);
});

test('organization users are paged and only an exact To recipient can be lead assignee', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.includes('/v1/organization/users?') && url.includes('Cursor=next')) return jsonResponse({ IsSuccess: true, Data: [{ Id: 72, FirstName: 'Mary', LastName: 'Smith', Email: 'mary@example.com' }] });
    if (url.includes('/v1/organization/users?')) return jsonResponse({ IsSuccess: true, Data: [{ Id: 71, FirstName: 'John', LastName: 'Jones', Email: 'John@EXAMPLE.com' }], DataContext: { Pagination: { NextCursor: 'next' } } });
    if (url.endsWith('/v1/tickets')) return jsonResponse({ IsSuccess: true, Data: { Id: 'ticket-id' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const connector = new GoreloConnector(config);
  assert.deepEqual(await connector.getUsers('key'), [
    { id: 71, name: 'John Jones', email: 'john@example.com' }, { id: 72, name: 'Mary Smith', email: 'mary@example.com' },
  ]);
  const input = createTicketSchema.parse({ ...ticket, to: [{ name: 'John', email: 'JOHN@example.com' }], leadAssigneeId: 71 });
  assert.deepEqual(await connector.createTicket('key', input, '<p>Email</p>'), { ticketId: 'ticket-id' });
  assert.equal(calls.filter((url) => url.includes('/v1/organization/users?')).length, 4);
  const invalid = createTicketSchema.parse({ ...ticket, to: [{ name: 'External', email: 'external@example.com' }], leadAssigneeId: 71 });
  await assert.rejects(connector.createTicket('key', invalid, '<p>Email</p>'), /does not match a To recipient/);
  assert.equal(calls.filter((url) => url.endsWith('/v1/tickets')).length, 1);
});

test('To technicians cannot become client CC contacts, while other To recipients can', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/v1/organization/users?')) return jsonResponse({ IsSuccess: true, Data: [{ Id: 71, Email: 'jake@desk.test' }] });
    if (url.includes('/v1/contacts?')) return jsonResponse({ IsSuccess: true, Data: [{ Id: 52, ClientId: 40, PrimaryEmail: 'katrina@client.test' }] });
    if (url.endsWith('/v1/tickets')) return jsonResponse({ IsSuccess: true, Data: { Id: 'ticket-id' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const connector = new GoreloConnector(config);
  const to = [{ name: 'Jake', email: 'jake@desk.test' }, { name: 'Katrina', email: 'katrina@client.test' }];
  const invalid = createTicketSchema.parse({ ...ticket, to, ccRecipients: [{ email: 'jake@desk.test', firstName: 'Jake', lastName: 'Tech' }] });
  await assert.rejects(connector.createTicket('key', invalid, '<p>Email</p>'), /cannot be added as a client CC contact/);
  assert.equal(calls.some(({ url }) => url.endsWith('/v1/tickets')), false);
  const valid = createTicketSchema.parse({ ...ticket, to, leadAssigneeId: 71,
    ccRecipients: [{ email: 'katrina@client.test', firstName: 'Katrina', lastName: 'Client' }] });
  assert.deepEqual(await connector.createTicket('key', valid, '<p>Email</p>'), { ticketId: 'ticket-id' });
  const body = JSON.parse(String(calls.find(({ url }) => url.endsWith('/v1/tickets'))?.init?.body));
  assert.deepEqual(body.CcContactIds, [52]);
  assert.equal(body.LeadAssigneeId, 71);
});

test('createTicket reuses exact company contacts and creates only missing CC contacts', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/v1/contacts?')) {
      if (url.includes('sender%40example.com')) return jsonResponse({ IsSuccess: true, Data: [{ Id: 51, ClientId: 40, PrimaryEmail: 'sender@example.com' }] });
      if (url.includes('existing%40example.com')) return jsonResponse({ IsSuccess: true, Data: [{ Id: 52, ClientId: 40, PrimaryEmail: 'existing@example.com' }, { Id: 99, ClientId: 41, PrimaryEmail: 'existing@example.com' }] });
      return jsonResponse({ IsSuccess: true, Data: [] });
    }
    if (url.endsWith('/v1/contacts')) return jsonResponse({ IsSuccess: true, Data: { Id: 53 } });
    if (url.endsWith('/v1/tickets')) return jsonResponse({ IsSuccess: true, Data: { Id: 'ticket-id' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const input = createTicketSchema.parse({ ...ticket, contactId: undefined, from: { name: 'Sender Example', email: 'sender@example.com' },
    to: [], cc: [{ name: 'Existing Person', email: 'existing@example.com' }, { name: 'New Person', email: 'new@example.com' }],
    createSenderContact: true, requesterFirstName: 'Sender', requesterLastName: 'Example',
    ccRecipients: [{ email: 'existing@example.com', firstName: 'Existing', lastName: 'Person' }, { email: 'new@example.com', firstName: 'New', lastName: 'Person' }],
  });
  assert.deepEqual(await new GoreloConnector(config).createTicket('key', input, '<p>Body</p>'), { ticketId: 'ticket-id' });
  const creates = calls.filter(({ url, init }) => url.endsWith('/v1/contacts') && init?.method === 'POST');
  assert.equal(creates.length, 1);
  assert.deepEqual(JSON.parse(String(creates[0]?.init?.body)), { ClientId: 40, FirstName: 'New', LastName: 'Person', PrimaryEmail: 'new@example.com' });
  const body = JSON.parse(String(calls.find(({ url }) => url.endsWith('/v1/tickets'))?.init?.body));
  assert.equal(body.ContactId, 51);
  assert.deepEqual(body.CcContactIds, [52, 53]);
  assert.equal(body.SendTicketCreatedEmail, false);
});

test('createTicket creates an unmatched requester before linking that contact to the ticket', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/v1/contacts?')) return jsonResponse({ IsSuccess: true, Data: [] });
    if (url.endsWith('/v1/contacts')) return jsonResponse({ IsSuccess: true, Data: { Id: 82 } });
    if (url.endsWith('/v1/tickets')) return jsonResponse({ IsSuccess: true, Data: { Id: 'ticket-id' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const input = createTicketSchema.parse({ ...ticket, contactId: undefined, createSenderContact: true,
    requesterFirstName: 'Sender', requesterLastName: 'Person' });
  await new GoreloConnector(config).createTicket('key', input, '<p>Body</p>');
  assert.deepEqual(JSON.parse(String(calls.find(({ url }) => url.endsWith('/v1/contacts'))?.init?.body)), {
    ClientId: 40, FirstName: 'Sender', LastName: 'Person', PrimaryEmail: 'sender@example.com',
  });
  assert.equal(JSON.parse(String(calls.find(({ url }) => url.endsWith('/v1/tickets'))?.init?.body)).ContactId, 82);
});

test("read methods parse tickets, comments, linked assets and contact matches", async (context) => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/tickets?") && url.includes("Query=printer")) {
      return jsonResponse({ IsSuccess: true, Data: [{
        Id: "ticket-1", DisplayNumber: "T-42", Title: "Printer", ClientId: 40,
        Status: { Id: 7, Name: "Open" }, UpdatedOn: "2026-09-28T10:00:00Z",
      }], DataContext: { Pagination: { NextCursor: "ticket-next" } } });
    }
    if (url.endsWith("/v1/clients/40")) return jsonResponse({ IsSuccess: true, Data: { Name: "Acme" } });
    if (url.endsWith("/v1/tickets/ticket-1")) return jsonResponse({ IsSuccess: true, Data: {
      Id: "ticket-1", DisplayNumber: "T-42", Title: "Printer", ClientId: 40, ContactId: 6,
      Description: "<p>Details &amp; notes</p><p>Second line</p><script>ignored()</script>", Status: { Id: 7, Name: "Open" }, Priority: { Name: "High" },
      AgentAssetIds: ["agent-uuid"], CustomAssetIds: ["custom-uuid"],
    } });
    if (url.endsWith("/v1/contacts/6")) return jsonResponse({ IsSuccess: true, Data: { FirstName: "Ada", LastName: "Lovelace" } });
    if (url.includes("/comments?")) return jsonResponse({ IsSuccess: true, Data: [{
      Id: "comment-1", BodyTruncated: true,
    }], DataContext: { Pagination: { NextCursor: "comment-next" } } });
    if (url.endsWith("/comments/comment-1")) return jsonResponse({ IsSuccess: true, Data: {
      Id: "comment-1", BodyHtml: "<p>Reply</p><script>bad()</script>", BodyText: "Reply",
      CreatedOn: "2026-09-28T11:00:00Z", ConversationType: { Id: 2 }, Author: { Name: "Agent" },
    } });
    if (url.includes("/v1/assets/agents?")) return jsonResponse({ IsSuccess: true, Data: [{
      Id: "agent-uuid", DisplayName: "Workstation", ClientId: 40, Status: { Name: "Online" },
      Os: "Windows", SerialNo: "ABC123", LastLoggedOnUser: "Ada Lovelace", LastLoggedOnUserUpn: "ada@example.com",
    }] });
    if (url.endsWith("/v1/assets/agents/agent-uuid")) return jsonResponse({ IsSuccess: true, Data: {
      Id: "agent-uuid", DisplayName: "Reception PC", ClientId: 40, Os: "Windows",
    } });
    if (url.includes("/v1/assets/custom?")) return jsonResponse({ IsSuccess: true, Data: [{
      Id: "custom-uuid", Name: "Office Firewall", ClientId: 40, HardwareType: "Network",
    }] });
    if (url.includes("/v1/contacts?") && url.includes("Query=ada%40example.com")) return jsonResponse({ IsSuccess: true, Data: [{
      Id: 6, FirstName: "Ada", LastName: "Lovelace", ClientId: 40, PrimaryEmail: "ada@example.com",
    }] });
    throw new Error(`Unexpected URL ${url}`);
  };

  const connector = new GoreloConnector(config);
  const tickets = await connector.getTickets("local-key", { query: "printer", clientId: 40, contactId: 6, cursor: "page-1" });
  assert.deepEqual(tickets, {
    items: [{ id: "ticket-1", displayNumber: "T-42", title: "Printer", statusName: "Open", statusId: 7, clientName: "Acme", updatedOn: "2026-09-28T10:00:00Z" }],
    nextCursor: "ticket-next",
  });
  assert.match(calls[0]!, /ClientIds=40/);
  assert.match(calls[0]!, /ContactIds=6/);
  assert.match(calls[0]!, /Cursor=page-1/);
  assert.deepEqual(await connector.getTicket("local-key", "ticket-1"), {
    id: "ticket-1", displayNumber: "T-42", title: "Printer", descriptionHtml: "<pre>Details &amp; notes\nSecond line</pre>",
    descriptionText: "Details & notes\nSecond line", clientId: 40, clientName: "Acme", contactName: "Ada Lovelace",
    statusName: "Open", statusId: 7, priorityName: "High", createdOn: "", updatedOn: "",
    agentAssetIds: ["agent-uuid"], customAssetIds: ["custom-uuid"],
    linkedAssets: [
      { id: "agent-uuid", name: "Reception PC", kind: "agent", clientId: 40, details: { os: "Windows" } },
      { id: "custom-uuid", name: "Office Firewall", kind: "custom", clientId: 40, details: { hardwareType: "Network" } },
    ],
  });
  assert.deepEqual(await connector.getTicketComments("local-key", "ticket-1", "comment-page"), {
    items: [{ id: "comment-1", bodyHtml: "<p>Reply</p>", bodyText: "Reply", createdOn: "2026-09-28T11:00:00Z", conversationTypeId: 2, createdByName: "Agent" }],
    nextCursor: "comment-next",
  });
  assert.deepEqual(await connector.getAssets("local-key", { kind: "agent", clientId: 40, query: "desk" }), {
    items: [{ id: "agent-uuid", name: "Workstation", kind: "agent", clientId: 40, details: { statusName: "Online", os: "Windows", serialNumber: "ABC123", lastLoggedOnUser: "Ada Lovelace", lastLoggedOnUserUpn: "ada@example.com" } }],
  });
  assert.deepEqual(await connector.getAssets("local-key", { kind: "agent", clientId: 40, userEmail: "ADA@example.com" }), {
    items: [{ id: "agent-uuid", name: "Workstation", kind: "agent", clientId: 40, details: { statusName: "Online", os: "Windows", serialNumber: "ABC123", lastLoggedOnUser: "Ada Lovelace", lastLoggedOnUserUpn: "ada@example.com" } }],
  });
  assert.deepEqual(await connector.getAsset("local-key", "agent", "agent-uuid"), {
    id: "agent-uuid", name: "Reception PC", kind: "agent", clientId: 40, details: { os: "Windows" },
  });
  assert.deepEqual(await connector.getAssets("local-key", { kind: "custom", clientId: 40 }), {
    items: [{ id: "custom-uuid", name: "Office Firewall", kind: "custom", clientId: 40, details: { hardwareType: "Network" } }],
  });
  assert.deepEqual(await connector.matchContacts("local-key", "ada@example.com"), {
    contacts: [{ id: 6, name: "Ada Lovelace", clientId: 40, email: "ada@example.com" }],
    suggestedClientId: 40, suggestedContactId: 6,
  });
});

test("sender domain suggests only one exact client when no contact matches", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/contacts?")) {
      if (url.includes("Query=known%40acme.test")) return jsonResponse({ IsSuccess: true, Data: [
        { Id: 12, PrimaryEmail: "known@acme.test", ClientId: 60 },
      ] });
      if (url.includes("Query=duplicate%40acme.test")) return jsonResponse({ IsSuccess: true, Data: [
        { Id: 12, PrimaryEmail: "duplicate@acme.test", ClientId: 60 },
        { Id: 13, PrimaryEmail: "duplicate@acme.test", ClientId: 61 },
      ] });
      return jsonResponse({ IsSuccess: true, Data: [] });
    }
    if (url.includes("/v1/clients?")) return jsonResponse({ IsSuccess: true, Data: [
      { Id: 40, Domains: [{ Name: "Acme.Test" }, { Name: "gmail.com" }] },
      { Id: 41, Domains: [{ Name: "shared.test" }] },
      { Id: 42, Domains: [{ Name: "shared.test" }] },
    ] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const connector = new GoreloConnector(config);
  assert.deepEqual(await connector.matchContacts("key", "NEW@ACME.TEST"), {
    contacts: [], suggestedClientId: 40, suggestedViaDomain: true,
  });
  assert.deepEqual(await connector.matchContacts("key", "new@notacme.test"), { contacts: [] });
  assert.deepEqual(await connector.matchContacts("key", "new@shared.test"), { contacts: [], ambiguousDomain: true });
  assert.deepEqual(await connector.matchContacts("key", "new@gmail.com"), { contacts: [] });
  assert.deepEqual(await connector.matchContacts("key", "known@acme.test"), {
    contacts: [{ id: 12, name: "known@acme.test", email: "known@acme.test", clientId: 60 }],
    suggestedClientId: 60, suggestedContactId: 12,
  });
  assert.deepEqual(await connector.matchContacts("key", "duplicate@acme.test"), {
    contacts: [
      { id: 12, name: "duplicate@acme.test", email: "duplicate@acme.test", clientId: 60 },
      { id: 13, name: "duplicate@acme.test", email: "duplicate@acme.test", clientId: 61 },
    ],
  });
  assert.equal(calls.filter((url) => url.includes("/v1/clients?")).length, 3);
});

test("devices used by a sender are found across all company pages", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("Cursor=next")) return jsonResponse({ IsSuccess: true, Data: [
      { Id: "device-b", DisplayName: "Ada laptop", ClientId: 40, LastLoggedOnUserUpn: "ADA@example.com" },
      { Id: "device-c", DisplayName: "Other laptop", ClientId: 40, LastLoggedOnUserUpn: "other@example.com" },
    ] });
    return jsonResponse({ IsSuccess: true, Data: [
      { Id: "device-a", DisplayName: "Ada desktop", ClientId: 40, LastLoggedOnUserUpn: "ada@example.com" },
    ], DataContext: { Pagination: { NextCursor: "next" } } });
  };
  const result = await new GoreloConnector(config).getAssets("local-key", {
    kind: "agent", clientId: 40, userEmail: "ada@example.com",
  });
  assert.deepEqual(result.items.map((item) => item.id), ["device-a", "device-b"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /ClientIds=40/);
  assert.match(calls[0]!, /PageSize=200/);
});

test("server-managed sender, device and option lookups reuse in-flight results", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/assets/agents?")) return jsonResponse({ IsSuccess: true, Data: [{
      Id: "device-1", DisplayName: "Laptop", ClientId: 40, LastLoggedOnUser: "AzureAD\\AlexTaylor",
    }] });
    if (url.includes("/v1/contacts?")) return jsonResponse({ IsSuccess: true, Data: [{
      Id: 9, FirstName: "Alex", LastName: "Taylor", PrimaryEmail: "alex.taylor@example.com", ClientId: 40,
    }] });
    if (url.includes("/v1/clients?")) return jsonResponse({ IsSuccess: true, Data: [{ Id: 40, Name: "Company" }] });
    if (url.includes("/v1/organization/groups")) return jsonResponse({ IsSuccess: true, Data: [] });
    if (url.includes("/v1/tickets/statuses")) return jsonResponse({ IsSuccess: true, Data: [] });
    if (url.includes("/v1/tickets/types")) return jsonResponse({ IsSuccess: true, Data: [] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const connector = new GoreloConnector({ ...config, goreloApiKey: "server-key" });
  const assetQuery = { kind: "agent" as const, clientId: 40, userEmail: "alex.taylor@example.com" };
  const [first, second] = await Promise.all([
    connector.getAssets("server-key", assetQuery), connector.getAssets("server-key", assetQuery),
  ]);
  assert.deepEqual(first.items.map((item) => item.id), ["device-1"]);
  assert.deepEqual(second, first);
  await connector.getAssets("server-key", assetQuery);
  await Promise.all([connector.matchContacts("server-key", assetQuery.userEmail), connector.matchContacts("server-key", assetQuery.userEmail)]);
  await connector.getOptions("server-key");
  await connector.getOptions("server-key");
  assert.equal(calls.filter((url) => url.includes("/v1/assets/agents?")).length, 1);
  assert.equal(calls.filter((url) => url.includes("/v1/contacts?")).length, 1);
  assert.equal(calls.filter((url) => url.includes("/v1/clients?")).length, 1);
});

test("ticket detail remains readable when a linked asset cannot be resolved", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/tickets/ticket-2")) return jsonResponse({ IsSuccess: true, Data: {
      Id: "ticket-2", Title: "Offline device", Description: "<p>Needs attention</p>",
      AgentAssetIds: ["missing-agent"], CustomAssetIds: [],
    } });
    if (url.endsWith("/v1/assets/agents/missing-agent")) return jsonResponse({ IsSuccess: false, Notifications: ["Not found"] }, 404);
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await new GoreloConnector(config).getTicket("local-key", "ticket-2");
  assert.equal(result.descriptionText, "Needs attention");
  assert.deepEqual(result.linkedAssets, [{ id: "missing-agent", name: "missing-agent", kind: "agent", details: {} }]);
});

test("surfaces Gorelo notifications without exposing the API key", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => jsonResponse({ IsSuccess: false, Notifications: [{ Message: "Unknown group" }] }, 400);
  await assert.rejects(
    new GoreloConnector(config).createTicket("do-not-leak", ticket, "description"),
    (error: Error) => error.message === "Unknown group" && !error.message.includes("do-not-leak"),
  );
});

test("marks a transport failure during create as indeterminate", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error("socket closed"); };
  await assert.rejects(
    new GoreloConnector(config).createTicket("do-not-leak", ticket, "description"),
    (error: Error) => error instanceof TicketCreateIndeterminateError &&
      error.message.includes("do not retry automatically") && !error.message.includes("do-not-leak"),
  );
});
