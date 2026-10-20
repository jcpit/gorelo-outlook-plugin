import assert from 'node:assert/strict';
import test from 'node:test';
import { isOutlookHost } from '../src/outlook-host.js';

test('standalone browsers and missing or failed Office startup are blocked', async () => {
  assert.equal(await isOutlookHost(undefined), false);
  assert.equal(await isOutlookHost({ onReady: async () => ({ host: null }) }), false);
  assert.equal(await isOutlookHost({ onReady: async () => { throw new Error('Unavailable'); } }), false);
});

test('both the Outlook host and mailbox context are required', async () => {
  const HostType = { Outlook: 'Outlook' };
  assert.equal(await isOutlookHost({ HostType, onReady: async () => ({ host: 'Word' }), context: { mailbox: {} } }), false);
  assert.equal(await isOutlookHost({ HostType, onReady: async () => ({ host: 'Outlook' }) }), false);
  assert.equal(await isOutlookHost({ onReady: async () => ({ host: 'Outlook' }), context: { mailbox: {} } }), false);
  assert.equal(await isOutlookHost({ HostType, onReady: async () => ({ host: 'Outlook' }), context: { mailbox: {} } }), true);
});

test('waits for Office readiness before checking its mailbox context', async () => {
  const office = {
    HostType: { Outlook: 'Outlook' },
    context: {} as { mailbox?: unknown },
    onReady: async () => {
      office.context.mailbox = {};
      return { host: 'Outlook' };
    },
  };
  assert.equal(await isOutlookHost(office), true);
});
