import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInternalOrder, mapOrderLi } from '../../src/a2000/restMapper.js';

const order = {
  customer_code:'CITI', store_code:'SAME', order_no:'X1', order_date:'2026-01-01', start_date:'2026-01-02', cancel_date:'2026-01-03', division_code:'FA', terms_code:'X6', warehouse_code:'PE',
  purchase_order_lines:[{ line_no:1, style_code:'STYLE1', color_code:'001', qty_total:10, qty_sz1:10, warehouse_code:'PE', sales_price:null }]
};

test('sales price is optional and omitted rather than converted to zero', () => {
  const validation = validateInternalOrder(order);
  assert.equal(validation.valid, true);
  assert.ok(validation.warnings.some(item => item.code === 'SALES_PRICE_OMITTED'));
  const row = mapOrderLi(order, order.purchase_order_lines[0], 123, 1);
  assert.equal(Object.hasOwn(row, 'SALES_PRICE'), false);
  assert.equal(row.QTY_SZ1, 10);
});

test('qty bucket remains required because ORDER_LI has no generic qty_total field', () => {
  const broken = structuredClone(order);
  delete broken.purchase_order_lines[0].qty_sz1;
  assert.equal(validateInternalOrder(broken).valid, false);
});
