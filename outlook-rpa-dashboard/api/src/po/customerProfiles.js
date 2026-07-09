function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function token(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const CUSTOMER_PROFILES = Object.freeze({
  '10BELOW': { code: '10BELOW', parser: 'tenbelow', sourceFormat: 'pdf', sampleStatus: 'verified' },
  BEALLSOUTL: { code: 'BEALLSOUTL', parser: 'bealls', sourceFormat: 'pdf', sampleStatus: 'verified' },
  CARNIVAL: { code: 'CARNIVAL', parser: 'carnival', sourceFormat: 'pdf', sampleStatus: 'verified' },
  CATO: { code: 'CATO', parser: 'catocorp', sourceFormat: 'pdf', sampleStatus: 'family_only' },
  CITI: { code: 'CITI', parser: 'cititrends', sourceFormat: 'pdf', sampleStatus: 'verified' },
  COLONY: { code: 'COLONY', parser: 'colony', sourceFormat: 'pdf', sampleStatus: 'verified' },
  GABRIELBRO: { code: 'GABRIELBRO', parser: 'gabes', sourceFormat: 'pdf', sampleStatus: 'verified' },
  GORBRORET: { code: 'GORBRORET', parser: 'gordon', sourceFormat: 'xlsx', sampleStatus: 'source_xlsx_pdf_pipeline_gap' },
  HAMRICKS: { code: 'HAMRICKS', parser: 'known_unsupported', sourceFormat: 'pdf', sampleStatus: 'missing_source_hardcopy' },
  IPC: { code: 'IPC', parser: 'ipc', sourceFormat: 'pdf', sampleStatus: 'verified' },
  ITSFASHION: { code: 'ITSFASHION', parser: 'catocorp', sourceFormat: 'pdf', sampleStatus: 'verified_family_ambiguous_identity' },
  MACYSBACKS: { code: 'MACYSBACKS', parser: 'macysbacks', sourceFormat: 'pdf', sampleStatus: 'verified' },
  MANDEE: { code: 'MANDEE', parser: 'known_unsupported', sourceFormat: 'pdf', sampleStatus: 'missing_source_hardcopy' },
  MARSHALLS: { code: 'MARSHALLS', parser: 'marshalls', sourceFormat: 'pdf', sampleStatus: 'verified' },
  MESALVEINC: { code: 'MESALVEINC', parser: 'mesalve', sourceFormat: 'pdf', sampleStatus: 'verified' },
  OLLIES: { code: 'OLLIES', parser: 'ollies', sourceFormat: 'pdf', sampleStatus: 'verified' },
  SHOE4500: { code: 'SHOE4500', parser: 'shoeshow', sourceFormat: 'pdf', sampleStatus: 'verified' },
  SPENCER: { code: 'SPENCER', parser: 'spencers', sourceFormat: 'pdf', sampleStatus: 'legacy_parser_no_canonical_source_sample' },
  TILLYS: { code: 'TILLYS', parser: 'tillys', sourceFormat: 'pdf', sampleStatus: 'verified' },
  TJMAXX: { code: 'TJMAXX', parser: 'tjmaxx', sourceFormat: 'pdf', sampleStatus: 'verified' },
  VARIETYWHO: { code: 'VARIETYWHO', parser: 'variety', sourceFormat: 'pdf', sampleStatus: 'verified' },
  VERSONA: { code: 'VERSONA', parser: 'catocorp', sourceFormat: 'pdf', sampleStatus: 'verified_family_ambiguous_identity' },
  ZUMIEZ: { code: 'ZUMIEZ', parser: 'zumiez', sourceFormat: 'pdf', sampleStatus: 'verified' }
});

export const CUSTOMER_CODE_ALIASES = Object.freeze({
  GORDONRBO: 'GORBRORET',
  GORDONBROTHERS: 'GORBRORET',
  GORDONBROTHERSRETAILPARTNERS: 'GORBRORET',
  BEALLS: 'BEALLSOUTL',
  CITI: 'CITI',
  CITITRENDS: 'CITI',
  GABES: 'GABRIELBRO',
  GABRIELBROTHERS: 'GABRIELBRO',
  SHOESHOW: 'SHOE4500',
  VARIETYWHOL: 'VARIETYWHO',
  VARIETYWHOLESALERS: 'VARIETYWHO',
  MACYSBACKSTAGE: 'MACYSBACKS',
  MESALVE: 'MESALVEINC',
  TJBMAXX: 'TJMAXX'
});

const TEXT_HINTS = [
  { code: 'ITSFASHION', re: /\bITS\s*FASHION\b|\bIT'?S\s+FASHION\b/i },
  { code: 'VERSONA', re: /\bVERSONA\b/i },
  { code: '10BELOW', re: /\b10\s*BELOW\b|\bSIMPLY\s*10\b/i },
  { code: 'BEALLSOUTL', re: /\bBEALLS\s*OUTLET\b|\bBEALLSOUTL\b/i },
  { code: 'CARNIVAL', re: /\bCARNIVAL\b/i },
  { code: 'CITI', re: /\bCITI\s*TRENDS\b|\bCITI\b/i },
  { code: 'COLONY', re: /\bCOLONY\s*BRANDS\b|\bCOLONY\b/i },
  { code: 'GABRIELBRO', re: /\bGABRIEL\s*BROTHERS\b|\bGABE'?S\b/i },
  { code: 'GORBRORET', re: /\bGORDON\s*BROTHERS(?:\s*RETAIL\s*PARTNERS)?\b|\bGORDONRBO\b|\bGORBRORET\b/i },
  { code: 'HAMRICKS', re: /\bHAMRICK'?S\b|\bHAMRICKS\b/i },
  { code: 'IPC', re: /\bINTEGRATED\s*PREMIUM\s*CONCEPTS\b|\bIPC\b/i },
  { code: 'MACYSBACKS', re: /\bMACY'?S\s*BACKSTAGE\b|\bMACYSBACKS\b/i },
  { code: 'MANDEE', re: /\bMANDEE\b/i },
  { code: 'MARSHALLS', re: /\bMARSHALL'?S\b|\bMARSHALLS\b/i },
  { code: 'MESALVEINC', re: /\bME\s*SALVE\b|\bMESALVEINC\b/i },
  { code: 'OLLIES', re: /\bOLLIE'?S\b|\bOLLIES\b/i },
  { code: 'SHOE4500', re: /\bSHOE\s*SHOW\b|\bSHOE4500\b/i },
  { code: 'SPENCER', re: /\bSPENCER'?S?\s*GIFTS?\b|\bSPENCER\b/i },
  { code: 'TILLYS', re: /\bTILLY'?S\b|\bTILLYS\b/i },
  { code: 'TJMAXX', re: /\bTJ\s*MAXX\b|\bTJMAXX\b/i },
  { code: 'VARIETYWHO', re: /\bVARIETY\s*WHOLESALERS\b|\bVARIETYWHO\b/i },
  { code: 'ZUMIEZ', re: /\bZUMIEZ\b/i },
  // CATO is intentionally last. This only examines upstream document metadata,
  // never the PDF body, so a subject explicitly saying CATO is usable evidence.
  { code: 'CATO', re: /\bCATO\b/i }
];

function structuredCandidates(document = {}) {
  return [
    ['document.customer_code', document.customer_code],
    ['document.customer_candidate', document.customer_candidate],
    ['document.detected_customer_code', document.detected_customer_code],
    ['document.raw.customer_code', document.raw?.customer_code],
    ['document.raw.customer_candidate', document.raw?.customer_candidate],
    ['document.raw.analysis.customerCode', document.raw?.analysis?.customerCode]
  ];
}

export function resolveCustomerCodeAlias(value) {
  const key = token(value);
  if (!key) return null;
  if (CUSTOMER_PROFILES[key]) return key;
  return CUSTOMER_CODE_ALIASES[key] || null;
}

export function customerHintFromDocument(document = {}, allowedCodes = null) {
  const allowed = allowedCodes ? new Set(allowedCodes.map((value) => resolveCustomerCodeAlias(value) || upperCode(value)).filter(Boolean)) : null;
  for (const [source, value] of structuredCandidates(document)) {
    const code = resolveCustomerCodeAlias(value);
    if (code && (!allowed || allowed.has(code))) return { code, source, evidence: clean(value), strength: 'structured' };
  }

  const textSources = [
    ['document.subject', document.subject],
    ['document.file_name', document.file_name],
    ['document.raw.analysis.customerName', document.raw?.analysis?.customerName],
    ['document.raw.customerName', document.raw?.customerName],
    ['document.raw.customer_name', document.raw?.customer_name]
  ];
  for (const [source, value] of textSources) {
    const text = clean(value);
    if (!text) continue;
    for (const hint of TEXT_HINTS) {
      if (allowed && !allowed.has(hint.code)) continue;
      if (hint.re.test(text)) return { code: hint.code, source, evidence: text, strength: 'metadata_text' };
    }
  }
  return null;
}

function upperCode(value) {
  return clean(value).toUpperCase();
}

export function customerProfile(codeOrAlias) {
  const code = resolveCustomerCodeAlias(codeOrAlias);
  return code ? CUSTOMER_PROFILES[code] || null : null;
}

export function allCustomerCodes() {
  return Object.keys(CUSTOMER_PROFILES);
}
