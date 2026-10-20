import type { AppConfig } from "./config.js";
import type { CreateTicketInput } from "./schemas.js";
import type { AttachEmailInput } from "./schemas.js";
import sanitizeHtml from "sanitize-html";
import { AttachmentRetryStore, AttachmentRetryError, attachmentHash, type AttachmentResult } from "./attachment-retry.js";
import { senderUsesDevice } from "../src/asset-sort.js";

export interface Option {
  id: number;
  name: string;
  color?: string;
}

export interface GoreloOptions {
  groups: Option[];
  statuses: Option[];
  types: Option[];
  clients: Option[];
  contacts?: Option[];
}

export interface GoreloUser { id: number; name: string; email: string }

type ContactMatches = {
  contacts: Array<{ id: number; name: string; clientId?: number; email: string }>;
  suggestedClientId?: number;
  suggestedContactId?: number;
  suggestedViaDomain?: boolean;
  ambiguousDomain?: boolean;
};

// Shared mailbox providers do not establish ownership of a particular client.
const sharedMailDomains = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "yahoo.com.au", "icloud.com", "me.com",
  "aol.com", "proton.me", "protonmail.com", "mail.com",
]);

interface GoreloEnvelope {
  IsSuccess?: boolean;
  Data?: unknown;
  DataContext?: unknown;
  Notifications?: unknown;
}

export interface TicketListItem {
  id: string;
  displayNumber: string;
  title: string;
  statusName: string;
  statusId?: number;
  clientName: string;
  updatedOn: string;
}

export interface TicketDetail {
  id: string;
  displayNumber: string;
  title: string;
  descriptionHtml: string;
  descriptionText: string;
  clientId?: number;
  clientName: string;
  contactName: string;
  statusName: string;
  statusId?: number;
  priorityName: string;
  createdOn: string;
  updatedOn: string;
  agentAssetIds: string[];
  customAssetIds: string[];
  linkedAssets: AssetItem[];
}

export interface AssetItem {
  id: string;
  name: string;
  kind: "agent" | "custom";
  clientId?: number;
  details: Record<string, string>;
}

export class GoreloRequestError extends Error {
  constructor(message: string, readonly indeterminate = false, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "GoreloRequestError";
  }
}

export class TicketCreateIndeterminateError extends Error {
  readonly retrySafe = false;

  constructor(message: string) {
    super(message);
    this.name = "TicketCreateIndeterminateError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function property(value: unknown, ...keys: string[]): unknown {
  const object = record(value);
  if (!object) return undefined;
  for (const key of keys) {
    if (object[key] !== undefined) return object[key];
  }
  return undefined;
}

function notificationMessage(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((notification) => {
      if (typeof notification === "string") return notification;
      const message = property(notification, "Message", "message");
      return typeof message === "string" ? message : undefined;
    })
    .filter((message): message is string => Boolean(message))
    .join("; ");
}

function toOptions(value: unknown): Option[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const rawId = property(item, "Id", "id");
      const id = typeof rawId === "number" ? rawId : Number(rawId);
      const explicitName = property(item, "Name", "name", "DisplayName", "displayName");
      const firstName = property(item, "FirstName", "firstName");
      const lastName = property(item, "LastName", "lastName");
      const contactName = [firstName, lastName]
        .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
        .join(" ");
      const email = property(item, "PrimaryEmail", "primaryEmail");
      const name = explicitName || contactName || email;
      return Number.isInteger(id) && id > 0 && typeof name === "string" && name.trim()
        ? { id, name: name.trim() }
        : undefined;
    })
    .filter((item): item is Option => Boolean(item));
}

function toStatusOptions(value: unknown): Option[] {
  const options = toOptions(value);
  if (!Array.isArray(value)) return options;
  return options.map((option) => {
    const source = value.find((item) => optionalPositiveInteger(item, "Id", "id") === option.id);
    const color = property(source, "Color", "color");
    return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)
      ? { ...option, color }
      : option;
  });
}

function nextCursor(envelope: GoreloEnvelope): string | undefined {
  const dataContext = property(envelope, "DataContext", "dataContext");
  const pagination = property(dataContext, "Pagination", "pagination");
  const cursor = property(pagination, "NextCursor", "nextCursor");
  return typeof cursor === "string" && cursor ? cursor : undefined;
}

function stringProperty(value: unknown, ...keys: string[]): string {
  const result = property(value, ...keys);
  return typeof result === "string" ? result : "";
}

function optionalPositiveInteger(value: unknown, ...keys: string[]): number | undefined {
  const raw = property(value, ...keys);
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function codeName(value: unknown, ...keys: string[]): string {
  return stringProperty(property(value, ...keys), "Name", "name");
}

function codeId(value: unknown, ...keys: string[]): number | undefined {
  return optionalPositiveInteger(property(value, ...keys), "Id", "id");
}

function uuidArray(value: unknown, ...keys: string[]): string[] {
  const raw = property(value, ...keys);
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}

function safeHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== "style"),
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
  });
}

