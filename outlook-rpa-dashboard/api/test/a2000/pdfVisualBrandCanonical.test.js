import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPdfVisualBrandFromBuffer
} from '../../src/po/pdfVisualBrand.js';
import { extractPdfTextFromBuffer } from '../../src/po/pdfText.js';
import { parsePurchaseOrders } from '../../src/po/parsers/index.js';

const cwd = path.resolve(process.cwd());
const apiRoot = path.basename(cwd) === 'api' ? cwd : path.join(cwd, 'api');
const sourceRoot = path.join(apiRoot, 'training', 'all_customer_source_fixtures');

const versonaPath = path.join(sourceRoot, 'Versona', '615628 earlier ship.pdf');
const itsFashionPath = path.join(sourceRoot, 'ITSFASHION', 'stainless steel AMEX PO.pdf');

test('canonical Versona embedded logo is detected without filename/subject metadata', async () => {
  const buffer = await fs.readFile(versonaPath);
  const brand = await detectPdfVisualBrandFromBuffer(buffer);
  assert.equal(brand?.code, 'VERSONA');

  const text = await extractPdfTextFromBuffer(buffer);
  assert.match(text, /\[A2000_PDF_VISUAL_BRAND:VERSONA:/);

  const orders = parsePurchaseOrders({
    text,
    fileName: 'opaque-615628.pdf',
    document: {
      file_name: 'opaque-615628.pdf',
      subject: 'factura american',
      source: 'visual_brand_test'
    }
  });

  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.header?.customer_code, 'VERSONA');
  assert.equal(orders[0]?.header?.order_no, '615628');
  assert.equal(orders[0]?.status, 'parsed');
});

test("canonical It's Fashion embedded logo identifies six orders without customer metadata", async () => {
  const buffer = await fs.readFile(itsFashionPath);
  const brand = await detectPdfVisualBrandFromBuffer(buffer);
  assert.equal(brand?.code, 'ITSFASHION');

  const text = await extractPdfTextFromBuffer(buffer);
  assert.match(text, /\[A2000_PDF_VISUAL_BRAND:ITSFASHION:/);

  const orders = parsePurchaseOrders({
    text,
    fileName: 'opaque-multi-order.pdf',
    document: {
      file_name: 'opaque-multi-order.pdf',
      subject: 'factura american',
      source: 'visual_brand_test'
    }
  });

  assert.equal(orders.length, 6);
  assert.ok(orders.every(order => order.header?.customer_code === 'ITSFASHION'));
  assert.ok(orders.every(order => order.status === 'parsed'));
});
