function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

export function buildPickTicketGroupKey(row) {
  const customer = clean(row.CUSTOMER ?? row.customer_code).toUpperCase();
  const division = clean(row.DIV ?? row.division_code).toUpperCase();
  const orderNo = clean(
    row.SUMMARY_ORDER_NO ?? row.ORDER_NO ?? row.order_no
  );
  return `${customer}|${division}|${orderNo}`;
}

export function classifyPickTicketRows(rows, {
  now = Date.now(),
  firstSeenAt = now,
  lastSeenAt = now,
  stabilizationMs = 120000
} = {}) {
  const controls = unique(rows.map((row) => row.CTRL_NO ?? row.control_no));
  const pickTickets = unique(rows.map((row) => row.PICKTKT ?? row.pick_ticket_no));
  const nonBulkStores = unique(
    rows
      .map((row) => row.STORE ?? row.store_no)
      .filter((store) => clean(store).toUpperCase() !== 'BULK')
  );

  const parentRows = rows.filter((row) =>
    clean(row.STORE ?? row.store_no).toUpperCase() === 'BULK'
    && !clean(row.PICKTKT ?? row.pick_ticket_no)
    && toNumber(row.PICK_QTY ?? row.pick_qty) === 0
  );
  const childRows = rows.filter((row) => clean(row.PICKTKT ?? row.pick_ticket_no));
  const childControls = unique(childRows.map((row) => row.CTRL_NO ?? row.control_no));

  const strongDistrop =
    (parentRows.length > 0 && pickTickets.length >= 1)
    || pickTickets.length > 1
    || childControls.length > 1
    || nonBulkStores.length > 1;

  let classification = 'PENDING';
  if (strongDistrop) {
    classification = 'DISTROP';
  } else if (
    pickTickets.length === 1
    && parentRows.length === 0
    && now - firstSeenAt >= stabilizationMs
  ) {
    classification = 'SINGLE';
  }

  const parentControls = unique(
    parentRows.map((row) => row.CTRL_NO ?? row.control_no)
  );
  let checklistControlIdentity = null;
  let checklistControlIdentityType = 'PENDING';
  if (classification === 'DISTROP' && parentControls.length === 1) {
    checklistControlIdentity = parentControls[0];
    checklistControlIdentityType = 'A2000_PARENT_CONTROL';
  } else if (classification === 'SINGLE' && childControls.length === 1) {
    checklistControlIdentity = childControls[0];
    checklistControlIdentityType = 'A2000_CONTROL';
  }

  return {
    classification,
    has_bulk_parent: parentRows.length > 0,
    parent_controls: parentControls,
    controls,
    child_controls: childControls,
    pick_tickets: pickTickets,
    stores: nonBulkStores,
    checklist_control_no: checklistControlIdentity,
    checklist_control_identity_type: checklistControlIdentityType,
    checklist_control_pending_reason:
      checklistControlIdentity
        ? null
        : classification === 'DISTROP'
          ? 'DISTROP_PARENT_CONTROL_MISSING_OR_AMBIGUOUS'
          : 'CLASSIFICATION_NOT_STABLE',
    expected_pick_ticket_count: pickTickets.length,
    source_row_count: rows.length,
    stabilization: {
      first_seen_at: new Date(firstSeenAt).toISOString(),
      last_seen_at: new Date(lastSeenAt).toISOString(),
      stabilization_ms: stabilizationMs
    }
  };
}

export function consolidatePickTicketRows(rows) {
  const usable = rows.filter((row) =>
    clean(row.PICKTKT ?? row.pick_ticket_no)
    && clean(row.STORE ?? row.store_no).toUpperCase() !== 'BULK'
  );

  const dedupe = new Map();
  for (const row of usable) {
    const key = [
      clean(row.ORDER_NO ?? row.order_no),
      clean(row.CTRL_NO ?? row.control_no),
      clean(row.PICKTKT ?? row.pick_ticket_no),
      clean(row.LINE_NO ?? row.line_no),
      clean(row.STYLE ?? row.style),
      clean(row.CLR ?? row.color),
      clean(row.SKU ?? row.sku)
    ].join('|');
    if (!dedupe.has(key)) dedupe.set(key, row);
  }

  const traceability = [...dedupe.values()].map((row) => ({
    order_no: clean(row.ORDER_NO ?? row.order_no),
    control_no: clean(row.CTRL_NO ?? row.control_no),
    pick_ticket_no: clean(row.PICKTKT ?? row.pick_ticket_no),
    store_no: clean(row.STORE ?? row.store_no),
    line_no: clean(row.LINE_NO ?? row.line_no),
    style: clean(row.STYLE ?? row.style),
    color: clean(row.CLR ?? row.color),
    sku: clean(row.SKU ?? row.sku),
    customer_sku: clean(row.CUST_STYLE1 ?? row.customer_sku),
    pick_qty: toNumber(row.PICK_QTY ?? row.pick_qty)
  }));

  const summary = new Map();
  for (const row of traceability) {
    const key = [row.style, row.color, row.sku, row.customer_sku].join('|');
    const current = summary.get(key) || {
      style: row.style,
      color: row.color,
      sku: row.sku,
      customer_sku: row.customer_sku,
      picked_quantity: 0
    };
    current.picked_quantity += row.pick_qty;
    summary.set(key, current);
  }

  return {
    traceability,
    consolidated_summary: [...summary.values()]
  };
}
