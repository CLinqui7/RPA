import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2000ScaleResolver
} from '../../src/a2000/scaleResolver.js';

const liveRows = [
  { STYLE: '11KS306S9962', CLR: '0C9', SCALE: 'v0', SIZE_NUM: 1, SIZE_NAME: '4', SCALE_QTY: 0, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
  { STYLE: '11KS306S9962', CLR: '0C9', SCALE: 'v0', SIZE_NUM: 2, SIZE_NAME: '5', SCALE_QTY: 0, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
  { STYLE: '11KS306S9962', CLR: '0C9', SCALE: 'v0', SIZE_NUM: 3, SIZE_NAME: '6', SCALE_QTY: 0, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
  { STYLE: '11KS306S9962', CLR: '0C9', SCALE: 'v0', SIZE_NUM: 4, SIZE_NAME: '7', SCALE_QTY: 1, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
  { STYLE: '11KS306S9962', CLR: '0C9', SCALE: 'v0', SIZE_NUM: 5, SIZE_NAME: '8/10', SCALE_QTY: 2, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
  { STYLE: '11KS306S9962', CLR: '0C9', SCALE: 'v0', SIZE_NUM: 6, SIZE_NAME: '12/14', SCALE_QTY: 2, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' },
  { STYLE: '11KS306S9962', CLR: '0C9', SCALE: 'v0', SIZE_NUM: 7, SIZE_NAME: '16', SCALE_QTY: 1, SCALE_PACK_QTY: 6, DIV: 'AL', SKU_ACTIVE: 'Y' }
];

const fakeClient = {
  async viewer() {
    return {
      httpStatus: 200,
      rows: liveRows
    };
  }
};

test('live scale resolver accepts the certified 1:2:2:1 distribution', async () => {
  const resolver = new A2000ScaleResolver(fakeClient);

  const result = await resolver.validateLine(
    { division_code: 'AL' },
    {
      line_no: 1,
      style_code: '11KS306S9962',
      color_code: '0C9',
      scale_code: 'v0',
      qty_sz4: 96,
      qty_sz5: 192,
      qty_sz6: 192,
      qty_sz7: 96
    },
    0
  );

  assert.equal(result.valid, true);
  assert.equal(result.pack_multiplier, 96);
});

test('live scale resolver blocks the wrong Header division', async () => {
  const resolver = new A2000ScaleResolver(fakeClient);

  const result = await resolver.validateLine(
    { division_code: 'ZZ' },
    {
      line_no: 1,
      style_code: '11KS306S9962',
      color_code: '0C9',
      scale_code: 'v0',
      qty_sz4: 96,
      qty_sz5: 192,
      qty_sz6: 192,
      qty_sz7: 96
    },
    0
  );

  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      error => error.code === 'WRONG_DIVISION_FOR_STYLE'
    )
  );
});
