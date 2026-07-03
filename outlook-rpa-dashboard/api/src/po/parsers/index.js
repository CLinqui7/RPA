import { compactText, missingFields, inferStatus } from '../helpers.js';
import { normalizeForA2000 } from '../mappers/normalizeForA2000.js';
import { enrichOrderWithMasters } from '../enrichment/enrichOrder.js';
import { parseBealls } from './bealls.js';
import { parseGabes } from './gabes.js';
import { parseCitiTrends } from './cititrends.js';
import { parseSpencers } from './spencers.js';
import { parseVariety } from './variety.js';
import { parseShoeShow } from './shoeshow.js';

function detectCustomer({ text, fileName }) {
  const sample = compactText(`${fileName || ''} ${text || ''}`).toLowerCase();
  if (sample.includes('bealls') || sample.includes('beall blvd') || /dept#\d+\s*-po#/i.test(fileName || '')) return 'bealls';
  if (sample.includes("gabe's") || sample.includes('gabes.net') || sample.includes('gabrielap@gabes')) return 'gabes';
  if (sample.includes('cititrends.com') || sample.includes('citi trends')) return 'cititrends';
  if (sample.includes('spencer gifts') || sample.includes('sgvendors.com')) return 'spencers';
  if (sample.includes('shoe show') || sample.includes('purchase order #') && sample.includes('pattern:')) return 'shoeshow';
  if (sample.includes('variety wholesalers') || sample.includes('variety who') || sample.includes('vw sku') || sample.includes('vnd id')) return 'variety';
  return 'generic';
}

function addQuality(parsed) {
  const header = parsed.header || {};
  const lines = parsed.lines || [];

  const headerMissing = missingFields(header, ['order_no', 'customer_code', 'store_code', 'terms_code', 'division_code', 'warehouse_code']);
  const lineMissing = [];
  for (const line of lines) {
    const missing = missingFields(line, ['style_code', 'color_code', 'warehouse_code', 'qty_sz1']);
    if (missing.length) lineMissing.push({ line_no: line.line_no, missing });
    line.missing_fields = missing;
  }

  if (!lines.length) {
    lineMissing.push({ line_no: null, missing: ['no_lines_extracted'] });
  }

  parsed.header.missing_fields = headerMissing;
  parsed.status = inferStatus({ headerMissing, lineMissing, conflicts: parsed.conflicts || [] });
  parsed.needs_mapping = {
    header: headerMissing,
    lines: lineMissing,
    conflicts: parsed.conflicts || []
  };
  return parsed;
}

export function parsePurchaseOrder({ text, fileName, document }) {
  const customer = detectCustomer({ text, fileName });
  const input = { text, fileName, document };
  let parsed;

  if (customer === 'bealls') parsed = parseBealls(input);
  else if (customer === 'gabes') parsed = parseGabes(input);
  else if (customer === 'spencers') parsed = parseSpencers(input);
  else if (customer === 'cititrends') parsed = parseCitiTrends(input);
  else if (customer === 'shoeshow') parsed = parseShoeShow(input);
  else if (customer === 'variety') parsed = parseVariety(input);
  else {
    parsed = {
      parser: 'generic',
      confidence: 0.1,
      header: {
        customer_raw: null,
        customer_code: null,
        order_no: null,
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
        raw: {}
      },
      lines: [],
      totals: {},
      conflicts: [{ field: 'customer', message: 'No parser matched this document yet' }]
    };
  }

  return addQuality(enrichOrderWithMasters(normalizeForA2000(parsed)));
}
