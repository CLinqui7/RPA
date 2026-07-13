import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIdempotencyKey,
  mapOrderLi,
  validateInternalOrder
} from '../../src/a2000/restMapper.js';

const order = {
  status: 'parsed',
  conflicts: [],
  customer_code: 'CITI',
  store_code: '1',
  order_no: 'TEST123',
  order_date: '07/09/26',
  start_date: '07/16/26',
  cancel_date: '07/23/26',
  division_code: 'AL',
  terms_code: 'X6',
  warehouse_code: 'PE'
};

test('REST mapper uses STORE_NO and preserves exact qty buckets', () => {
  const row = mapOrderLi(
    order,
    {
      line_no: 1,
      style_code: '11KS306S9962',
      color_code: '0C9',
      sales_price: 7.1429,
      warehouse_code: 'PE',
      qty_total: 576,
      qty_sz4: 96,
      qty_sz5: 192,
      qty_sz6: 192,
      qty_sz7: 96
    },
    3758963,
    1
  );

  assert.equal(row.STORE_NO, '1');
  assert.equal(Object.hasOwn(row, '_NO'), false);
  assert.equal(row.QTY_SZ4, 96);
  assert.equal(row.QTY_SZ5, 192);
  assert.equal(row.QTY_SZ6, 192);
  assert.equal(row.QTY_SZ7, 96);
  assert.equal(Object.hasOwn(row, 'QTY_SZ1'), false);
});

test('preflight rejects qty_total without a real size distribution', () => {
  const result = validateInternalOrder({
    ...order,
    purchase_order_lines: [{
      line_no: 1,
      style_code: '11KS306S9962',
      color_code: '0C9',
      sales_price: 7.1429,
      warehouse_code: 'PE',
      qty_total: 576
    }]
  });

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      error => error.field === 'qty_size_distribution'
    )
  );
});

test('idempotency key is stable for the same canonical A2000 payload', () => {
  const payload = {
    ...order,
    purchase_order_lines: [{
      line_no: 1,
      style_code: '11KS306S9962',
      color_code: '0C9',
      sales_price: 7.1429,
      warehouse_code: 'PE',
      qty_total: 576,
      qty_sz4: 96,
      qty_sz5: 192,
      qty_sz6: 192,
      qty_sz7: 96
    }]
  };

  assert.equal(
    buildIdempotencyKey(payload),
    buildIdempotencyKey(JSON.parse(JSON.stringify(payload)))
  );
});
