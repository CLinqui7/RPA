import test from 'node:test';
import assert from 'node:assert/strict';
import { stableKey } from '../../src/parser.js';

function email(currentUrl, attachments) {
  return {
    subject: 'factura american',
    senderEmail: 'same@example.com',
    receivedAt: null,
    poNumber: null,
    ptNumber: null,
    snippet: 'Caution: external email',
    attachments,
    raw: { currentUrl }
  };
}

test('two same-subject Outlook messages use message URL identity and do not collapse', () => {
  const first = stableKey(email('https://outlook.office.com/mail/inbox/id/AAA', ['a.pdf', 'b.pdf']));
  const second = stableKey(email('https://outlook.office.com/mail/inbox/id/BBB', ['a.pdf', 'b.pdf']));
  assert.notEqual(first, second);
});

test('attachment order does not change the stable email key', () => {
  const first = stableKey(email('https://outlook.office.com/mail/inbox/id/AAA', ['a.pdf', 'b.pdf']));
  const reordered = stableKey(email('https://outlook.office.com/mail/inbox/id/AAA', ['b.pdf', 'a.pdf']));
  assert.equal(first, reordered);
});
