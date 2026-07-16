import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertParsedOrderLinesSafe,
  parsedLineSafetyReport
} from '../../src/po/parsedLineSafety.js';

test('blocks a positive printed quantity with zero parsed lines before persistence', () => {
  const report = parsedLineSafetyReport({ totals: { qty: 340 }, lines: [], conflicts: [] });
  assert.equal(report.ok, false);
  assert.equal(report.code, 'PURCHASE_ORDER_LINES_EMPTY_BLOCKED');
  assert.throws(
    () => assertParsedOrderLinesSafe({ totals: { qty: 340 }, lines: [], conflicts: [] }),
    /PURCHASE_ORDER_LINES_EMPTY_BLOCKED/
  );
});

test('accepts the certified Bealls five-line quantity', () => {
  const lines = [60, 80, 80, 60, 60].map((qty_total, index) => ({ line_no: index + 1, qty_total }));
  const report = assertParsedOrderLinesSafe({ totals: { qty: 340 }, lines, conflicts: [] });
  assert.equal(report.ok, true);
  assert.equal(report.line_count, 5);
  assert.equal(report.calculated_qty, 340);
});

test('blocks a parsed total mismatch', () => {
  const report = parsedLineSafetyReport({ totals: { qty: 340 }, lines: [{ qty_total: 339 }], conflicts: [] });
  assert.equal(report.ok, false);
  assert.equal(report.code, 'PURCHASE_ORDER_LINE_TOTAL_MISMATCH_BLOCKED');
});
