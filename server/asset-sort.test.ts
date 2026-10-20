import assert from 'node:assert/strict';
import test from 'node:test';
import { prioritizeSenderDevices, senderUsesDevice } from '../src/asset-sort.js';

test('sender devices come first without mistaking another user or a custom asset for a match', () => {
  const assets = [
    { id: 'other', name: 'Other laptop', kind: 'agent' as const, details: { lastLoggedOnUserUpn: 'other@example.com' } },
    { id: 'custom', name: 'Custom item', kind: 'custom' as const, details: { lastLoggedOnUserUpn: 'ada@example.com' } },
    { id: 'sender', name: 'Sender laptop', kind: 'agent' as const, details: { lastLoggedOnUserUpn: 'ADA@example.com' } },
  ];
  assert.deepEqual(prioritizeSenderDevices(assets, 'ada@example.com').map((asset) => asset.id), ['sender', 'other', 'custom']);
  assert.equal(senderUsesDevice(assets[0]!, 'ada@example.com'), false);
  assert.equal(senderUsesDevice(assets[1]!, 'ada@example.com'), false);
  assert.deepEqual(assets.map((asset) => asset.id), ['other', 'custom', 'sender']);
});

test('a Windows AzureAD username matches a contact email without punctuation in its local part', () => {
  const device = { id: 'device', name: 'Laptop', kind: 'agent' as const, details: { lastLoggedOnUser: 'AzureAD\\AlexTaylor' } };
  assert.equal(senderUsesDevice(device, 'alex.taylor@example.com'), true);
  assert.equal(senderUsesDevice(device, 'alex.taylorson@example.com'), false);
  assert.equal(senderUsesDevice({ ...device, details: { ...device.details, lastLoggedOnUserUpn: 'someone@example.com' } }, 'alex.taylor@example.com'), false);
});
