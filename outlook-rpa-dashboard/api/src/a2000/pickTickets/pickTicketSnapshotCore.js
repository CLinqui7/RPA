import crypto from 'node:crypto';

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeOrderNumber(value) {
  const raw = clean(value);
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '');
  return digits
    ? digits.replace(/^0+(?=\d)/, '')
    : raw.toUpperCase();
}

function normalizeCode(value) {
  return clean(value).toUpperCase();
}

function styleColorKey(style, color) {
  return `${normalizeCode(style)}|${normalizeCode(color)}`;
}

function deepValues(value, output = [], seen = new Set()) {
  if (
    value === null
    || value === undefined
    || seen.has(value)
  ) return output;

  if (typeof value !== 'object') {
    output.push(clean(value));
    return output;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) deepValues(item, output, seen);
    return output;
  }

  for (const item of Object.values(value)) {
    deepValues(item, output, seen);
  }

  return output;
}

function orderContainsStore(order, storeCode) {
  const store = normalizeCode(storeCode);
  if (!store) return false;
  if (normalizeCode(order.store_code) === store) return true;
  return deepValues(order.raw_json || {}).some(
    value => normalizeCode(value) === store
  );
}

function orderStyleKeys(order = {}) {
  return new Set(
    (order.purchase_order_lines || [])
      .map(line => styleColorKey(
        line.style_code,
        line.color_code
      ))
      .filter(key => key !== '|')
  );
}

function snapshotStyleKeys(snapshot = {}) {
  return new Set(
    (snapshot.lines || [])
      .map(line => styleColorKey(
        line.style,
        line.color || line.clr
      ))
      .filter(key => key !== '|')
  );
}

export function pickTicketIdentityFromViewerRow(row = {}) {
  return {
    pick_ticket_no: clean(row.PICKTKT),
    control_no: clean(row.CTRL_NO),
    order_no: clean(row.PO || row.ORDER_NO),
    po_number: clean(row.PO || row.ORDER_NO),
    a2000_order_no: clean(row.ORDER_NO),
    customer_code: clean(row.CUSTOMER),
    store_code: clean(row.STORE),
    warehouse_code: clean(row.WH),
    status: clean(row.STATUS),
    pt_track: clean(row.PT_TRACK)
  };
}

export function pickTicketLineFromViewerRow(row = {}) {
  return {
    line_no: numberOrNull(row.LINE_NO),
    style: clean(row.STYLE),
    color: clean(row.CLR),
    internal_sku: clean(row.SKU),
    customer_style1: clean(row.CUST_STYLE1),
    customer_style2: clean(row.CUST_STYLE2),
    pick_qty: numberOrNull(row.PICK_QTY),
    order_qty: numberOrNull(row.ORDER_QTY),
    ship_qty: numberOrNull(row.SHIP_QTY),
    price: numberOrNull(row.PRICE),
    extension: numberOrNull(row.EXTENSION),
    warehouse_code: clean(row.WH),
    size_name: clean(row.SIZE_NAME || row.SCALE),
    status: clean(row.STATUS),
    entry_date: clean(row.ENTRY_DATE),
    modify_date: clean(row.MODIFY_DATE),
    line_entry_date: clean(row.LINE_ENTRY_DATE),
    line_modify_date: clean(row.LINE_MODIFY_DATE)
  };
}

export function isBulkParentViewerRow(row = {}) {
  const identity = pickTicketIdentityFromViewerRow(row);
  return (
    clean(identity.store_code).toUpperCase() === 'BULK'
    || clean(row.RECORD_TYPE).toUpperCase() === 'BULK_PARENT'
    || clean(row.CLASSIFICATION).toUpperCase() === 'BULK_PARENT'
    || !identity.pick_ticket_no
    || Number(identity.pick_ticket_no) <= 0
  );
}

export function groupPickTicketViewerRows(rows = []) {
  const groups = new Map();
  let excludedParentCount = 0;
  let incompleteCount = 0;

  for (const row of rows || []) {
    if (isBulkParentViewerRow(row)) {
      excludedParentCount += 1;
      continue;
    }

    const identity = pickTicketIdentityFromViewerRow(row);

    if (!identity.pick_ticket_no || !identity.control_no) {
      incompleteCount += 1;
      continue;
    }

    const key = `${identity.control_no}|${identity.pick_ticket_no}`;

    if (!groups.has(key)) {
      groups.set(key, {
        ...identity,
        control_identity: [
          identity.customer_code,
          identity.order_no || identity.po_number,
          identity.control_no
        ].join('|'),
        lines: [],
        picked_quantity: 0,
        order_quantity: 0,
        ship_quantity: 0,
        source: 'VR_ORDER_LI',
        captured_at: null
      });
    }

    const group = groups.get(key);
    const line = pickTicketLineFromViewerRow(row);
    group.lines.push(line);
    group.picked_quantity += Number(line.pick_qty || 0);
    group.order_quantity += Number(line.order_qty || 0);
    group.ship_quantity += Number(line.ship_qty || 0);
  }

  const output = [...groups.values()]
    .map(group => ({
      ...group,
      captured_at: new Date().toISOString(),
      lines: group.lines.sort((left, right) => (
        Number(left.line_no || 0) - Number(right.line_no || 0)
      ))
    }))
    .sort((left, right) => (
      String(left.control_no).localeCompare(
        String(right.control_no),
        undefined,
        { numeric: true }
      )
    ));

  return {
    groups: output,
    group_count: output.length,
    excluded_parent_count: excludedParentCount,
    incomplete_count: incompleteCount
  };
}

