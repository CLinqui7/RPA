function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const current = clean(value);
    if (current) return current;
  }
  return '';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCode(value) {
  return clean(value).toUpperCase();
}

function styleColorKey(style, color) {
  return `${normalizeCode(style)}|${normalizeCode(color)}`;
}

export function identifiersFromPickTicketName(fileName = '') {
  const name = String(fileName);
  const pickTicket = name.match(/(?:PT|PICKTKT)[-_ ]?(\d+)/i)?.[1] || '';
  const control = name.match(/(?:CTRL|CONTROL)[-_ ]?(\d+)/i)?.[1] || '';
  const order = name.match(/ORDER[-_ ]?([^_]+?)(?:_STORE|\.pdf|$)/i)?.[1] || '';
  const store = name.match(/STORE[-_ ]?([^_.]+)(?:\.pdf|$)/i)?.[1] || '';

  return {
    pick_ticket_no: pickTicket,
    control_no: control,
    order_no: order,
    store_code: store
  };
}

export function identifiersFromPickTicketText(text = '') {
  const source = String(text || '');
  const pickTicket = source.match(
    /(?:PICK\s*TICKET|PICKTKT|PT\s*(?:NO|#|NUMBER)?)\s*(?:#\s*)?[:#-]?\s*(\d{5,})/i
  )?.[1] || '';
  const control = source.match(
    /(?:CONTROL|CTRL(?:_NO|\s*NO|#)?)\s*(?:#\s*)?[:#-]?\s*(\d{5,})/i
  )?.[1] || '';
  const order = source.match(
    /(?:ORDER(?:\s*NO|\s*NUMBER|#)?|PO(?:\s*NO|#)?)\s*(?:#\s*)?[:#-]?\s*([A-Z0-9-]{3,25})/i
  )?.[1] || '';
  const store = (
    source.match(
      /STORE\s*#?\s*[:#-]?\s*([A-Z0-9-]{1,20})/i
    )?.[1]
    || source.match(
      /SHIP\s*TO\s*#?\s*[:#-]?\s*([A-Z0-9-]{1,20})(?=\s|$)/i
    )?.[1]
    || ''
  );

  return {
    pick_ticket_no: pickTicket,
    control_no: control,
    order_no: order,
    store_code: store
  };
}

export function mergePickTicketIdentity(...candidates) {
  return {
    pick_ticket_no: firstNonEmpty(
      ...candidates.map(item => item?.pick_ticket_no)
    ),
    control_no: firstNonEmpty(
      ...candidates.map(item => item?.control_no)
    ),
    order_no: firstNonEmpty(
      ...candidates.map(item => item?.order_no)
    ),
    store_code: firstNonEmpty(
      ...candidates.map(item => item?.store_code)
    ),
    customer_code: firstNonEmpty(
      ...candidates.map(item => item?.customer_code)
    )
  };
}

export function isBulkParentIdentity(identity = {}) {
  return (
    clean(identity.store_code).toUpperCase() === 'BULK'
    || clean(identity.record_type).toUpperCase() === 'BULK_PARENT'
    || clean(identity.classification).toUpperCase() === 'BULK_PARENT'
  );
}

function comparable(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') return value;
  return clean(value);
}

export function authoritativeValue({
  field,
  hardcopyValue,
  pickTicketValue,
  pickTicketSource = 'pick_ticket_snapshot'
}) {
  const hardcopy = comparable(hardcopyValue);
  const pickTicket = comparable(pickTicketValue);
  const hasPickTicket = pickTicket !== null;
  const conflict = (
    hardcopy !== null
    && pickTicket !== null
    && String(hardcopy) !== String(pickTicket)
  );

  return {
    field,
    hardcopy_value: hardcopy,
    pick_ticket_value: pickTicket,
    effective_value: hasPickTicket ? pickTicket : hardcopy,
    source_used: hasPickTicket ? pickTicketSource : 'hardcopy',
    conflict
  };
}

function findHardcopyMatch(hardcopyLines, pt, usedIndexes) {
  const ptKey = styleColorKey(pt.style, pt.color || pt.clr);

  if (ptKey !== '|') {
    const candidates = hardcopyLines
      .map((line, index) => ({ line, index }))
      .filter(item => !usedIndexes.has(item.index))
      .filter(item => styleColorKey(
        item.line.style_code,
        item.line.color_code
      ) === ptKey);

    if (candidates.length === 1) return candidates[0];
  }

  if (pt.line_no !== null && pt.line_no !== undefined) {
    const lineNo = Number(pt.line_no);
    const candidates = hardcopyLines
      .map((line, index) => ({ line, index }))
      .filter(item => !usedIndexes.has(item.index))
      .filter(item => Number(item.line.line_no) === lineNo);

    if (candidates.length === 1) return candidates[0];
  }

  return null;
}

function normalizedPtLine(line = {}, index = 0) {
  return {
    ...line,
    line_no: numberOrNull(line.line_no) ?? index + 1,
    style: clean(line.style || line.style_code),
    color: clean(line.color || line.clr || line.color_code),
    pick_qty: numberOrNull(
      line.pick_qty
      ?? line.qty_total
      ?? line.quantity
    ),
    customer_sku: clean(line.customer_sku) || null,
    customer_upc: clean(line.customer_upc) || null
  };
}

export function buildAuthoritativeChecklistInput({
  order,
  identity,
  pickTicketLines = [],
  pickTicketDocumentId = null,
  pickTicketSource = 'pick_ticket_snapshot'
} = {}) {
  const hardcopyLines = order?.purchase_order_lines || [];
  const normalizedPtLines = (pickTicketLines || []).map(normalizedPtLine);
  const usedHardcopy = new Set();
  const conflicts = [];
  const unmatchedPickTicketLines = [];

  const effectiveLines = normalizedPtLines.length
    ? normalizedPtLines.map((pt, index) => {
        const match = findHardcopyMatch(
          hardcopyLines,
          pt,
          usedHardcopy
        );
        const hardcopy = match?.line || {};
        if (match) usedHardcopy.add(match.index);
        else unmatchedPickTicketLines.push(pt);

        const lineNo = Number(
          pt.line_no
          || hardcopy.line_no
          || index + 1
        );

        const fields = {
          style: authoritativeValue({
            field: 'style',
            hardcopyValue: hardcopy.style_code,
            pickTicketValue: pt.style,
            pickTicketSource
          }),
          color: authoritativeValue({
            field: 'color',
            hardcopyValue: hardcopy.color_code,
            pickTicketValue: pt.color,
            pickTicketSource
          }),
          quantity: authoritativeValue({
            field: 'quantity',
            hardcopyValue: hardcopy.qty_total,
            pickTicketValue: pt.pick_qty,
            pickTicketSource
          }),
          customer_sku: authoritativeValue({
            field: 'customer_sku',
            hardcopyValue: hardcopy.customer_sku,
            pickTicketValue: pt.customer_sku,
            pickTicketSource
          }),
          customer_upc: authoritativeValue({
            field: 'customer_upc',
            hardcopyValue: hardcopy.customer_upc
              || hardcopy.raw_json?.customer_upc_raw,
            pickTicketValue: pt.customer_upc,
            pickTicketSource
          })
        };

        for (const item of Object.values(fields)) {
          if (item.conflict) {
            conflicts.push({
              line_no: lineNo,
              ...item
            });
          }
        }

        return {
          line_no: lineNo,
          hardcopy,
          pick_ticket: pt,
          hardcopy_match: match
            ? 'STYLE_COLOR_OR_LINE_MATCH'
            : 'NO_HARDCOPY_LINE_MATCH',
          fields,
          effective: Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key,
              value.effective_value
            ])
          )
        };
      })
    : hardcopyLines.map((hardcopy, index) => {
        const lineNo = Number(hardcopy.line_no || index + 1);
        const fields = {
          style: authoritativeValue({
            field: 'style',
            hardcopyValue: hardcopy.style_code,
            pickTicketValue: null,
            pickTicketSource
          }),
          color: authoritativeValue({
            field: 'color',
            hardcopyValue: hardcopy.color_code,
            pickTicketValue: null,
            pickTicketSource
          }),
          quantity: authoritativeValue({
            field: 'quantity',
            hardcopyValue: hardcopy.qty_total,
            pickTicketValue: null,
            pickTicketSource
          }),
          customer_sku: authoritativeValue({
            field: 'customer_sku',
            hardcopyValue: hardcopy.customer_sku,
            pickTicketValue: null,
            pickTicketSource
          }),
          customer_upc: authoritativeValue({
            field: 'customer_upc',
            hardcopyValue: hardcopy.customer_upc
              || hardcopy.raw_json?.customer_upc_raw,
            pickTicketValue: null,
            pickTicketSource
          })
        };

        return {
          line_no: lineNo,
          hardcopy,
          pick_ticket: {},
          hardcopy_match: 'HARDCOPY_ONLY_NO_PT_LINES',
          fields,
          effective: Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key,
              value.effective_value
            ])
          )
        };
      });

  const hardcopyLinesNotOnPickTicket = hardcopyLines.filter(
    (_line, index) => !usedHardcopy.has(index)
  );

  return {
    version: 2,
    control_identity: [
      identity?.customer_code,
      identity?.order_no,
      identity?.control_no
    ].map(clean).join('|'),
    source_precedence: (
      'PICK_TICKET_PDF_THEN_SNAPSHOT_THEN_HARDCOPY'
    ),
    pick_ticket_scope_policy: normalizedPtLines.length
      ? 'PICK_TICKET_LINES_ONLY'
      : 'HARDCOPY_FALLBACK_NO_PICK_TICKET_LINES',
    purchase_order_id: order?.id || null,
    pick_ticket_document_id: pickTicketDocumentId,
    customer_code: identity?.customer_code
      || order?.customer_code
      || null,
    order_no: identity?.order_no
      || order?.order_no
      || null,
    a2000_order_no: identity?.a2000_order_no || null,
    control_no: identity?.control_no || null,
    pick_ticket_no: identity?.pick_ticket_no || null,
    store_code: identity?.store_code
      || order?.store_code
      || null,
    warehouse_code: identity?.warehouse_code
      || order?.warehouse_code
      || null,
    is_distrop_child: Boolean(identity?.control_no),
    lines: effectiveLines,
    hardcopy_lines_not_on_pick_ticket: hardcopyLinesNotOnPickTicket,
    unmatched_pick_ticket_lines: unmatchedPickTicketLines,
    conflicts,
    conflict_count: conflicts.length,
    created_at: new Date().toISOString()
  };
}
