import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutlookReadState } from '../../src/rpa/outlookConversationGuards.js';

test('Mark as read means the message is currently unread', () => {
  const state = classifyOutlookReadState({ labels: ['Mark as read'] });
  assert.equal(state.isUnread, true);
  assert.equal(state.isRead, false);
});

test('Facturas American bold Outlook row is accepted as unread fallback', () => {
  const state = classifyOutlookReadState({
    labels: [],
    classText: '',
    maxFontWeight: 700
  });
  assert.equal(state.isUnread, true);
  assert.equal(state.source, 'bold_unread_row');
});

test('explicit data-isread=true overrides bold text', () => {
  const state = classifyOutlookReadState({
    dataIsRead: 'true',
    maxFontWeight: 700
  });
  assert.equal(state.isRead, true);
  assert.equal(state.isUnread, false);
});
