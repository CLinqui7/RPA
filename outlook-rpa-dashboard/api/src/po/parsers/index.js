import { compactText, inferStatus } from '../helpers.js';
import { normalizeForA2000 } from '../mappers/normalizeForA2000.js';
import { enrichOrderWithMasters } from '../enrichment/enrichOrder.js';
import { applyCustomerReadingHardening } from '../enrichment/customerReadingHardening.js';
import { resolveOrderOfficialMasterIdentity } from '../enrichment/officialMasterIdentityResolver.js';
import { resolveCatoFamilyCustomerFromOfficialMaster } from '../enrichment/catoFamilyCustomerResolver.js';
import { parseBealls } from './bealls.js';
import { parseGabes } from './gabes.js';
import { parseCitiTrends } from './cititrends.js';
import { parseSpencers } from './spencers.js';
import { parseVariety } from './variety.js';
import { parseShoeShow } from './shoeshow.js';
import { parseOllies } from './ollies.js';
import { parseCarnival } from './carnival.js';
import { parseTenBelow } from './tenbelow.js';
import { parseIpc } from './ipc.js';
import { parseTillys } from './tillys.js';
import { parseZumiez } from './zumiez.js';
import { parseMacysBacks } from './macysbacks.js';
import { parseColony } from './colony.js';
import { parseCatoCorp, parseCatoCorpOrders } from './catocorp.js';
import { parseMarshalls, parseMarshallsOrders } from './marshalls.js';
import { parseTjMaxx } from './tjmaxx.js';
import { parseMeSalve } from './mesalve.js';
import { parseKnownUnsupported } from './knownUnsupported.js';
import { customerHintFromDocument, customerProfile } from '../customerProfiles.js';
import { strictHeaderMissing, strictLineMissing } from '../../a2000/strictImport.js';

