import {
  loadMasterData
} from './masterData.js';
import {
  resolveOrderOfficialMasterIdentity
} from './officialMasterIdentityResolver.js';

const CATO_FAMILY_CUSTOMERS = Object.freeze([
  'CATO',
  'ITSFASHION',
  'VERSONA'
]);

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).replace(/\u00a0/g, ' ').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function exactCustomerOwnedPair(
  masters,
  customerCode,
  styleCode,
  colorCode
) {
  const style = upper(styleCode);
  const color = upper(colorCode);
  const customer = upper(customerCode);

  if (!style || !color || !customer) return false;

  return (
    masters.skuByStyle.get(style) || []
  ).some(
    row => (
      upper(row.Clr) === color
      && upper(row.Customer) === customer
    )
  );
}

function summarizeTrial(
  rawParsed,
  customerCode,
  masters
) {
  const trial = cloneValue(rawParsed);
  trial.header = trial.header || {};
  trial.header.customer_code = customerCode;

  resolveOrderOfficialMasterIdentity(
    trial,
    masters
  );

  const lines = Array.isArray(trial.lines)
    ? trial.lines
    : [];

  const lineEvidence = lines.map(line => {
    const trace = (
      line.raw?.universal_official_master_identity
      || {}
    );

    const exactPair = (
      trace.exact_official_style_color_exists === true
    );

    const customerOwnedPair = exactCustomerOwnedPair(
      masters,
      customerCode,
      line.style_code,
      line.color_code
    );

    return {
      line_no: line.line_no || null,
      style_raw: clean(line.style_raw) || null,
      color_raw: clean(line.color_raw) || null,
      style_code: clean(line.style_code) || null,
      color_code: clean(line.color_code) || null,
      exact_official_style_color: exactPair,
      exact_customer_owned_style_color: customerOwnedPair,
      style_scope: trace.style_scope || null,
      style_source: trace.style_source || null,
      color_source: trace.color_source || null
    };
  });

  const exactPairCount = lineEvidence.filter(
    line => line.exact_official_style_color
  ).length;

  const customerOwnedPairCount = lineEvidence.filter(
    line => line.exact_customer_owned_style_color
  ).length;

  return {
    customer_code: customerCode,
    line_count: lineEvidence.length,
    exact_pair_count: exactPairCount,
    customer_owned_pair_count: customerOwnedPairCount,
    valid: (
      lineEvidence.length > 0
      && exactPairCount === lineEvidence.length
      && customerOwnedPairCount === lineEvidence.length
    ),
    lines: lineEvidence
  };
}

export function resolveCatoFamilyCustomerFromOfficialMaster(
  parsed,
  providedMasters = null
) {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }

  if (parsed.parser !== 'catocorp') {
    return parsed;
  }

  parsed.header = parsed.header || {};

  if (upper(parsed.header.customer_code)) {
    return parsed;
  }

  const masters = providedMasters || loadMasterData();

  if (!masters?.loaded) {
    return parsed;
  }

  const trials = CATO_FAMILY_CUSTOMERS.map(
    customerCode => summarizeTrial(
      parsed,
      customerCode,
      masters
    )
  );

  const winners = trials.filter(
    trial => trial.valid
  );

  parsed.raw_enrichment = parsed.raw_enrichment || {};
  parsed.raw_enrichment.cato_family_customer_identity = {
    policy: 'OFFICIAL_VR_SKU_EXACT_CUSTOMER_OWNERSHIP_ONLY',
    resolver_version: 'cato_family_customer_identity_v4_6_7',
    candidates: CATO_FAMILY_CUSTOMERS,
    trials,
    winner_count: winners.length,
    resolved_customer_code: (
      winners.length === 1
        ? winners[0].customer_code
        : null
    )
  };

  if (winners.length !== 1) {
    return parsed;
  }

  const customerCode = winners[0].customer_code;

  parsed.header.customer_code = customerCode;
  parsed.header.raw = parsed.header.raw || {};
  parsed.header.raw.cato_family_customer_resolution = {
    status: 'resolved',
    source: 'VR_SKU_EXACT_CUSTOMER_OWNERSHIP',
    customer_code: customerCode,
    exact_customer_owned_line_count: (
      winners[0].customer_owned_pair_count
    ),
    line_count: winners[0].line_count
  };

  parsed.document_identity = parsed.document_identity || {};
  parsed.document_identity.customer_candidate = customerCode;
  parsed.document_identity.customer_candidate_source = (
    'VR_SKU_EXACT_CUSTOMER_OWNERSHIP'
  );
  parsed.document_identity.a2000_customer_code = customerCode;

  parsed.conflicts = (
    Array.isArray(parsed.conflicts)
      ? parsed.conflicts
      : []
  ).filter(
    conflict => (
      clean(conflict.code)
      !== 'cato_banner_identity_ambiguous'
    )
  );

  return parsed;
}

export {
  CATO_FAMILY_CUSTOMERS
};
