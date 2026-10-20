import assert from 'node:assert/strict';
import test from 'node:test';
import { assetPresence } from '../src/asset-presence.js';

test('presence dots require explicit Gorelo online/offline status', () => {
  assert.equal(assetPresence('Online'), 'online');
  assert.equal(assetPresence(' offline '), 'offline');
  assert.equal(assetPresence('Active'), undefined);
  assert.equal(assetPresence(undefined), undefined);
});