function descriptionPlainText(value: string): string {
  const withBreaks = value
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n");
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], disallowedTagsMode: "discard" });
  return stripped
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
      if (code.toLowerCase() === "amp") return "&";
      if (code.toLowerCase() === "lt") return "<";
      if (code.toLowerCase() === "gt") return ">";
      if (code.toLowerCase() === "quot") return '"';
      if (code.toLowerCase() === "apos") return "'";
      if (code.toLowerCase() === "nbsp") return " ";
      const numeric = code[0]?.toLowerCase() === "#"
        ? Number.parseInt(code.slice(code[1]?.toLowerCase() === "x" ? 2 : 1), code[1]?.toLowerCase() === "x" ? 16 : 10)
        : NaN;
      return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
        ? String.fromCodePoint(numeric)
        : entity;
    })
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detailStrings(entries: Array<[string, unknown]>): Record<string, string> {
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && Boolean(entry[1].trim()),
    ),
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function requireApiKey(apiKey: string): string {
  if (typeof apiKey !== "string") throw new Error("A valid Gorelo API key is required");
  const key = apiKey.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error("A valid Gorelo API key is required");
  return key;
}

export class GoreloConnector {
  private readonly baseUrl: string;
  private readonly senderDeviceCache = new Map<string, { until: number; result: Promise<AssetItem[]> }>();
  private readonly contactMatchCache = new Map<string, { until: number; result: Promise<ContactMatches> }>();
  private clientDomainCache?: { until: number; result: Promise<Map<string, Set<number>>> };
  private optionsCache?: { until: number; result: Promise<GoreloOptions> };
  private usersCache?: { until: number; result: Promise<GoreloUser[]> };
  private readonly readCache = new Map<string, { until: number; result: Promise<GoreloEnvelope> }>();
  private readonly cooldowns = new Map<string, number>();
  private readonly uploadSlots = new Map<string, number>();
  private readonly attachmentRetries: AttachmentRetryStore;

  constructor(private readonly config: AppConfig, private readonly pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
    this.baseUrl = config.goreloBaseUrl.replace(/\/+$/, "");
    this.attachmentRetries = new AttachmentRetryStore(config.attachmentRetryDir);
  }

  private async request(apiKey: string, path: string, init: RequestInit = {}): Promise<GoreloEnvelope> {
    const key = requireApiKey(apiKey);
    const isRead = !init.method || init.method === "GET";
    const cached = isRead && key === this.config.goreloApiKey ? this.readCache.get(path) : undefined;
    if (cached && cached.until > Date.now()) return cached.result;
    const run = async () => {
      const deadline = Date.now() + 25_000;
      const safeToRepeat = isRead || path === "/v1/attachments" || (init.method === "POST" && path.endsWith("/comments"));
      for (let attempt = 0; ; attempt++) {
        const wait = (this.cooldowns.get(key) || 0) - Date.now();
        if (wait >= deadline - Date.now()) throw new GoreloRequestError("Gorelo is rate-limiting requests; wait before retrying", false, 429, Math.max(1, Math.ceil(wait / 1000)));
        if (wait > 0) await this.pause(wait);
        if (path === "/v1/attachments") {
          if (this.uploadSlots.size >= 100 && !this.uploadSlots.has(key)) this.uploadSlots.delete(this.uploadSlots.keys().next().value!);
          const slot = Math.max(Date.now(), this.uploadSlots.get(key) || 0);
          this.uploadSlots.set(key, slot + 500);
          if (slot >= deadline) throw new GoreloRequestError("Attachment uploads are queued; wait before retrying", false, 429, 1);
          if (slot > Date.now()) await this.pause(slot - Date.now());
        }
        try {
          const result = await this.requestOnce(key, path, init, Math.max(1, deadline - Date.now()));
          if (!isRead && path !== "/v1/attachments") this.readCache.clear();
          return result;
        } catch (error) {
          if (!(error instanceof GoreloRequestError) || error.status !== 429) throw error;
          const delay = (error.retryAfterSeconds ?? 2 ** (attempt + 1)) * 1000;
          console.warn("Gorelo rate limit", { method: init.method || "GET", resource: path.split("?")[0].split("/").slice(0, 3).join("/"), attempt: attempt + 1, waitSeconds: delay / 1000 });
          if (this.cooldowns.size >= 100 && !this.cooldowns.has(key)) this.cooldowns.delete(this.cooldowns.keys().next().value!);
          this.cooldowns.set(key, Math.max(this.cooldowns.get(key) || 0, Date.now() + delay));
          // Only explicit rejections are retried. Never repeat ticket creation or an unconfirmed write.
          if (!safeToRepeat || attempt >= 2 || delay >= deadline - Date.now()) throw error;
        }
      }
    };
    if (!isRead || key !== this.config.goreloApiKey) return run();
    if (this.readCache.size >= 200) this.readCache.delete(this.readCache.keys().next().value!);
    const entry = { until: Date.now() + 30_000, result: run() };
    this.readCache.set(path, entry);
    try { return await entry.result; }
    catch (error) { if (this.readCache.get(path) === entry) this.readCache.delete(path); throw error; }
  }