import { detectStrictCustomerPattern } from './customerPatternRegistry.js';
function detectCustomer({ text, fileName, document }) {
  const sample = compactText(`${fileName || ''} ${text || ''}`).toLowerCase();


  const strictPattern = detectStrictCustomerPattern({ text, fileName });
  if (strictPattern.status === 'matched') return strictPattern.parser;
  if (strictPattern.status === 'ambiguous') return 'generic';
  // Strict document-family anchors first. These require a layout signature, not just a logo/name.
  if (sample.includes('purchase order:') && sample.includes('cato style') && sample.includes('color/size/diff summary') && sample.includes('catovendors.com')) return 'catocorp';
  if (sample.includes('routing and distribution instructions') && sample.includes('po number:') && sample.includes('tjx style #') && sample.includes('distribution center')) return 'marshalls';
  if ((sample.includes('domestic po no:') || sample.includes('domestic po #')) && sample.includes('reference no:') && sample.includes('total po units') && sample.includes('vendor style')) return 'tjmaxx';
  if (sample.includes('me salve') && sample.includes('order number:') && sample.includes('style no.') && sample.includes('inner pack') && sample.includes('sb-class')) return 'mesalve';
  if (sample.includes('integrated premium concepts') && sample.includes('p.o. no.') && sample.includes('customer id') && sample.includes('pickup date') && sample.includes('item #')) return 'ipc';
  if (sample.includes('purchase order:') && sample.includes('zumiez #:') && sample.includes('vendor style:') && sample.includes('cost/unit')) return 'zumiez';
  if (sample.includes('macys backstage') && sample.includes('vendor style number') && sample.includes('backstage cost') && sample.includes('in macys backstage dc by')) return 'macysbacks';
  if (sample.includes('colony brands') && sample.includes('po number') && sample.includes('pln # / item #') && sample.includes('terms of sale')) return 'colony';
  if (sample.includes('american exchange group') && sample.includes('fineline hang tag') && sample.includes('byr#') && /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(sample)) return 'tillys';
  if (sample.includes("ollie's bargain outlet") && sample.includes('po#:') && sample.includes('upc number') && sample.includes('model#')) return 'ollies';
  if (sample.includes('carnival cruise line') && sample.includes('purchase order no') && sample.includes('date ordered') && sample.includes('item number')) return 'carnival';
  if ((sample.includes('10 below llc') || sample.includes('simply 10')) && sample.includes('purchase #') && sample.includes('vendor style') && sample.includes('total units')) return 'tenbelow';

  // Legacy parsers. Keep specific signatures before broad family names.
  if (sample.includes('bealls') || sample.includes('beall blvd') || /dept#\d+\s*-po#/i.test(fileName || '')) return 'bealls';
  if (sample.includes("gabe's") || sample.includes('gabes.net') || sample.includes('gabrielap@gabes')) return 'gabes';
  if (sample.includes('cititrends.com') || sample.includes('citi trends')) return 'cititrends';
  if (sample.includes('spencer gifts') || sample.includes('sgvendors.com')) return 'spencers';
  if (sample.includes('shoe show') || (sample.includes('purchase order #') && sample.includes('pattern:'))) return 'shoeshow';
  if (sample.includes('variety wholesalers') || sample.includes('variety who') || sample.includes('vw sku') || sample.includes('vnd id')) return 'variety';

  // For customers with no source hardcopy sample or an unsupported source format,
  // upstream email/document metadata may identify the customer. Route to a safe
  // blocking profile instead of inventing a parser layout.
  const hint = customerHintFromDocument(document);
  const profile = customerProfile(hint?.code);
  // If upstream email/document metadata names a known customer but the PDF does
  // not match a verified document-family signature, preserve the customer
  // candidate and block safely. Never fall through to a generic parser that may
  // reinterpret the wrong layout, and never invent fields from the customer name.
  if (profile) return 'known_unsupported';
  return 'generic';
}

function genericParsedDocument() {
  return {
    parser: 'generic', document_family: 'unknown', layout_version: null,
    document_identity: { legal_entity_raw: null, brand_raw: null, customer_candidate: null, customer_candidate_source: null, a2000_customer_code: null },
    confidence: 0.1,
    header: {
      customer_raw: null, customer_code: null, order_no: null, order_date: null, start_date: null, cancel_date: null, book_date: null,
      dept_raw: null, dept_code: null, division_code: null, store_raw: null, store_code: null, terms_raw: null, terms_code: null,
      ship_via_code: null, warehouse_code: null, raw: {}
    },
    lines: [], totals: {},
    conflicts: [{ field: 'customer', code: 'no_parser_match', severity: 'high', blocking: true, message: 'No parser matched this document yet' }]
  };
}

export function parseRawPurchaseOrders({ text, fileName, document }) {
  const customer = detectCustomer({ text, fileName, document });
  const input = { text, fileName, document };
  if (customer === 'catocorp') return parseCatoCorpOrders(input);
  if (customer === 'marshalls') return parseMarshallsOrders(input);
  return [parseRawPurchaseOrder(input)];
}

export function parseRawPurchaseOrder({ text, fileName, document }) {
  const customer = detectCustomer({ text, fileName, document });
  const input = { text, fileName, document };
  if (customer === 'catocorp') return parseCatoCorp(input);
  if (customer === 'marshalls') return parseMarshalls(input);
  if (customer === 'tjmaxx') return parseTjMaxx(input);
  if (customer === 'mesalve') return parseMeSalve(input);
  if (customer === 'known_unsupported') return parseKnownUnsupported(input);
  if (customer === 'ipc') return parseIpc(input);
  if (customer === 'tillys') return parseTillys(input);
  if (customer === 'zumiez') return parseZumiez(input);
  if (customer === 'macysbacks') return parseMacysBacks(input);
  if (customer === 'colony') return parseColony(input);
  if (customer === 'ollies') return parseOllies(input);
  if (customer === 'carnival') return parseCarnival(input);
  if (customer === 'tenbelow') return parseTenBelow(input);
  if (customer === 'bealls') return parseBealls(input);
  if (customer === 'gabes') return parseGabes(input);
  if (customer === 'spencers') return parseSpencers(input);
  if (customer === 'cititrends') return parseCitiTrends(input);
  if (customer === 'shoeshow') return parseShoeShow(input);
  if (customer === 'variety') return parseVariety(input);
  return genericParsedDocument();
}

function addQuality(parsed) {
  const header = parsed.header || {};
  const lines = parsed.lines || [];
  const headerMissing = strictHeaderMissing(header, lines);
  const lineMissing = [];
  for (const line of lines) {
    const missing = strictLineMissing(header, line);
    if (missing.length) lineMissing.push({ line_no: line.line_no, missing });
    line.missing_fields = missing;
  }
  if (!lines.length) lineMissing.push({ line_no: null, missing: ['no_lines_extracted'] });

  parsed.header.missing_fields = headerMissing;
  parsed.status = inferStatus({ headerMissing, lineMissing, conflicts: parsed.conflicts || [] });
  parsed.needs_mapping = { header: headerMissing, lines: lineMissing, conflicts: parsed.conflicts || [] };
  return parsed;
}

function enrichAndAddQuality(rawParsed) {
  const identified = resolveCatoFamilyCustomerFromOfficialMaster(rawParsed);
  const normalized = normalizeForA2000(identified);
  const enriched = enrichOrderWithMasters(normalized);
  const nativeMasterResolved = resolveOrderOfficialMasterIdentity(enriched);
  const hardened = applyCustomerReadingHardening(nativeMasterResolved);
  return addQuality(hardened);
}

export function parsePurchaseOrders({ text, fileName, document }) {
  return parseRawPurchaseOrders({ text, fileName, document }).map(enrichAndAddQuality);
}

export function parsePurchaseOrder({ text, fileName, document }) {
  const rawParsed = parseRawPurchaseOrder({ text, fileName, document });
  return enrichAndAddQuality(rawParsed);
}
