import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  explicitCustomerIdentifierSets,
  explicitCustomerIdentifiers,
  resolveA2000Size
} from '../src/a2000/customerSkus/explicitIdentifierCore.js';
import {
  authoritativeValue,
  buildAuthoritativeChecklistInput,
  isBulkParentIdentity
} from '../src/a2000/pickTickets/pickTicketCore.js';
import {
  correlatePickTicketOrder,
  groupPickTicketViewerRows,
  orderNumberCandidates
} from '../src/a2000/pickTickets/pickTicketSnapshotCore.js';
import {
  parsePickTicketPdfText
} from '../src/a2000/pickTickets/pickTicketPdfParser.js';
import {
  buildChecklistPayloadFromAuthoritativeInput,
  resolveChecklistQtyBuckets
} from '../src/a2000/pickTickets/controlChecklistCore.js';

test('CITI explicit customer SKU and UPC are extracted without using master fields', () => {
  const result = explicitCustomerIdentifiers({
    customerCode: 'CITI',
    line: {
      ticket_sku: 'FORBIDDEN',
      master_upc: '196540342073',
      raw_json: {
        detail_line: (
          '0886-009721-0000022-0001-00000 '
          + '400433438478 12.00 2.0000 - 299'
        )
      }
    }
  });

  assert.equal(
    result.customer_sku,
    '0886-009721-0000022-0001-00000'
  );
  assert.equal(result.customer_upc, '400433438478');
  assert.notEqual(result.customer_sku, 'FORBIDDEN');
  assert.notEqual(result.customer_upc, '196540342073');
});

test('generic customer uses only explicit customer fields', () => {
  const result = explicitCustomerIdentifiers({
    customerCode: 'OTHER',
    line: {
      customer_sku: 'CUSTOMER-ABC',
      customer_upc: '123456789012',
      ticket_sku: 'FORBIDDEN',
      master_upc: '999999999999'
    }
  });

  assert.equal(result.customer_sku, 'CUSTOMER-ABC');
  assert.equal(result.customer_upc, '123456789012');
});

test('per-size explicit customer identifiers become multiple rows', () => {
  const rows = explicitCustomerIdentifierSets({
    customerCode: 'OTHER',
    line: {
      raw_json: {
        customer_identifiers_by_size: [
          {
            size_name: 'S',
            customer_sku: 'SKU-S',
            customer_upc: '111111111111'
          },
          {
            size_name: 'M',
            customer_sku: 'SKU-M',
            customer_upc: '222222222222'
          }
        ]
      }
    }
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].printed_size, 'S');
  assert.equal(rows[1].customer_sku, 'SKU-M');
});

