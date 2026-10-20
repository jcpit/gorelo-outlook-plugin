export type Address = { name: string; email: string };
export type Attachment = { name: string; contentType: string; contentBase64: string };
export type Email = {
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  receivedAt: string;
  internetMessageId: string;
  internetHeaders: string;
  outlookItemId: string;
  conversationId: string;
  bodyHtml: string;
  bodyText: string;
  attachments: Attachment[];
};

export const sampleEmail: Email = {
  subject: 'Printer offline in reception',
  from: { name: 'Morgan Reed', email: 'morgan@example.com' },
  to: [{ name: 'Service desk', email: 'support@example.com' }],
  cc: [{ name: 'Jane Doe', email: 'jane@example.com' }],
  receivedAt: '2026-09-29T09:42:00+10:00',
  internetMessageId: '<example-message@invalid>',
  internetHeaders: 'Message-ID: <example-message@invalid>\r\nDate: Tue, 29 Sep 2026 09:42:00 +1000',
  outlookItemId: 'example-outlook-id',
  conversationId: 'example-conversation-id',
  bodyHtml: '<p>Hi team, the printer in reception has stopped responding. Could someone take a look?</p>',
  bodyText: 'Hi team, the printer in reception has stopped responding. Could someone take a look?',
  attachments: [],
};

function asyncResult<T>(start: (callback: (result: Office.AsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => start((result) => {
    if (result.status === Office.AsyncResultStatus.Succeeded) resolve(result.value);
    else reject(new Error(result.error?.message || 'Outlook could not read the message.'));
  }));
}

function address(value: Office.EmailAddressDetails): Address {
  return { name: value.displayName || '', email: value.emailAddress || '' };
}

export async function readSelectedEmail(): Promise<Email> {
  const item = Office.context.mailbox.item;
  if (!item || item.itemType !== Office.MailboxEnums.ItemType.Message) {
    throw new Error('Open an email message to create a ticket.');
  }
  const message = item as Office.MessageRead;
  const [bodyHtml, bodyText, headers] = await Promise.all([
    asyncResult<string>((callback) => message.body.getAsync(Office.CoercionType.Html, callback)),
    asyncResult<string>((callback) => message.body.getAsync(Office.CoercionType.Text, callback)),
    asyncResult<string>((callback) => message.getAllInternetHeadersAsync(callback)),
  ]);
  const attachments: Attachment[] = [];
  const unsupported: string[] = [];
  for (const file of message.attachments) {
    const result = await asyncResult<Office.AttachmentContent>((callback) => message.getAttachmentContentAsync(file.id, callback));
    if (result.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) {
      unsupported.push(file.name);
      continue;
    }
    attachments.push({ name: file.name, contentType: file.contentType || 'application/octet-stream', contentBase64: result.content });
  }
  if (unsupported.length) throw new Error(`These Outlook attachments cannot be captured: ${unsupported.join(', ')}. Save them as files and attach them to the Gorelo ticket manually.`);
  const messageId = headers.match(/^message-id:\s*(.+)$/im)?.[1]?.trim() || '';
  return {
    subject: message.subject || '(No subject)',
    from: address(message.from),
    to: (message.to || []).map(address),
    cc: (message.cc || []).map(address),
    receivedAt: message.dateTimeCreated?.toISOString() || new Date().toISOString(),
    internetMessageId: messageId,
    internetHeaders: headers,
    outlookItemId: message.itemId || '',
    conversationId: message.conversationId || '',
    bodyHtml,
    bodyText,
    attachments,
  };
}