export function orderNumberCandidates(value) {
  const raw = clean(value);
  if (!raw) return [];

  const values = new Set([raw]);
  const digitsOnly = raw.replace(/\D+/g, '');

  if (digitsOnly) {
    values.add(digitsOnly);
    values.add(digitsOnly.replace(/^0+(?=\d)/, ''));
    values.add(digitsOnly.padStart(10, '0'));
  }

  return [...values].filter(Boolean);
}

export function scoreOrderForSnapshot(
  order = {},
  snapshot = {},
  {
    controlPurchaseOrderId = null
  } = {}
) {
  let score = 0;
  const reasons = [];

  if (
    controlPurchaseOrderId
    && String(order.id) === String(controlPurchaseOrderId)
  ) {
    score += 1000;
    reasons.push('EXACT_A2000_CONTROL_JOB');
  }

  if (
    normalizeCode(order.customer_code)
    && normalizeCode(order.customer_code)
      === normalizeCode(snapshot.customer_code)
  ) {
    score += 100;
    reasons.push('CUSTOMER_MATCH');
  }

  if (
    normalizeOrderNumber(order.order_no)
    && normalizeOrderNumber(order.order_no)
      === normalizeOrderNumber(
        snapshot.order_no
        || snapshot.po_number
      )
  ) {
    score += 100;
    reasons.push('PO_MATCH');
  }

  if (
    snapshot.store_code
    && normalizeCode(order.store_code)
      === normalizeCode(snapshot.store_code)
  ) {
    score += 80;
    reasons.push('STORE_MATCH');
  } else if (orderContainsStore(order, snapshot.store_code)) {
    score += 35;
    reasons.push('STORE_FOUND_IN_HARDCOPY_RAW');
  }

  const orderKeys = orderStyleKeys(order);
  const snapshotKeys = snapshotStyleKeys(snapshot);
  let overlap = 0;

  for (const key of snapshotKeys) {
    if (orderKeys.has(key)) overlap += 1;
  }

  if (overlap) {
    score += Math.min(overlap * 10, 50);
    reasons.push(`STYLE_COLOR_OVERLAP_${overlap}`);
  }

  const orderQty = Number(
    order.totals?.qty
    || (order.purchase_order_lines || [])
      .reduce((sum, line) => sum + Number(line.qty_total || 0), 0)
  );
  const snapshotQty = Number(snapshot.picked_quantity || 0);

  if (
    Number.isFinite(orderQty)
    && Number.isFinite(snapshotQty)
    && orderQty > 0
    && snapshotQty > 0
    && orderQty === snapshotQty
  ) {
    score += 20;
    reasons.push('TOTAL_QTY_MATCH');
  }

  return { score, reasons };
}

export function correlatePickTicketOrder(
  orders = [],
  snapshot = {},
  {
    controlPurchaseOrderId = null
  } = {}
) {
  const scored = orders
    .map(order => ({
      order,
      ...scoreOrderForSnapshot(order, snapshot, {
        controlPurchaseOrderId
      })
    }))
    .sort((left, right) => right.score - left.score);

  const first = scored[0] || null;
  const second = scored[1] || null;

  if (!first || first.score < 150) {
    return {
      order: null,
      score: first?.score || 0,
      reason: 'NO_CONFIDENT_ORDER_MATCH',
      candidates: scored.slice(0, 5)
    };
  }

  if (second && second.score === first.score) {
    return {
      order: null,
      score: first.score,
      reason: 'AMBIGUOUS_ORDER_MATCH',
      candidates: scored.slice(0, 5)
    };
  }

  return {
    order: first.order,
    score: first.score,
    reason: first.reasons.join('|') || 'UNIQUE_MATCH',
    candidates: scored.slice(0, 5)
  };
}

export function snapshotFingerprint(snapshot = {}) {
  const canonical = {
    pick_ticket_no: clean(snapshot.pick_ticket_no),
    control_no: clean(snapshot.control_no),
    order_no: normalizeOrderNumber(snapshot.order_no),
    customer_code: normalizeCode(snapshot.customer_code),
    store_code: normalizeCode(snapshot.store_code),
    lines: (snapshot.lines || []).map(line => ({
      line_no: Number(line.line_no || 0),
      style: normalizeCode(line.style),
      color: normalizeCode(line.color),
      pick_qty: Number(line.pick_qty || 0),
      order_qty: Number(line.order_qty || 0),
      ship_qty: Number(line.ship_qty || 0)
    }))
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}
