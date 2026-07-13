import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCustomerReadingHardening } from '../../src/po/enrichment/customerReadingHardening.js';

function skuZRows(style, color, scale, entries, extra = {}) {
  return entries.map(([sizeNum, sizeName, scaleQty]) => ({
    Style: style,
    Clr: color,
    Scale: scale,
    'Scale Abbr': extra.scaleAbbr || scale,
    'Size Num': String(sizeNum),
    'Size Name': String(sizeName),
    'Scale Qty': String(scaleQty),
    'Scale Pack Qty': String(extra.scalePackQty || 0),
    'Pack Qty': String(extra.packQty || 0),
    Div: extra.div || 'MJ',
    Active: 'Y'
  }));
}

function fakeMasters() {
  const rt = skuZRows('WILLA01L', 'SGA', 'RT', [
    [1, '6', 1], [2, '7', 1], [3, '7.5', 1], [4, '8', 2],
    [5, '8.5', 2], [6, '9', 2], [7, '10', 2], [8, '11', 1]
  ]);
  const rt2 = rt.map(row => ({ ...row, Style: 'RYNN05L', Clr: 'WHA' }));
  const gk = skuZRows('WELMA61K', 'MDA', 'GK', [
    [1, '10', 1], [2, '11', 1], [3, '12', 1], [4, '13', 1],
    [5, '1', 2], [6, '2', 2], [7, '3', 2], [8, '4', 2]
  ], { scalePackQty: 12, packQty: 12 });
  const gk2 = gk.map(row => ({ ...row, Clr: 'FSA' }));
  const carnivalRows = skuZRows('133CARNIVA01', '003', 'c1', [
    [1, 'M6/W8', 1], [2, 'M7/W9', 1], [3, 'M8/W10', 1],
    [4, 'M9/W11', 1], [5, 'M10/W12', 1], [6, 'M11/W13', 1],
    [7, 'M12/W14', 1]
  ]);

  const byStyleColor = new Map([
    ['WILLA01L|SGA', rt],
    ['RYNN05L|WHA', rt2],
    ['WELMA61K|MDA', gk],
    ['WELMA61K|FSA', gk2],
    ['133CARNIVA01|003', carnivalRows]
  ]);
  const byStyleColorSize = new Map();
  for (const row of carnivalRows) {
    const sizeNorm = String(row['Size Name']).toUpperCase().replace(/[^A-Z0-9]/g, '');
    byStyleColorSize.set(`133CARNIVA01|003|${sizeNorm}`, [row]);
  }

  return {
    loaded: true,
    skuZByStyleColor: byStyleColor,
    skuZByStyleColorSize: byStyleColorSize
  };
}

function buckets(line) {
  const out = {};
  for (let index = 1; index <= 18; index += 1) {
    const value = Number(line[`qty_sz${index}`] || 0);
    if (value > 0) out[`qty_sz${index}`] = value;
  }
  return out;
}

test('10BELOW distributes total EACH by exact official RT ratio and matching printed range', () => {
  const parsed = {
    parser: 'tenbelow',
    header: { customer_code: '10BELOW', raw: {} },
    lines: [
      { line_no: 1, style_code: 'WILLA01L', color_code: 'SGA', size_raw: '6 to 11', scale_code: 'RT', qty_total: 240, master_upc: '194866934613', raw: { quantity_semantics: 'TOTAL_EACH_UNDISTRIBUTED' } },
      { line_no: 2, style_code: 'RYNN05L', color_code: 'WHA', size_raw: '6 to 11', scale_code: 'RT', qty_total: 300, master_upc: '194866886837', raw: { quantity_semantics: 'TOTAL_EACH_UNDISTRIBUTED' } }
    ],
    conflicts: [], warnings: []
  };

  applyCustomerReadingHardening(parsed, fakeMasters());

  assert.deepEqual(buckets(parsed.lines[0]), {
    qty_sz1: 20, qty_sz2: 20, qty_sz3: 20, qty_sz4: 40,
    qty_sz5: 40, qty_sz6: 40, qty_sz7: 40, qty_sz8: 20
  });
  assert.deepEqual(buckets(parsed.lines[1]), {
    qty_sz1: 25, qty_sz2: 25, qty_sz3: 25, qty_sz4: 50,
    qty_sz5: 50, qty_sz6: 50, qty_sz7: 50, qty_sz8: 25
  });
  assert.equal(parsed.lines[0].master_upc, '194866934613');
});

test('10BELOW refuses ratio when printed range does not exactly cover official scale range', () => {
  const parsed = {
    parser: 'tenbelow',
    header: { customer_code: '10BELOW', raw: {} },
    lines: [{ line_no: 1, style_code: 'WILLA01L', color_code: 'SGA', size_raw: '7 to 11', scale_code: 'RT', qty_total: 240, raw: { quantity_semantics: 'TOTAL_EACH_UNDISTRIBUTED' } }],
    conflicts: [], warnings: []
  };

  applyCustomerReadingHardening(parsed, fakeMasters());
  assert.deepEqual(buckets(parsed.lines[0]), {});
});

