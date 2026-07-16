import test from 'node:test';
import assert from 'node:assert/strict';

import {
  officialMasterReferenceUpc,
  mapOrderLi,
  canonicalOrderForIdempotency
} from '../../src/a2000/restMapper.js';

import {
  customerMasterOrderDefaults
} from '../../src/po/enrichment/masterData.js';

test('unique official VR_UPC_STYLE UPC maps to ORDER_LI REF', () => {
  const order = {
    customer_code: 'CITI',
    store_code: '184',
    order_no: 'TEST-UPC-REF',
    order_date: '2026-07-13',
    start_date: '2026-07-14',
    cancel_date: '2026-07-20',
    division_code: 'AL',
    terms_code: 'X6',
    warehouse_code: 'PE'
  };

  const line = {
    line_no: 1,
    style_code: '11KS306S9962',
    color_code: '0C9',
    warehouse_code: 'PE',
    qty_total: 100,
    qty_sz4: 100,
    raw_json: {
      master_upc: '199347556759',
      master_upc_source:
        'VR_UPC_STYLE_UNIQUE_MASTER_UPC'
    }
  };

  assert.equal(
    officialMasterReferenceUpc(line),
    '199347556759'
  );

  const row = mapOrderLi(order, line, 1234567, 1);

  assert.equal(row.REF, '199347556759');
  assert.equal(row.QTY_SZ4, 100);

  const canonical = canonicalOrderForIdempotency({
    ...order,
    purchase_order_lines: [line]
  });

  assert.equal(
    canonical.lines[0].reference_upc,
    '199347556759'
  );
});

test('raw customer UPC without official master provenance is never sent in REF', () => {
  const order = {
    customer_code: 'CITI',
    store_code: '184',
    order_no: 'TEST-UNSAFE-UPC',
    order_date: '2026-07-13',
    start_date: '2026-07-14',
    cancel_date: '2026-07-20',
    division_code: 'AL',
    terms_code: 'X6',
    warehouse_code: 'PE'
  };

  const line = {
    line_no: 1,
    style_code: '11KS306S9962',
    color_code: '0C9',
    warehouse_code: 'PE',
    qty_total: 100,
    qty_sz4: 100,
    raw_json: {
      customer_upc_raw: '400429913804'
    }
  };

  assert.equal(officialMasterReferenceUpc(line), '');

  const row = mapOrderLi(order, line, 1234567, 1);

  assert.equal('REF' in row, false);
});

test('Cancel Open Lines is exposed only from the official Customer Master row', () => {
  const masters = {
    customerByCode: new Map([
      ['CITI', {
        Customer: 'CITI',
        'Cancel Open Lines': 'Y',
        'Cancel Open Lines Source Column':
          'Cancel Open Lines'
      }]
    ])
  };

  const defaults = customerMasterOrderDefaults(
    'CITI',
    masters
  );

  assert.equal(defaults.cancel_open_lines, 'Y');
  assert.equal(
    defaults.cancel_open_lines_source_column,
    'Cancel Open Lines'
  );
  assert.equal(defaults.cancel_open_lines_authoritative, true);
  assert.equal(defaults.source, 'OFFICIAL_CUSTOMER_MASTER');
});
