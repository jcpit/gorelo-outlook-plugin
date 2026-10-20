import assert from 'node:assert/strict';
import test from 'node:test';
import { nameParts, uniqueRecipients } from '../src/recipients.js';

test('recipient review deduplicates To/Cc and keeps editable names', () => {
  const email = { from: { name: 'Jamie Example', email: 'jamie@example.com' },
    to: [{ name: 'Ada Lovelace', email: 'ada@example.com' }, { name: '', email: 'jamie@example.com' }],
    cc: [{ name: 'Ada', email: 'ADA@example.com' }, { name: '', email: 'mary.jane@example.com' }] };
  assert.deepEqual(uniqueRecipients(email).map(({ email, role }) => [email, role]), [['ada@example.com', 'Cc'], ['mary.jane@example.com', 'Cc']]);
  assert.deepEqual(nameParts(email.cc[1]!), { firstName: 'mary', lastName: 'jane' });
  assert.deepEqual(nameParts({ name: 'Support', email: 'help@example.com' }), { firstName: 'Support', lastName: 'Contact' });
});
