import assert from 'node:assert/strict';
import test from 'node:test';
import { creationKey, savedTicketId, savedAttachmentRetryToken, saveTicketId } from '../src/ticket-creation.js';
import { sampleEmail } from '../src/mail.js';

test('creation record is scoped to mailbox and message, not subject or conversation', async () => {
  const key = await creationKey(sampleEmail, 'agent@example.com');
  assert.ok(key?.startsWith('gorelo-outlook-created:v1:'));
  assert.equal(key?.includes('example-message'), false);
  assert.equal(key, await creationKey({ ...sampleEmail, subject: 'Renamed', conversationId: 'changed' }, 'AGENT@example.com'));
  assert.notEqual(key, await creationKey(sampleEmail, 'other@example.com'));
  assert.notEqual(key, await creationKey({ ...sampleEmail, internetMessageId: '<other@invalid>' }, 'agent@example.com'));
  assert.equal(await creationKey({ ...sampleEmail, internetMessageId: '', outlookItemId: '' }, 'agent@example.com'), undefined);
});

test('confirmed tickets survive reload while unavailable storage fails safely', async () => {
  const key = (await creationKey(sampleEmail, 'agent@example.com'))!;
  const records = new Map<string, string>();
  const storage = { getItem: (name: string) => records.get(name) || null, setItem: (name: string, value: string) => { records.set(name, value); } };
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(savedTicketId(storage, key), undefined);
  assert.equal(saveTicketId(storage, key, id), true);
  assert.equal(savedTicketId(storage, key), id);
  const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal(saveTicketId(storage, key, id, token), true);
  assert.equal(savedAttachmentRetryToken(storage, key), token);
  assert.equal(saveTicketId(storage, key, id), true);
  assert.equal(savedAttachmentRetryToken(storage, key), undefined);
  assert.equal(savedTicketId(storage, 'another-message'), undefined);
  assert.equal(savedTicketId({ ...storage, getItem: () => '{invalid' }, key), undefined);
  assert.equal(saveTicketId({ ...storage, setItem: () => { throw new Error('storage blocked'); } }, key, id), false);
});
