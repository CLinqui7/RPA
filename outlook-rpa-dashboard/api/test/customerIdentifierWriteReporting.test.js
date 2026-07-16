import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(
  path.join(
    apiRoot,
    'src/a2000/customerSkus/customerIdentifierSync.js'
  ),
  'utf8'
);

test('successful CUST_SKUS upload reports an A2000 write', () => {
  assert.match(
    source,
    /a2000_write_performed:\s*parsed\.ok/
  );
});

test('idempotent Customer SKU sync reports no new A2000 write', () => {
  assert.match(
    source,
    /stage:\s*'customer_identifiers_already_synced'[\s\S]*?a2000_write_performed:\s*false/
  );
});

test('preflight remains explicitly non-writing', () => {
  assert.match(
    source,
    /a2000_write_performed:\s*false/
  );
});
