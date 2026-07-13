import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(apiRoot, 'src', 'po', 'poRepository.js'), 'utf8');
const migration = fs.readFileSync(path.join(apiRoot, 'sql', 'purchase_orders_multi_order_document.sql'), 'utf8');

test('persistence keeps legacy single-order mode safe until composite schema is explicitly enabled', () => {
  assert.match(source, /parsePurchaseOrder,\s*parsePurchaseOrders/);
  assert.match(source, /A2000_MULTI_ORDER_PERSISTENCE_READY/);
  assert.match(source, /const multiOrderMode = multiOrderPersistenceReady\(\)/);
  assert.match(source, /multiOrderMode\s*\?\s*parsePurchaseOrders\(/);
  assert.match(source, /:\s*\[parsePurchaseOrder\(/);
  assert.match(source, /onConflict:\s*'document_id'/);
});

test('multi-order mode uses document_id + order_no only behind the schema-ready gate', () => {
  assert.match(source, /multiOrderPersistenceReady\(\) && orderNo/);
  assert.match(source, /onConflict:\s*'document_id,order_no'/);
  assert.match(source, /for \(const \[orderIndex, parsed\] of parsedOrders\.entries\(\)\)/);
  assert.match(source, /processed_order_count:/);
  assert.match(source, /multi_order_persistence_ready:/);
  assert.match(source, /source_document_order_count:/);
});

test('multi-order migration replaces document-only uniqueness with composite document_id + order_no uniqueness', () => {
  assert.match(migration, /purchase_orders_document_order_uq/i);
  assert.match(migration, /document_id\s*,\s*order_no/i);
  assert.match(migration, /DROP CONSTRAINT/i);
  assert.match(migration, /CREATE UNIQUE INDEX/i);
});
