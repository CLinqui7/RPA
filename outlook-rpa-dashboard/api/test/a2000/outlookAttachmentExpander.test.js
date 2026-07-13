import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAttachmentExpanderLabel
} from '../../src/rpa/outlookAttachmentRecovery.js';

test('English Outlook collapsed attachment group is recognized', () => {
  assert.equal(isAttachmentExpanderLabel('Show all 6 attachments (601 KB)'), true);
});

test('Spanish Outlook collapsed attachment group is recognized', () => {
  assert.equal(isAttachmentExpanderLabel('Mostrar los 6 archivos adjuntos (601 KB)'), true);
});

test('Download all is not mistaken for attachment expander', () => {
  assert.equal(isAttachmentExpanderLabel('Download all'), false);
});
