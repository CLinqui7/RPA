import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBealls } from '../../src/po/parsers/bealls.js';

const text = `
BulkDomestic-20582188-1915414 Page 1 of 3
bealls DIST CENTER #115
DEPT. NUMBER: 270 ORDER NUMBER: 1915414
Order Date: 6/2/2026 Terms: ROG NET 60
Ship Date: 6/22/2026
Cancel Date: 6/26/2026
Ship To: Bealls Stores Mark For: bealls DIST CENTER #115
Store: 115
Order Number Ship Date Cancel Date Freight Allowance
1915414 6/22/2026 6/26/2026 0.00%
SKU MFG Style MFG Color Size Desc. Description Cost/Unit Total Units
492961 EHH358-26- Black . Holland Twill Tote BLACK $12.00 60
003
492986 EHH381-42- Black/Pink . Honey Paris Satchel BLACKPINK $16.00 80
060
492974 EHH411A-42- Black . small satchel w lrg swagchain $12.00 80
003
493005 EHH413-42- Red/Black . Anita Flap Shoulder $12.00 60
BMT
492998 EHH415-42- BLACK/RED . Heloise Tote Bag BLACKRED $17.00 60
085
Total Cost $4700.00 Total Qty. 340
`;

test('parses the Bealls BulkDomestic layout into five exact lines', () => {
  const parsed = parseBealls({
    text,
    fileName: 'AMERICAN EXCHANGE-Dept#3270 -PO#1915414-DT#06022026-163035.PDF'
  });
  assert.equal(parsed.layout_version, 'bealls_bulkdomestic_layout_parser_v3');
  assert.equal(parsed.header.order_no, '1915414');
  assert.equal(parsed.header.store_raw, '115');
  assert.equal(parsed.header.dept_raw, '270');
  assert.equal(parsed.lines.length, 5);
  assert.equal(parsed.totals.qty, 340);
  assert.equal(parsed.totals.amount, 4700);
  assert.deepEqual(parsed.lines.map(line => [line.customer_sku, line.style_raw, line.qty_total]), [
    ['492961', 'EHH358-26-003', 60],
    ['492986', 'EHH381-42-060', 80],
    ['492974', 'EHH411A-42-003', 80],
    ['493005', 'EHH413-42-BMT', 60],
    ['492998', 'EHH415-42-085', 60]
  ]);
  assert.deepEqual(parsed.conflicts, []);
});