test('labeled Customer SKU and Customer UPC are accepted generically', () => {
  const result = explicitCustomerIdentifiers({
    customerCode: 'NEWCUSTOMER',
    line: {
      raw_json: {
        customer_identifier_line: (
          'Customer SKU: RET-4499 Customer UPC: 123456789012'
        )
      }
    }
  });

  assert.equal(result.customer_sku, 'RET-4499');
  assert.equal(result.customer_upc, '123456789012');
  assert.equal(
    result.provenance.customer_sku,
    'raw.explicit_labeled_customer_sku'
  );
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
  assert.equal(
    result.source,
    'VR_SKU_PC_SINGLE_SIZE_FALLBACK'
  );
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

test('distrop checklist contains only Pick Ticket lines', () => {
  const order = {
    id: 'po-1',
    customer_code: 'CITI',
    order_no: '192631',
    purchase_order_lines: [
      {
        line_no: 1,
        style_code: 'A',
        color_code: '001',
        qty_total: 100
      },
      {
        line_no: 2,
        style_code: 'B',
        color_code: '002',
        qty_total: 100
      }
    ]
  };
  const input = buildAuthoritativeChecklistInput({
    order,
    identity: {
      customer_code: 'CITI',
      order_no: '192631',
      control_no: '3759007',
      pick_ticket_no: '1744307',
      store_code: '101'
    },
    pickTicketLines: [{
      line_no: 1,
      style: 'A',
      color: '001',
      pick_qty: 7
    }]
  });

  assert.equal(input.lines.length, 1);
  assert.equal(input.lines[0].effective.quantity, 7);
  assert.equal(input.hardcopy_lines_not_on_pick_ticket.length, 1);
  assert.equal(input.pick_ticket_scope_policy, 'PICK_TICKET_LINES_ONLY');
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

test('Pick Ticket snapshot is grouped before any PDF exists', () => {
  const result = groupPickTicketViewerRows([
    {
      PICKTKT: 1744307,
      CTRL_NO: 3759007,
      ORDER_NO: '1930901',
      PO: '0000192631',
      CUSTOMER: 'CITI',
      STORE: '101',
      LINE_NO: 1,
      STYLE: 'A',
      CLR: '001',
      PICK_QTY: 7,
      ORDER_QTY: 7,
      SHIP_QTY: 0
    },
    {
      PICKTKT: 1744308,
      CTRL_NO: 3759008,
      ORDER_NO: '1930902',
      PO: '0000192631',
      CUSTOMER: 'CITI',
      STORE: '102',
      LINE_NO: 1,
      STYLE: 'A',
      CLR: '001',
      PICK_QTY: 5,
      ORDER_QTY: 5,
      SHIP_QTY: 0
    }
  ]);

  assert.equal(result.group_count, 2);
  assert.equal(result.groups[0].picked_quantity, 7);
  assert.equal(result.groups[0].order_no, '0000192631');
});

test('snapshot grouping excludes BULK parent', () => {
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
});

test('order number candidates include padded and unpadded forms', () => {
  const result = orderNumberCandidates('0000199431');
  assert.ok(result.includes('0000199431'));
  assert.ok(result.includes('199431'));
});

test('control job creates a decisive order match', () => {
  const orders = [
    {
      id: 'one',
      customer_code: 'CITI',
      order_no: '199431',
      store_code: '100',
      purchase_order_lines: []
    },
    {
      id: 'two',
      customer_code: 'CITI',
      order_no: '199431',
      store_code: '101',
      purchase_order_lines: []
    }
  ];
  const result = correlatePickTicketOrder(
    orders,
    {
      customer_code: 'CITI',
      order_no: '0000199431',
      store_code: '101',
      control_no: '3760510',
      lines: []
    },
    { controlPurchaseOrderId: 'two' }
  );

  assert.equal(result.order.id, 'two');
  assert.match(result.reason, /EXACT_A2000_CONTROL_JOB/);
});

test('actual Citi multi-page Pick Ticket text returns one PT per control', async () => {
  const text = await fs.readFile(
    new URL('./fixtures/citi_multi_pick_ticket.txt', import.meta.url),
    'utf8'
  );
  const parsed = parsePickTicketPdfText(text);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].identity.pick_ticket_no, '1745841');
  assert.equal(parsed[0].identity.control_no, '3760509');
  assert.equal(parsed[0].identity.store_code, '100');
  assert.equal(parsed[1].identity.pick_ticket_no, '1745842');
  assert.equal(parsed[1].identity.control_no, '3760510');
});

test('single-size Pick Ticket quantity becomes exact checklist bucket', () => {
  const resolution = resolveChecklistQtyBuckets({
    effective: { quantity: 14 },
    pick_ticket: { size_name: 'PC' },
    hardcopy: {}
  });

  assert.deepEqual(resolution.buckets, { QTY_SZ1: 14 });
  assert.equal(resolution.exact, true);
});

test('control checklist payload uses Pick Ticket quantity and existing template profile', () => {
  const input = {
    control_identity: 'CITI|199431|3760509',
    source_precedence: (
      'PICK_TICKET_PDF_THEN_SNAPSHOT_THEN_HARDCOPY'
    ),
    pick_ticket_scope_policy: 'PICK_TICKET_LINES_ONLY',
    customer_code: 'CITI',
    order_no: '199431',
    control_no: '3760509',
    pick_ticket_no: '1745841',
    store_code: '100',
    lines: [{
      line_no: 1,
      hardcopy: {
        style_code: 'A',
        color_code: '001',
        qty_total: 100,
        size_raw: 'PC'
      },
      pick_ticket: {
        style: 'A',
        color: '001',
        pick_qty: 14,
        size_name: 'PC'
      },
      effective: {
        style: 'A',
        color: '001',
        quantity: 14,
        customer_sku: null,
        customer_upc: null
      }
    }],
    conflict_count: 1
  };
  const payload = buildChecklistPayloadFromAuthoritativeInput({
    input,
    order: {
      id: 'po-1',
      customer_code: 'CITI',
      order_no: '199431'
    },
    template: {
      customer_code: 'CITI',
      sha256: 'abc'
    }
  });

  assert.equal(payload.lines.length, 1);
  assert.equal(payload.lines[0].qty_total, 14);
  assert.equal(payload.lines[0].qty_sz1, 14);
  assert.equal(payload.header.control_no, '3760509');
});
