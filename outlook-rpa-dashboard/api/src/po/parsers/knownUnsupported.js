import { customerHintFromDocument, customerProfile } from '../customerProfiles.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function parseKnownUnsupported({ text, fileName, document, forcedCode = null }) {
  const hint = forcedCode
    ? { code: forcedCode, source: 'detector_known_profile', evidence: forcedCode, strength: 'structured' }
    : customerHintFromDocument(document);
  const profile = customerProfile(hint?.code);
  const customerCode = profile?.code || hint?.code || null;
  const isXlsxGap = profile?.sourceFormat === 'xlsx';
  const conflictCode = isXlsxGap ? 'source_format_not_supported_xlsx' : 'hardcopy_layout_not_profiled';
  const message = isXlsxGap
    ? `Customer ${customerCode} is recognized from upstream metadata and its available original hardcopy source is XLSX, but the current Outlook/document ingestion pipeline accepts PDF only. Provide or convert the original PO to PDF, or add XLSX ingestion. The parser refuses to derive the order from PT/checklist/export documents.`
    : profile?.sampleStatus === 'missing_source_hardcopy'
      ? `Customer ${customerCode} is recognized from upstream metadata, but no original source hardcopy sample was provided. Provide one original customer-issued PO/hardcopy PDF. The parser refuses to invent a layout from PT/checklist/export documents.`
      : profile?.sampleStatus === 'legacy_parser_no_canonical_source_sample'
        ? `Customer ${customerCode} is recognized from upstream metadata and a legacy parser exists, but no canonical original hardcopy sample was provided to regression-test the current layout. Provide one original customer-issued PO/hardcopy PDF before enabling automatic import for an unmatched layout.`
        : profile?.sampleStatus === 'family_only'
          ? `Customer ${customerCode} is recognized from upstream metadata, but only the broader Cato Corporation document family has been profiled. The source PDF must match that verified family signature and customer/banner identity must be supported by upstream metadata.`
          : `Customer ${customerCode || 'UNKNOWN'} is recognized from upstream metadata, but this source document layout does not match a verified family signature. The order is blocked instead of being guessed.`;

  return {
    parser: 'known_unsupported',
    document_family: customerCode ? `${customerCode.toLowerCase()}_unprofiled_source_document` : 'known_customer_unprofiled_source_document',
    layout_version: null,
    document_identity: {
      legal_entity_raw: null,
      brand_raw: null,
      customer_candidate: customerCode,
      customer_candidate_source: hint?.source || null,
      a2000_customer_code: null,
      upstream_customer_hint: hint || null
    },
    confidence: customerCode ? 0.55 : 0.2,
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
      raw: {
        source_file_name: clean(fileName) || null,
        upstream_customer_hint: hint || null,
        source_profile: profile || null,
        text_present: Boolean(clean(text))
      }
    },
    lines: [],
    totals: {},
    conflicts: [{
      field: 'document_family',
      code: conflictCode,
      severity: 'high',
      blocking: true,
      message,
      customer_code_candidate: customerCode,
      source_profile: profile || null
    }],
    warnings: []
  };
}
