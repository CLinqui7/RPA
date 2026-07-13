import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentCoverage,
  isBulkAttachmentDownloadAction,
  isPdfMagic,
  mergePdfAttachmentNames
} from '../../src/rpa/outlookAttachmentRecovery.js';

test('bulk Outlook attachment actions are blocked but single Download is allowed', () => {
  assert.equal(isBulkAttachmentDownloadAction('Download all'), true);
  assert.equal(isBulkAttachmentDownloadAction('Descargar todo'), true);
  assert.equal(isBulkAttachmentDownloadAction('Save all attachments'), true);
  assert.equal(isBulkAttachmentDownloadAction('Download'), false);
  assert.equal(isBulkAttachmentDownloadAction('Descargar'), false);
});

test('PDF magic rejects ZIP bytes even when a filename could be renamed to .pdf', () => {
  assert.equal(isPdfMagic(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(isPdfMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04])), false);
});

test('attachment name merge keeps all eight PDF attachments and dedupes repeat names', () => {
  const names = mergePdfAttachmentNames(
    [
      '1885387.pdf',
      '615628 earlier ship.pdf',
      '4587_476085_20260204134804 LINKIN PARK 1.pdf',
      '72041 American Exchange PO.pdf',
      'hardcopie nueva.pdf',
      'PurchaseOrder-0000194450-00-080900.pdf'
    ],
    [
      'POLINK 1.pdf',
      'hardcopie.PDF',
      '1885387.pdf',
      'factura american.zip'
    ]
  );

  assert.equal(names.length, 8);
  assert.equal(
    names.some(name => name.toLowerCase() === 'factura american.zip.pdf'),
    false
  );
});

test('attachment coverage requires every expected PDF before the email is complete', () => {
  const expected = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf'];

  const complete = attachmentCoverage(
    expected,
    ['a.pdf'],
    ['b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf']
  );

  assert.equal(complete.complete, true);
  assert.equal(complete.available_count, 6);
  assert.deepEqual(complete.missing, []);

  const incomplete = attachmentCoverage(
    expected,
    ['a.pdf'],
    ['b.pdf', 'c.pdf', 'd.pdf', 'e.pdf']
  );

  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missing, ['f.pdf']);
});
