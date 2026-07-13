import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUnreadSearchAttempts,
  rowUnreadDecision,
  subjectFilterAlternatives
} from '../../src/rpa/outlookUnreadQueue.js';

test('Factura American and Facturas American are always aliases', () => {
  assert.deepEqual(
    subjectFilterAlternatives('facturas american').sort(),
    ['factura american', 'facturas american'].sort()
  );
});

test('search attempts include both singular and plural subjects', () => {
  const attempts = buildUnreadSearchAttempts({
    configuredQuery: 'subject:"factura american" hasattachments:yes isread:no',
    subjectFilter: 'facturas american'
  });

  assert.ok(attempts.some(value => value.includes('subject:"factura american"')));
  assert.ok(attempts.some(value => value.includes('subject:"facturas american"')));
  assert.ok(attempts.includes('american isread:no'));
  assert.ok(attempts.every(value => /isread:no/i.test(value)));
});

test('raw inbox fallback never accepts unknown read state', () => {
  const decision = rowUnreadDecision(
    { isRead: false, isUnread: false, readStateSource: 'unknown' },
    '__INBOX_DOM_UNREAD_FALLBACK__'
  );
  assert.equal(decision.accept, false);
});

test('raw inbox fallback accepts explicit unread state', () => {
  const decision = rowUnreadDecision(
    { isRead: false, isUnread: true, readStateSource: 'data_is_read_false' },
    '__INBOX_DOM_UNREAD_FALLBACK__'
  );
  assert.equal(decision.accept, true);
});
