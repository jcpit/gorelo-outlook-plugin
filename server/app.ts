import express, { type ErrorRequestHandler } from "express";
import sanitizeHtml from "sanitize-html";
import { ZodError } from "zod";
import { join } from "node:path";
import { classifyTicket } from "./classifier.js";
import { AttachmentRetryError } from "./attachment-retry.js";
import { accessMiddleware } from "./access.js";
import { auditActor, auditedMutation, AuditUnavailableError, createAuditSink, newAuditRequestId, type AuditOperation, type AuditSink } from "./audit.js";
import type { Response } from "express";

import type { AppConfig } from "./config.js";
import {
  GoreloConnector,
  GoreloRequestError,
  TicketCreateIndeterminateError,
  type GoreloOptions,
} from "./goreloConnector.js";
import {
  assetsQuerySchema,
  attachEmailSchema,
  commentsQuerySchema,
  createTicketSchema,
  matchesQuerySchema,
  optionsQuerySchema,
  classificationSchema,
  attachmentRecoverySchema,
  attachmentRetrySchema,
  contactsQuerySchema,
  ticketsQuerySchema,
  uuidParamsSchema,
  type CreateTicketInput,
  type AttachEmailInput,
} from "./schemas.js";

const DEMO_OPTIONS: GoreloOptions = {
  groups: [{ id: 1, name: "Service Desk" }],
  statuses: [{ id: 1, name: "New" }],
  types: [{ id: 1, name: "Support" }],
  clients: [{ id: 1, name: "Example Client" }],
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function addressList(addresses: AttachEmailInput["to"]): string {
  return addresses
    .map(({ name, email }) =>
      name
        ? `${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;`
        : escapeHtml(email),
    )
    .join(", ");
}

export function buildDescription(input: AttachEmailInput): string {
  const sanitizedHtml = input.bodyHtml
    ? sanitizeHtml(input.bodyHtml, {
        allowedTags: sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== "style"),
        allowedAttributes: {
          a: ["href", "title"],
          td: ["colspan", "rowspan"],
          th: ["colspan", "rowspan"],
        },
        allowedSchemes: ["http", "https", "mailto"],
        disallowedTagsMode: "discard",
      })
    : "";
  const safeBody = sanitizedHtml || `<pre>${escapeHtml(input.bodyText || "(Empty message)")}</pre>`;
  const sender = input.from.name
    ? `${escapeHtml(input.from.name)} &lt;${escapeHtml(input.from.email)}&gt;`
    : escapeHtml(input.from.email);

  return sanitizeHtml(
    `<table><tbody>
      <tr><th align="left">From</th><td>${sender}</td></tr>
      <tr><th align="left">To</th><td>${addressList(input.to)}</td></tr>
      <tr><th align="left">Cc</th><td>${addressList(input.cc)}</td></tr>
      <tr><th align="left">Received</th><td>${escapeHtml(input.receivedAt)}</td></tr>
      <tr><th align="left">Message ID</th><td>${escapeHtml(input.internetMessageId || "Not available")}</td></tr>
      <tr><th align="left">Outlook item ID</th><td>${escapeHtml(input.outlookItemId || "Not available")}</td></tr>
      <tr><th align="left">Conversation ID</th><td>${escapeHtml(input.conversationId || "Not available")}</td></tr>
    </tbody></table><hr>${safeBody}`,
    {
      allowedTags: [...sanitizeHtml.defaults.allowedTags, "table", "tbody", "tr", "th", "td", "pre"],
      allowedAttributes: {
        a: ["href", "title"],
        th: ["align", "colspan", "rowspan"],
        td: ["colspan", "rowspan"],
      },
      allowedSchemes: ["http", "https", "mailto"],
    },
  );
}

