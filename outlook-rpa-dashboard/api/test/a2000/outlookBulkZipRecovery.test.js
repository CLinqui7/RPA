import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isZipMagic,
  pdfArchiveEntries
} from '../../src/rpa/outlookAttachmentRecovery.js';

test('ZIP magic accepts normal, empty and spanned PK signatures', () => {
  assert.equal(isZipMagic(Buffer.from('504b0304', 'hex')), true);
  assert.equal(isZipMagic(Buffer.from('504b0506', 'hex')), true);
  assert.equal(isZipMagic(Buffer.from('504b0708', 'hex')), true);
  assert.equal(isZipMagic(Buffer.from('%PDF-1.7')), false);
});

test('archive PDF inventory keeps every unique PDF and ignores non-PDF entries', () => {
  assert.deepEqual(
    pdfArchiveEntries([
      '1885387.pdf',
      'folder/615628 earlier ship.pdf',
      'folder/615628 earlier ship.pdf',
      'notes.txt',
      'nested/PurchaseOrder-0000199431-00-009721.pdf',
      'folder/'
    ]),
    [
      { entry: '1885387.pdf', fileName: '1885387.pdf' },
      { entry: 'folder/615628 earlier ship.pdf', fileName: '615628 earlier ship.pdf' },
      {
        entry: 'nested/PurchaseOrder-0000199431-00-009721.pdf',
        fileName: 'PurchaseOrder-0000199431-00-009721.pdf'
      }
    ]
  );
});

