import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentOccurrenceCoverage,
  classifyOutlookReadState
} from '../../src/rpa/outlookConversationGuards.js';

test('Unread is never misclassified as Read by substring overlap', () => {
  const state = classifyOutlookReadState({ labels: ['Unread'] });
  assert.equal(state.isUnread, true);
  assert.equal(state.isRead, false);
});

test('Mark as read means the Outlook row is currently unread', () => {
  const state = classifyOutlookReadState({ labels: ['Mark as read'] });
  assert.equal(state.isUnread, true);
  assert.equal(state.isRead, false);
});

test('Mark as unread means the Outlook row is currently read', () => {
  const state = classifyOutlookReadState({ labels: ['Mark as unread'] });
  assert.equal(state.isUnread, false);
  assert.equal(state.isRead, true);
});

test('two message groups with 5 and 10 PDF occurrences require all 15', () => {
  const expected = [
    ...Array.from({ length: 5 }, (_, index) => `carlos|${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `rafael|${index + 1}`)
  ];
  const partial = attachmentOccurrenceCoverage({
    expected,
    recovered: expected.slice(0, 14)
  });
  assert.equal(partial.expected_count, 15);
  assert.equal(partial.complete, false);
  assert.equal(partial.missing.length, 1);

  const complete = attachmentOccurrenceCoverage({ expected, recovered: expected });
  assert.equal(complete.recovered_count, 15);
  assert.equal(complete.complete, true);
});
