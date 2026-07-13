import {
  cleanMasterValue,
  loadMasterData,
  normalizeMasterAddressParts,
  normalizeMasterToken
} from './masterData.js';
import {
  aggregateCitiSizeRows,
  hasPositiveSizeDistribution,
  mapExtractedSizeToBucket
} from './sizeScaleMapping.js';

function clean(value) {
  return cleanMasterValue(value);
}

function upper(value) {
  return clean(value).toUpperCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function finiteNumber(value) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateSummary(rows, limit = 8) {
  return (rows || []).slice(0, limit).map((row) => ({
    style: clean(row.Style),
    color: clean(row.Clr),
    color_description: clean(row['Clr Desc']),
    color_abbr: clean(row['Clr Abbr']),
    sku: clean(row.Sku),
    div: clean(row.Div),
    customer: clean(row.Customer),
    scale: clean(row.Scale),
    scale_abbr: clean(row['Scale Abbr']),
    warehouse: clean(row.Wh),
    price: clean(row.Price)
  }));
}

function skuBusinessTuple(row) {
  return [
    upper(row.Style),
    upper(row.Clr),
    upper(row.Scale),
    upper(row.Div),
    normalizeMasterToken(row.Sku),
    upper(row.Wh),
    clean(row.Price),
    clean(row['Pack Qty'])
  ].join('|');
}

function collapseRowsByTuple(rows, tupleFn = skuBusinessTuple) {
  const map = new Map();
  for (const row of rows || []) {
    const key = tupleFn(row);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function rowsForCustomerPreference(rows, customerCode) {
  const customer = upper(customerCode);
  const specific = (rows || []).filter((row) => upper(row.Customer) === customer);
  if (specific.length) return specific;
  const stock = (rows || []).filter((row) => upper(row.Customer) === 'STOCK');
  if (stock.length) return stock;
  return rows || [];
}

function inferCustomer(parsed, masters) {
  const header = parsed.header || {};
  const current = upper(header.customer_code);
  if (current && masters.customerByCode.has(current)) return current;

  const candidate = upper(parsed.document_identity?.customer_candidate);
  if (candidate && masters.customerByCode.has(candidate)) return candidate;

  const parser = clean(parsed.parser).toLowerCase();
  const parserCandidates = {
    cititrends: 'CITI',
    bealls: 'BEALLSOUTL',
    ollies: 'OLLIES',
    carnival: 'CARNIVAL',
    tenbelow: '10BELOW',
    ipc: 'IPC',
    tillys: 'TILLYS',
    zumiez: 'ZUMIEZ',
    macysbacks: 'MACYSBACKS',
    colony: 'COLONY',
    spencers: 'SPENCER',
    variety: 'VARIETYWHO',
    shoeshow: 'SHOE4500',
    gabes: 'GABRIELBRO',
    marshalls: 'MARSHALLS',
    tjmaxx: 'TJMAXX',
    mesalve: 'MESALVEINC'
  };
  const parserCandidate = parserCandidates[parser];
  if (parserCandidate && masters.customerByCode.has(parserCandidate)) return parserCandidate;

  const rawKey = normalizeMasterToken(header.customer_raw);
  if (rawKey && masters.customerByName.has(rawKey)) {
    return upper(masters.customerByName.get(rawKey).Customer);
  }
  return null;
}

function parseTermsSemantics(value) {
  const raw = upper(value);
  if (!raw) return { category: 'ABSENT', days: null, raw: null };
  if (/\b(PREPAY|PREPAID|PAYMENT\s+IN\s+ADVANCE|PAY\s+IN\s+ADVANCE)\b/.test(raw)) {
    return { category: 'PREPAY', days: null, raw };
  }
  const netMatches = [...raw.matchAll(/\bNET\s*([0-9]{1,3})\b/g)].map((match) => Number(match[1]));
  const daysMatches = [...raw.matchAll(/\b([0-9]{1,3})\s+DAYS?\b/g)].map((match) => Number(match[1]));
  const slashDays = raw.match(/%\s*\/\s*([0-9]{1,3})\s+DAYS?\b/)?.[1];
  const days = netMatches.at(-1) ?? (slashDays ? Number(slashDays) : daysMatches.at(-1) ?? null);
  if (Number.isInteger(days)) return { category: 'NET', days, raw };
  return { category: 'UNKNOWN', days: null, raw };
}

function termsSemanticAudit(pdfRaw, masterDescription, masterCode) {
  const pdf = parseTermsSemantics(pdfRaw);
  const master = parseTermsSemantics(masterDescription || masterCode);
  if (pdf.category === 'ABSENT') return { status: 'pdf_terms_absent', pdf, master };
  if (pdf.category === 'UNKNOWN' || master.category === 'UNKNOWN' || master.category === 'ABSENT') {
    return { status: 'unknown_semantics', pdf, master };
  }
  if (pdf.category !== master.category) return { status: 'policy_mismatch', pdf, master };
  if (pdf.category === 'NET' && master.category === 'NET') {
    const difference = Math.abs(Number(pdf.days) - Number(master.days));
    if (difference === 0) return { status: 'compatible', pdf, master, difference_days: 0 };
    if (difference === 1) return { status: 'soft_day_difference', pdf, master, difference_days: difference };
    return { status: 'net_days_mismatch', pdf, master, difference_days: difference };
  }
  return { status: 'compatible', pdf, master };
}

function applyCustomerMaster(parsed, masters, conflicts, warnings, trace) {
  const header = parsed.header || {};
  const customerCode = inferCustomer(parsed, masters);
  if (!customerCode) return null;
  const customer = masters.customerByCode.get(customerCode);
  if (!customer) return null;

  header.customer_code = customerCode;
  header.raw = header.raw || {};
  const masterTerms = clean(customer.Terms);
  const previousTermsCode = clean(header.terms_code);
  const audit = termsSemanticAudit(header.terms_raw, customer['Terms Description'], masterTerms);
  header.raw.customer_master = {
    customer: customerCode,
    name: clean(customer['Cust Name']),
    terms: masterTerms,
    terms_description: clean(customer['Terms Description']),
    ship_via: clean(customer['Ship Via']),
    def_wh: clean(customer['Def Wh']),
    div: clean(customer.Div),
    address: [customer['Addr 1'], customer.City, customer.State, customer.Postal].map(clean).filter(Boolean).join(', '),
    terms_resolution: masterTerms ? {
      source: 'customer_master',
      code: masterTerms,
      pdf_terms_raw: clean(header.terms_raw) || null,
      comparison_mode: 'semantic_audit_only',
      audit
    } : null
  };

  if (masterTerms) {
    header.terms_code = masterTerms;
    if (previousTermsCode && upper(previousTermsCode) !== upper(masterTerms)) {
      conflicts.push({
        field: 'terms_code', code: 'non_master_terms_code_conflict', severity: 'high', blocking: true,
        message: 'Existing terms code differs from the official Customer Master TERM code.',
        existing: previousTermsCode, master: masterTerms
      });
    }
  }

  if (audit.status === 'policy_mismatch' || audit.status === 'net_days_mismatch') {
    warnings.push({
      field: 'terms_code', code: 'terms_master_policy_precedence', severity: 'medium', blocking: false,
      message: 'Printed payment terms differ from the official Customer Master policy. Per business rule, TERM_NO remains the Customer Master code and the PDF text is retained for audit.',
      pdf: clean(header.terms_raw) || null,
      master_code: masterTerms || null,
      master_description: clean(customer['Terms Description']) || null,
      audit
    });
  } else if (audit.status === 'soft_day_difference') {
    warnings.push({
      field: 'terms_code', code: 'terms_soft_day_difference', severity: 'low', blocking: false,
      message: 'Printed NET day count differs from Customer Master by one day. Master TERM_NO is retained and the source difference is recorded.',
      pdf: clean(header.terms_raw) || null,
      master_code: masterTerms || null,
      master_description: clean(customer['Terms Description']) || null,
      audit
    });
  }

  if (!header.ship_via_code && clean(customer['Ship Via'])) header.ship_via_code = clean(customer['Ship Via']);
  if (!header.warehouse_code && clean(customer['Def Wh'])) header.warehouse_code = clean(customer['Def Wh']);
  if (!header.division_code && clean(customer.Div)) header.division_code = clean(customer.Div);

  trace.customer = header.raw.customer_master;
  return customerCode;
}

function storeActivityStatus(row) {
  const value = upper(row?.Active);
  if (value === 'Y') return 'active';
  if (value === 'N') return 'inactive';
  return 'unknown';
}

function isActiveStore(row) {
  return storeActivityStatus(row) === 'active';
}

function isExactPrintedStoreUsable(row) {
  // Exact customer + printed STORE_NO existence is authoritative master evidence.
  // Explicit Active=N blocks it. Blank/unknown Active is accepted only for the
  // exact printed key because malformed official CSV rows are quarantined from
  // address/default/WH enrichment rather than column-shifted into fake fields.
  return Boolean(row) && storeActivityStatus(row) !== 'inactive';
}

function activeRowsByStore(rows) {
  const byStore = new Map();
  for (const row of (rows || []).filter(isActiveStore)) {
    const key = upper(row.Store);
    if (key && !byStore.has(key)) byStore.set(key, row);
  }
  return [...byStore.values()];
}

function activeUniqueStore(rows) {
  const active = activeRowsByStore(rows);
  return active.length === 1 ? active[0] : null;
}

function shipToSearchText(shipTo = {}) {
  return normalizeMasterToken([
    shipTo.name_raw,
    shipTo.location_name_raw,
    shipTo.contact_raw,
    ...(Array.isArray(shipTo.block_raw) ? shipTo.block_raw : [shipTo.block_raw])
  ].filter(Boolean).join(' '));
}

function normalizeEntityIdentity(value) {
  return normalizeMasterToken(value)
    .replace(/^THE/, '')
    .replace(/(?:INCORPORATED|CORPORATION|CORP|COMPANY|CO|LLC|INC)$/g, '');
}

function pickBestActiveStore(rows, shipTo = null) {
  const active = activeRowsByStore(rows);
  if (active.length <= 1) return active[0] || null;

  const primaryIdentityTokens = unique([
    normalizeMasterToken(shipTo?.name_raw),
    normalizeMasterToken(shipTo?.location_name_raw)
  ]);
  for (const identityToken of primaryIdentityTokens) {
    const exactCode = active.filter((row) => normalizeMasterToken(row.Store) === identityToken);
    if (exactCode.length === 1) return exactCode[0];
    const exactLabel = active.filter((row) => [row['St Name'], row['St Label Name']].map(normalizeMasterToken).includes(identityToken));
    if (exactLabel.length === 1) return exactLabel[0];
    const identityCore = normalizeEntityIdentity(identityToken);
    const entityLabel = active.filter((row) => [row['St Name'], row['St Label Name']].map(normalizeEntityIdentity).includes(identityCore));
    if (identityCore && entityLabel.length === 1) return entityLabel[0];
  }

  const haystack = shipToSearchText(shipTo);
  if (haystack) {
    const codeMatch = active.filter((row) => {
      const store = normalizeMasterToken(row.Store);
      return store && (haystack.includes(store) || store.includes(haystack));
    });
    if (codeMatch.length === 1) return codeMatch[0];

    const nameMatch = active.filter((row) => {
      const name = normalizeMasterToken(row['St Name']);
      return name && (haystack.includes(name) || name.includes(haystack));
    });
    if (nameMatch.length === 1) return nameMatch[0];
  }

  const ship = active.find((row) => upper(row.Store) === 'SHIP');
  if (ship) return ship;
  const same = active.find((row) => upper(row.Store) === 'SAME');
  if (same) return same;
  return null;
}

function leadingStreetNumber(value) {
  return clean(value).match(/^(\d{1,8})\b/)?.[1] || null;
}

function exactStoreByShipToFirstStreetNumber(masters, customerCode, shipTo) {
  const number = leadingStreetNumber(shipTo?.address1_raw);
  const city = normalizeMasterToken(shipTo?.city_raw);
  const state = upper(shipTo?.state_raw);
  const postal = normalizeMasterToken(shipTo?.postal_raw);
  if (!number || !postal) return null;
  const rows = (masters.storesByCustomer?.get(customerCode) || []).filter((row) => {
    if (!isActiveStore(row)) return false;
    if (leadingStreetNumber(row['St Addr 1']) !== number) return false;
    if (postal && normalizeMasterToken(row['St Postal']) !== postal) return false;
    if (state && upper(row['St State']) !== state) return false;
    if (city && normalizeMasterToken(row['St City']) !== city) return false;
    return true;
  });
  return pickBestActiveStore(rows, shipTo);
}

function storeTrace(source, customerCode, store, extras = {}) {
  return {
    source,
    customer: customerCode,
    store: clean(store.Store),
    name: clean(store['St Name']),
    address: [store['St Addr 1'], store['St City'], store['St State'], store['St Postal']].map(clean).filter(Boolean).join(', '),
    active: clean(store.Active),
    activity_status: storeActivityStatus(store),
    source_row_status: clean(store['Source Row Status']) || 'ok',
    ...extras
  };
}

function exactStoreByShipToLocation(masters, customerCode, shipTo) {
  const location = normalizeMasterToken(shipTo?.location_name_raw);
  const city = normalizeMasterToken(shipTo?.city_raw);
  const state = upper(shipTo?.state_raw);
  const postal = normalizeMasterToken(shipTo?.postal_raw);
  if (!location || !city || !state || !postal) return null;
  const rows = (masters.storesByCustomer?.get(customerCode) || []).filter((row) => {
    if (!isActiveStore(row)) return false;
    const locationTokens = [row['St Name'], row['St Addr 1']].map(normalizeMasterToken).filter(Boolean);
    return locationTokens.includes(location)
      && normalizeMasterToken(row['St City']) === city
      && upper(row['St State']) === state
      && normalizeMasterToken(row['St Postal']) === postal;
  });
  return pickBestActiveStore(rows, shipTo);
}

function applyDefaultStore(parsed, masters, customerCode, trace, warnings) {
  const header = parsed.header || {};
  const parser = clean(parsed.parser).toLowerCase();
  if (!customerCode) return;

  let resolvedStore = null;
  let resolutionTrace = null;

  if (header.store_raw) {
    const exact = masters.storeByCustomerStore.get(`${customerCode}|${upper(header.store_raw)}`);
    if (exact && isExactPrintedStoreUsable(exact)) {
      resolvedStore = exact;
      const activityStatus = storeActivityStatus(exact);
      resolutionTrace = storeTrace('stores_master_exact_printed_store', customerCode, exact, { printed_store_raw: clean(header.store_raw) });
      if (activityStatus === 'unknown') {
        warnings.push({
          field: 'store_code', code: 'printed_store_master_activity_unknown', severity: 'low', blocking: false,
          message: 'Printed STORE/DC exists as an exact Customer+Store key in the official Store Master. Its activity flag is unavailable/unknown, so the exact printed key is retained but the uncertainty is recorded.',
          printed_store_raw: clean(header.store_raw), source_row_status: clean(exact['Source Row Status']) || 'ok'
        });
      }
    } else if (exact && storeActivityStatus(exact) === 'inactive') {
      warnings.push({ field: 'store_code', code: 'printed_store_inactive', severity: 'low', blocking: false, message: 'Printed store/DC exists in the official master and is explicitly inactive; STORE_NO was not auto-resolved.', printed_store_raw: clean(header.store_raw) });
    }
  }

  if (!resolvedStore) {
    const shipTo = header.raw?.ship_to;
    if (shipTo?.semantics === 'SHIP_TO') {
      const addressKey = normalizeMasterAddressParts({
        customer: customerCode,
        address1: shipTo.address1_raw,
        city: shipTo.city_raw,
        state: shipTo.state_raw,
        postal: shipTo.postal_raw
      });
      const candidates = addressKey ? masters.storeByCustomerAddressNorm.get(addressKey) || [] : [];
      const exactAddressStore = pickBestActiveStore(candidates, shipTo);
      if (exactAddressStore) {
        resolvedStore = exactAddressStore;
        resolutionTrace = storeTrace('stores_master_exact_ship_to_address', customerCode, exactAddressStore, { address_key: addressKey, ship_to_raw: shipTo });
      } else if (candidates.length) {
        warnings.push({ field: 'store_code', code: 'ship_to_address_ambiguous_or_inactive', severity: 'low', blocking: false, message: 'Ship To address matched master rows but not one unique active store.', candidate_stores: unique(candidates.map((row) => clean(row.Store))) });
      }
    }
  }

  if (!resolvedStore) {
    const shipTo = header.raw?.ship_to;
    if (shipTo?.semantics === 'SHIP_TO') {
      const locationStore = exactStoreByShipToLocation(masters, customerCode, shipTo);
      if (locationStore) {
        resolvedStore = locationStore;
        resolutionTrace = storeTrace('stores_master_exact_ship_to_location_city_postal', customerCode, locationStore, { ship_to_raw: shipTo });
      }
    }
  }

  if (!resolvedStore) {
    const shipTo = header.raw?.ship_to;
    if (shipTo?.semantics === 'SHIP_TO') {
      const firstNumberStore = exactStoreByShipToFirstStreetNumber(masters, customerCode, shipTo);
      if (firstNumberStore) {
        resolvedStore = firstNumberStore;
        resolutionTrace = storeTrace('stores_master_first_street_number_city_state_postal', customerCode, firstNumberStore, { ship_to_raw: shipTo, match_basis: 'leading street number + city/state/postal + best customer/store text match' });
      }
    }
  }

  if (!resolvedStore && header.raw?.default_store_code_raw) {
    const defaultCode = upper(header.raw.default_store_code_raw);
    const exactDefault = masters.storeByCustomerStore.get(`${customerCode}|${defaultCode}`);
    if (exactDefault && isExactPrintedStoreUsable(exactDefault)) {
      resolvedStore = exactDefault;
      resolutionTrace = storeTrace('stores_master_explicit_parser_default_store', customerCode, exactDefault, { default_store_code_raw: defaultCode, reason: clean(header.raw.default_store_reason) || null });
    }
  }

  if (!resolvedStore && parser === 'cititrends' && customerCode === 'CITI') {
    const same = masters.storeByCustomerStore.get('CITI|SAME');
    if (same && isActiveStore(same)) {
      resolvedStore = same;
      resolutionTrace = storeTrace('stores_master_exact_citi_same', customerCode, same);
    }
  }

  if (resolvedStore) {
    header.store_code = clean(resolvedStore.Store) || null;
    header.raw = header.raw || {};
    header.raw.store_master = resolutionTrace;
    if (!header.ship_via_code && clean(resolvedStore['Ship Via'])) header.ship_via_code = clean(resolvedStore['Ship Via']);
    if (!header.warehouse_code && clean(resolvedStore.Wh)) header.warehouse_code = clean(resolvedStore.Wh);
    trace.store = resolutionTrace;
  }
}

function styleRowsForStyle(masters, styleCode) {
  return masters.skuByStyle.get(upper(styleCode)) || [];
}

function inferStyleFromMaster({ masters, customerCode, styleRaw }) {
  const rawToken = normalizeMasterToken(styleRaw);
  if (!rawToken) return { style_code: null, candidates: [], reason: null };

  // Exact A2000 style code is stronger than Master Style / Alias indexes.
  const exactStyleCode = upper(styleRaw);
  if (exactStyleCode && masters.skuByStyle.has(exactStyleCode)) {
    const exactRows = masters.skuByStyle.get(exactStyleCode) || [];
    return { style_code: exactStyleCode, candidates: exactRows, reason: 'exact_style_code_master_match' };
  }

  const styles = new Set();
  for (const customer of unique([upper(customerCode), 'STOCK'])) {
    const direct = masters.styleByCustomerNorm.get(`${customer}|${rawToken}`);
    if (direct) direct.forEach((style) => styles.add(style));
  }
  const uniqueStyles = [...styles];
  return {
    style_code: uniqueStyles.length === 1 ? uniqueStyles[0] : null,
    candidates: uniqueStyles.flatMap((style) => styleRowsForStyle(masters, style)),
    reason: uniqueStyles.length === 1 ? 'exact_normalized_style_master_field' : uniqueStyles.length > 1 ? 'exact_normalized_style_ambiguous' : 'exact_normalized_style_not_found'
  };
}



function levenshteinDistance(leftValue, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function resolveNearestOfficialStyle({ masters, styleRaw }) {
  const rawToken = normalizeMasterToken(styleRaw);
  if (rawToken.length < 7) return { style_code: null, candidates: [], reason: 'style_token_too_short_for_similarity' };
  const maxDistance = rawToken.length >= 12 ? 2 : 1;
  const scored = [];
  for (const [styleCode, rows] of masters.skuByStyle.entries()) {
    const styleToken = normalizeMasterToken(styleCode);
    const stablePrefixLength = rawToken.length >= 8 ? 3 : 4;
    if (!styleToken || styleToken.slice(0, stablePrefixLength) !== rawToken.slice(0, stablePrefixLength)) continue;
    const distance = levenshteinDistance(rawToken, styleToken);
    if (distance > maxDistance) continue;
    const prefixRelation = styleToken.startsWith(rawToken) || rawToken.startsWith(styleToken);
    const prefix_rank = prefixRelation ? 0 : 1;
    const length_delta = Math.abs(styleToken.length - rawToken.length);
    scored.push({ style_code: styleCode, distance, prefix_rank, length_delta, rows });
  }
  scored.sort((a, b) => a.distance - b.distance || a.prefix_rank - b.prefix_rank || a.length_delta - b.length_delta || a.style_code.localeCompare(b.style_code));
  if (!scored.length) return { style_code: null, candidates: [], reason: 'no_near_official_style' };
  const bestKey = [scored[0].distance, scored[0].prefix_rank, scored[0].length_delta].join('|');
  const best = scored.filter((entry) => [entry.distance, entry.prefix_rank, entry.length_delta].join('|') === bestKey);
  if (best.length !== 1) {
    return {
      style_code: null,
      candidates: best.flatMap((entry) => entry.rows),
      reason: 'nearest_official_style_tied_after_prefix_ranking',
      scored: best.map(({ style_code, distance, prefix_rank, length_delta }) => ({ style_code, distance, prefix_rank, length_delta }))
    };
  }
  return {
    style_code: best[0].style_code,
    candidates: best[0].rows,
    reason: best[0].prefix_rank === 0 ? 'nearest_official_style_unique_prefix_extension' : 'nearest_official_style_unique_edit_distance',
    distance: best[0].distance,
    scored: scored.slice(0, 5).map(({ style_code, distance, prefix_rank, length_delta }) => ({ style_code, distance, prefix_rank, length_delta }))
  };
}

function resolveTrailingSuffixColorPrefix({ styleRows, suffixRaw }) {
  const suffix = upper(suffixRaw);
  if (!/^[A-Z0-9]{2,8}$/.test(suffix)) return { color_code: null, candidates: [], reason: 'suffix_not_color_like' };
  const colors = unique((styleRows || []).map((row) => upper(row.Clr)));
  const scored = colors.map((code) => {
    let score = 0;
    if (code === suffix) score = 100;
    else if (code.startsWith(suffix)) score = 95 - Math.max(0, code.length - suffix.length);
    else if (suffix.startsWith(code)) score = 88 - Math.max(0, suffix.length - code.length);
    return { code, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  if (!scored.length) return { color_code: null, candidates: colors, reason: 'printed_suffix_no_official_color_prefix_match' };
  const bestScore = scored[0].score;
  const best = scored.filter((entry) => entry.score === bestScore);
  if (best.length !== 1 || bestScore < 90) return { color_code: null, candidates: scored, reason: 'printed_suffix_official_color_prefix_ambiguous' };
  return { color_code: best[0].code, candidates: scored, reason: bestScore === 100 ? 'printed_suffix_exact_official_color' : 'printed_suffix_unique_prefix_of_official_color', score: bestScore };
}

function consonantSkeleton(value) {
  return normalizeMasterToken(value).replace(/[AEIOUY]/g, '');
}

function descriptionTokens(value) {
  return upper(value).split(/[^A-Z0-9]+/).map((token) => token.trim()).filter(Boolean);
}

function fuzzyTokenMatchScore(expectedValue, rawTokens) {
  const expected = normalizeMasterToken(expectedValue);
  if (!expected) return 0;
  const expectedSkeleton = consonantSkeleton(expected);
  let best = 0;
  for (const token of rawTokens) {
    const normalized = normalizeMasterToken(token);
    const skeleton = consonantSkeleton(normalized);
    if (normalized === expected) best = Math.max(best, 100);
    if (expected.length >= 3 && (normalized.startsWith(expected) || expected.startsWith(normalized))) best = Math.max(best, 96);
    if (expectedSkeleton && skeleton === expectedSkeleton) best = Math.max(best, 98);
    if (expectedSkeleton.length >= 3 && skeleton.length >= 3) {
      const distance = levenshteinDistance(expectedSkeleton, skeleton);
      if (distance === 1) best = Math.max(best, 92);
      else if (distance === 2 && Math.max(expectedSkeleton.length, skeleton.length) >= 5) best = Math.max(best, 86);
    }
  }
  return best;
}

function colorDescriptionScore(row, descriptionRaw) {
  const rawTokens = descriptionTokens(descriptionRaw);
  const normalizedDescription = normalizeMasterToken(descriptionRaw);
  const desc = clean(row['Clr Desc']);
  const abbr = clean(row['Clr Abbr']);
  if (!rawTokens.length || (!desc && !abbr)) return 0;
  if (desc && normalizedDescription.includes(normalizeMasterToken(desc))) return 100;
  if (abbr && rawTokens.some((token) => normalizeMasterToken(token) === normalizeMasterToken(abbr))) return 99;
  const abbrScore = abbr ? fuzzyTokenMatchScore(abbr, rawTokens) : 0;
  const descWords = upper(desc).split(/[^A-Z0-9]+/).filter((word) => word.length >= 3);
  const wordScores = descWords.map((word) => fuzzyTokenMatchScore(word, rawTokens));
  const allWordsMatched = wordScores.length > 0 && wordScores.every((score) => score >= 90);
  if (allWordsMatched) return Math.min(98, 90 + wordScores.length * 2);
  return Math.max(abbrScore, ...wordScores, 0);
}

function colorHasAllSizeOfficialUpc(masters, styleCode, colorCode) {
  const rows = masters.upcByStyleColor.get(`${upper(styleCode)}|${upper(colorCode)}`) || [];
  return rows.some((row) => clean(row['Size Num']) === '0' || upper(row['Size Name']) === 'ALL');
}

function chooseSemanticColorCode({ masters, styleCode, rows, preference }) {
  const colorCodes = unique((rows || []).map((row) => upper(row.Clr)));
  if (colorCodes.length === 1) return { color_code: colorCodes[0], reason: 'single_official_code_for_semantic_color' };
  if (upper(preference) === 'ALPHA_ALL_SIZE_FOR_PREPACK') {
    const alphaAll = colorCodes.filter((code) => /^[A-Z]{3}$/.test(code) && colorHasAllSizeOfficialUpc(masters, styleCode, code));
    if (alphaAll.length === 1) return { color_code: alphaAll[0], reason: 'unique_alpha_all_size_official_color_for_prepack' };
  }
  if (upper(preference) === 'NUMERIC_FOR_SOLID') {
    const numeric = colorCodes.filter((code) => /^\d{3}$/.test(code));
    if (numeric.length === 1) return { color_code: numeric[0], reason: 'unique_numeric_official_color_for_solid' };
  }
  if (upper(preference) === 'ALPHA_FOR_PREPACK_IF_SEMANTIC_DUPLICATE') {
    const alpha = colorCodes.filter((code) => /^[A-Z]{3}$/.test(code));
    if (alpha.length === 1) return { color_code: alpha[0], reason: 'unique_alpha_official_color_for_prepack_semantic_duplicate' };
  }
  return { color_code: null, reason: 'semantic_color_maps_to_multiple_official_codes' };
}

function semanticColorGroups(styleRows = []) {
  const groups = [];
  for (const row of styleRows || []) {
    const key = normalizeMasterToken(row['Clr Desc']) || normalizeMasterToken(row['Clr Abbr']) || upper(row.Clr);
    if (!key) continue;
    const compatible = groups.find((group) => {
      const distance = levenshteinDistance(group.key, key);
      const samePrefix = group.key.slice(0, 2) === key.slice(0, 2);
      return group.key === key
        || (Math.min(group.key.length, key.length) >= 5 && distance <= 1)
        || (samePrefix && Math.min(group.key.length, key.length) >= 6 && distance <= 2);
    });
    if (compatible) compatible.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups;
}

function resolveColorFromDescription({ masters, styleCode, styleRows, descriptionRaw, preference }) {
  if (!styleCode || !clean(descriptionRaw) || !(styleRows || []).length) return { color_code: null, rows: [], reason: 'description_color_input_missing', score: 0 };
  const scored = semanticColorGroups(styleRows).map(({ key, rows }) => ({
    key,
    rows,
    score: Math.max(...rows.map((row) => colorDescriptionScore(row, descriptionRaw)))
  })).filter((entry) => entry.score >= 90).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  if (!scored.length) return { color_code: null, rows: [], reason: 'printed_description_no_confident_official_color_match', score: 0 };
  const bestScore = scored[0].score;
  const best = scored.filter((entry) => entry.score === bestScore);
  if (best.length !== 1) return { color_code: null, rows: best.flatMap((entry) => entry.rows), reason: 'printed_description_official_color_semantic_tie', score: bestScore };
  const chosen = chooseSemanticColorCode({ masters, styleCode, rows: best[0].rows, preference });
  return { color_code: chosen.color_code, rows: best[0].rows, reason: chosen.reason, score: bestScore, semantic_key: best[0].key };
}

function resolveExactPrintedColorBySize({ masters, styleCode, styleRows, colorRaw, sizeRaw }) {
  const exact = exactColorMatches(styleRows, colorRaw);
  if (exact.color_code || !exact.candidates.length || !clean(sizeRaw)) return exact;
  const sizeToken = normalizeMasterToken(sizeRaw);
  const candidateColors = unique(exact.candidates.map((row) => upper(row.Clr)));
  const matchingColors = candidateColors.filter((colorCode) => {
    const rows = masters.upcByStyleColorSize.get(`${upper(styleCode)}|${colorCode}|${sizeToken}`) || [];
    return rows.length > 0;
  });
  if (matchingColors.length === 1) {
    return {
      color_code: matchingColors[0],
      candidates: exact.candidates.filter((row) => upper(row.Clr) === matchingColors[0]),
      reason: 'printed_color_semantic_disambiguated_by_exact_official_size'
    };
  }
  return exact;
}

function resolveTrailingCustomerSuffixBase({ masters, styleRaw }) {
  const rawStyle = clean(styleRaw);
  const parts = rawStyle.split('-');
  if (parts.length < 2) return { style_code: null, suffix: null, candidates: [], reason: 'no_trailing_segment' };
  const suffix = parts.pop();
  const baseStyle = clean(parts.join('-')).toUpperCase();
  if (!baseStyle || !suffix) return { style_code: null, suffix: null, candidates: [], reason: 'invalid_trailing_segment' };
  if (masters.skuByStyle.has(rawStyle.toUpperCase())) return { style_code: null, suffix, candidates: [], reason: 'full_style_exists_in_master' };
  const rows = masters.skuByStyle.get(baseStyle) || [];
  if (!rows.length) return { style_code: null, suffix, candidates: [], reason: 'base_style_not_found' };
  return { style_code: baseStyle, suffix, candidates: rows, reason: 'exact_base_style_exists_after_non_a2000_suffix_removed' };
}

function exactColorMatches(styleRows, colorRaw) {
  const color = normalizeMasterToken(colorRaw);
  if (!color) return { color_code: null, candidates: [], reason: 'printed_color_absent' };
  const matches = (styleRows || []).filter((row) => {
    const tokens = [row.Clr, row['Clr Desc'], row['Clr Abbr']].map(normalizeMasterToken).filter(Boolean);
    return tokens.includes(color);
  });
  const colors = unique(matches.map((row) => upper(row.Clr)));
  return {
    color_code: colors.length === 1 ? colors[0] : null,
    candidates: matches.length ? matches : styleRows,
    reason: colors.length === 1 ? 'exact_printed_color_master_match' : colors.length > 1 ? 'exact_printed_color_ambiguous' : 'exact_printed_color_not_found'
  };
}

function uniqueOfficialColorForStyle(styleRows, customerCode) {
  const preferred = rowsForCustomerPreference(styleRows || [], customerCode);
  const byColor = new Map();
  for (const row of preferred) {
    const code = upper(row.Clr);
    if (!code) continue;
    if (!byColor.has(code)) byColor.set(code, []);
    byColor.get(code).push(row);
  }
  if (byColor.size !== 1) {
    return { color_code: null, row: null, candidates: preferred, reason: byColor.size ? 'multiple_official_colors_for_style' : 'no_official_color_for_style' };
  }
  const [colorCode, rows] = [...byColor.entries()][0];
  return { color_code: colorCode, row: rows[0] || null, candidates: preferred, reason: 'unique_official_color_for_resolved_style' };
}

function findSkuRow(masters, styleCode, colorCode, customerCode) {
  if (!styleCode || !colorCode) return null;
  const rows = (masters.skuByStyle.get(upper(styleCode)) || []).filter((row) => upper(row.Clr) === upper(colorCode));
  const preferred = rowsForCustomerPreference(rows, customerCode);
  const tuples = collapseRowsByTuple(preferred);
  return tuples.length === 1 ? tuples[0] : null;
}

function resolveExactNormalizedSku({ masters, line, customerCode }) {
  if (upper(line.raw?.style_resolution_hint) !== 'EXACT_MASTER_SKU_NORMALIZED') {
    return { row: null, candidates: [], reason: null, lookup_value: null };
  }
  const lookupValue = normalizeMasterToken(line.style_raw);
  if (!lookupValue) return { row: null, candidates: [], reason: 'normalized_sku_absent', lookup_value: null };
  const allCandidates = masters.skuByNormalizedSku?.get(lookupValue) || [];
  const candidates = rowsForCustomerPreference(allCandidates, customerCode);
  const tuples = collapseRowsByTuple(candidates);
  if (tuples.length === 1) {
    return { row: tuples[0], candidates: allCandidates, reason: allCandidates.length === 1 ? 'exact_normalized_sku_unique' : 'exact_normalized_sku_same_business_tuple', lookup_value: lookupValue };
  }
  return { row: null, candidates: allCandidates, reason: allCandidates.length ? 'exact_normalized_sku_ambiguous' : 'exact_normalized_sku_not_found', lookup_value: lookupValue };
}

function normalizeUpcValue(value) {
  const digits = clean(value).replace(/[^0-9]/g, '');
  return /^\d{11,14}$/.test(digits) ? digits : '';
}

function upcBusinessTuple(row) {
  return [
    upper(row.Style), upper(row.Clr), clean(row['Size Num']), upper(row['Size Name']),
    upper(row.Div), upper(row.Scale), normalizeMasterToken(row.Sku)
  ].join('|');
}

function resolveExactUpc({ masters, line }) {
  const inputValues = unique([line.customer_upc, line.upc, line.raw?.customer_upc_raw].map(normalizeUpcValue));
  let firstAmbiguous = null;
  for (const upc of inputValues) {
    const candidates = masters.upcByValue?.get(upc) || [];
    if (!candidates.length) continue;
    const tuples = collapseRowsByTuple(candidates, upcBusinessTuple);
    if (tuples.length === 1) {
      return { upc, row: tuples[0], candidates, reason: candidates.length === 1 ? 'exact_upc_unique' : 'exact_upc_duplicate_rows_same_business_tuple' };
    }
    const rawStyle = normalizeMasterToken(line.style_raw);
    if (rawStyle) {
      const styleMatches = candidates.filter((row) => normalizeMasterToken(row.Style) === rawStyle || normalizeMasterToken(row.Sku) === rawStyle);
      const styleTuples = collapseRowsByTuple(styleMatches, upcBusinessTuple);
      if (styleTuples.length === 1) return { upc, row: styleTuples[0], candidates, reason: 'exact_upc_style_disambiguated' };
    }
    firstAmbiguous ||= { upc, row: null, candidates, reason: 'exact_upc_ambiguous' };
  }
  return firstAmbiguous || { upc: null, row: null, candidates: [], reason: null };
}

function resolveCompositeStyleSuffix({ masters, styleRaw, customerCode }) {
  const printed = upper(styleRaw);
  const match = printed.match(/^(.+)-([A-Z0-9]{2,8})$/);
  if (!match) return { style_code: null, color_code: null, row: null, candidates: [], reason: null };
  const baseStyle = upper(match[1]);
  const suffix = upper(match[2]);
  const rows = styleRowsForStyle(masters, baseStyle).filter((row) => upper(row.Clr) === suffix);
  const preferred = rowsForCustomerPreference(rows, customerCode);
  const tuples = collapseRowsByTuple(preferred);
  if (tuples.length !== 1) {
    return { style_code: null, color_code: null, row: null, candidates: rows, reason: rows.length ? 'exact_style_suffix_color_ambiguous' : 'suffix_not_exact_color_for_style' };
  }
  return { style_code: baseStyle, color_code: suffix, row: tuples[0], candidates: rows, reason: 'exact_master_style_suffix_color' };
}


function resolveNearestCompositeStyleSuffix({ masters, styleRaw, customerCode }) {
  const printed = upper(styleRaw);
  const match = printed.match(/^(.+)-([A-Z0-9]{2,8})$/);
  if (!match) return { style_code: null, color_code: null, row: null, candidates: [], reason: 'composite_style_pattern_not_found' };
  const baseRaw = clean(match[1]);
  const suffix = upper(match[2]);
  const nearest = resolveNearestOfficialStyle({ masters, styleRaw: baseRaw });
  if (!nearest.style_code) {
    return { style_code: null, color_code: null, row: null, candidates: nearest.candidates, reason: nearest.reason, nearest, suffix, base_raw: baseRaw };
  }
  const rows = styleRowsForStyle(masters, nearest.style_code).filter((row) => upper(row.Clr) === suffix);
  const preferred = rowsForCustomerPreference(rows, customerCode);
  const tuples = collapseRowsByTuple(preferred);
  if (tuples.length !== 1) {
    return {
      style_code: null,
      color_code: null,
      row: null,
      candidates: rows,
      reason: rows.length ? 'nearest_base_style_suffix_color_ambiguous' : 'nearest_base_style_suffix_color_not_found',
      nearest,
      suffix,
      base_raw: baseRaw
    };
  }
  return {
    style_code: nearest.style_code,
    color_code: suffix,
    row: tuples[0],
    candidates: rows,
    reason: 'nearest_base_style_plus_exact_official_suffix_color',
    nearest,
    suffix,
    base_raw: baseRaw
  };
}

function resolveCarnivalWaterShoes({ masters, line }) {
  const description = upper(line.description || line.raw?.description_raw);
  const colorRaw = upper(line.color_raw || line.raw?.color_candidate_raw);
  if (!description.includes('WATER SHOES') || !colorRaw) return { row: null, candidates: [], reason: null };

  // Current Carnival hardcopies identify the product family in English text but
  // do not print the A2000 style. Resolve only through the official CARNIVAL
  // customer master rows, and only for the exact product family/color.
  const rows = masters.skuByStyle.get('133CARNIVA01') || [];
  const candidates = rows.filter((row) => upper(row.Customer) === 'CARNIVAL' && upper(row['Style Descr']).includes('CARNIVAL-01') && upper(row['Style Descr']).includes('MESH AQUA SHOES'));
  const colorMatches = exactColorMatches(candidates, colorRaw);
  if (!colorMatches.color_code) return { row: null, candidates, reason: colorMatches.reason || 'carnival_color_not_resolved' };
  const matchedRows = candidates.filter((row) => upper(row.Clr) === upper(colorMatches.color_code));
  const tuples = collapseRowsByTuple(matchedRows);
  if (tuples.length !== 1) return { row: null, candidates: matchedRows, reason: tuples.length ? 'carnival_style_color_ambiguous' : 'carnival_style_color_not_found' };
  return { row: tuples[0], candidates: matchedRows, reason: 'carnival_water_shoes_official_master_style_color' };
}

function applySkuMasterRow(line, raw, row, source, resolution = {}) {
  if (!row) return;
  line.style_code = clean(row.Style) || line.style_code || null;
  line.color_code = clean(row.Clr) || line.color_code || null;
  line.internal_sku = line.internal_sku || clean(row.Sku) || null;
  line.master_sku = line.master_sku || clean(row.Sku) || null;
  line.master_division_code = line.master_division_code || clean(row.Div) || null;
  line.warehouse_code = line.warehouse_code || clean(row.Wh) || null;
  line.scale_code = line.scale_code || clean(row.Scale) || null;
  line.scale_abbr = line.scale_abbr || clean(row['Scale Abbr']) || null;
  const price = finiteNumber(row.Price);
  if (line.list_price === null || line.list_price === undefined) {
    if (price !== null) line.list_price = price;
  }
  line.master_price = line.master_price ?? price;
  if (!line.description && clean(row['Sku Descr'])) line.description = clean(row['Sku Descr']);
  raw.sku_master = {
    source,
    style: clean(row.Style), color: clean(row.Clr),
    color_description: clean(row['Clr Desc']), color_abbr: clean(row['Clr Abbr']),
    sku: clean(row.Sku), div: clean(row.Div), customer: clean(row.Customer),
    price: clean(row.Price), pack_qty: clean(row['Pack Qty']), warehouse: clean(row.Wh),
    scale: clean(row.Scale), scale_abbr: clean(row['Scale Abbr']),
    ...resolution
  };
}

function hasAnyQtyBucket(line) {
  return Array.from({ length: 18 }, (_, index) => line[`qty_sz${index + 1}`]).some((value) => value !== null && value !== undefined && value !== '');
}

function applyExactUpcResolution(line, raw, resolution) {
  const row = resolution.row;
  if (!row) return;
  const printedStyle = clean(line.style_raw) || null;
  const resolvedStyle = clean(row.Style) || null;
  const resolvedColor = clean(row.Clr) || null;
  line.style_code = resolvedStyle;
  line.color_code = resolvedColor;
  line.master_upc = clean(row['Upc No']) || resolution.upc || null;
  line.internal_sku = line.internal_sku || clean(row.Sku) || null;
  line.master_sku = line.master_sku || clean(row.Sku) || null;
  line.master_division_code = line.master_division_code || clean(row.Div) || null;
  line.size_code = line.size_code || clean(row['Size Name']) || null;
  line.scale_code = line.scale_code || clean(row.Scale) || null;
  line.scale_abbr = line.scale_abbr || clean(row['Scale Abbr']) || null;
  const price = finiteNumber(row.Price);
  if ((line.list_price === null || line.list_price === undefined) && price !== null) line.list_price = price;

  const sizeNum = Number.parseInt(clean(row['Size Num']), 10);
  const qtyTotal = finiteNumber(line.qty_total);
  const quantitySemantics = upper(raw.quantity_semantics);
  if (!hasAnyQtyBucket(line) && ['EACH', 'ORDERED_UNITS'].includes(quantitySemantics) && Number.isInteger(qtyTotal) && qtyTotal > 0 && Number.isInteger(sizeNum) && sizeNum >= 1 && sizeNum <= 18) {
    line[`qty_sz${sizeNum}`] = qtyTotal;
    raw.qty_bucket_resolution = { source: 'VR_UPC_STYLE_EXACT_UPC_SIZE_NUM', size_num: sizeNum, size_name: clean(row['Size Name']) || null, scale: clean(row.Scale) || null, quantity: qtyTotal, quantity_semantics: quantitySemantics };
  } else if (!hasAnyQtyBucket(line) && Number.isInteger(sizeNum) && sizeNum >= 1 && sizeNum <= 18 && qtyTotal !== null) {
    raw.qty_bucket_resolution = { source: 'VR_UPC_STYLE_EXACT_UPC_SIZE_NUM', status: 'not_applied', reason: 'quantity_semantics_or_quantity_not_safe', size_num: sizeNum, size_name: clean(row['Size Name']) || null, scale: clean(row.Scale) || null, quantity: qtyTotal, quantity_semantics: quantitySemantics || null };
  }

  raw.upc_resolution = {
    source: 'VR_UPC_STYLE_EXACT_UPC', reason: resolution.reason, lookup_value: resolution.upc,
    candidate_count: resolution.candidates.length, style: resolvedStyle, color: resolvedColor,
    size_num: clean(row['Size Num']) || null, size_name: clean(row['Size Name']) || null,
    scale: clean(row.Scale) || null, div: clean(row.Div) || null, sku: clean(row.Sku) || null
  };
  if (printedStyle && resolvedStyle && normalizeMasterToken(printedStyle) !== normalizeMasterToken(resolvedStyle) && normalizeMasterToken(printedStyle) !== normalizeMasterToken(row.Sku)) {
    raw.style_master_override = { source: 'VR_UPC_STYLE_EXACT_UPC', pdf_style_raw: printedStyle, master_style: resolvedStyle, note: 'Printed model/style differs from exact UPC master style; exact UPC mapping has priority in enrichment.' };
  }
}

function applyExactPrintedSizeGrid(line, raw, masters) {
  if (hasAnyQtyBucket(line)) return;
  if (!['EACH', 'ORDERED_UNITS'].includes(upper(raw.quantity_semantics))) return;
  if (!line.style_code || !line.color_code) return;
  const entries = raw.size_grid?.size_grid_entries_raw;
  if (!Array.isArray(entries) || !entries.length) return;

  let candidates = masters.upcByStyleColor.get(`${upper(line.style_code)}|${upper(line.color_code)}`) || [];
  if (line.scale_code) {
    const sameScale = candidates.filter((row) => upper(row.Scale) === upper(line.scale_code));
    if (sameScale.length) candidates = sameScale;
  }

  const resolved = [];
  const failures = [];
  for (const entry of entries) {
    const sizeToken = normalizeMasterToken(entry?.size_raw);
    const qty = finiteNumber(entry?.qty_raw);
    if (!sizeToken || !Number.isInteger(qty) || qty < 0) {
      failures.push({ size_raw: clean(entry?.size_raw) || null, qty_raw: entry?.qty_raw ?? null, reason: 'invalid_grid_entry' });
      continue;
    }
    const matches = candidates.filter((row) => normalizeMasterToken(row['Size Name']) === sizeToken);
    const slots = new Map();
    for (const row of matches) {
      const sizeNum = Number.parseInt(clean(row['Size Num']), 10);
      if (!Number.isInteger(sizeNum) || sizeNum < 1 || sizeNum > 18) continue;
      const key = `${sizeNum}|${upper(row.Scale)}`;
      if (!slots.has(key)) slots.set(key, row);
    }
    if (slots.size !== 1) {
      failures.push({ size_raw: clean(entry.size_raw), qty_raw: qty, reason: slots.size ? 'size_name_maps_to_multiple_master_slots' : 'printed_size_name_not_found_for_style_color', candidate_slots: [...slots.keys()] });
      continue;
    }
    const [key, row] = [...slots.entries()][0];
    resolved.push({ size_raw: clean(entry.size_raw), qty, size_num: Number(key.split('|')[0]), scale: clean(row.Scale) || null, size_name: clean(row['Size Name']) || null });
  }

  const slotNumbers = resolved.map((entry) => entry.size_num);
  const duplicateSlot = new Set(slotNumbers).size !== slotNumbers.length;
  const qtySum = resolved.reduce((sum, entry) => sum + entry.qty, 0);
  const qtyTotal = finiteNumber(line.qty_total);
  if (failures.length || resolved.length !== entries.length || duplicateSlot || (Number.isInteger(qtyTotal) && qtyTotal >= 0 && qtySum !== qtyTotal)) {
    raw.qty_bucket_resolution = {
      source: 'VR_UPC_STYLE_EXACT_PRINTED_SIZE_NAME_GRID', status: 'not_applied',
      reason: failures.length ? 'grid_entries_not_uniquely_resolved' : duplicateSlot ? 'duplicate_master_size_slot' : 'grid_quantity_total_mismatch',
      printed_entries: entries, resolved_entries: resolved, failures, qty_sum: qtySum, qty_total: qtyTotal
    };
    return;
  }

  for (const entry of resolved) line[`qty_sz${entry.size_num}`] = entry.qty;
  raw.qty_bucket_resolution = {
    source: 'VR_UPC_STYLE_EXACT_PRINTED_SIZE_NAME_GRID', status: 'applied',
    mapping_basis: 'PDF visual column positions + exact VR_UPC_STYLE Size Name to Size Num mapping',
    resolved_entries: resolved, qty_sum: qtySum, qty_total: qtyTotal
  };
}


function applyExactPrintedSingleSize(line, raw, masters) {
  if (hasAnyQtyBucket(line)) return;
  if (!['EACH', 'ORDERED_UNITS'].includes(upper(raw.quantity_semantics))) return;
  const qtyTotal = finiteNumber(line.qty_total);
  const sizeToken = normalizeMasterToken(line.size_raw);
  if (!Number.isInteger(qtyTotal) || qtyTotal <= 0 || !sizeToken || !line.style_code || !line.color_code) return;
  const candidates = masters.upcByStyleColorSize.get(`${upper(line.style_code)}|${upper(line.color_code)}|${sizeToken}`) || [];
  const slotMap = new Map();
  for (const row of candidates) {
    const sizeNum = Number.parseInt(clean(row['Size Num']), 10);
    if (!Number.isInteger(sizeNum) || sizeNum < 1 || sizeNum > 18) continue;
    const key = `${sizeNum}|${upper(row.Scale)}`;
    if (!slotMap.has(key)) slotMap.set(key, row);
  }
  if (slotMap.size !== 1) {
    if (candidates.length) {
      raw.qty_bucket_resolution = {
        source: 'VR_UPC_STYLE_EXACT_PRINTED_SINGLE_SIZE',
        status: 'not_applied',
        reason: slotMap.size ? 'printed_size_maps_to_multiple_master_slots' : 'printed_size_has_no_positive_master_slot',
        printed_size_raw: clean(line.size_raw),
        candidate_slots: [...slotMap.keys()]
      };
    }
    return;
  }
  const [key, row] = [...slotMap.entries()][0];
  const sizeNum = Number(key.split('|')[0]);
  line[`qty_sz${sizeNum}`] = qtyTotal;
  line.size_code = line.size_code || clean(row['Size Name']) || null;
  line.scale_code = line.scale_code || clean(row.Scale) || null;
  line.scale_abbr = line.scale_abbr || clean(row['Scale Abbr']) || null;
  raw.qty_bucket_resolution = {
    source: 'VR_UPC_STYLE_EXACT_PRINTED_SINGLE_SIZE',
    status: 'applied',
    mapping_basis: 'printed size token + exact official STYLE/COLOR/SIZE row',
    printed_size_raw: clean(line.size_raw),
    size_num: sizeNum,
    size_name: clean(row['Size Name']) || null,
    scale: clean(row.Scale) || null,
    quantity: qtyTotal,
    quantity_semantics: upper(raw.quantity_semantics)
  };
}

function applyUniqueOfficialSizeSlot(line, raw, masters) {
  if (hasAnyQtyBucket(line)) return;
  if (!['EACH', 'ORDERED_UNITS'].includes(upper(raw.quantity_semantics))) return;
  const qtyTotal = finiteNumber(line.qty_total);
  if (!Number.isInteger(qtyTotal) || qtyTotal <= 0 || !line.style_code || !line.color_code) return;
  let candidates = masters.upcByStyleColor.get(`${upper(line.style_code)}|${upper(line.color_code)}`) || [];
  if (line.scale_code) {
    const sameScale = candidates.filter((row) => upper(row.Scale) === upper(line.scale_code));
    if (sameScale.length) candidates = sameScale;
  }
  const slotMap = new Map();
  for (const row of candidates) {
    const sizeNum = Number.parseInt(clean(row['Size Num']), 10);
    if (!Number.isInteger(sizeNum) || sizeNum < 1 || sizeNum > 18) continue;
    const key = `${sizeNum}|${upper(row.Scale)}`;
    if (!slotMap.has(key)) slotMap.set(key, row);
  }
  if (slotMap.size === 1) {
    const [key, row] = [...slotMap.entries()][0];
    const sizeNum = Number(key.split('|')[0]);
    line[`qty_sz${sizeNum}`] = qtyTotal;
    line.size_code = line.size_code || clean(row['Size Name']) || null;
    line.scale_code = line.scale_code || clean(row.Scale) || null;
    line.scale_abbr = line.scale_abbr || clean(row['Scale Abbr']) || null;
    raw.qty_bucket_resolution = { source: 'VR_UPC_STYLE_UNIQUE_SIZE_SLOT', size_num: sizeNum, size_name: clean(row['Size Name']) || null, scale: clean(row.Scale) || null, quantity: qtyTotal, quantity_semantics: 'EACH', candidate_rows: candidates.length };
    return;
  }

  // Some exact VR_SKU style/color rows have an official SCALE but no matching
  // style/color row in VR_UPC_STYLE. In that case we may use the official scale
  // definition only when it has exactly one positive A2000 size slot. Size Num 0
  // (ALL) is excluded from bucket mapping.
  const scaleCode = upper(line.scale_code || raw.sku_master?.scale);
  const scaleSlots = scaleCode ? masters.sizeSlotsByScale?.get(scaleCode) : null;
  if (!candidates.length && raw.sku_master && scaleSlots && scaleSlots.size === 1) {
    const [sizeNum, sizeNames] = [...scaleSlots.entries()][0];
    if (Number.isInteger(sizeNum) && sizeNum >= 1 && sizeNum <= 18) {
      line[`qty_sz${sizeNum}`] = qtyTotal;
      const names = [...sizeNames].filter(Boolean);
      if (names.length === 1 && !line.size_code) line.size_code = names[0];
      raw.qty_bucket_resolution = {
        source: 'VR_UPC_STYLE_UNIQUE_POSITIVE_SIZE_SLOT_FOR_SCALE',
        mapping_basis: 'exact VR_SKU scale + unique positive Size Num in official VR_UPC_STYLE scale definition',
        size_num: sizeNum,
        size_names: names,
        scale: scaleCode,
        quantity: qtyTotal,
        quantity_semantics: 'EACH'
      };
      return;
    }
  }

  if (candidates.length) raw.qty_bucket_candidates = [...slotMap.keys()];
}

function resolveMasterUpcsByPrintedSizeGrid(line, raw, masters) {
  if (!line.style_code || !line.color_code) return;
  const entries = raw.size_grid?.size_grid_entries_raw;
  if (!Array.isArray(entries) || !entries.length) return;

  let styleColorRows = masters.upcByStyleColor.get(`${upper(line.style_code)}|${upper(line.color_code)}`) || [];
  if (line.scale_code) {
    const sameScale = styleColorRows.filter((row) => upper(row.Scale) === upper(line.scale_code));
    if (sameScale.length) styleColorRows = sameScale;
  }

  const resolved = [];
  const failures = [];
  for (const entry of entries) {
    const sizeRaw = clean(entry?.size_raw);
    const sizeToken = normalizeMasterToken(sizeRaw);
    const qtyRaw = finiteNumber(entry?.qty_raw);
    if (!sizeToken) {
      failures.push({ size_raw: sizeRaw || null, qty_raw: entry?.qty_raw ?? null, reason: 'missing_size_token' });
      continue;
    }

    const direct = masters.upcByStyleColorSize.get(`${upper(line.style_code)}|${upper(line.color_code)}|${sizeToken}`) || [];
    const candidates = direct.length
      ? direct
      : styleColorRows.filter((row) => normalizeMasterToken(row['Size Name']) === sizeToken || normalizeMasterToken(row['Size Num']) === sizeToken);

    const uniqueRows = new Map();
    for (const row of candidates) {
      const upc = normalizeUpcValue(row['Upc No']);
      if (!upc) continue;
      const key = [upc, clean(row['Size Num']), upper(row['Size Name']), upper(row.Scale), upper(row.Style), upper(row.Clr)].join('|');
      if (!uniqueRows.has(key)) uniqueRows.set(key, row);
    }

    const uniqueUpcs = new Map();
    for (const row of uniqueRows.values()) {
      const upc = normalizeUpcValue(row['Upc No']);
      if (upc && !uniqueUpcs.has(upc)) uniqueUpcs.set(upc, row);
    }

    if (uniqueUpcs.size !== 1) {
      failures.push({
        size_raw: sizeRaw || null,
        qty_raw: qtyRaw,
        reason: uniqueUpcs.size ? 'printed_size_maps_to_multiple_master_upcs' : 'printed_size_has_no_master_upc',
        candidate_count: uniqueUpcs.size,
        candidate_upcs: [...uniqueUpcs.keys()]
      });
      continue;
    }

    const [upc, row] = [...uniqueUpcs.entries()][0];
    resolved.push({
      size_raw: sizeRaw || null,
      size_name: clean(row['Size Name']) || null,
      size_num: clean(row['Size Num']) || null,
      qty_raw: qtyRaw,
      upc,
      scale: clean(row.Scale) || null,
      sku: clean(row.Sku) || null
    });
  }

  line.master_upcs_by_size = resolved;
  raw.upc_master_by_size = {
    source: 'VR_UPC_STYLE_EXACT_PRINTED_SIZE_GRID',
    reason: failures.length ? 'partial_or_unresolved_size_upc_mapping' : 'all_printed_sizes_unique_master_upc',
    printed_entry_count: entries.length,
    resolved_entry_count: resolved.length,
    resolved_entries: resolved,
    failures
  };
}

function findMasterUpc(masters, styleCode, colorCode, sizeRaw) {
  if (!styleCode || !colorCode) return { upc: null, row: null, candidates: [], reason: null };
  const style = upper(styleCode);
  const color = upper(colorCode);
  const size = normalizeMasterToken(sizeRaw === '-' ? 'PC' : sizeRaw);
  const exact = size ? masters.upcByStyleColorSize.get(`${style}|${color}|${size}`) || [] : [];
  const candidates = exact.length ? exact : (masters.upcByStyleColor.get(`${style}|${color}`) || []);
  if (!candidates.length) return { upc: null, row: null, candidates: [], reason: 'no_master_upc' };
  const byUpc = new Map();
  for (const row of candidates) {
    const upc = normalizeUpcValue(row['Upc No']);
    if (upc && !byUpc.has(upc)) byUpc.set(upc, row);
  }
  if (byUpc.size === 1) {
    const [upc, row] = [...byUpc.entries()][0];
    return { upc, row, candidates, reason: exact.length ? 'unique_exact_size_master_upc' : 'unique_style_color_master_upc' };
  }
  return { upc: null, row: null, candidates, reason: 'master_upc_ambiguous' };
}

function enrichLine(line, parsed, masters, customerCode, warnings) {
  const parser = clean(parsed.parser).toLowerCase();
  const raw = { ...(line.raw || {}) };
  const explicitCustomerUpc = line.customer_upc || line.upc || raw.customer_upc_raw || null;
  if (explicitCustomerUpc) {
    line.customer_upc = explicitCustomerUpc;
    raw.customer_upc_source = raw.customer_upc_source || 'explicit_pdf_upc';
  }

  const exactUpcAllowed = parser === 'ollies' || upper(raw.upc_semantics) === 'UPC';
  const exactUpc = exactUpcAllowed ? resolveExactUpc({ masters, line: { ...line, raw } }) : { upc: null, row: null, candidates: [], reason: null };
  if (exactUpc.row) {
    applyExactUpcResolution(line, raw, exactUpc);
  } else if (exactUpc.candidates.length) {
    raw.upc_master_candidates = exactUpc.candidates.slice(0, 10).map((row) => ({ upc: clean(row['Upc No']), style: clean(row.Style), color: clean(row.Clr), size_num: clean(row['Size Num']), size_name: clean(row['Size Name']), scale: clean(row.Scale), sku: clean(row.Sku), div: clean(row.Div) }));
    raw.upc_resolution = { source: 'VR_UPC_STYLE_EXACT_UPC', reason: exactUpc.reason, lookup_value: exactUpc.upc, candidate_count: exactUpc.candidates.length };
  }

  if (!exactUpc.row) {
    const exactSku = resolveExactNormalizedSku({ masters, line: { ...line, raw }, customerCode });
    if (exactSku.row) {
      applySkuMasterRow(line, raw, exactSku.row, 'VR_SKU_EXACT_NORMALIZED_SKU', { reason: exactSku.reason, lookup_value: exactSku.lookup_value, candidate_count: exactSku.candidates.length });
    } else if (exactSku.reason) {
      raw.exact_sku_resolution = { source: 'VR_SKU_EXACT_NORMALIZED_SKU', reason: exactSku.reason, lookup_value: exactSku.lookup_value, candidate_count: exactSku.candidates.length, candidates: candidateSummary(exactSku.candidates) };
    }
  }

  if (!line.style_code && upper(raw.composite_style_color_semantics) === 'STYLE_COLOR_SUFFIX' && line.style_raw) {
    const composite = resolveCompositeStyleSuffix({ masters, customerCode, styleRaw: line.style_raw });
    if (composite.row) {
      line.style_code = composite.style_code;
      line.color_code = composite.color_code;
      raw.composite_style_resolution = { source: 'VR_SKU_EXACT_STYLE_COLOR_PAIR', reason: composite.reason, semantics: 'STYLE_COLOR_SUFFIX', printed_style_raw: clean(line.style_raw), base_style: composite.style_code, suffix_color: composite.color_code, candidate_count: composite.candidates.length };
    } else {
      raw.composite_style_resolution = { source: 'VR_SKU_EXACT_STYLE_COLOR_PAIR', reason: composite.reason, semantics: 'STYLE_COLOR_SUFFIX', printed_style_raw: clean(line.style_raw), base_style_candidate: clean(line.raw?.style_base_candidate_raw) || null, suffix_candidate: clean(line.raw?.style_suffix_candidate_raw) || null, candidate_count: composite.candidates.length };
    }
  }

  if (!line.style_code && upper(raw.trailing_style_suffix_semantics) === 'NON_A2000_CUSTOMER_SUFFIX_CANDIDATE' && line.style_raw) {
    const suffixResolution = resolveTrailingCustomerSuffixBase({ masters, styleRaw: line.style_raw });
    if (suffixResolution.style_code) line.style_code = suffixResolution.style_code;
    raw.trailing_style_suffix_resolution = {
      source: 'VR_SKU_EXACT_BASE_STYLE_AFTER_PRINTED_SUFFIX',
      reason: suffixResolution.reason,
      printed_style_raw: clean(line.style_raw),
      base_style: suffixResolution.style_code,
      removed_suffix_raw: suffixResolution.suffix,
      note: 'The removed printed suffix is NOT treated as A2000 COLOR_NO. Color must resolve independently from official masters.',
      candidate_count: suffixResolution.candidates.length
    };
    if (suffixResolution.candidates.length) raw.style_master_candidates = candidateSummary(suffixResolution.candidates);
  }

  if (!line.style_code && upper(raw.composite_style_color_semantics) === 'STYLE_COLOR_SUFFIX' && upper(raw.style_similarity_semantics) === 'NEAREST_OFFICIAL_STYLE_CODE' && line.style_raw) {
    const nearestComposite = resolveNearestCompositeStyleSuffix({ masters, customerCode, styleRaw: line.style_raw });
    if (nearestComposite.row) {
      applySkuMasterRow(line, raw, nearestComposite.row, 'VR_SKU_NEAREST_BASE_STYLE_EXACT_SUFFIX_COLOR', {
        reason: nearestComposite.reason,
        printed_style_raw: clean(line.style_raw),
        printed_base_style_raw: nearestComposite.base_raw,
        suffix_color_raw: nearestComposite.suffix,
        edit_distance: nearestComposite.nearest?.distance ?? null,
        scored_candidates: nearestComposite.nearest?.scored || [],
        candidate_count: nearestComposite.candidates.length
      });
    } else {
      raw.nearest_composite_style_resolution = {
        source: 'VR_SKU_NEAREST_BASE_STYLE_EXACT_SUFFIX_COLOR',
        reason: nearestComposite.reason,
        printed_style_raw: clean(line.style_raw),
        printed_base_style_raw: nearestComposite.base_raw || null,
        suffix_color_raw: nearestComposite.suffix || null,
        scored_candidates: nearestComposite.nearest?.scored || [],
        candidate_count: nearestComposite.candidates.length
      };
    }
  }

  if (!line.style_code && upper(raw.style_resolution_hint) === 'EXACT_MASTER_STYLE_NORMALIZED') {
    const inferred = inferStyleFromMaster({ masters, customerCode, styleRaw: line.style_raw });
    if (inferred.style_code) line.style_code = inferred.style_code;
    raw.style_resolution = { source: 'VR_SKU_EXACT_NORMALIZED_STYLE_FIELDS', reason: inferred.reason, printed_style_raw: clean(line.style_raw) || null, candidate_count: inferred.candidates.length };
    raw.style_master_candidates = candidateSummary(inferred.candidates);
  }

  if (!line.style_code && upper(raw.style_similarity_semantics) === 'NEAREST_OFFICIAL_STYLE_CODE' && line.style_raw) {
    const nearest = resolveNearestOfficialStyle({ masters, styleRaw: line.style_raw });
    if (nearest.style_code) line.style_code = nearest.style_code;
    raw.style_similarity_resolution = {
      source: 'VR_SKU_NEAREST_OFFICIAL_STYLE_CODE',
      reason: nearest.reason,
      semantics: 'NEAREST_OFFICIAL_STYLE_CODE',
      printed_style_raw: clean(line.style_raw),
      resolved_style: nearest.style_code,
      edit_distance: nearest.distance ?? null,
      scored_candidates: nearest.scored || [],
      candidate_count: nearest.candidates.length
    };
    if (nearest.candidates.length) raw.style_master_candidates = candidateSummary(nearest.candidates);
  }

  if (!line.style_code && parser === 'carnival' && customerCode === 'CARNIVAL') {
    const carnival = resolveCarnivalWaterShoes({ masters, line: { ...line, raw } });
    if (carnival.row) {
      applySkuMasterRow(line, raw, carnival.row, 'VR_SKU_CARNIVAL_WATER_SHOES_OFFICIAL_MASTER', { reason: carnival.reason, printed_description_raw: clean(line.description || raw.description_raw), printed_color_raw: clean(line.color_raw || raw.color_candidate_raw), candidate_count: carnival.candidates.length });
    } else if (carnival.reason) {
      raw.carnival_water_shoes_resolution = { source: 'VR_SKU_CARNIVAL_WATER_SHOES_OFFICIAL_MASTER', reason: carnival.reason, printed_description_raw: clean(line.description || raw.description_raw), printed_color_raw: clean(line.color_raw || raw.color_candidate_raw), candidate_count: carnival.candidates.length, candidates: candidateSummary(carnival.candidates) };
    }
  }

  let styleRows = line.style_code ? styleRowsForStyle(masters, line.style_code) : [];

  if (!line.color_code && styleRows.length && upper(raw.trailing_style_suffix_color_semantics) === 'PREFIX_OF_OFFICIAL_COLOR_CODE') {
    const suffixRaw = raw.trailing_style_suffix_resolution?.removed_suffix_raw || line.raw?.style_suffix_candidate_raw || clean(line.style_raw).split('-').at(-1);
    const suffixColor = resolveTrailingSuffixColorPrefix({ styleRows, suffixRaw });
    if (suffixColor.color_code) line.color_code = suffixColor.color_code;
    raw.trailing_style_suffix_color_resolution = {
      source: 'VR_SKU_OFFICIAL_COLOR_CODE_PREFIX_MATCH',
      reason: suffixColor.reason,
      semantics: 'PREFIX_OF_OFFICIAL_COLOR_CODE',
      printed_suffix_raw: clean(suffixRaw) || null,
      resolved_style: clean(line.style_code) || null,
      resolved_color: suffixColor.color_code,
      score: suffixColor.score ?? null,
      candidates: suffixColor.candidates
    };
  }

  if (!line.color_code && styleRows.length && line.color_raw) {
    const inferredColor = resolveExactPrintedColorBySize({ masters, styleCode: line.style_code, styleRows, colorRaw: line.color_raw, sizeRaw: line.size_raw });
    if (inferredColor.color_code) line.color_code = inferredColor.color_code;
    raw.color_resolution = { source: inferredColor.reason === 'printed_color_semantic_disambiguated_by_exact_official_size' ? 'VR_SKU_PRINTED_COLOR_PLUS_VR_UPC_STYLE_SIZE' : 'VR_SKU_EXACT_PRINTED_COLOR', reason: inferredColor.reason, printed_color_raw: clean(line.color_raw), printed_size_raw: clean(line.size_raw) || null, candidate_count: inferredColor.candidates.length };
    raw.color_master_candidates = candidateSummary(inferredColor.candidates);
  }

  if (!line.color_code && styleRows.length && raw.color_description_candidate_raw) {
    const descriptiveColor = exactColorMatches(styleRows, raw.color_description_candidate_raw);
    if (descriptiveColor.color_code) {
      line.color_code = descriptiveColor.color_code;
      raw.color_resolution = {
        source: 'VR_SKU_EXACT_PRINTED_COLOR_DESCRIPTION', reason: descriptiveColor.reason,
        printed_color_description_raw: clean(raw.color_description_candidate_raw),
        printed_color_token_raw: clean(line.color_raw) || null,
        candidate_count: descriptiveColor.candidates.length
      };
      if (line.color_raw) {
        warnings.push({
          field: 'color_code', line_no: line.line_no, code: 'printed_color_token_not_on_resolved_style', severity: 'low', blocking: false,
          message: 'The printed COLOR token did not exactly match the resolved style master, but a separate printed descriptive color phrase matched one official master color exactly.',
          printed_color_token_raw: clean(line.color_raw), printed_color_description_raw: clean(raw.color_description_candidate_raw), resolved_color_code: descriptiveColor.color_code
        });
      }
    } else {
      raw.color_description_resolution = { source: 'VR_SKU_EXACT_PRINTED_COLOR_DESCRIPTION', reason: descriptiveColor.reason, printed_color_description_raw: clean(raw.color_description_candidate_raw), candidate_count: descriptiveColor.candidates.length };
    }
  }

  if (!line.color_code && styleRows.length && ['ABBREVIATED_OFFICIAL_COLOR_DESCRIPTION', 'DESCRIPTION_COLOR_WORDS'].includes(upper(raw.description_color_semantics))) {
    const descriptionColor = resolveColorFromDescription({
      masters,
      styleCode: line.style_code,
      styleRows,
      descriptionRaw: line.description || raw.po_description_raw || raw.description_raw,
      preference: raw.color_code_format_preference
    });
    if (descriptionColor.color_code) {
      line.color_code = descriptionColor.color_code;
      raw.description_color_resolution = {
        source: 'VR_SKU_PRINTED_DESCRIPTION_TO_OFFICIAL_COLOR',
        reason: descriptionColor.reason,
        semantics: upper(raw.description_color_semantics),
        printed_description_raw: clean(line.description || raw.po_description_raw || raw.description_raw),
        resolved_style: clean(line.style_code),
        resolved_color: descriptionColor.color_code,
        semantic_key: descriptionColor.semantic_key || null,
        confidence_score: descriptionColor.score,
        code_format_preference: clean(raw.color_code_format_preference) || null,
        candidate_count: descriptionColor.rows.length,
        candidates: candidateSummary(descriptionColor.rows)
      };
    } else {
      raw.description_color_resolution = {
        source: 'VR_SKU_PRINTED_DESCRIPTION_TO_OFFICIAL_COLOR',
        reason: descriptionColor.reason,
        semantics: upper(raw.description_color_semantics),
        printed_description_raw: clean(line.description || raw.po_description_raw || raw.description_raw),
        confidence_score: descriptionColor.score,
        code_format_preference: clean(raw.color_code_format_preference) || null,
        candidate_count: descriptionColor.rows.length,
        candidates: candidateSummary(descriptionColor.rows)
      };
    }
  }

  if (!line.color_code && styleRows.length) {
    const uniqueColor = uniqueOfficialColorForStyle(styleRows, customerCode);
    if (uniqueColor.color_code) {
      line.color_code = uniqueColor.color_code;
      raw.color_resolution = {
        source: 'VR_SKU_UNIQUE_COLOR_FOR_STYLE', reason: uniqueColor.reason,
        resolved_style: clean(line.style_code), resolved_color: uniqueColor.color_code,
        printed_color_raw: clean(line.color_raw) || null, candidate_count: uniqueColor.candidates.length
      };
      if (line.color_raw) {
        warnings.push({
          field: 'color_code', line_no: line.line_no, code: 'printed_color_not_master_color_but_style_has_one_official_color', severity: 'low', blocking: false,
          message: 'Printed color text did not exactly match the official style color, but the resolved style has exactly one official master color. The master color is used and the printed text is preserved.',
          printed_color_raw: clean(line.color_raw), resolved_color_code: uniqueColor.color_code
        });
      }
    } else {
      raw.unique_style_color_resolution = { source: 'VR_SKU_UNIQUE_COLOR_FOR_STYLE', reason: uniqueColor.reason, resolved_style: clean(line.style_code), candidate_colors: unique((uniqueColor.candidates || []).map((row) => upper(row.Clr))) };
    }
  }

  const skuRow = findSkuRow(masters, line.style_code, line.color_code, customerCode);
  if (skuRow) applySkuMasterRow(line, raw, skuRow, 'VR_SKU_EXACT_STYLE_COLOR_DETERMINISTIC');

  styleRows = line.style_code ? styleRowsForStyle(masters, line.style_code) : [];
  if (!line.master_division_code && styleRows.length) {
    const divisions = unique(styleRows.map((row) => clean(row.Div)));
    if (divisions.length === 1) line.master_division_code = divisions[0];
  }

  applyExactPrintedSizeGrid(line, raw, masters);
  applyExactPrintedSingleSize(line, raw, masters);
  applyUniqueOfficialSizeSlot(line, raw, masters);

  if (parser === 'cititrends' && !hasPositiveSizeDistribution(line)) {
    raw.a2000_size_mapping = mapExtractedSizeToBucket(
      { ...line, raw },
      masters
    );

    if (raw.a2000_size_mapping?.applied) {
      const bucket = Number(raw.a2000_size_mapping.bucket);
      if (Number.isInteger(bucket) && bucket >= 1 && bucket <= 18) {
        line[`qty_sz${bucket}`] = raw.a2000_size_mapping.quantity;
        line.size_bucket = bucket;
        line.scale_code = raw.a2000_size_mapping.scale || line.scale_code || null;
        line.scale_abbr = raw.a2000_size_mapping.scale_abbr || line.scale_abbr || null;
      }
    }
  }

  resolveMasterUpcsByPrintedSizeGrid(line, raw, masters);

  const upc = findMasterUpc(masters, line.style_code, line.color_code, line.size_raw || line.size_code);
  if (upc.upc) {
    line.master_upc = upc.upc;
    raw.upc_master = { source: 'VR_UPC_STYLE_UNIQUE_MASTER_UPC', reason: upc.reason, upc: upc.upc, style: clean(upc.row?.Style), color: clean(upc.row?.Clr), size_name: clean(upc.row?.['Size Name']), div: clean(upc.row?.Div), sku: clean(upc.row?.Sku) };
  } else if (line.style_code && line.color_code && upc.candidates.length) {
    raw.upc_master_candidates = upc.candidates.slice(0, 10).map((row) => ({ upc: clean(row['Upc No']), style: clean(row.Style), color: clean(row.Clr), size_name: clean(row['Size Name']), size_num: clean(row['Size Num']), scale: clean(row.Scale), sku: clean(row.Sku) }));
    raw.upc_master_resolution = { source: 'VR_UPC_STYLE', reason: upc.reason, candidate_count: upc.candidates.length };
  }

  if (parser === 'cititrends' && line.customer_upc && line.master_upc && normalizeUpcValue(line.customer_upc) !== normalizeUpcValue(line.master_upc)) {
    raw.upc_note = 'Citi printed UPC is kept as customer_upc. Master UPC is stored separately and does not overwrite the printed UPC.';
  } else if (parser === 'cititrends' && line.customer_upc && !line.master_upc) {
    raw.upc_note = 'Citi printed UPC is preserved as customer_upc. The exact resolved A2000 style/color has no unique official VR_UPC_STYLE UPC row, so no master UPC is invented.';
    raw.upc_master_status = {
      source: 'VR_UPC_STYLE',
      status: 'customer_upc_only_no_unique_official_master_upc',
      customer_upc: clean(line.customer_upc),
      style: clean(line.style_code) || null,
      color: clean(line.color_code) || null
    };
  }

  line.raw = raw;
  return line;
}

function addConflictOnce(conflicts, conflict) {
  const key = [conflict.field, conflict.code, conflict.line_no, conflict.message].join('|');
  const exists = conflicts.some((item) => [item.field, item.code, item.line_no, item.message].join('|') === key);
  if (!exists) conflicts.push(conflict);
}

function applyHeaderFromLines(parsed, conflicts) {
  const header = parsed.header || {};
  const lineDivisions = unique((parsed.lines || []).map((line) => clean(line.master_division_code || line.division_code)));
  if (!header.division_code && lineDivisions.length === 1) header.division_code = lineDivisions[0];
  if (header.division_code && lineDivisions.some((division) => upper(division) !== upper(header.division_code))) {
    addConflictOnce(conflicts, {
      field: 'division_code', code: 'style_division_mismatch', severity: 'high', blocking: true,
      message: 'Official style master division conflicts with the resolved header division.',
      header_division: clean(header.division_code), line_divisions: lineDivisions
    });
  }
  if (!header.division_code && lineDivisions.length > 1) {
    addConflictOnce(conflicts, {
      field: 'division_code', code: 'multiple_line_divisions', severity: 'high', blocking: true,
      message: 'Lines resolve to multiple official divisions and no single header division can be selected safely.',
      line_divisions: lineDivisions
    });
  }

  const lineWarehouses = unique((parsed.lines || []).map((line) => clean(line.warehouse_code)));
  if (!header.warehouse_code && lineWarehouses.length === 1) header.warehouse_code = lineWarehouses[0];
}

export function enrichOrderWithMasters(parsed) {
  if (process.env.A2000_MASTER_ENRICH === 'false') return parsed;
  const masters = loadMasterData();
  parsed.raw_enrichment = parsed.raw_enrichment || {};
  parsed.raw_enrichment.master_lookup = {
    attempted: true, master_dir: masters.masterDir, loaded: masters.loaded, counts: masters.counts, error: masters.error || null
  };
  if (!masters.loaded || masters.error) return parsed;

  const conflicts = Array.isArray(parsed.conflicts) ? [...parsed.conflicts] : [];
  const warnings = Array.isArray(parsed.warnings) ? [...parsed.warnings] : [];
  const trace = {};
  const customerCode = applyCustomerMaster(parsed, masters, conflicts, warnings, trace);
  applyDefaultStore(parsed, masters, customerCode, trace, warnings);
  parsed.lines = (parsed.lines || []).map((line) => enrichLine(line, parsed, masters, customerCode, warnings));

  if (clean(parsed.parser).toLowerCase() === 'cititrends') {
    parsed.lines = aggregateCitiSizeRows(parsed.lines, masters, conflicts);
  }

  applyHeaderFromLines(parsed, conflicts);

  const pendingWarnings = warnings.filter((warning) => {
    if (warning.code !== 'size_grid_requires_official_scale_mapping') return true;
    const gridLines = (parsed.lines || []).filter((line) =>
      Array.isArray(line.raw?.size_grid?.size_grid_entries_raw)
      && line.raw.size_grid.size_grid_entries_raw.length
    );
    return !gridLines.length
      || gridLines.some((line) => line.raw?.qty_bucket_resolution?.status !== 'applied');
  });

  parsed.conflicts = conflicts;
  parsed.warnings = pendingWarnings;
  parsed.raw_enrichment.master_lookup.trace = trace;
  return parsed;
}