export function createApp(config: AppConfig, connector = new GoreloConnector(config), options: { auditSink?: AuditSink } = {}) {
  const app = express();
  const auditSink = options.auditSink ?? createAuditSink(config.auditDirectory);
  const mutate = <T>(response: Response, operation: AuditOperation, ticketId: string | undefined, action: () => Promise<T>) =>
    auditedMutation(auditSink, auditActor(response.locals.microsoftUser, Boolean(config.entraTenantId && config.entraClientId)),
      response.locals.auditRequestId as string, operation, ticketId, action);
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    // Never trust caller-supplied correlation or identity headers.
    response.locals.auditRequestId = newAuditRequestId();
    response.setHeader("X-Request-ID", response.locals.auditRequestId as string);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.get("/healthz", (_request, response) => response.json({ status: "ok" }));
  app.use((request, response, next) => {
    const requestOrigin = request.header("origin");
    if (requestOrigin && requestOrigin !== config.corsOrigin) {
      response.status(403).json({ error: "This add-in origin is not permitted" });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, X-Gorelo-Key, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });
  // Public registration metadata only. Business APIs still require a token;
  // the static task pane must be public so Outlook can load the sign-in code.
  app.get("/api/auth-config", (_request, response) => {
    response.json(config.entraTenantId && config.entraClientId ? {
      provider: "entra", tenantId: config.entraTenantId, clientId: config.entraClientId,
      scope: `api://${config.entraClientId}/access_as_user`,
    } : { provider: "local" });
  });
  if (config.entraTenantId && config.entraClientId) {
    app.use("/api", accessMiddleware(config.entraTenantId, config.entraClientId));
  }
  app.use(express.json({ limit: "36mb" }));
  app.get("/api/auth-mode", (_request, response) => {
    response.json({ serverManaged: Boolean(config.goreloApiKey) && !config.demoMode });
  });
  app.use("/api", (request, response, next) => {
    if (config.demoMode) return next();
    if (config.goreloApiKey) {
      if (request.header("x-gorelo-key") !== undefined) {
        response.status(400).json({ error: "Client-supplied API keys are not accepted in server-managed mode" });
        return;
      }
      response.locals.goreloKey = config.goreloApiKey;
      return next();
    }
    const apiKey = request.header("x-gorelo-key")?.trim();
    if (!apiKey || apiKey.length > 512) {
      response.status(401).json({ error: "Enter your Gorelo API key in the add-in settings" });
      return;
    }
    response.locals.goreloKey = apiKey;
    next();
  });

  app.get("/api/options", async (request, response, next) => {
    try {
      const { clientId } = optionsQuerySchema.parse(request.query);
      if (config.demoMode) {
        response.json(DEMO_OPTIONS);
        return;
      }
      response.json(await connector.getOptions(response.locals.goreloKey as string, clientId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/classify", async (request, response, next) => {
    try {
      const { subject, bodyText } = classificationSchema.parse(request.body);
      if (!config.openCodeApiKey || config.demoMode) { response.json({ available: false }); return; }
      const options = await connector.getOptions(response.locals.goreloKey as string);
      response.json({ available: true, ...(await classifyTicket(config.openCodeApiKey, subject, bodyText, options)) });
    } catch (error) { next(error); }
  });

  app.get("/api/contacts", async (request, response, next) => {
    try {
      const { clientId } = contactsQuerySchema.parse(request.query);
      if (config.demoMode) { response.json({ contacts: [] }); return; }
      response.json(await connector.getContacts(response.locals.goreloKey as string, clientId));
    } catch (error) { next(error); }
  });

  app.get("/api/users", async (_request, response, next) => {
    try {
      if (config.demoMode) { response.json({ users: [] }); return; }
      response.json({ users: await connector.getUsers(response.locals.goreloKey as string) });
    } catch (error) { next(error); }
  });

  app.get("/api/matches", async (request, response, next) => {
    try {
      const { email } = matchesQuerySchema.parse(request.query);
      if (config.demoMode) {
        response.json({ contacts: [] });
        return;
      }
      response.json(await connector.matchContacts(response.locals.goreloKey as string, email));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tickets", async (request, response, next) => {
    try {
      const query = ticketsQuerySchema.parse(request.query);
      if (config.demoMode) {
        response.json({ items: [] });
        return;
      }
      response.json(await connector.getTickets(response.locals.goreloKey as string, query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tickets/:ticketId", async (request, response, next) => {
    try {
      const { ticketId } = uuidParamsSchema.parse(request.params);
      if (config.demoMode) {
        response.status(404).json({ error: "Ticket not found in demo mode" });
        return;
      }
      response.json(await connector.getTicket(response.locals.goreloKey as string, ticketId!));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tickets/:ticketId/comments", async (request, response, next) => {
    try {
      const { ticketId } = uuidParamsSchema.parse(request.params);
      const { cursor } = commentsQuerySchema.parse(request.query);
      if (config.demoMode) {
        response.json({ items: [] });
        return;
      }
      response.json(await connector.getTicketComments(response.locals.goreloKey as string, ticketId!, cursor));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tickets/:ticketId/emails", async (request, response, next) => {
    try {
      if (config.demoMode) { response.status(403).json({ error: "Attaching email is disabled in demo mode" }); return; }
      const { ticketId } = uuidParamsSchema.parse(request.params);
      const input = attachEmailSchema.parse(request.body);
      const result = await mutate(response, "email.append", ticketId!, () => connector.attachEmail(response.locals.goreloKey as string, ticketId!, input,
        `<p>Outlook email: ${escapeHtml(input.subject)}</p>${buildDescription(input)}`));
      response.status(201).json(result);
    } catch (error) { next(error); }
  });

  app.get("/api/tickets/:ticketId/attachments/retry/:token", async (request, response, next) => {
    try {
      const { ticketId } = uuidParamsSchema.parse(request.params);
      const { token } = attachmentRetrySchema.parse({ token: request.params.token });
      if (config.demoMode) { response.json({}); return; }
      response.json(await connector.attachmentRetryStatus(response.locals.goreloKey as string, ticketId!, token));
    } catch (error) { next(error); }
  });

  app.post("/api/tickets/:ticketId/attachments/retry", async (request, response, next) => {
    try {
      const { ticketId } = uuidParamsSchema.parse(request.params);
      const { token } = attachmentRetrySchema.parse(request.body);
      if (config.demoMode) { response.status(403).json({ error: "Attachment writes are disabled in demo mode" }); return; }
      response.json(await mutate(response, "attachments.retry", ticketId!, () => connector.retryAttachments(response.locals.goreloKey as string, ticketId!, token)));
    } catch (error) { next(error); }
  });

  app.post("/api/tickets/:ticketId/attachments/recover", async (request, response, next) => {
    try {
      const { ticketId } = uuidParamsSchema.parse(request.params);
      const { attachments } = attachmentRecoverySchema.parse(request.body);
      if (config.demoMode) { response.status(403).json({ error: "Attachment writes are disabled in demo mode" }); return; }
      response.json(await mutate(response, "attachments.recover", ticketId!, () => connector.recoverAttachments(response.locals.goreloKey as string, ticketId!, attachments)));
    } catch (error) { next(error); }
  });

  app.get("/api/assets", async (request, response, next) => {
    try {
      const query = assetsQuerySchema.parse(request.query);
      if (config.demoMode) {
        response.json({ items: [] });
        return;
      }
      response.json(await connector.getAssets(response.locals.goreloKey as string, query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/assets/:kind/:id", async (request, response, next) => {
    try {
      const { kind, id } = uuidParamsSchema.parse(request.params);
      if (config.demoMode) {
        response.status(404).json({ error: "Asset not found in demo mode" });
        return;
      }
      response.json(await connector.getAsset(response.locals.goreloKey as string, kind!, id!));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tickets", async (request, response, next) => {
    try {
      if (config.demoMode) {
        response.status(403).json({ error: "Ticket creation is disabled in demo mode" });
        return;
      }
      const input = createTicketSchema.parse(request.body);
      const result = await mutate(response, "ticket.create", undefined, () => connector.createTicket(response.locals.goreloKey as string, input, buildDescription(input)));
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  if (config.staticDir) {
    app.use(express.static(config.staticDir));
    app.use((request, response, next) => {
      if (request.method === "GET" && request.path !== "/api" && !request.path.startsWith("/api/")) {
        response.sendFile(join(config.staticDir!, "index.html"));
        return;
      }
      next();
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof AuditUnavailableError) {
      response.status(503).json({
        error: error.mutationMayHaveOccurred
          ? "The operation may have completed, but its audit outcome could not be confirmed. Check the ticket before taking further action."
          : "The operation was not started because security audit logging is unavailable.",
        retrySafe: !error.mutationMayHaveOccurred,
        mutationStatus: error.mutationMayHaveOccurred ? "indeterminate" : "not-started",
      });
      return;
    }
    if (error instanceof AttachmentRetryError) {
      response.status(error.status).json({ error: error.message, retrySafe: false });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "Invalid request",
        issues: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
      });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      response.status(413).json({ error: "Request body is too large" });
      return;
    }

    if (error instanceof TicketCreateIndeterminateError) {
      console.error("Gorelo write was not confirmed");
      response.status(502).json({ error: error.message, retrySafe: false });
      return;
    }

    if (error instanceof GoreloRequestError && (error.status === 401 || error.status === 403)) {
      response.status(401).json({ error: config.goreloApiKey
        ? "Gorelo rejected the configured API key. Ask the hosting administrator to check it."
        : "Gorelo rejected this API key. Use Change key in the add-in to enter it again." });
      return;
    }

    if (error instanceof GoreloRequestError && error.status === 429) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds ?? 60));
      response.status(429).json({ error: "Gorelo is rate-limiting requests. Wait a minute, then retry.", retrySafe: true });
      return;
    }

    if (error instanceof GoreloRequestError && error.status && error.status >= 400 && error.status < 500) {
      const status = error.status === 404 || error.status === 429 ? error.status : 400;
      const safeMessage = config.goreloApiKey
        ? error.message.split(config.goreloApiKey).join("[redacted]")
        : error.message;
      response.status(status).json({ error: safeMessage, retrySafe: true });
      return;
    }

    console.error("Gorelo request failed");
    response.status(502).json({ error: "The Gorelo service request failed" });
  };
  app.use(errorHandler);

  return app;
}