test('GABRIELBRO distributes total EACH only when PDF case pack equals official ratio total', () => {
  const parsed = {
    parser: 'gabes',
    header: { customer_code: 'GABRIELBRO', raw: {} },
    lines: [
      { line_no: 1, style_code: 'WELMA61K', color_code: 'MDA', scale_code: 'GK', qty_total: 504, raw: { quantity_semantics: 'EACH', case_pack_raw: 12 } },
      { line_no: 2, style_code: 'WELMA61K', color_code: 'FSA', scale_code: 'GK', qty_total: 660, raw: { quantity_semantics: 'EACH', case_pack_raw: 12 } }
    ],
    conflicts: [], warnings: []
  };

  applyCustomerReadingHardening(parsed, fakeMasters());

  assert.deepEqual(buckets(parsed.lines[0]), {
    qty_sz1: 42, qty_sz2: 42, qty_sz3: 42, qty_sz4: 42,
    qty_sz5: 84, qty_sz6: 84, qty_sz7: 84, qty_sz8: 84
  });
  assert.deepEqual(buckets(parsed.lines[1]), {
    qty_sz1: 55, qty_sz2: 55, qty_sz3: 55, qty_sz4: 55,
    qty_sz5: 110, qty_sz6: 110, qty_sz7: 110, qty_sz8: 110
  });
});

test('Carnival maps CASE count times pack to exact size bucket and leaves sales price optional', () => {
  const parsed = {
    parser: 'carnival',
    header: { customer_code: 'CARNIVAL', raw: {} },
    totals: { amount: 2441.88, raw_ordered_quantity: 68 },
    lines: [{
      line_no: 1,
      style_code: '133CARNIVA01',
      color_code: '003',
      size_raw: 'M6/W8',
      scale_code: 'c1',
      qty_total: 68,
      sales_price: 35.91,
      master_upc: '196540797156',
      raw: { quantity_semantics: 'CASE', pack_qty_candidate_raw: 6 }
    }],
    conflicts: [], warnings: []
  };

  applyCustomerReadingHardening(parsed, fakeMasters());

  assert.equal(parsed.lines[0].qty_total, 408);
  assert.deepEqual(buckets(parsed.lines[0]), { qty_sz1: 408 });
  assert.equal(parsed.lines[0].sales_price, null);
  assert.equal(parsed.lines[0].master_upc, '196540797156');
  assert.equal(parsed.lines[0].raw.case_to_each_conversion.exact_each_price_candidate, 5.985);
  assert.equal(
    parsed.conflicts.some(item => item.code === 'carnival_each_sales_price_requires_source_rule'),
    false
  );
});

test('IPC applies only the narrow same-MM/DD one-year typo correction and preserves both raw dates', () => {
  const parsed = {
    parser: 'ipc',
    header: {
      customer_code: 'IPC',
      order_date: '2026-02-04',
      start_date: '2026-05-08',
      raw: {
        pickup_date_raw: '5/8/26',
        instruction_pickup_date_raw: '05/08/25'
      }
    },
    lines: [],
    conflicts: [{ code: 'source_date_conflict', field: 'pickup_date', blocking: true }],
    warnings: []
  };

  applyCustomerReadingHardening(parsed, fakeMasters());

  assert.equal(parsed.header.start_date, '2026-05-08');
  assert.equal(parsed.conflicts.some(item => item.code === 'source_date_conflict'), false);
  assert.equal(parsed.header.raw.pickup_date_raw, '5/8/26');
  assert.equal(parsed.header.raw.instruction_pickup_date_raw, '05/08/25');
  assert.equal(parsed.header.raw.pickup_date_resolution.preserved_earlier_source_date, '2025-05-08');
  assert.ok(parsed.warnings.some(item => item.code === 'source_date_year_typo_corrected'));
});

test('Versona removes only PO 615628 business-review blocker and preserves printed order number', () => {
  const parsed = {
    parser: 'catocorp',
    header: { customer_code: 'VERSONA', order_no: '615628', raw: {} },
    lines: [],
    conflicts: [
      { code: 'order_no_requires_business_review', field: 'order_no', blocking: true },
      { code: 'another_real_conflict', field: 'x', blocking: true }
    ],
    warnings: []
  };

  applyCustomerReadingHardening(parsed, fakeMasters());

  assert.equal(parsed.header.order_no, '615628');
  assert.equal(parsed.conflicts.some(item => item.code === 'order_no_requires_business_review'), false);
  assert.equal(parsed.conflicts.some(item => item.code === 'another_real_conflict'), true);
});

test('unrelated explicit size distribution remains unchanged', () => {
  const parsed = {
    parser: 'bealls',
    header: { customer_code: 'BEALLSOUTL', raw: {} },
    lines: [{ line_no: 1, style_code: '03HOSTARYK', color_code: '001', qty_total: 46, qty_sz5: 46, raw: {} }],
    conflicts: [], warnings: []
  };
  applyCustomerReadingHardening(parsed, fakeMasters());
  assert.deepEqual(buckets(parsed.lines[0]), { qty_sz5: 46 });
});
