import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  runScanDependencyStatus
} from '../src/runScan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..');
const runScanPath = path.join(apiRoot, 'src/runScan.js');
const serverPath = path.join(apiRoot, 'src/server.js');

const runScanSource = fs.readFileSync(runScanPath, 'utf8');
const serverSource = fs.readFileSync(serverPath, 'utf8');

test('all runScan dependencies are bound at module load', () => {
  const status = runScanDependencyStatus();

  assert.equal(status.ok, true);
  assert.deepEqual(status.missing, []);

  for (const dependency of [
    'scanOutlook',
    'createRun',
    'finishRun',
    'upsertEmails',
    'saveDownloadedDocuments',
    'processScannedDocuments',
    'syncCustomerIdentifiersForDocuments',
    'customerSkuAutoUploadEnabled'
  ]) {
    assert.equal(
      status.dependencies[dependency],
      'function',
      `${dependency} must be a function`
    );
  }
});

test('Customer SKU/UPC sync executes only once per scanner run', () => {
  const callCount = (
    runScanSource.match(
      /await\s+syncCustomerIdentifiersForDocuments\s*\(/g
    ) || []
  ).length;

  assert.equal(callCount, 1);
});

test('Outlook search keeps all generated attempts and safe fallback', () => {
  assert.doesNotMatch(
    runScanSource,
    /allAttempts\.slice\s*\(\s*0\s*,\s*1\s*\)/
  );

  assert.match(
    runScanSource,
    /OUTLOOK_ENABLE_INBOX_FALLBACK[\s\S]*true/
  );
});

test('Sales Order upload stays disabled during inbox reading', () => {
  assert.match(
    runScanSource,
    /processScannedDocuments[\s\S]*uploadToA2000:\s*false/
  );
});

test('server exposes dependency health and propagates run failures', () => {
  assert.match(
    serverSource,
    /\/run-scan\/dependencies/
  );

  assert.match(
    serverSource,
    /result\?\.run\?\.status\s*===\s*['"]error['"]/
  );

  assert.match(
    serverSource,
    /status:\s*runError\s*\?\s*['"]error['"]\s*:\s*['"]completed['"]/
  );

  assert.match(
    serverSource,
    /const\s+emails\s*=\s*Array\.isArray\(result\?\.emails\)/
  );

  assert.match(
    serverSource,
    /const\s+documents\s*=\s*Array\.isArray\(result\?\.documents\)/
  );

  assert.match(
    serverSource,
    /email_count:\s*emails\.length/
  );

  assert.match(
    serverSource,
    /document_count:\s*documents\.length/
  );
});
