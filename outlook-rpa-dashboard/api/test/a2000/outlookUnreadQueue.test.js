import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUnreadSearchAttempts, rowUnreadDecision, completeAttachmentCoverage } from '../../src/rpa/outlookUnreadQueue.js';

test('all Outlook attempts remain unread-only', () => {
  const attempts = buildUnreadSearchAttempts({ configuredQuery: 'subject:"factura american" hasattachments:yes isread:no', subjectFilter: 'factura american' });
  assert.ok(attempts.length >= 3);
  assert.ok(attempts.every(value => /isread:no/i.test(value)));
  assert.ok(attempts.every(value => !/isread:yes/i.test(value)));
});

test('explicit read row is never accepted even inside fallback logic', () => {
  assert.equal(rowUnreadDecision({ isRead: true, isUnread: false }, 'subject:"factura american" isread:no').accept, false);
  assert.equal(rowUnreadDecision({ isRead: false, isUnread: true }, '').accept, true);
});

test('coverage requires every expected PDF', () => {
  assert.deepEqual(completeAttachmentCoverage({ expected: ['a.pdf','b.pdf'], existing: ['a.pdf'], downloaded: ['b.pdf'] }), { expected_count: 2, available_count: 2, missing: [], complete: true });
});
