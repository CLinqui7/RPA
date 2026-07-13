import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateCitiSizeRows,
  mapExtractedSizeToBucket,
  quantitiesByBucket,
  validateDistributionAgainstScaleRows
} from '../../src/po/enrichment/sizeScaleMapping.js';

const rows = [
  { Style: '11KS306S9962', Clr: '0C9', 'Size Num': 1, 'Size Name': '4', 'Scale Qty': 0, 'Scale Pack Qty': 6, 'Pack Qty': 6, Scale: 'v0', 'Scale Abbr': '4..16', Div: 'AL', Active: 'Y' },
  { Style: '11KS306S9962', Clr: '0C9', 'Size Num': 2, 'Size Name': '5', 'Scale Qty': 0, 'Scale Pack Qty': 6, 'Pack Qty': 6, Scale: 'v0', 'Scale Abbr': '4..16', Div: 'AL', Active: 'Y' },
  { Style: '11KS306S9962', Clr: '0C9', 'Size Num': 3, 'Size Name': '6', 'Scale Qty': 0, 'Scale Pack Qty': 6, 'Pack Qty': 6, Scale: 'v0', 'Scale Abbr': '4..16', Div: 'AL', Active: 'Y' },
  { Style: '11KS306S9962', Clr: '0C9', 'Size Num': 4, 'Size Name': '7', 'Scale Qty': 1, 'Scale Pack Qty': 6, 'Pack Qty': 6, Scale: 'v0', 'Scale Abbr': '4..16', Div: 'AL', Active: 'Y' },
  { Style: '11KS306S9962', Clr: '0C9', 'Size Num': 5, 'Size Name': '8/10', 'Scale Qty': 2, 'Scale Pack Qty': 6, 'Pack Qty': 6, Scale: 'v0', 'Scale Abbr': '4..16', Div: 'AL', Active: 'Y' },
  { Style: '11KS306S9962', Clr: '0C9', 'Size Num': 6, 'Size Name': '12/14', 'Scale Qty': 2, 'Scale Pack Qty': 6, 'Pack Qty': 6, Scale: 'v0', 'Scale Abbr': '4..16', Div: 'AL', Active: 'Y' },
  { Style: '11KS306S9962', Clr: '0C9', 'Size Num': 7, 'Size Name': '16', 'Scale Qty': 1, 'Scale Pack Qty': 6, 'Pack Qty': 6, Scale: 'v0', 'Scale Abbr': '4..16', Div: 'AL', Active: 'Y' }
];

const masters = {
  skuZByStyleColor: new Map([
    ['11KS306S9962|0C9', rows]
  ]),
  skuZByStyleColorSize: new Map(
    rows.map(row => [
      `11KS306S9962|0C9|${String(row['Size Name']).replace(/[^A-Z0-9]/gi, '').toUpperCase()}`,
      [row]
    ])
  )
};

function line(size, qty) {
  return {
    style_code: '11KS306S9962',
    color_code: '0C9',
    size_raw: size,
    qty_total: qty,
    sales_price: 7.1429,
    warehouse_code: 'PE',
    scale_code: 'v0',
    raw: {
      quantity_semantics: 'EACH'
    }
  };
}

test('existing positive Citi PC bucket is preserved and never cleared', () => {
  const value = {
    ...line('-', 638),
    scale_code: 'PC',
    qty_sz1: 638
  };

  const mapping = mapExtractedSizeToBucket(value, masters);

  assert.equal(mapping.applied, false);
  assert.equal(mapping.reason, 'existing_positive_qty_distribution_preserved');
  assert.equal(value.qty_sz1, 638);
  assert.deepEqual(quantitiesByBucket(value), { 1: 638 });
});

test('VR_SKU_Z SIZE_NUM maps printed size 7 to qty_sz4', () => {
  const value = line('7', 96);
  const mapping = mapExtractedSizeToBucket(value, masters);

  assert.equal(mapping.applied, true);
  assert.equal(mapping.bucket, 4);
  assert.equal(value.qty_sz4, 96);
  assert.equal(value.qty_sz1, null);
});

test('Citi per-size rows aggregate into one exact A2000 distribution', () => {
  const input = [
    line('7', 96),
    line('8/10', 192),
    line('12/14', 192),
    line('16', 96)
  ];

  for (const value of input) {
    value.raw.a2000_size_mapping = mapExtractedSizeToBucket(
      value,
      masters
    );
  }

  const conflicts = [];
  const aggregated = aggregateCitiSizeRows(
    input,
    masters,
    conflicts
  );

  assert.equal(aggregated.length, 1);
  assert.deepEqual(
    quantitiesByBucket(aggregated[0]),
    {
      4: 96,
      5: 192,
      6: 192,
      7: 96
    }
  );
  assert.equal(aggregated[0].qty_total, 576);
  assert.equal(conflicts.length, 0);
  assert.equal(
    aggregated[0].raw.a2000_scale_validation.valid,
    true
  );
  assert.equal(
    aggregated[0].raw.a2000_scale_validation.pack_multiplier,
    96
  );
});

test('out-of-ratio distribution is rejected by scale validation', () => {
  const value = {
    qty_sz4: 1,
    qty_sz5: 0,
    qty_sz6: 0,
    qty_sz7: 0
  };

  const validation = validateDistributionAgainstScaleRows(
    value,
    rows
  );

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some(
      error => error.code === 'MISSING_REQUIRED_RATIO_BUCKET'
    )
  );
});

test('ambiguous scale candidates do not map a printed size', () => {
  const extra = {
    ...rows[3],
    Scale: 'ZZ'
  };

  const ambiguousMasters = {
    skuZByStyleColor: new Map([
      ['11KS306S9962|0C9', [...rows, extra]]
    ]),
    skuZByStyleColorSize: new Map([
      ['11KS306S9962|0C9|7', [rows[3], extra]]
    ])
  };

  const value = {
    ...line('7', 96),
    scale_code: null
  };

  const mapping = mapExtractedSizeToBucket(
    value,
    ambiguousMasters
  );

  assert.equal(mapping.applied, false);
  assert.equal(mapping.reason, 'ambiguous_vr_sku_z_scale');
  assert.deepEqual(quantitiesByBucket(value), {});
});
