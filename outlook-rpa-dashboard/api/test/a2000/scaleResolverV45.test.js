import test from 'node:test';
import assert from 'node:assert/strict';

import { A2000ScaleResolver } from '../../src/a2000/scaleResolver.js';

function clientFor(rows) {
  return {
    async viewer() {
      return { httpStatus: 200, rows };
    }
  };
}

const beallsKlRows = [
  ['10', 1, 1], ['11', 2, 1], ['12', 3, 1], ['13', 4, 1],
  ['1', 5, 1], ['2', 6, 1], ['3', 7, 1], ['4', 8, 1]
].map(([size, bucket, qty]) => ({
  STYLE: '03HOSTARYK', CLR: '001', SCALE: 'KL', SIZE_NUM: bucket,
  SIZE_NAME: size, SCALE_QTY: qty, SCALE_PACK_QTY: 8, DIV: 'MJ', SKU_ACTIVE: 'Y'
}));

test('V4.5 accepts one exact printed size slot without forcing the full scale ratio', async () => {
  const resolver = new A2000ScaleResolver(clientFor(beallsKlRows));
  const result = await resolver.validateLine(
    { division_code: 'MJ' },
    {
      line_no: 1,
      style_code: '03HOSTARYK',
      color_code: '001',
      scale_code: 'KL',
      size_raw: '1',
      qty_total: 46,
      qty_sz5: 46
    },
    0
  );

  assert.equal(result.valid, true);
  assert.equal(result.source, 'LIVE_VR_SKU_Z_EXACT_PRINTED_SIZE_SLOT');
  assert.equal(result.exact_size_slot.bucket, 5);
});

test('V4.5 exact printed size path still blocks wrong Header division', async () => {
  const resolver = new A2000ScaleResolver(clientFor(beallsKlRows));
  const result = await resolver.validateLine(
    { division_code: 'ZZ' },
    {
      line_no: 1,
      style_code: '03HOSTARYK',
      color_code: '001',
      scale_code: 'KL',
      size_raw: '1',
      qty_sz5: 46
    },
    0
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'WRONG_DIVISION_FOR_STYLE'));
});

test('V4.5 accepts an exact VR_UPC_STYLE per-size grid as evidence without inventing ratio quantities', async () => {
  const liveRows = [1, 2, 3, 4, 5, 6].map(bucket => ({
    STYLE: 'HAMPTON', CLR: 'TSI', SCALE: '2B', SIZE_NUM: bucket,
    SIZE_NAME: String(bucket + 7), SCALE_QTY: 1, SCALE_PACK_QTY: 6,
    DIV: 'MJ', SKU_ACTIVE: 'Y'
  }));
  const resolver = new A2000ScaleResolver(clientFor(liveRows));
  const quantities = [346, 520, 580, 580, 460, 322];
  const upcs = ['199347310061', '199347310078', '199347310085', '199347310092', '199347310108', '199347310115'];
  const line = {
    line_no: 1,
    style_code: 'HAMPTON',
    color_code: 'TSI',
    scale_code: '2B',
    qty_total: 2808,
    master_upcs_by_size: quantities.map((qty, index) => ({
      size_raw: String(index + 8),
      size_num: String(index + 1),
      qty_raw: qty,
      upc: upcs[index],
      scale: '2B'
    })),
    raw: {
      upc_master_by_size: {
        source: 'VR_UPC_STYLE_EXACT_PRINTED_SIZE_GRID',
        reason: 'all_printed_sizes_unique_master_upc'
      }
    }
  };
  quantities.forEach((qty, index) => { line[`qty_sz${index + 1}`] = qty; });

  const result = await resolver.validateLine({ division_code: 'MJ' }, line, 0);
  assert.equal(result.valid, true);
  assert.equal(result.source, 'EXACT_MASTER_UPCS_BY_SIZE_DISTRIBUTION');
  assert.equal(result.exact_master_upcs_by_size.length, 6);
});

test('V4.5 accepts only a narrow PC one-size official master UPC fallback when VR_SKU_Z has no row', async () => {
  const resolver = new A2000ScaleResolver(clientFor([]));
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
      master_upc: '199347655421',
      master_upc_source: 'VR_UPC_STYLE_UNIQUE_MASTER_UPC'
    },
    0
  );

  assert.equal(result.valid, true);
  assert.equal(result.source, 'OFFICIAL_MASTER_UPC_PC_SINGLE_BUCKET_FALLBACK');
});

test('V4.5 does not use the PC fallback for arbitrary size text', async () => {
  const resolver = new A2000ScaleResolver(clientFor([]));
  const result = await resolver.validateLine(
    { division_code: 'MJ' },
    {
      line_no: 1,
      style_code: 'X', color_code: 'Y', scale_code: 'PC', size_raw: '7',
      qty_sz1: 100, master_upc: '123', master_upc_source: 'VR_UPC_STYLE_UNIQUE_MASTER_UPC'
    },
    0
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'STYLE_COLOR_NOT_IN_VR_SKU_Z'));
});

test('V4.5 preserves generic full-ratio rejection for out-of-ratio quantities', async () => {
  const rows = [
    { STYLE: 'R', CLR: 'C', SCALE: 'v0', SIZE_NUM: 4, SIZE_NAME: '7', SCALE_QTY: 1, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
    { STYLE: 'R', CLR: 'C', SCALE: 'v0', SIZE_NUM: 5, SIZE_NAME: '8/10', SCALE_QTY: 2, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
    { STYLE: 'R', CLR: 'C', SCALE: 'v0', SIZE_NUM: 6, SIZE_NAME: '12/14', SCALE_QTY: 2, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
    { STYLE: 'R', CLR: 'C', SCALE: 'v0', SIZE_NUM: 7, SIZE_NAME: '16', SCALE_QTY: 1, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' }
  ];
  const resolver = new A2000ScaleResolver(clientFor(rows));
  const result = await resolver.validateLine(
    { division_code: 'AL' },
    { style_code: 'R', color_code: 'C', scale_code: 'v0', qty_sz4: 96, qty_sz5: 193, qty_sz6: 192, qty_sz7: 96 },
    0
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => ['NON_INTEGER_PACK_MULTIPLIER', 'OUT_OF_RATIO'].includes(error.code)));
});
