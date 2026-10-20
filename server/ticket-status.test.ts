import assert from 'node:assert/strict';
import test from 'node:test';
import { statusStyle } from '../src/ticket-status.js';

test('status badges use configured colours with readable text and a name fallback', () => {
  const statuses = [
    { id: 1, name: 'New', color: '#ffffff' },
    { id: 2, name: 'In Progress', color: '#2196F3' },
    { id: 3, name: 'Closed', color: '#222222' },
    { id: 4, name: 'Unsafe', color: 'red;display:none' },
  ];
  assert.deepEqual(statusStyle(1, 'New', statuses), { backgroundColor: '#ffffff', borderColor: '#cbd7e5', color: '#172438' });
  assert.equal(statusStyle(2, 'In Progress', statuses)?.color, '#172438');
  assert.equal(statusStyle(3, 'Closed', statuses)?.color, '#fff');
  assert.equal(statusStyle(undefined, 'new', statuses)?.backgroundColor, '#ffffff');
  assert.equal(statusStyle(999, 'New', statuses), undefined);
  assert.equal(statusStyle(4, 'Unsafe', statuses), undefined);
});
