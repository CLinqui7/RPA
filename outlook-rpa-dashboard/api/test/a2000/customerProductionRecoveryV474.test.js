import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTillys } from '../../src/po/parsers/tillys.js';
import { parseMarshalls } from '../../src/po/parsers/marshalls.js';
import { parseMacysBacks } from '../../src/po/parsers/macysbacks.js';
import { applyCustomerReadingHardening } from '../../src/po/enrichment/customerReadingHardening.js';
import { A2000ScaleResolver } from '../../src/a2000/scaleResolver.js';

const tillysText = `
1253037A  AMERICAN EXCHANGE GROUP  108906  10/05/26  10/09/26
JORDAN  6/22/26  6/22/26
No  545067  ED HARDY W HILDY BAGUETTE BAG
122 EHH477-42-031  ONESZ
BURGUNDY
320 BURGUNDY  12.00  100
1  100  12.000  1,200.000  0/00/00  FINELINE Hang Tag  N/A
Nicole Stuhler Byr# 23 6/22/26
`;

test('TILLYS generic color parser reads the uploaded order without a BURGUNDY-only rule', () => {
  const parsed = parseTillys({ text: tillysText });

  assert.equal(parsed.header.order_no, '1253037A');
  assert.equal(parsed.header.order_date, '2026-06-22');
  assert.equal(parsed.header.start_date, '2026-10-05');
  assert.equal(parsed.header.cancel_date, '2026-10-09');
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].style_raw, 'EHH477-42-031');
  assert.equal(parsed.lines[0].size_raw, 'ONESZ');
  assert.equal(parsed.lines[0].color_raw, 'BURGUNDY');
  assert.equal(parsed.lines[0].raw.customer_color_code_raw, '320');
  assert.equal(parsed.lines[0].sales_price, 12);
  assert.equal(parsed.lines[0].qty_total, 100);
});

test('TILLYS persisted official UPC provenance activates the PC fallback when live VR_SKU_Z has no row', async () => {
  const client = {
    async viewer() {
      return { httpStatus: 200, rows: [] };
    }
  };

  const resolver = new A2000ScaleResolver(client);
  const result = await resolver.validateLine(
    { division_code: 'MJ' },
    {
      line_no: 1,
      style_code: 'EHH477-42',
      color_code: '031',
      scale_code: 'PC',
      size_raw: 'ONESZ',
      qty_total: 100,
      qty_sz1: 100,
      raw: {
        master_upc: '199347655421',
        master_upc_source: 'VR_UPC_STYLE_UNIQUE_MASTER_UPC'
      }
    },
    0
  );

  assert.equal(result.valid, true);
  assert.equal(result.source, 'OFFICIAL_MASTER_UPC_PC_SINGLE_BUCKET_FALLBACK');
  assert.equal(result.distribution[1], 100);
});

const marshallsText = `
ROUTING AND DISTRIBUTION INSTRUCTIONS
PO Number: 314654
Dept #  Order Date  Start Ship Date  Consolidator Cancel Date
28  2/25/2026  3/7/2026  3/14/2026
Ship Merchandise to:
BRI: BRIDGEWATER
DC #: 886
PG-LN  Vendor Style #  TJX Style #  Description  Color  Vendor Pack Size  Store Ready Pack Size  Nest Code  Total Units  BRI DC# 886 Units
1-1  HANZB-006  488733  HANZ-B BOYS DOUBLE BUCKLE FOOTBED  BROWN  0  0  0  192  192
1-2  HANZB-TAU  488738  HANZ-B BOYS DOUBLE BUCKLE FOOTBED  TAUPE  0  0  0  192  192
1-3  BARRETTB-285  488741  BARRETT-B CLOSED TOE FOOTBED W BUCKLE  CHOCOLATE  0  0  0  144  144
1-4  BARRETTB-003  488746  BARRETT-B CLOSED TOE FOOTBED W BUCKLE  BLACK  0  0  0  216  216
1-5  BARRETTB-TAU  488748  BARRETT-B CLOSED TOE FOOTBED W BUCKLE  TAUPE  0  0  0  216  216
`;

