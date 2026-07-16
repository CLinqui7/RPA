import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveColonyDates,
  parseColony
} from '../../src/po/parsers/colony.js';

test('COLONY derives cancel seven days before In House Due and start ten days before cancel', () => {
  assert.deepEqual(
    deriveColonyDates('08/01/2026'),
    {
      in_house_due_date: '2026-08-01',
      cancel_date: '2026-07-25',
      start_date: '2026-07-15',
      cancel_offset_days_from_due: -7,
      start_offset_days_from_cancel: -10,
      start_offset_days_from_due: -17,
      rule: 'COLONY_IN_HOUSE_DUE_MINUS_7_CANCEL_THEN_MINUS_10_START'
    }
  );
});

test('COLONY parser persists the derived dates and provenance', () => {
  const text = [
    'COLONY BRANDS, INC',
    'PO Number 751548165',
    'PO Date 06/08/26',
    'PLN # / Item # Description',
    '61381 / 61381 #G1200 SAMPLE ITEM /RED',
    '12345 NEW 50 50 08/01/2026 10.00 EA $500.00'
  ].join('\n');

  const parsed = parseColony({ text });

  assert.equal(parsed.header.start_date, '2026-07-15');
  assert.equal(parsed.header.cancel_date, '2026-07-25');
  assert.equal(
    parsed.header.raw.date_derivation_rule,
    'COLONY_IN_HOUSE_DUE_MINUS_7_CANCEL_THEN_MINUS_10_START'
  );
});
