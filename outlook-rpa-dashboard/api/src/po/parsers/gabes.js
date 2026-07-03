import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value = '') {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function money(value) {
  return normalizeMoney(String(value || '').replace(/[$,]/g, ''));
}

function int(value) {
  return normalizeInteger(String(value || '').replace(/[,]/g, ''));
}

function normalizePoNumber(value) {
  return clean(value).replace(/\s+/g, ' ').toUpperCase() || null;
}

function parseGabesPoNumber(text, oneLine) {
  // Gabe's PO number appears in the PO header beside/under the Purchase Order title.
  // Keep the whole value through the final suffix, for example: 100-0012002783 JR.
  // Do not derive it from PT, Pull Sheet, checklist, export, or A2000.
  const patterns = [
    /Purchase\s+Order[\s\S]{0,350}?\b(\d{3}-\d{9,12}\s+[A-Z]{1,4})\b/i,
    /(?:Customer\s+PO|P\.?O\.?|Order\s*#)\s*:?\s*\b(\d{3}-\d{9,12}\s+[A-Z]{1,4})\b/i,
    /\b(\d{3}-\d{9,12}\s+[A-Z]{1,4})\b/i
  ];

  for (const pattern of patterns) {
    const match = String(text || '').match(pattern) || String(oneLine || '').match(pattern);
    if (match?.[1]) return normalizePoNumber(match[1]);
  }

  return null;
}

function parseDates(oneLine) {
  const orderDate = oneLine.match(/Order\s+Date\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;

  // Gabe's PO page 1 usually contains:
  // Freight  Ship Date  Cancel Date  Contact
  // Collect 6/11/26 6/18/26 ...
  const shipCancel = oneLine.match(/Collect\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)
    || oneLine.match(/Ship\s+Date\s+Cancel\s+Date.*?(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);

  return {
    orderDate,
    shipDate: shipCancel?.[1] || null,
    cancelDate: shipCancel?.[2] || null
  };
}

function parseTerms(oneLine) {
  return oneLine.match(/\b(NET\s*\d+\s*DAYS)\b/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() || null;
}

function parseVendorId(oneLine) {
  return oneLine.match(/Vendor\s+ID:\s*([A-Z0-9]+)/i)?.[1] || null;
}

function parseVendorNo(oneLine) {
  return oneLine.match(/Revision:\s*\d+\s+Vendor:\s*(\d+)/i)?.[1]
    || oneLine.match(/\bVendor:\s*(\d+)\b/i)?.[1]
    || null;
}

function parseShipTo(text, oneLine) {
  const rawText = String(text || '');
  const block = rawText.match(/Ship\s+To:\s*([\s\S]{0,250}?)\n\s*Ship\s+Via/i)?.[1];
  if (block) return clean(block.replace(/\n/g, ' '));

  const m = oneLine.match(/Ship\s+To:\s*(.+?)\s+Ship\s+Via/i);
  return m?.[1] ? clean(m[1]) : null;
}

function parseTotals(oneLine) {
  const m = oneLine.match(/Total\s+([\d,]+)\s+\$\s*([\d,]+\.\d{2})/i);
  return {
    qty: int(m?.[1]),
    amount: money(m?.[2])
  };
}

function parsePoLines(oneLine) {
  const afterTableHeader = oneLine.split(/Internal\s+Item\s+#\s*\/\s*Ticket|Internal\s+Item\s+#/i).slice(-1)[0] || oneLine;
  const beforeFooter = afterTableHeader.split(/\bTotal\s+[\d,]+\s+\$/i)[0] || afterTableHeader;

  const rowPattern = /(\d{4}-\d{4}-\d{2}-\d-\d)\s+(\d{10})\s+(\d{1,3})\s+([\d,]+)\s+([A-Z0-9]+(?:-[A-Z0-9]+){1,4})\s+(.+?)\s+\$\s*(\d+(?:\.\d{2})?)\s+\$\s*([\d,]+\.\d{2})/gi;

  const lines = [];
  let match;
  let lineNo = 1;
  while ((match = rowPattern.exec(beforeFooter)) !== null) {
    const customerSku = clean(match[1]);
    const ticketSku = clean(match[2]);
    const csPack = int(match[3]);
    const qty = int(match[4]);
    const poStyle = clean(match[5]).toUpperCase();
    const poDescription = clean(match[6]);
    const unitCost = money(match[7]);
    const extCost = money(match[8]);

    lines.push({
      line_no: lineNo++,
      customer_sku: customerSku,
      ticket_sku: ticketSku,
      style_raw: poStyle,
      style_code: null,
      color_raw: null,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: poDescription,
      list_price: null,
      sales_price: unitCost,
      qty_total: qty,
      // Do not put qty_total into qty_sz1. Gabe's PO does not print the size distribution.
      qty_sz1: null,
      warehouse_code: null,
      raw: {
        source: 'gabes_purchase_order_pdf_only_v11',
        po_style: poStyle,
        po_description: poDescription,
        cs_pack: csPack,
        ext_cost: extCost,
        note: 'Only values printed on the Gabe\'s Purchase Order PDF are extracted here. A2000 style/color/store/division/warehouse/size distribution require PT, Pull Sheet, export, checklist, or master mapping.'
      }
    });
  }

  return lines;
}

function parsePackingSlipOrPt({ text, oneLine }) {
  // Supporting docs can contain operational mapping data, but this strict parser
  // does not use those values to mutate a Purchase Order result.
  const isPt = /\bPick\s+Ticket\b/i.test(oneLine) || /\bPacking\s+Slip\b/i.test(oneLine) || /\bP\/T:\s*\d+/i.test(oneLine);
  if (!isPt) return null;

  return {
    is_supporting_document: true,
    pick_ticket: oneLine.match(/(?:Pick\s+Ticket\s*#|P\/T:)\s*(\d{5,12})/i)?.[1] || null,
    control_no: oneLine.match(/(?:Ctrl\s*#|Control\s+No\.:?)\s*(\d{5,12})/i)?.[1] || null,
    order_no: parseGabesPoNumber(text, oneLine),
    warehouse_code_seen_in_support_doc: oneLine.match(/Warehouse\s*:\s*([A-Z0-9]+)/i)?.[1] || null,
    division_code_seen_in_support_doc: oneLine.match(/Div\s*#?\s*:\s*([A-Z0-9]+)/i)?.[1] || null,
    store_code_seen_in_support_doc: oneLine.match(/Store#\s*:\s*([A-Z0-9]+)/i)?.[1] || null
  };
}

export function parseGabes({ text }) {
  const oneLine = compactText(text);
  const supporting = parsePackingSlipOrPt({ text, oneLine });

  if (supporting) {
    return {
      parser: 'gabes',
      confidence: 0.35,
      header: {
        customer_raw: 'GABRIEL BROTHERS',
        customer_code: null,
        order_no: supporting.order_no,
        order_date: null,
        start_date: null,
        cancel_date: null,
        book_date: null,
        dept_raw: null,
        dept_code: null,
        division_code: null,
        store_raw: null,
        store_code: null,
        terms_raw: null,
        terms_code: null,
        ship_via_code: null,
        warehouse_code: null,
        raw: {
          ...supporting,
          note: 'Supporting Gabe\'s document detected. Values seen here are not applied automatically in strict PO-only mode.'
        }
      },
      lines: [],
      totals: {},
      conflicts: [{ field: 'document_type', message: 'Gabe\'s supporting document detected. Use Purchase Order PDF as the order source; supporting documents require a separate enrichment step.' }]
    };
  }

  const po = parseGabesPoNumber(text, oneLine);
  const dates = parseDates(oneLine);
  const terms = parseTerms(oneLine);
  const vendorId = parseVendorId(oneLine);
  const vendorNo = parseVendorNo(oneLine);
  const shipTo = parseShipTo(text, oneLine);
  const lines = parsePoLines(oneLine);
  const totals = parseTotals(oneLine);

  return {
    parser: 'gabes',
    confidence: lines.length ? 0.86 : 0.55,
    header: {
      customer_raw: "Gabriel Brothers, Inc., d.b.a. GABE'S",
      customer_code: null,
      order_no: po,
      order_date: normalizeDate(dates.orderDate),
      start_date: normalizeDate(dates.shipDate),
      cancel_date: normalizeDate(dates.cancelDate),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: shipTo,
      store_code: null,
      terms_raw: terms,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        source: 'gabes_purchase_order_pdf_only_v11',
        vendorId,
        vendorNo,
        shipTo,
        order_no_source: po ? 'purchase_order_header_or_po_text' : null,
        note: 'Strict PDF-only mode. No A2000 customer/store/division/warehouse/terms/style/color/size mapping is invented from PT, Pull Sheet, checklist, export, or screenshots.'
      }
    },
    lines,
    totals,
    conflicts: []
  };
}
