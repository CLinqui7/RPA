import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function collapseRepeatedLetters(value) {
  // Some Shoe Show PDFs extract as PPPPUUUURRRRCCCCHHHHAAAASSSSEEEE.
  return String(value || '').replace(/(.)\1{2,}/g, '$1');
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function cleanTerms(value) {
  const raw = clean(value);
  if (!raw) return null;
  return raw.replace(/^TERMS:\s*/i, '').replace(/\s*\|.*$/, '').trim();
}

function firstPageText(text) {
  return String(text || '').split('\f')[0] || String(text || '');
}

function findDateTriplet(lines = []) {
  for (const line of lines) {
    const dates = line.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g);
    if (dates && dates.length >= 3) {
      return {
        orderDate: dates[0],
        shipDate: dates[1],
        cancelDate: dates[2]
      };
    }
  }
  return { orderDate: null, shipDate: null, cancelDate: null };
}

function findShoeShowItemLines(pageLines = []) {
  const items = [];
  let inTable = false;

  for (const rawLine of pageLines) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) continue;

    if (/\*\*\s*S\s*T\s*O\s*C\s*K\s*#\s*\*\*/i.test(line) || /DESCRIPTION\s+COLOR\s+QUANTITY/i.test(line)) {
      inTable = true;
      continue;
    }

    if (inTable && /^QTY\s+CASES\s+WD\b/i.test(line)) break;
    if (!inTable) continue;

    // Example:
    // 248325          (PRETICKETED)      MUDD STORMY MICRO 11-5                      TPE                                                   1200
    const match = line.match(/^(\d{4,12})\s+(?:\(([^)]+)\)\s+)?(.+?)\s+([A-Z0-9]{2,6})\s+([\d,]+)\s*$/i);
    if (!match) continue;

    items.push({
      stock: clean(match[1]),
      ticketFlag: clean(match[2]),
      description: clean(match[3]),
      colorRaw: clean(match[4]),
      qty: normalizeInteger(match[5])
    });
  }

  return items;
}

function extractSizeBreakdown(pageLines = []) {
  // Shoe Show's size grid wraps visually. In this layout the visible non-zero values
  // from the TOTALS row correspond to sizes 1,2,3,4,5,11,12,13.
  // A2000 normally displays this shoe run as 11,12,13,1,2,3,4,5,6.
  const totalsLine = pageLines.find((line) => /\bTOTALS\b/i.test(line) && /\d/.test(line));
  if (!totalsLine) return null;

  const numbers = (totalsLine.match(/[\d,]+/g) || []).map((n) => normalizeInteger(n)).filter((n) => Number.isFinite(n));
  if (numbers.length < 2) return null;

  const total = numbers[0];
  const values = numbers.slice(1);

  // Known Shoe Show PO grid used in these vendor copies:
  // size 1,2,3,4,5,11,12,13 appear as non-zero quantities in the wrapped row.
  if (values.length === 8) {
    const bySize = {
      '1': values[0],
      '2': values[1],
      '3': values[2],
      '4': values[3],
      '5': values[4],
      '11': values[5],
      '12': values[6],
      '13': values[7]
    };
    const a2000SizeOrder = ['11', '12', '13', '1', '2', '3', '4', '5', '6'];
    const a2000Qtys = a2000SizeOrder.map((size) => bySize[size] || 0);
    return { total, bySize, a2000SizeOrder, a2000Qtys };
  }

  return { total, bySize: null, a2000SizeOrder: null, a2000Qtys: values };
}

export function parseShoeShow({ text }) {
  const normalizedText = collapseRepeatedLetters(text || '');
  const pageOne = firstPageText(normalizedText);
  const pageLines = pageOne.split('\n');
  const oneLine = compactText(pageOne);
  const allOneLine = compactText(normalizedText);

  const orderNo = oneLine.match(/PURCHASE\s+ORDER\s*#\s*(\d{4,12})/i)?.[1]
    || allOneLine.match(/PURCHASE\s+ORDER\s*#\s*(\d{4,12})/i)?.[1]
    || null;

  const { orderDate, shipDate, cancelDate } = findDateTriplet(pageLines);

  const termsRaw = cleanTerms(oneLine.match(/TERMS:\s*([^|]+?NET\s+\d+\s+DAYS)/i)?.[0])
    || cleanTerms(oneLine.match(/TERMS:\s*([^|]+)/i)?.[0])
    || null;

  const price = normalizeMoney(oneLine.match(/COST:\s*\$?\s*([\d,.]+)/i)?.[1]);
  const explicitStyle = clean(oneLine.match(/STYLE:\s*([A-Z0-9-]+)/i)?.[1]) || null;

  const explicitColorName = clean(oneLine.match(/COLOR:\s*([A-Z0-9 /.-]+?)(?:\s+SOCK\s+STAMP|\s+OTHER\s+LOGOS|\s+BOX::|\s+\*\*\s*S\s*T\s*O\s*C\s*K)/i)?.[1]) || null;

  const pattern = clean(oneLine.match(/PATTERN:\s*(.+?)(?:\s+STYLE:|\s+COLOR:|\s+SAME\s+COLOR|\s+SOCK\s+STAMP|\s+OTHER\s+LOGOS|\s+BOX::|\s+\*\*\s*S\s*T\s*O\s*C\s*K)/i)?.[1])
    || null;

  const itemRows = findShoeShowItemLines(pageLines);
  const sizeBreakdown = extractSizeBreakdown(pageLines);

  const lines = itemRows.map((item, index) => {
    const qtySz = {};
    if (sizeBreakdown?.a2000Qtys?.length) {
      sizeBreakdown.a2000Qtys.forEach((qty, i) => {
        qtySz[`qty_sz${i + 1}`] = qty;
      });
    }

    return {
      line_no: index + 1,
      customer_sku: item.stock,
      ticket_sku: item.stock,
      style_raw: explicitStyle || pattern || item.description,
      style_code: null,
      color_raw: item.colorRaw,
      color_code: null,
      description: item.description,
      list_price: null,
      sales_price: price,
      qty_total: item.qty,
      ...qtySz,
      warehouse_code: null,
      raw: {
        source: 'shoeshow_pdf_only_v13',
        ticket_flag: item.ticketFlag,
        terms_raw: termsRaw,
        size_breakdown: sizeBreakdown,
        explicit_style: explicitStyle,
        explicit_color_name: explicitColorName
      }
    };
  });

  const totalQty = lines.reduce((sum, line) => sum + (normalizeInteger(line.qty_total) || 0), 0) || normalizeInteger(oneLine.match(/\b(\d[\d,]*)\s+TOTALS\b/i)?.[1]);
  const amount = price && totalQty ? Number((price * totalQty).toFixed(2)) : null;

  return {
    parser: 'shoeshow',
    confidence: lines.length ? 0.88 : 0.45,
    header: {
      customer_raw: 'THE SHOE SHOW',
      customer_code: null,
      order_no: orderNo,
      order_date: normalizeDate(orderDate),
      start_date: normalizeDate(shipDate),
      cancel_date: normalizeDate(cancelDate),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: null,
      store_code: null,
      terms_raw: termsRaw,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        source: 'shoeshow_pdf_only_v13',
        cost_raw: price,
        pattern
      }
    },
    lines,
    totals: {
      qty: totalQty || null,
      amount
    },
    conflicts: []
  };
}