  private async requestOnce(apiKey: string, path: string, init: RequestInit, timeout: number): Promise<GoreloEnvelope> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        // Never forward the organisation-wide API key to a redirect destination.
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers: { "X-API-Key": requireApiKey(apiKey), ...init.headers },
      });
    } catch {
      throw new GoreloRequestError("Could not reach the Gorelo API", true);
    }

    if (response.status === 429) {
      const header = response.headers.get("Retry-After");
      const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header)
        : header ? Math.max(0, (Date.parse(header) - Date.now()) / 1000) : undefined;
      throw new GoreloRequestError("Gorelo request failed (HTTP 429)", false, 429,
        seconds !== undefined && Number.isFinite(seconds) ? Math.ceil(seconds) : undefined);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new GoreloRequestError(
        `Gorelo returned an invalid response (HTTP ${response.status})`,
        response.ok || response.status >= 500,
        response.status,
      );
    }
    if (!record(parsed)) {
      throw new GoreloRequestError(
        `Gorelo returned an invalid response (HTTP ${response.status})`,
        response.ok || response.status >= 500,
        response.status,
      );
    }
    const envelope = parsed as GoreloEnvelope;

    if (envelope.IsSuccess === false) {
      throw new GoreloRequestError(
        notificationMessage(envelope.Notifications) || `Gorelo rejected the request (HTTP ${response.status})`,
        response.status >= 500,
        response.status,
      );
    }
    if (!response.ok) {
      throw new GoreloRequestError(
        `Gorelo request failed (HTTP ${response.status})`,
        response.status >= 500,
        response.status,
      );
    }
    return envelope;
  }

  private async collectPaged(
    apiKey: string,
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 100; page += 1) {
      const params = new URLSearchParams({ ...query, PageSize: "200" });
      if (cursor) params.set("Cursor", cursor);
      const envelope = await this.request(apiKey, `${path}?${params}`);
      if (Array.isArray(envelope.Data)) items.push(...envelope.Data);

      cursor = nextCursor(envelope);
      if (!cursor) return items;
      if (seenCursors.has(cursor)) throw new Error("Gorelo returned a repeated pagination cursor");
      seenCursors.add(cursor);
    }

    throw new Error("Gorelo pagination exceeded the safety limit");
  }

  private async getPage(
    apiKey: string,
    path: string,
    query: Record<string, string | undefined>,
  ): Promise<{ data: unknown[]; nextCursor?: string }> {
    const params = new URLSearchParams({ PageSize: "50" });
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value);
    }
    const envelope = await this.request(apiKey, `${path}?${params}`);
    return {
      data: Array.isArray(envelope.Data) ? envelope.Data : [],
      ...(nextCursor(envelope) ? { nextCursor: nextCursor(envelope) } : {}),
    };
  }

  private async entityName(apiKey: string, path: string): Promise<string> {
    const result = await this.request(apiKey, path);
    const explicitName = stringProperty(result.Data, "Name", "name");
    if (explicitName) return explicitName;
    return [
      stringProperty(result.Data, "FirstName", "firstName"),
      stringProperty(result.Data, "LastName", "lastName"),
    ].filter(Boolean).join(" ");
  }

  async getTickets(
    apiKey: string,
    query: { query?: string; cursor?: string; clientId?: number; contactId?: number },
  ): Promise<{ items: TicketListItem[]; nextCursor?: string }> {
    const key = requireApiKey(apiKey);
    const page = await this.getPage(key, "/v1/tickets", {
      Query: query.query,
      Cursor: query.cursor,
      ClientIds: query.clientId ? String(query.clientId) : undefined,
      ContactIds: query.contactId ? String(query.contactId) : undefined,
      SortBy: "updatedOn",
      SortOrder: "desc",
    });
    const clientIds = [...new Set(page.data
      .map((item) => optionalPositiveInteger(item, "ClientId", "clientId"))
      .filter((id): id is number => id !== undefined))];
    const clientNames = new Map(await Promise.all(clientIds.map(async (id) =>
      [id, await this.entityName(key, `/v1/clients/${id}`)] as const,
    )));
    return {
      items: page.data.map((item) => {
        const clientId = optionalPositiveInteger(item, "ClientId", "clientId");
        return {
          id: stringProperty(item, "Id", "id"),
          displayNumber: stringProperty(item, "DisplayNumber", "displayNumber"),
          title: stringProperty(item, "Title", "title"),
          statusName: codeName(item, "Status", "status"),
          ...(codeId(item, "Status", "status") ? { statusId: codeId(item, "Status", "status") } : {}),
          clientName: clientId ? clientNames.get(clientId) || "" : "",
          updatedOn: stringProperty(item, "UpdatedOn", "updatedOn"),
        };
      }),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async getTicket(apiKey: string, ticketId: string): Promise<TicketDetail> {
    const key = requireApiKey(apiKey);
    const envelope = await this.request(key, `/v1/tickets/${encodeURIComponent(ticketId)}`);
    const item = envelope.Data;
    const clientId = optionalPositiveInteger(item, "ClientId", "clientId");
    const contactId = optionalPositiveInteger(item, "ContactId", "contactId");
    const [clientName, contactName] = await Promise.all([
      clientId ? this.entityName(key, `/v1/clients/${clientId}`) : Promise.resolve(""),
      contactId ? this.entityName(key, `/v1/contacts/${contactId}`) : Promise.resolve(""),
    ]);
    const agentAssetIds = uuidArray(item, "AgentAssetIds", "agentAssetIds");
    const customAssetIds = uuidArray(item, "CustomAssetIds", "customAssetIds");
    const linkedAssets = await Promise.all([
      ...agentAssetIds.map((id) => this.resolveLinkedAsset(key, "agent", id)),
      ...customAssetIds.map((id) => this.resolveLinkedAsset(key, "custom", id)),
    ]);
    const descriptionText = descriptionPlainText(stringProperty(item, "Description", "description"));
    return {
      id: stringProperty(item, "Id", "id"),
      displayNumber: stringProperty(item, "DisplayNumber", "displayNumber"),
      title: stringProperty(item, "Title", "title"),
      descriptionHtml: `<pre>${escapeHtml(descriptionText)}</pre>`,
      descriptionText,
      ...(clientId ? { clientId } : {}),
      clientName,
      contactName,
      statusName: codeName(item, "Status", "status"),
      ...(codeId(item, "Status", "status") ? { statusId: codeId(item, "Status", "status") } : {}),
      priorityName: codeName(item, "Priority", "priority"),
      createdOn: stringProperty(item, "CreatedOn", "createdOn"),
      updatedOn: stringProperty(item, "UpdatedOn", "updatedOn"),
      agentAssetIds,
      customAssetIds,
      linkedAssets,
    };
  }

  private async resolveLinkedAsset(apiKey: string, kind: "agent" | "custom", id: string): Promise<AssetItem> {
    try {
      return await this.getAsset(apiKey, kind, id);
    } catch {
      // A permission gap or stale asset must not prevent opening the ticket.
      return { id, name: id, kind, details: {} };
    }
  }

  async getTicketComments(
    apiKey: string,
    ticketId: string,
    cursor?: string,
  ): Promise<{ items: Array<{ id: string; bodyHtml: string; bodyText: string; createdOn: string; conversationTypeId?: number; createdByName: string }>; nextCursor?: string }> {
    const key = requireApiKey(apiKey);
    const page = await this.getPage(key, `/v1/tickets/${encodeURIComponent(ticketId)}/comments`, {
      Cursor: cursor,
      SortBy: "createdOn",
      SortOrder: "asc",
    });
    const complete = await Promise.all(page.data.map(async (item) => {
      if (property(item, "BodyTruncated", "bodyTruncated") !== true) return item;
      const id = stringProperty(item, "Id", "id");
      if (!id) return item;
      return (await this.request(key, `/v1/tickets/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(id)}`)).Data;
    }));
    return {
      items: complete.map((item) => ({
        id: stringProperty(item, "Id", "id"),
        bodyHtml: safeHtml(stringProperty(item, "BodyHtml", "bodyHtml")),
        bodyText: stringProperty(item, "BodyText", "bodyText"),
        createdOn: stringProperty(item, "CreatedOn", "createdOn"),
        ...(optionalPositiveInteger(property(item, "ConversationType", "conversationType"), "Id", "id")
          ? { conversationTypeId: optionalPositiveInteger(property(item, "ConversationType", "conversationType"), "Id", "id") }
          : {}),
        createdByName: stringProperty(property(item, "Author", "author"), "Name", "name"),
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  private normalizeAsset(item: unknown, kind: "agent" | "custom"): AssetItem {
    const clientId = optionalPositiveInteger(item, "ClientId", "clientId");
    const name = kind === "agent"
      ? stringProperty(item, "DisplayName", "displayName") || stringProperty(item, "Name", "name")
      : stringProperty(item, "Name", "name");
    const details = kind === "agent"
      ? detailStrings([
          ["statusName", codeName(item, "Status", "status")],
          ["description", stringProperty(item, "Description", "description")],
          ["os", stringProperty(item, "Os", "os")],
          ["manufacturer", stringProperty(item, "Manufacturer", "manufacturer")],
          ["model", stringProperty(item, "Model", "model")],
          ["serialNumber", stringProperty(item, "SerialNo", "serialNo")],
          ["lastLoggedOnUser", stringProperty(item, "LastLoggedOnUser", "lastLoggedOnUser")],
          ["lastLoggedOnUserUpn", stringProperty(item, "LastLoggedOnUserUpn", "lastLoggedOnUserUpn")],
          ["ipAddress", stringProperty(item, "LocalIPAddress", "localIPAddress")],
          ["updatedOn", stringProperty(item, "UpdatedOn", "updatedOn")],
        ])
      : detailStrings([
          ["description", stringProperty(item, "Description", "description")],
          ["banner", stringProperty(item, "Banner", "banner")],
          ["hardwareType", stringProperty(item, "HardwareType", "hardwareType")],
          ["serialNumber", stringProperty(item, "SerialNumber", "serialNumber")],
          ["ipAddress", stringProperty(item, "IpAddress", "ipAddress")],
          ["warrantyEndDate", stringProperty(item, "WarrantyEndDate", "warrantyEndDate")],
          ["updatedOn", stringProperty(item, "UpdatedOn", "updatedOn")],
        ]);
    return {
      id: stringProperty(item, "Id", "id"),
      name,
      kind,
      ...(clientId ? { clientId } : {}),
      details,
    };
  }

  async getAssets(
    apiKey: string,
    query: { kind: "agent" | "custom"; clientId?: number; userEmail?: string; query?: string; cursor?: string },
  ): Promise<{ items: AssetItem[]; nextCursor?: string }> {
    const key = requireApiKey(apiKey);
    if (query.userEmail) {
      if (query.kind !== "agent" || !query.clientId) throw new Error("User filtering requires a client and managed devices");
      const scan = () => this.scanSenderDevices(key, query.clientId!, query.userEmail!, query.query);
      // The three UI views share one scan. Cache only the configured server key;
      // client-supplied keys must never share cached results with other users.
      if (key !== this.config.goreloApiKey) return { items: await scan() };
      const cacheKey = `${query.clientId}:${query.userEmail.toLowerCase()}:${query.query || ''}`;
      const cached = this.senderDeviceCache.get(cacheKey);
      if (cached && cached.until > Date.now()) return { items: await cached.result };
      if (this.senderDeviceCache.size >= 100) this.senderDeviceCache.delete(this.senderDeviceCache.keys().next().value!);
      const result = scan();
      this.senderDeviceCache.set(cacheKey, { until: Date.now() + 5 * 60_000, result });
      try { return { items: await result }; }
      catch (error) { this.senderDeviceCache.delete(cacheKey); throw error; }
    }
    const page = await this.getPage(key, `/v1/assets/${query.kind === "agent" ? "agents" : "custom"}`, {
      ClientIds: query.clientId ? String(query.clientId) : undefined,
      Query: query.query,
      Cursor: query.cursor,
    });
    return {
      items: page.data.map((item) => this.normalizeAsset(item, query.kind)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  private async scanSenderDevices(key: string, clientId: number, email: string, query?: string): Promise<AssetItem[]> {
    const matches: AssetItem[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await this.getPage(key, "/v1/assets/agents", {
        ClientIds: String(clientId), PageSize: "200", Cursor: cursor, Query: query,
      });
      matches.push(...page.data
        .map((item) => this.normalizeAsset(item, "agent"))
        .filter((item) => senderUsesDevice(item, email)));
      if (!page.nextCursor || seen.has(page.nextCursor)) return matches;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new GoreloRequestError("Too many device pages to identify all devices used by this sender");
  }

  async getAsset(apiKey: string, kind: "agent" | "custom", id: string): Promise<AssetItem> {
    const key = requireApiKey(apiKey);
    if (kind === "agent") {
      const envelope = await this.request(key, `/v1/assets/agents/${encodeURIComponent(id)}`);
      return this.normalizeAsset(envelope.Data, kind);
    }

    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await this.getPage(key, "/v1/assets/custom", { Cursor: cursor });
      const match = page.data.find((item) => stringProperty(item, "Id", "id") === id);
      if (match) return this.normalizeAsset(match, kind);
      if (!page.nextCursor || seen.has(page.nextCursor)) break;
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new GoreloRequestError("Custom asset not found", false, 404);
  }

  async matchContacts(apiKey: string, email: string): Promise<ContactMatches> {
    const key = requireApiKey(apiKey);
    const lookup = () => this.lookupContacts(key, email);
    if (key !== this.config.goreloApiKey) return lookup();
    const cacheKey = email.trim().toLowerCase();
    const cached = this.contactMatchCache.get(cacheKey);
    if (cached && cached.until > Date.now()) return cached.result;
    if (this.contactMatchCache.size >= 100) this.contactMatchCache.delete(this.contactMatchCache.keys().next().value!);
    const result = lookup();
    this.contactMatchCache.set(cacheKey, { until: Date.now() + 2 * 60_000, result });
    try { return await result; }
    catch (error) { this.contactMatchCache.delete(cacheKey); throw error; }
  }

  private async lookupContacts(key: string, email: string): Promise<ContactMatches> {
    // An exact email search needs only one page; fetching every page amplifies rate limits.
    const page = await this.getPage(key, "/v1/contacts", { Query: email, PageSize: "200" });
    const normalizedEmail = email.trim().toLowerCase();
    const contacts = page.data.flatMap((item) => {
      const id = optionalPositiveInteger(item, "Id", "id");
      const primaryEmail = stringProperty(item, "PrimaryEmail", "primaryEmail");
      if (!id || primaryEmail.toLowerCase() !== normalizedEmail) return [];
      const clientId = optionalPositiveInteger(item, "ClientId", "clientId");
      const name = [
        stringProperty(item, "FirstName", "firstName"),
        stringProperty(item, "LastName", "lastName"),
      ].filter(Boolean).join(" ") || primaryEmail;
      return [{ id, name, ...(clientId ? { clientId } : {}), email: primaryEmail }];
    });
    const suggestion = contacts.length === 1 ? contacts[0] : undefined;
    // Only fall back when no exact contact exists; multiple exact contacts require a manual choice.
    let domainClients: Set<number> | undefined;
    if (contacts.length === 0) {
      const domain = normalizedEmail.split("@")[1];
      if (domain && !sharedMailDomains.has(domain)) {
        domainClients = (await this.getClientDomains(key)).get(domain);
      }
    }
    return {
      contacts,
      ...(suggestion?.clientId ? { suggestedClientId: suggestion.clientId } :
        domainClients?.size === 1 ? { suggestedClientId: [...domainClients][0], suggestedViaDomain: true } : {}),
      ...(suggestion ? { suggestedContactId: suggestion.id } : {}),
      ...(domainClients && domainClients.size > 1 ? { ambiguousDomain: true } : {}),
    };
  }

  private async getClientDomains(key: string): Promise<Map<string, Set<number>>> {
    const load = async () => {
      const clients = await this.collectPaged(key, "/v1/clients");
      const domains = new Map<string, Set<number>>();
      for (const client of clients) {
        const id = optionalPositiveInteger(client, "Id", "id");
        const entries = property(client, "Domains", "domains");
        if (!id || !Array.isArray(entries)) continue;
        for (const entry of entries) {
          const name = stringProperty(entry, "Name", "name").trim().toLowerCase();
          if (!name || sharedMailDomains.has(name)) continue;
          if (!domains.has(name)) domains.set(name, new Set());
          domains.get(name)!.add(id);
        }
      }
      return domains;
    };
    if (key !== this.config.goreloApiKey) return load();
    if (this.clientDomainCache && this.clientDomainCache.until > Date.now()) return this.clientDomainCache.result;
    const result = load();
    this.clientDomainCache = { until: Date.now() + 10 * 60_000, result };
    try { return await result; }
    catch (error) { this.clientDomainCache = undefined; throw error; }
  }

  async getOptions(apiKey: string, clientId?: number): Promise<GoreloOptions> {
    const key = requireApiKey(apiKey);
    const load = () => this.loadOptions(key, clientId);
    if (clientId || key !== this.config.goreloApiKey) return load();
    if (this.optionsCache && this.optionsCache.until > Date.now()) return this.optionsCache.result;
    const result = load();
    this.optionsCache = { until: Date.now() + 2 * 60_000, result };
    try { return await result; }
    catch (error) { this.optionsCache = undefined; throw error; }
  }

  private async loadOptions(key: string, clientId?: number): Promise<GoreloOptions> {
    const [groups, statuses, types, clients, contacts] = await Promise.all([
      this.request(key, "/v1/organization/groups"),
      this.request(key, "/v1/tickets/statuses"),
      this.request(key, "/v1/tickets/types"),
      this.collectPaged(key, "/v1/clients"),
      clientId
        ? this.collectPaged(key, "/v1/contacts", { ClientIds: String(clientId) })
        : Promise.resolve(undefined),
    ]);

    return {
      groups: toOptions(groups.Data),
      statuses: toStatusOptions(statuses.Data),
      types: toOptions(types.Data),
      clients: toOptions(clients),
      ...(contacts ? { contacts: toOptions(contacts) } : {}),
    };
  }

  async getContacts(apiKey: string, clientId: number): Promise<{ contacts: Option[] }> {
    const contacts = await this.collectPaged(requireApiKey(apiKey), "/v1/contacts", { ClientIds: String(clientId) });
    return { contacts: toOptions(contacts) };
  }

  async getUsers(apiKey: string): Promise<GoreloUser[]> {
    const key = requireApiKey(apiKey);
    const load = async (): Promise<GoreloUser[]> => {
      const items = await this.collectPaged(key, "/v1/organization/users");
      return items.flatMap((item) => {
        const id = optionalPositiveInteger(item, "Id", "id");
        const email = stringProperty(item, "Email", "email").trim().toLowerCase();
        if (!id || !email) return [];
        const name = [stringProperty(item, "FirstName", "firstName"), stringProperty(item, "LastName", "lastName")].filter(Boolean).join(" ") || email;
        return [{ id, name, email }];
      });
    };
    if (key !== this.config.goreloApiKey) return load();
    if (this.usersCache && this.usersCache.until > Date.now()) return this.usersCache.result;
    const result = load();
    this.usersCache = { until: Date.now() + 10 * 60_000, result };
    try { return await result; } catch (error) { this.usersCache = undefined; throw error; }
  }

  private async ensureClientContact(
    key: string, clientId: number, contact: { email: string; firstName: string; lastName: string },
  ): Promise<number> {
    const existing = await this.collectPaged(key, "/v1/contacts", { ClientIds: String(clientId), Query: contact.email });
    const email = contact.email.toLowerCase();
    const match = existing.find((item) => optionalPositiveInteger(item, "ClientId", "clientId") === clientId &&
      [stringProperty(item, "PrimaryEmail", "primaryEmail"), ...(
        Array.isArray(property(item, "SecondaryEmail", "secondaryEmail"))
          ? property(item, "SecondaryEmail", "secondaryEmail") as string[] : []
      )].some((address) => typeof address === "string" && address.toLowerCase() === email));
    const matchId = optionalPositiveInteger(match, "Id", "id");
    if (matchId) return matchId;
    let result: GoreloEnvelope;
    try {
      result = await this.request(key, "/v1/contacts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ClientId: clientId, FirstName: contact.firstName, LastName: contact.lastName, PrimaryEmail: contact.email }),
      });
    } catch (error) {
      if (error instanceof GoreloRequestError && error.indeterminate) {
        throw new TicketCreateIndeterminateError(`Gorelo did not confirm whether contact ${contact.email} was created. Check Gorelo before retrying the ticket`);
      }
      throw error;
    }
    const id = optionalPositiveInteger(result.Data, "Id", "id");
    if (!id) throw new TicketCreateIndeterminateError(`Gorelo did not return an ID for contact ${contact.email}. Check Gorelo before retrying the ticket`);
    this.contactMatchCache.delete(email);
    return id;
  }

  async createTicket(
    apiKey: string,
    input: CreateTicketInput,
    description: string,
  ): Promise<{ ticketId: string } & AttachmentResult> {
    const key = requireApiKey(apiKey);
    if (input.leadAssigneeId || input.ccRecipients.some((recipient) => input.to.some((address) => address.email.toLowerCase() === recipient.email.toLowerCase()))) {
      const toAddresses = new Set(input.to.map(({ email }) => email.toLowerCase()));
      const users = await this.getUsers(key);
      if (input.leadAssigneeId && !users.some(({ id, email }) => id === input.leadAssigneeId && toAddresses.has(email))) {
        throw new GoreloRequestError("The selected assignee does not match a To recipient; refresh the add-in and review the assignment", false, 400);
      }
      if (input.ccRecipients.some((recipient) => toAddresses.has(recipient.email.toLowerCase()) && users.some((user) => user.email === recipient.email.toLowerCase()))) {
        throw new GoreloRequestError("A To recipient is a Gorelo technician and cannot be added as a client CC contact", false, 400);
      }
    }
    const contactId = input.contactId || (input.createSenderContact && input.clientId
      ? await this.ensureClientContact(key, input.clientId, {
          email: input.from.email, firstName: input.requesterFirstName!, lastName: input.requesterLastName!,
        }) : undefined);
    const ccContactIds: number[] = [];
    for (const recipient of input.ccRecipients) {
      const id = await this.ensureClientContact(key, input.clientId!, recipient);
      if (id !== contactId && !ccContactIds.includes(id)) ccContactIds.push(id);
    }
    let created: GoreloEnvelope;
    try {
      created = await this.request(key, "/v1/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Title: input.subject,
          Description: description,
          GroupId: input.groupId,
          StatusId: input.statusId,
          TypeId: input.typeId,
          ClientId: input.clientId ?? null,
          ContactId: contactId ?? null,
          CcContactIds: ccContactIds,
          LeadAssigneeId: input.leadAssigneeId ?? null,
          AgentAssetIds: input.agentAssetIds,
          CustomAssetIds: input.customAssetIds,
          SendTicketCreatedEmail: false,
        }),
      });
    } catch (error) {
      if (!(error instanceof GoreloRequestError) || !error.indeterminate) throw error;
      throw new TicketCreateIndeterminateError(
        `${error.message}. Gorelo did not confirm whether the ticket was created; do not retry automatically.`,
      );
    }

    const ticketId = property(created.Data, "Id", "id");
    if (typeof ticketId !== "string" || !ticketId) {
      throw new TicketCreateIndeterminateError(
        "Gorelo may have created the ticket but returned no ticket ID. Do not retry automatically.",
      );
    }

    try {
      const result = await this.attachmentRetries.start(ticketId, key, input.attachments,
        (path, init) => this.request(key, path, init));
      return { ticketId, ...result };
    } catch {
      // The ticket is already confirmed even if local retry storage or linking fails.
      return { ticketId, partialFailures: ["Attachment processing stopped. Use Recover missing attachments on this ticket; do not recreate it."] };
    }
  }

  async attachmentRetryStatus(apiKey: string, ticketId: string, token: string): Promise<AttachmentResult> {
    return this.attachmentRetries.status(ticketId, token, requireApiKey(apiKey));
  }

  async retryAttachments(apiKey: string, ticketId: string, token: string): Promise<AttachmentResult> {
    const key = requireApiKey(apiKey);
    return this.attachmentRetries.resume(ticketId, token, key, (path, init) => this.request(key, path, init));
  }

  private readonly attachmentRecoveries = new Map<string, Promise<AttachmentResult>>();

  async recoverAttachments(apiKey: string, ticketId: string, attachments: AttachEmailInput["attachments"]): Promise<AttachmentResult> {
    const key = requireApiKey(apiKey);
    const identity = `${key}:${ticketId}`;
    const active = this.attachmentRecoveries.get(identity);
    if (active) return active;
    const recover = async () => {
      const existing = await this.attachmentRetries.existing(ticketId, key, attachments);
      if (existing) return this.retryAttachments(key, ticketId, existing);
      await this.request(key, `/v1/tickets/${encodeURIComponent(ticketId)}`);
      const comments = await this.collectPaged(key, `/v1/tickets/${encodeURIComponent(ticketId)}/comments`);
      const candidates = new Set(attachments.map((a) => a.name));
      const linkedHashes = new Set<string>();
      const urls = new Set<string>();
      for (const comment of comments) {
        const references = property(comment, "Attachments", "attachments");
        if (!Array.isArray(references)) continue;
        for (const reference of references) {
          const name = stringProperty(reference, "Name", "name");
          const url = stringProperty(reference, "Url", "url");
          if (!candidates.has(name) || urls.has(url)) continue;
          urls.add(url);
          if (urls.size > 100) throw new AttachmentRetryError("Too many matching attachments to verify safely. Review the ticket in Gorelo.");
          // Signed Gorelo blob URLs are read without the organisation API key.
          if (!URL.canParse(url)) throw new AttachmentRetryError("An existing attachment could not be verified. No files were uploaded.");
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || !/^gorelofiles[a-z]{3}\.blob\.core\.windows\.net$/.test(parsed.hostname))
            throw new AttachmentRetryError("An existing attachment has an unsupported storage URL. No files were uploaded.");
          let response: Response;
          try { response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }); }
          catch { throw new AttachmentRetryError("Could not verify an existing attachment. No files were uploaded.", 503); }
          if (!response.ok || !response.body) throw new AttachmentRetryError("Could not read an existing attachment. No files were uploaded.", 503);
          const chunks: Uint8Array[] = []; let size = 0;
          const reader = response.body.getReader();
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              size += chunk.value.length;
              if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new AttachmentRetryError("Existing attachment exceeds the verification limit. No files were uploaded."); }
              chunks.push(chunk.value);
            }
          } finally { reader.releaseLock(); }
          linkedHashes.add(attachmentHash(Buffer.concat(chunks)));
        }
      }
      return this.attachmentRetries.start(ticketId, key, attachments,
        (path, init) => this.request(key, path, init), linkedHashes);
    };
    const result = recover(); this.attachmentRecoveries.set(identity, result);
    try { return await result; } finally { this.attachmentRecoveries.delete(identity); }
  }

  async attachEmail(apiKey: string, ticketId: string, input: AttachEmailInput, description: string): Promise<{ partialFailures?: string[] }> {
    const key = requireApiKey(apiKey);
    // Check the target before uploading files to avoid attaching them to a stale ticket.
    await this.request(key, `/v1/tickets/${encodeURIComponent(ticketId)}`);
    const partialFailures: string[] = [];
    const uploaded: Array<{ Name: string; Url: string }> = [];
    for (const attachment of input.attachments) {
      try {
        const form = new FormData();
        form.append("file", new Blob([Uint8Array.from(Buffer.from(attachment.contentBase64, "base64"))], { type: attachment.contentType }), attachment.name);
        form.append("itemType", "Ticket");
        form.append("itemId", ticketId);
        const result = await this.request(key, "/v1/attachments", { method: "POST", body: form });
        const name = property(result.Data, "Name", "name");
        const url = property(result.Data, "Url", "url");
        if (typeof name !== "string" || !name || typeof url !== "string" || !url || !URL.canParse(url) || new URL(url).protocol !== "https:") {
          throw new Error("upload returned no attachment reference");
        }
        uploaded.push({ Name: name, Url: url });
      } catch (error) {
        partialFailures.push(`Attachment ${attachment.name}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    try {
      await this.request(key, `/v1/tickets/${encodeURIComponent(ticketId)}/comments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Body: description, ConversationTypeId: 2, Attachments: uploaded }),
      });
    } catch (error) {
      if (error instanceof GoreloRequestError && !error.indeterminate && error.status && error.status < 500) throw error;
      throw new TicketCreateIndeterminateError("Gorelo did not confirm whether the email was attached. Check the ticket conversation before retrying");
    }
    return partialFailures.length ? { partialFailures } : {};
  }
}
