import { z } from "zod";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Gorelo uses 36-character GUIDs that do not always have RFC UUID version/variant bits.
const uuidArraySchema = z.array(z.guid()).max(100).optional().default([]);

const addressSchema = z.object({
  name: z.string().trim().max(200).default(""),
  email: z.string().trim().email().max(320),
});

const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  contentBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4, "Attachment content is too large")
    .refine(
      (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
        (value.endsWith('==') ? value.length > 2 : value.endsWith('=') ? value.length > 1 : true),
      "Attachment content must be valid base64",
    )
    .refine(
      (value) => Buffer.byteLength(value, "base64") <= MAX_ATTACHMENT_BYTES,
      `Each attachment must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller`,
    ),
});

const emailSchema = z.object({
    subject: z.string().trim().min(1).max(250),
    from: addressSchema,
    to: z.array(addressSchema).max(100),
    cc: z.array(addressSchema).max(100).default([]),
    receivedAt: z.string().datetime({ offset: true }),
    internetMessageId: z.string().trim().max(998).optional().default(""),
    internetHeaders: z.string().max(100_000).optional().default(""),
    outlookItemId: z.string().max(2_000).optional().default(""),
    conversationId: z.string().max(2_000).optional().default(""),
    bodyHtml: z.string().max(2_000_000).optional().default(""),
    bodyText: z.string().max(1_000_000).optional().default(""),
    attachments: z.array(attachmentSchema).max(20).default([]),
  });

function validateAttachmentTotal(value: { attachments: Array<{ contentBase64: string }> }, context: z.RefinementCtx): void {
  const totalBytes = value.attachments.reduce(
    (total, attachment) => total + Buffer.byteLength(attachment.contentBase64, "base64"), 0,
  );
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Attachments must total ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB or less`,
      path: ["attachments"],
    });
  }
}

export const attachEmailSchema = emailSchema.superRefine(validateAttachmentTotal);
export const attachmentRecoverySchema = emailSchema.pick({ attachments: true }).strict().superRefine(validateAttachmentTotal);
export const attachmentRetrySchema = z.object({ token: z.guid() }).strict();

export const createTicketSchema = emailSchema
  .extend({
    groupId: z.number().int().positive(),
    statusId: z.number().int().positive(),
    typeId: z.number().int().positive(),
    clientId: z.number().int().positive().optional(),
    contactId: z.number().int().positive().optional(),
    leadAssigneeId: z.number().int().positive().optional(),
    createSenderContact: z.boolean().default(false),
    requesterFirstName: z.string().trim().min(1).max(150).optional(),
    requesterLastName: z.string().trim().min(1).max(150).optional(),
    ccRecipients: z.array(z.object({
      email: z.string().trim().email().max(200),
      firstName: z.string().trim().min(1).max(150),
      lastName: z.string().trim().min(1).max(150),
    })).max(200).default([]),
    agentAssetIds: uuidArraySchema,
    customAssetIds: uuidArraySchema,
  })
  .superRefine((value, context) => {
    validateAttachmentTotal(value, context);

    if (value.contactId && !value.clientId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clientId is required when contactId is supplied",
        path: ["clientId"],
      });
    }
    if ((value.ccRecipients.length || value.createSenderContact) && !value.clientId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A client is required to link or create contacts", path: ["clientId"] });
    }
    if (value.createSenderContact && !value.contactId && (!value.requesterFirstName || !value.requesterLastName)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Requester first and last name are required", path: ["requesterFirstName"] });
    }
    const allowed = new Set([...value.to, ...value.cc].map((address) => address.email.toLowerCase()));
    const included = new Set<string>();
    for (const [index, recipient] of value.ccRecipients.entries()) {
      const email = recipient.email.toLowerCase();
      if (!allowed.has(email) || email === value.from.email.toLowerCase() || included.has(email)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Ticket CC contacts must be unique To or Cc addresses from the email", path: ["ccRecipients", index, "email"] });
      }
      included.add(email);
    }
  });

export const optionsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
});

export const classificationSchema = z.object({
  subject: z.string().trim().min(1).max(250),
  bodyText: z.string().max(5000),
}).strict();

export const contactsQuerySchema = z.object({ clientId: z.coerce.number().int().positive() });

const cursorSchema = z.string().trim().min(1).max(2_000).optional();

export const ticketsQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  cursor: cursorSchema,
  clientId: z.coerce.number().int().positive().optional(),
  contactId: z.coerce.number().int().positive().optional(),
});

export const commentsQuerySchema = z.object({ cursor: cursorSchema });

export const assetsQuerySchema = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  userEmail: z.string().trim().email().max(320).optional(),
  query: z.string().trim().max(200).optional(),
  cursor: cursorSchema,
  kind: z.enum(["agent", "custom"]),
}).refine((value) => !value.userEmail || (value.kind === "agent" && Boolean(value.clientId) && !value.cursor), {
  message: "User filtering requires a client and managed devices",
});

export const uuidParamsSchema = z.object({
  ticketId: z.guid().optional(),
  id: z.guid().optional(),
  kind: z.enum(["agent", "custom"]).optional(),
});

export const matchesQuerySchema = z.object({
  email: z.string().trim().email().max(320),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type AttachEmailInput = z.infer<typeof attachEmailSchema>;
