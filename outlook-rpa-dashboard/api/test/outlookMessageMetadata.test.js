import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  configuredSubjectFromRow,
  inferOutlookMessageMetadata,
  outlookRowLines
} from '../src/rpa/outlookMessageMetadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..');
const scannerSource = fs.readFileSync(
  path.join(apiRoot, 'src/rpa/outlookScanner.js'),
  'utf8'
);

const sampleRow = [
  'CL',
  'carlos linqui',
  '\uE1B7',
  'facturas american',
  '10:37 AM',
  'Caution: This is an external email.',
  'Inbox'
].join('\n');

test('extracts the actual Outlook subject and sender from the row', () => {
  const result = inferOutlookMessageMetadata({
    rawSubject: 'Navigation pane',
    rowText: sampleRow,
    bodyText: 'Caution: This is an external email.',
    subjectFilter: 'factura american|facturas american'
  });

  assert.equal(result.subject, 'facturas american');
  assert.equal(result.senderName, 'carlos linqui');
  assert.equal(
    result.subjectSource,
    'message_list_exact_configured_subject'
  );
  assert.equal(result.rejectedRawSubject, 'Navigation pane');
});

test('never uses the pipe-delimited filter as the stored subject', () => {
  assert.equal(
    configuredSubjectFromRow(
      sampleRow,
      'factura american|facturas american'
    ),
    'facturas american'
  );

  assert.notEqual(
    inferOutlookMessageMetadata({
      rawSubject: '',
      rowText: sampleRow,
      subjectFilter: 'factura american|facturas american'
    }).subject,
    'factura american|facturas american'
  );
});

test('private-use icons do not become sender or subject lines', () => {
  const lines = outlookRowLines(sampleRow);
  assert.equal(lines.includes('\uE1B7'), false);
});

test('scanner recomputes analysis and identity after a correction', () => {
  assert.doesNotMatch(
    scannerSource,
    /email\.subject\s*=\s*config\.invoiceSubjectFilter/
  );

  assert.match(
    scannerSource,
    /OUTLOOK_EMAIL_METADATA_CORRECTED/
  );

  assert.match(
    scannerSource,
    /email\.analysis\s*=\s*analyzeEmail\(email\)/
  );

  assert.match(
    scannerSource,
    /email\.externalKey\s*=\s*stableKey\(email\)/
  );
});

test('unknown attachment occurrence coverage is observable', () => {
  assert.match(
    scannerSource,
    /OUTLOOK_ATTACHMENT_OCCURRENCE_COVERAGE_UNKNOWN/
  );
});