test('MARSHALLS parser reads all five Total Units and destination DC Units', () => {
  const parsed = parseMarshalls({ text: marshallsText });

  assert.equal(parsed.header.order_no, '314654');
  assert.equal(parsed.header.store_raw, '886');
  assert.deepEqual(
    parsed.lines.map(line => line.qty_total),
    [192, 192, 144, 216, 216]
  );
  assert.deepEqual(
    parsed.lines.map(line => line.raw.dc_units_raw),
    [192, 192, 144, 216, 216]
  );
  assert.equal(parsed.totals.qty, 960);
  assert.ok(parsed.lines.every(line => line.sales_price === null));
});

test('MARSHALLS exact official ratio turns Total Units into QTY_SZn and keeps SALES_PRICE omitted', () => {
  const parsed = {
    header: { customer_code: 'MARSHALLS' },
    lines: [{
      line_no: 1,
      style_code: 'HANZB',
      color_code: '006',
      qty_total: 192,
      sales_price: null,
      raw: {
        total_units_raw: 192,
        dc_units_raw: 192,
        quantity_semantics: 'EACH'
      }
    }],
    conflicts: [],
    warnings: []
  };

  const masters = {
    loaded: true,
    skuZByStyleColor: new Map([
      ['HANZB|006', [
        { 'Size Num': '4', 'Size Name': '6', 'Scale Qty': '2', Scale: 'v0', Active: 'Y' },
        { 'Size Num': '5', 'Size Name': '7', 'Scale Qty': '4', Scale: 'v0', Active: 'Y' },
        { 'Size Num': '6', 'Size Name': '8', 'Scale Qty': '4', Scale: 'v0', Active: 'Y' },
        { 'Size Num': '7', 'Size Name': '9', 'Scale Qty': '2', Scale: 'v0', Active: 'Y' }
      ]]
    ]),
    skuZByStyleColorSize: new Map()
  };

  applyCustomerReadingHardening(parsed, masters);

  assert.equal(parsed.lines[0].qty_sz4, 32);
  assert.equal(parsed.lines[0].qty_sz5, 64);
  assert.equal(parsed.lines[0].qty_sz6, 64);
  assert.equal(parsed.lines[0].qty_sz7, 32);
  assert.equal(parsed.lines[0].sales_price, null);
  assert.equal(parsed.totals.qty, 192);
  assert.equal(parsed.totals.destination_dc_units_verified, true);
});

test('MARSHALLS blocks a Total Units versus DC Units mismatch', () => {
  const parsed = {
    header: { customer_code: 'MARSHALLS' },
    lines: [{
      line_no: 1,
      style_code: 'HANZB',
      color_code: '006',
      qty_total: 192,
      raw: {
        total_units_raw: 192,
        dc_units_raw: 191,
        quantity_semantics: 'EACH'
      }
    }],
    conflicts: [],
    warnings: []
  };

  applyCustomerReadingHardening(parsed, {
    loaded: true,
    skuZByStyleColor: new Map(),
    skuZByStyleColorSize: new Map()
  });

  assert.ok(
    parsed.conflicts.some(
      item => item.code === 'marshalls_total_units_dc_units_mismatch'
        && item.blocking === true
    )
  );
});

const macysText = `
MACYS BACKSTAGE
VENDOR NAME: AMERICAN EXCHANGE GROUP ROUTE/START SHIP DATE: 03/16/2026
IN MACYS BACKSTAGE DC BY: 03/30/2026
PO# 4931768
DEPT #: 123
Vendor #: 108906
Terms: NET 60
PLEASE SHIP TO THE BELOW ADDRESS
MACYS BACKSTAGE COLUMBUS
Vendor Style Number  Description  NRF Color Description  Backstage Cost  Total Units  Ext Cost
1  A2018S-42-B28  TEST ITEM  SILVER  $9.50  200  $1,900.00
`;

test('MACYSBACKS uses the immutable first document ingestion date as ORDER_DATE', () => {
  const parsed = parseMacysBacks({
    text: macysText,
    document: {
      created_at: '2026-07-13T18:00:00.000Z'
    }
  });

  assert.equal(parsed.header.order_date, '2026-07-13');
  assert.equal(
    parsed.header.raw.order_date_source,
    'EMAIL_FIRST_INGESTION_DATE'
  );
  assert.equal(
    parsed.header.raw.order_date_timezone,
    'America/El_Salvador'
  );
});
