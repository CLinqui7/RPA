import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explicitCustomerIdentifiers,
  resolveA2000Size
} from '../src/a2000/customerSkus/explicitIdentifierCore.js';
import {
  authoritativeValue,
  buildAuthoritativeChecklistInput,
  isBulkParentIdentity
} from '../src/a2000/pickTickets/pickTicketCore.js';

test('CITI explicit customer SKU and UPC are extracted without using master fields', () => {
  const result = explicitCustomerIdentifiers({
    customerCode: 'CITI',
    line: {
      ticket_sku: 'FORBIDDEN',
      master_upc: '196540342073',
      raw_json: {
        detail_line: '0886-009721-0000022-0001-00000 400433438478 12.00 2.0000 - 299',
        customer_upc_raw: '400433438478'
      }
    }
  });

  assert.equal(result.customer_sku, '0886-009721-0000022-0001-00000');
  assert.equal(result.customer_upc, '400433438478');
  assert.notEqual(result.customer_sku, 'FORBIDDEN');
  assert.notEqual(result.customer_upc, '196540342073');
});

test('missing explicit identifiers remain absent', () => {
  const result = explicitCustomerIdentifiers({
    customerCode: 'ANY',
    line: {
      ticket_sku: '782511',
      master_upc: '199347506785',
      raw_json: { upc: '199347506785' }
    }
  });

  assert.equal(result.customer_sku, null);
  assert.equal(result.customer_upc, null);
});

test('unique PC scale safely resolves when VR_UPC_STYLE has no row', () => {
  const result = resolveA2000Size({
    skuRows: [{ SCALE: 'PC', SCALE_PACK_QTY: 1 }],
    sizeRows: []
  });

  assert.equal(result.valid, true);
  assert.equal(result.size_name, 'PC');
  assert.equal(result.size_num, 1);
  assert.equal(result.source, 'VR_SKU_PC_SINGLE_SIZE_FALLBACK');
});

test('non-PC zero-size match blocks', () => {
  const result = resolveA2000Size({
    skuRows: [{ SCALE: 'RT', SCALE_PACK_QTY: 6 }],
    sizeRows: []
  });

  assert.equal(result.valid, false);
});

test('Pick Ticket always wins a conflict while preserving both values', () => {
  const result = authoritativeValue({
    field: 'quantity',
    hardcopyValue: 299,
    pickTicketValue: 294
  });

  assert.equal(result.effective_value, 294);
  assert.equal(result.source_used, 'pick_ticket_snapshot');
  assert.equal(result.conflict, true);
});

test('BULK parent is excluded', () => {
  assert.equal(isBulkParentIdentity({ store_code: 'BULK' }), true);
  assert.equal(isBulkParentIdentity({ store_code: '101' }), false);
});

test('one PO with seven controls produces seven distinct checklist identities', () => {
  const order = {
    id: 'po-1',
    customer_code: 'CITI',
    order_no: '192631',
    purchase_order_lines: [{
      line_no: 1,
      style_code: 'A',
      color_code: '001',
      qty_total: 7
    }]
  };
  const identities = Array.from({ length: 7 }, (_, index) => (
    buildAuthoritativeChecklistInput({
      order,
      identity: {
        customer_code: 'CITI',
        order_no: '192631',
        control_no: String(3759007 + index),
        pick_ticket_no: String(1744307 + index),
        store_code: String(101 + index)
      },
      pickTicketLines: [{
        line_no: 1,
        style: 'A',
        color: '001',
        pick_qty: 7
      }]
    }).control_identity
  ));

  assert.equal(new Set(identities).size, 7);
});

import {
  groupPickTicketViewerRows,
  orderNumberCandidates
} from '../src/a2000/pickTickets/pickTicketSnapshotCore.js';

test('Pick Ticket snapshot is available from VR_ORDER_LI before any PDF exists', () => {
  const result = groupPickTicketViewerRows([
    {
      PICKTKT: 1744307,
      CTRL_NO: 3759007,
      ORDER_NO: '192631',
      PO: '192631',
      CUSTOMER: 'CITI',
      STORE: '101',
      LINE_NO: 1,
      STYLE: 'AX10751H-42',
      CLR: '003',
      PICK_QTY: 7,
      ORDER_QTY: 7,
      SHIP_QTY: 0
    },
    {
      PICKTKT: 1744308,
      CTRL_NO: 3759008,
      ORDER_NO: '192631',
      PO: '192631',
      CUSTOMER: 'CITI',
      STORE: '102',
      LINE_NO: 1,
      STYLE: 'AX10751H-42',
      CLR: '003',
      PICK_QTY: 5,
      ORDER_QTY: 5,
      SHIP_QTY: 0
    }
  ]);

  assert.equal(result.group_count, 2);
  assert.equal(result.groups[0].picked_quantity, 7);
  assert.equal(result.groups[1].picked_quantity, 5);
  assert.equal(result.groups[0].source, 'VR_ORDER_LI');
});

test('snapshot grouping excludes BULK parent and zero Pick Ticket rows', () => {
  const result = groupPickTicketViewerRows([
    {
      PICKTKT: 0,
      CTRL_NO: 3753287,
      ORDER_NO: '192631',
      CUSTOMER: 'CITI',
      STORE: 'BULK',
      LINE_NO: 1,
      PICK_QTY: 0
    },
    {
      PICKTKT: 1744307,
      CTRL_NO: 3759007,
      ORDER_NO: '192631',
      CUSTOMER: 'CITI',
      STORE: '101',
      LINE_NO: 1,
      PICK_QTY: 7
    }
  ]);

  assert.equal(result.group_count, 1);
  assert.equal(result.excluded_parent_count, 1);
  assert.equal(result.groups[0].control_no, '3759007');
});

test('order number candidates include padded and unpadded forms', () => {
  const result = orderNumberCandidates('0000199431');
  assert.ok(result.includes('0000199431'));
  assert.ok(result.includes('199431'));
});
