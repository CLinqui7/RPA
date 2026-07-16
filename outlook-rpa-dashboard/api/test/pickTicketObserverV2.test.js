import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPickTicketRows,
  consolidatePickTicketRows
} from '../src/a2000/pickTickets/distropClassifier.js';
import { correlateReportPages } from '../src/a2000/pickTickets/correlation.js';
import { parsePickTicketPdfText } from '../src/a2000/pickTickets/reportParser.js';

test('single PT remains PENDING before stabilization', () => {
  const now = Date.now();
  const result = classifyPickTicketRows([
    { CTRL_NO: 1, STORE: '101', PICKTKT: 10, PICK_QTY: 6 }
  ], { now, firstSeenAt: now, lastSeenAt: now, stabilizationMs: 120000 });
  assert.equal(result.classification, 'PENDING');
});

test('single PT becomes SINGLE after stabilization', () => {
  const now = Date.now();
  const result = classifyPickTicketRows([
    { CTRL_NO: 1, STORE: '101', PICKTKT: 10, PICK_QTY: 6 }
  ], {
    now,
    firstSeenAt: now - 200000,
    lastSeenAt: now - 200000,
    stabilizationMs: 120000
  });
  assert.equal(result.classification, 'SINGLE');
});

test('BULK parent plus child PT is DISTROP', () => {
  const result = classifyPickTicketRows([
    { CTRL_NO: 3753287, STORE: 'BULK', PICKTKT: null, PICK_QTY: 0 },
    { CTRL_NO: 3759007, STORE: '101', PICKTKT: 1744307, PICK_QTY: 18 },
    { CTRL_NO: 3759008, STORE: '102', PICKTKT: 1744308, PICK_QTY: 24 }
  ]);
  assert.equal(result.classification, 'DISTROP');
  assert.deepEqual(result.parent_controls, ['3753287']);
  assert.equal(result.checklist_control_no, '3753287');
  assert.equal(result.checklist_control_identity_type, 'A2000_PARENT_CONTROL');
});

test('late second PT promotes group to DISTROP', () => {
  const first = classifyPickTicketRows([
    { CTRL_NO: 1, STORE: '101', PICKTKT: 10, PICK_QTY: 6 }
  ]);
  const second = classifyPickTicketRows([
    { CTRL_NO: 1, STORE: '101', PICKTKT: 10, PICK_QTY: 6 },
    { CTRL_NO: 2, STORE: '102', PICKTKT: 11, PICK_QTY: 6 }
  ]);
  assert.equal(first.classification, 'PENDING');
  assert.equal(second.classification, 'DISTROP');
});

test('BULK parent is excluded from picked totals', () => {
  const result = consolidatePickTicketRows([
    {
      ORDER_NO: '192631', CTRL_NO: 3753287, STORE: 'BULK',
      PICKTKT: null, PICK_QTY: 0, STYLE: 'A', CLR: 'B'
    },
    {
      ORDER_NO: '192631', CTRL_NO: 3759007, STORE: '101',
      PICKTKT: 1744307, PICK_QTY: 6, LINE_NO: 1,
      STYLE: 'A', CLR: 'B', SKU: 'AB'
    }
  ]);
  assert.equal(result.traceability.length, 1);
  assert.equal(result.consolidated_summary[0].picked_quantity, 6);
});

function samplePages() {
  return parsePickTicketPdfText([
    'Pick Ticket # 1744307',
    'Ctrl # : 3759007',
    'Order # : 192631',
    'Store#:101'
  ].join('\n'));
}

test('watcher accepts exact PT/control/order/store tuple', () => {
  const result = correlateReportPages({
    expected: [{
      pick_ticket_no: '1744307',
      control_no: '3759007',
      order_no: '192631',
      store_no: '101'
    }],
    pages: samplePages()
  });
  assert.equal(result.accepted, true);
  assert.equal(result.matches.length, 1);
});

for (const [name, field, replacement] of [
  ['control', 'control_no', '9999999'],
  ['order', 'order_no', '999999'],
  ['store', 'store_no', '999']
]) {
  test(`watcher rejects different ${name}`, () => {
    const expected = {
      pick_ticket_no: '1744307',
      control_no: '3759007',
      order_no: '192631',
      store_no: '101'
    };
    expected[field] = replacement;
    const result = correlateReportPages({ expected: [expected], pages: samplePages() });
    assert.equal(result.accepted, false);
  });
}

test('multipage PICKCP matches every expected PT', () => {
  const text = [
    [
      'Pick Ticket # 1744307', 'Ctrl # : 3759007',
      'Order # : 192631', 'Store#:101'
    ].join('\n'),
    [
      'Pick Ticket # 1744308', 'Ctrl # : 3759008',
      'Order # : 192631', 'Store#:102'
    ].join('\n')
  ].join('\f');
  const result = correlateReportPages({
    expected: [
      { pick_ticket_no: '1744307', control_no: '3759007', order_no: '192631', store_no: '101' },
      { pick_ticket_no: '1744308', control_no: '3759008', order_no: '192631', store_no: '102' }
    ],
    pages: parsePickTicketPdfText(text)
  });
  assert.equal(result.accepted, true);
  assert.equal(result.matches.length, 2);
});
