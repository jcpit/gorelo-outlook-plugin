import type { Email } from './mail';

const prefix = 'gorelo-outlook-created:v1:';

export async function creationKey(email: Email, mailbox: string): Promise<string | undefined> {
  const messageId = email.internetMessageId.trim().toLowerCase();
  const outlookId = email.outlookItemId.trim();
  if (!messageId && !outlookId) return undefined;
  if (!globalThis.crypto?.subtle) return undefined;
  const identity = JSON.stringify([mailbox.trim().toLowerCase(), email.from.email.trim().toLowerCase(), messageId || outlookId]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return prefix + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type ResultStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function savedTicketId(storage: ResultStorage, key?: string): string | undefined {
  if (!key) return undefined;
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null') as { ticketId?: unknown } | null;
    return typeof saved?.ticketId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(saved.ticketId)
      ? saved.ticketId : undefined;
  } catch { return undefined; }
}

export function savedAttachmentRetryToken(storage: ResultStorage, key?: string): string | undefined {
  if (!key) return undefined;
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null') as { attachmentRetryToken?: unknown } | null;
    return typeof saved?.attachmentRetryToken === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(saved.attachmentRetryToken)
      ? saved.attachmentRetryToken : undefined;
  } catch { return undefined; }
}

export function saveTicketId(storage: ResultStorage, key: string | undefined, ticketId: string, attachmentRetryToken?: string): boolean {
  if (!key) return false;
  try { storage.setItem(key, JSON.stringify({ ticketId, attachmentRetryToken, createdAt: new Date().toISOString() })); return true; }
  catch { return false; }
}
