import {
  loadMasterData,
  normalizeMasterToken,
  cleanMasterValue
} from './masterData.js';
import {
  clearQtyBuckets,
  hasPositiveSizeDistribution
} from './sizeScaleMapping.js';

function clean(value) {
  return cleanMasterValue(value);
}

function upper(value) {
  return clean(value).toUpperCase();
}

function norm(value) {
  return normalizeMasterToken(value);
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function addConflictOnce(parsed, conflict) {
  parsed.conflicts = Array.isArray(parsed.conflicts)
    ? parsed.conflicts
    : [];

  const key = [
    conflict.field,
    conflict.code,
    conflict.line_no,
    conflict.message
  ].join('|');

  const exists = parsed.conflicts.some(
    item => [
      item.field,
      item.code,
      item.line_no,
      item.message
    ].join('|') === key
  );

  if (!exists) parsed.conflicts.push(conflict);
}

function positiveInteger(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validBucket(value) {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 18
    ? parsed
    : null;
}

function normalizeUpc(value) {
  const digits = clean(value).replace(/[^0-9]/g, '');
  return /^\d{11,14}$/.test(digits) ? digits : '';
}

function levenshteinDistance(leftValue, rightValue) {
  const left = String(leftValue || '');
  const right = String(rightValue || '');

  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index
  );

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

function consonantSkeleton(value) {
  return norm(value).replace(/[AEIOUY]/g, '');
}

function fuzzyTokenScore(expectedValue, rawValue) {
  const expected = norm(expectedValue);
  const raw = norm(rawValue);

  if (!expected || !raw) return 0;
  if (expected === raw) return 1000;

  if (
    expected.length >= 3
    && (
      expected.startsWith(raw)
      || raw.startsWith(expected)
    )
  ) {
    const delta = Math.abs(expected.length - raw.length);
    if (delta <= 2) return 940 - delta * 10;
  }

  const expectedSkeleton = consonantSkeleton(expected);
  const rawSkeleton = consonantSkeleton(raw);

  if (
    expectedSkeleton
    && expectedSkeleton === rawSkeleton
  ) {
    return 925;
  }

  const distance = levenshteinDistance(expected, raw);

  if (distance === 1 && Math.max(expected.length, raw.length) >= 5) {
    return 900;
  }

  if (distance === 2 && Math.max(expected.length, raw.length) >= 9) {
    return 850;
  }

  return 0;
}

const SCOPE_CACHE = new WeakMap();

function addStyleByLength(map, styleCode) {
  const length = norm(styleCode).length;

  if (!length) return;

  if (!map.has(length)) {
    map.set(length, new Set());
  }

  map.get(length).add(upper(styleCode));
}

function buildScopeIndex(masters) {
  if (SCOPE_CACHE.has(masters)) {
    return SCOPE_CACHE.get(masters);
  }

  const customerStyles = new Map();
  const customerStylesByLength = new Map();
  const stockStyles = new Set();
  const stockStylesByLength = new Map();
  const globalStyles = new Set();
  const globalStylesByLength = new Map();

  for (const [styleCode, rows] of masters.skuByStyle.entries()) {
    const style = upper(styleCode);
    if (!style) continue;

    globalStyles.add(style);
    addStyleByLength(globalStylesByLength, style);

    for (const row of rows || []) {
      const customer = upper(row.Customer);

      if (!customer) continue;

      if (customer === 'STOCK') {
        stockStyles.add(style);
        addStyleByLength(stockStylesByLength, style);
        continue;
      }

      if (!customerStyles.has(customer)) {
        customerStyles.set(customer, new Set());
      }

      if (!customerStylesByLength.has(customer)) {
        customerStylesByLength.set(customer, new Map());
      }

      customerStyles.get(customer).add(style);
      addStyleByLength(
        customerStylesByLength.get(customer),
        style
      );
    }
  }

  const index = {
    customerStyles,
    customerStylesByLength,
    stockStyles,
    stockStylesByLength,
    globalStyles,
    globalStylesByLength
  };

  SCOPE_CACHE.set(masters, index);
  return index;
}

function scopePlan(masters, customerCode) {
  const index = buildScopeIndex(masters);
  const customer = upper(customerCode);
  const customerSet = index.customerStyles.get(customer) || new Set();
  const customerLengthMap = (
    index.customerStylesByLength.get(customer)
    || new Map()
  );

  const stages = [];

  if (customerSet.size) {
    stages.push({
      name: 'CUSTOMER_SPECIFIC',
      style_codes: customerSet,
      style_codes_by_length: customerLengthMap,
      scope_bonus: 260
    });
  }

  if (index.stockStyles.size) {
    stages.push({
      name: 'STOCK',
      style_codes: index.stockStyles,
      style_codes_by_length: index.stockStylesByLength,
      scope_bonus: 90
    });
  }

  stages.push({
    name: 'GLOBAL_LAST_RESORT',
    style_codes: index.globalStyles,
    style_codes_by_length: index.globalStylesByLength,
    scope_bonus: 0
  });

  return {
    customer_code: customer,
    customer_specific_style_count: customerSet.size,
    stock_style_count: index.stockStyles.size,
    global_style_count: index.globalStyles.size,
    stages
  };
}

function customerPreferredRows(rows = [], customerCode) {
  const customer = upper(customerCode);

  const specific = rows.filter(
    row => upper(row.Customer) === customer
  );

  if (specific.length) return specific;

  const stock = rows.filter(
    row => upper(row.Customer) === 'STOCK'
  );

  if (stock.length) return stock;

  return rows;
}

function businessTuple(row = {}) {
  return [
    upper(row.Style),
    upper(row.Clr),
    norm(row.Sku),
    upper(row.Scale),
    upper(row.Div),
    upper(row.Wh),
    clean(row.Price),
    clean(row['Pack Qty'])
  ].join('|');
}

function collapseBusinessRows(rows = []) {
  const byTuple = new Map();

  for (const row of rows) {
    const key = businessTuple(row);
    if (!byTuple.has(key)) byTuple.set(key, row);
  }

  return [...byTuple.values()];
}

function exactUpcRow(masters, line = {}) {
  const values = unique([
    line.customer_upc,
    line.upc,
    line.raw?.customer_upc_raw
  ].map(normalizeUpc));

  for (const value of values) {
    const candidates = masters.upcByValue?.get(value) || [];
    if (!candidates.length) continue;

    const tuples = new Map();

    for (const row of candidates) {
      const key = [
        upper(row.Style),
        upper(row.Clr),
        clean(row['Size Num']),
        upper(row['Size Name']),
        upper(row.Div),
        upper(row.Scale),
        norm(row.Sku)
      ].join('|');

      if (!tuples.has(key)) tuples.set(key, row);
    }

    if (tuples.size === 1) {
      return {
        row: [...tuples.values()][0],
        upc: value,
        candidates,
        reason: 'exact_official_upc_unique_business_tuple'
      };
    }
  }

  return {
    row: null,
    upc: null,
    candidates: [],
    reason: 'no_unique_exact_official_upc'
  };
}

function exactNormalizedSkuRow(masters, line = {}, customerCode) {
  const values = unique([
    line.style_raw,
    line.customer_sku,
    line.ticket_sku
  ].map(norm));

  for (const value of values) {
    const allRows = masters.skuByNormalizedSku?.get(value) || [];
    const preferred = customerPreferredRows(allRows, customerCode);
    const tuples = collapseBusinessRows(preferred);

    if (tuples.length === 1) {
      return {
        row: tuples[0],
        lookup_value: value,
        candidates: allRows,
        reason: 'exact_official_normalized_sku_unique_business_tuple'
      };
    }
  }

  return {
    row: null,
    lookup_value: null,
    candidates: [],
    reason: 'no_unique_exact_official_normalized_sku'
  };
}


function rawStyleVariants(line = {}) {
  const values = [];

  const add = (value, source, weight = 0) => {
    const token = norm(value);
    if (!token) return;

    values.push({
      token,
      raw: clean(value),
      source,
      weight
    });
  };

  add(line.style_raw, 'style_raw', 80);
  add(line.raw?.style_base_candidate_raw, 'style_base_candidate_raw', 70);
  add(line.raw?.printed_style_raw, 'printed_style_raw', 65);
  add(line.raw?.vendor_style_raw, 'vendor_style_raw', 65);
  add(line.raw_json?.style_base_candidate_raw, 'raw_json_style_base_candidate_raw', 60);
  add(line.raw_json?.printed_style_raw, 'raw_json_printed_style_raw', 60);
  add(line.raw_json?.vendor_style_raw, 'raw_json_vendor_style_raw', 60);
  add(line.customer_sku, 'customer_sku', 35);
  add(line.ticket_sku, 'ticket_sku', 35);

  const rawStyle = clean(line.style_raw);

  if (rawStyle) {
    const parts = rawStyle.split('-').filter(Boolean);

    for (let cut = 1; cut <= Math.min(2, parts.length - 1); cut += 1) {
      add(
        parts.slice(0, -cut).join('-'),
        `style_raw_without_${cut}_trailing_token`,
        60 - cut * 5
      );
    }

    const rawToken = norm(rawStyle);

    // Some Bealls vendor styles append one documentary variant letter to the
    // base style while A2000 keeps the base/42 native style. Do not guess the
    // destination style here. We only add a search variant; the final candidate
    // must still be a unique exact official VR_SKU style/color pair.
    if (
      rawToken.length >= 6
      && /\d[A-Z]$/.test(rawToken)
    ) {
      add(
        rawToken.slice(0, -1),
        'style_raw_without_terminal_variant_letter',
        76
      );
    }
  }

  const byToken = new Map();

  for (const item of values) {
    const existing = byToken.get(item.token);

    if (!existing || item.weight > existing.weight) {
      byToken.set(item.token, item);
    }
  }

  return [...byToken.values()];
}


function numericPrefixTail(styleToken) {
  const match = String(styleToken || '').match(/^(\d{1,3})(.+)$/);
  return match ? match[2] : null;
}

function nativeStyleForms(styleToken) {
  const forms = new Set();

  const add = value => {
    const tokenValue = norm(value);
    if (tokenValue) forms.add(tokenValue);
  };

  add(styleToken);
  add(numericPrefixTail(styleToken));

  for (const value of [...forms]) {
    if (
      value.length >= 7
      && value.endsWith('42')
    ) {
      add(value.slice(0, -2));
    }
  }

  return [...forms];
}

function baseStyleRelationScore(rawToken, styleToken) {
  if (!rawToken || !styleToken) return 0;

  const raw = norm(rawToken);
  const official = norm(styleToken);

  if (!raw || !official) return 0;
  if (raw === official) return 1500;

  let best = 0;

  for (const form of nativeStyleForms(official)) {
    if (form === raw) {
      best = Math.max(
        best,
        form === official ? 1500 : 1475
      );
      continue;
    }

    const distance = levenshteinDistance(form, raw);

    if (
      distance === 1
      && Math.max(form.length, raw.length) >= 5
    ) {
      best = Math.max(best, 1400);
    }

    if (
      distance === 2
      && Math.max(form.length, raw.length) >= 8
    ) {
      best = Math.max(best, 1320);
    }

    if (
      (
        form.startsWith(raw)
        || raw.startsWith(form)
      )
      && Math.abs(form.length - raw.length) <= 2
    ) {
      best = Math.max(best, 1370);
    }
  }

  return best;
}

function officialColorTokens(rows = []) {
  const values = [];

  for (const row of rows) {
    const code = norm(row.Clr);
    const description = norm(row['Clr Desc']);
    const abbreviation = norm(row['Clr Abbr']);

    if (code) {
      values.push({
        token: code,
        color_code: upper(row.Clr),
        source: 'CLR',
        exact_weight: 520
      });
    }

    if (description) {
      values.push({
        token: description,
        color_code: upper(row.Clr),
        source: 'CLR_DESC',
        exact_weight: 430
      });
    }

    if (abbreviation) {
      values.push({
        token: abbreviation,
        color_code: upper(row.Clr),
        source: 'CLR_ABBR',
        exact_weight: 400
      });
    }
  }

  return values;
}

function styleBoundaryEvidence(rawToken, styleToken, rows = []) {
  const styleForms = nativeStyleForms(styleToken);

  let best = {
    score: 0,
    style_form: null,
    remainder: null,
    color_code: null,
    color_source: null,
    rule: null
  };

  for (const styleForm of styleForms) {
    if (!styleForm) continue;

    if (rawToken.startsWith(styleForm)) {
      const remainder = rawToken.slice(styleForm.length);

      if (!remainder) {
        const candidate = {
          score: 1480,
          style_form: styleForm,
          remainder: '',
          color_code: null,
          color_source: null,
          rule: 'raw_starts_with_exact_official_style_boundary'
        };

        if (candidate.score > best.score) best = candidate;
      }

      for (const color of officialColorTokens(rows)) {
        if (!remainder) continue;

        if (remainder === color.token) {
          const candidate = {
            score: 1600 + color.exact_weight,
            style_form: styleForm,
            remainder,
            color_code: color.color_code,
            color_source: color.source,
            rule: 'exact_official_style_boundary_plus_exact_color_token'
          };

          if (candidate.score > best.score) best = candidate;
        }

        if (
          color.source === 'CLR'
          && remainder.length >= 2
          && color.token.startsWith(remainder)
          && color.token.length - remainder.length <= 2
        ) {
          const samePrefixCodes = unique(
            officialColorTokens(rows)
              .filter(item => (
                item.source === 'CLR'
                && item.token.startsWith(remainder)
              ))
              .map(item => item.color_code)
          );

          if (samePrefixCodes.length === 1) {
            const candidate = {
              score: 1940,
              style_form: styleForm,
              remainder,
              color_code: samePrefixCodes[0],
              color_source: 'CLR_PREFIX_UNIQUE_WITHIN_STYLE',
              rule: 'exact_official_style_boundary_plus_unique_color_prefix'
            };

            if (candidate.score > best.score) best = candidate;
          }
        }
      }
    }

    const expectedLength = styleForm.length;

    for (const delta of [-2, -1, 0, 1, 2]) {
      const cut = expectedLength + delta;
      if (cut < 5 || cut > rawToken.length) continue;

      const prefix = rawToken.slice(0, cut);
      const remainder = rawToken.slice(cut);
      const distance = levenshteinDistance(prefix, styleForm);

      if (
        distance > 2
        || (
          distance === 2
          && Math.max(prefix.length, styleForm.length) < 9
        )
      ) {
        continue;
      }

      for (const color of officialColorTokens(rows)) {
        if (!remainder) continue;

        let colorScore = 0;
        let colorSource = null;

        if (remainder === color.token) {
          colorScore = color.exact_weight;
          colorSource = color.source;
        } else if (
          color.source === 'CLR'
          && remainder.length >= 2
          && color.token.startsWith(remainder)
          && color.token.length - remainder.length <= 2
        ) {
          const samePrefixCodes = unique(
            officialColorTokens(rows)
              .filter(item => (
                item.source === 'CLR'
                && item.token.startsWith(remainder)
              ))
              .map(item => item.color_code)
          );

          if (samePrefixCodes.length === 1) {
            colorScore = 420;
            colorSource = 'CLR_PREFIX_UNIQUE_WITHIN_STYLE';
          }
        }

        if (!colorScore) continue;

        const candidate = {
          score: 1500 - distance * 120 + colorScore,
          style_form: styleForm,
          remainder,
          color_code: color.color_code,
          color_source: colorSource,
          rule: 'fuzzy_official_style_boundary_plus_official_color_suffix'
        };

        if (candidate.score > best.score) best = candidate;
      }
    }
  }

  return best;
}

function explicitColorEvidence(row, line = {}) {
  const rawValues = unique([
    line.color_raw,
    line.raw?.color_candidate_raw,
    line.raw?.color_description_candidate_raw,
    line.description,
    line.raw?.po_description_raw,
    line.raw?.description_raw
  ]);

  let best = {
    score: 0,
    source: null
  };

  for (const rawValue of rawValues) {
    const fields = [
      ['CLR', row.Clr],
      ['CLR_DESC', row['Clr Desc']],
      ['CLR_ABBR', row['Clr Abbr']]
    ];

    for (const [field, officialValue] of fields) {
      const score = fuzzyTokenScore(officialValue, rawValue);

      if (score > best.score) {
        best = {
          score,
          source: `${field}_VS_RAW`
        };
      }
    }

    const rawUpper = upper(rawValue);
    const descUpper = upper(row['Clr Desc']);

    if (
      descUpper
      && rawUpper.includes(descUpper)
      && 990 > best.score
    ) {
      best = {
        score: 990,
        source: 'CLR_DESC_INSIDE_RAW_DESCRIPTION'
      };
    }
  }

  return best;
}

function scoreStyleCandidate(
  masters,
  line,
  customerCode,
  styleCode,
  scopeName,
  scopeBonus
) {
  const rows = masters.skuByStyle.get(styleCode) || [];
  const preferredRows = customerPreferredRows(rows, customerCode);
  const variants = rawStyleVariants(line);
  const styleToken = norm(styleCode);

  let bestRelation = {
    score: 0,
    source: null,
    variant: null
  };

  let bestBoundary = {
    score: 0,
    style_form: null,
    remainder: null,
    color_code: null,
    color_source: null,
    rule: null
  };

  for (const variant of variants) {
    const relation = baseStyleRelationScore(
      variant.token,
      styleToken
    );

    if (relation + variant.weight > bestRelation.score) {
      bestRelation = {
        score: relation + variant.weight,
        source: 'STYLE_TOKEN_RELATION',
        variant
      };
    }

    const boundary = styleBoundaryEvidence(
      variant.token,
      styleToken,
      preferredRows
    );

    const weightedBoundary = {
      ...boundary,
      score: boundary.score
        ? boundary.score + variant.weight
        : 0,
      variant
    };

    if (weightedBoundary.score > bestBoundary.score) {
      bestBoundary = weightedBoundary;
    }
  }

  let bestColor = {
    score: 0,
    source: null,
    color_code: null
  };

  for (const row of preferredRows) {
    const evidence = explicitColorEvidence(row, line);

    if (evidence.score > bestColor.score) {
      bestColor = {
        ...evidence,
        color_code: upper(row.Clr)
      };
    }
  }

  const coreScore = Math.max(
    bestRelation.score,
    bestBoundary.score
  );

  if (coreScore < 850) return null;

  const score = (
    coreScore
    + Math.round(bestColor.score * 0.40)
    + scopeBonus
  );

  return {
    style_code: styleCode,
    score,
    core_score: coreScore,
    scope_name: scopeName,
    scope_bonus: scopeBonus,
    relation: bestRelation,
    boundary: bestBoundary,
    explicit_color: bestColor,
    rows
  };
}

function candidateStyleCodesForLine(stage, line) {
  const variants = rawStyleVariants(line);
  const byLength = stage.style_codes_by_length;

  if (!byLength || variants.length === 0) {
    return stage.style_codes;
  }

  const candidates = new Set();

  for (const variant of variants) {
    const rawLength = variant.token.length;

    // The printed token can include a color suffix and the native A2000 style
    // can include a short numeric prefix. Keep this window intentionally
    // narrow so STOCK/GLOBAL matching stays fast without losing the known
    // hardcopy encodings.
    const minLength = Math.max(1, rawLength - 8);
    const maxLength = rawLength + 5;

    for (
      let length = minLength;
      length <= maxLength;
      length += 1
    ) {
      for (const styleCode of byLength.get(length) || []) {
        candidates.add(styleCode);
      }
    }
  }

  return candidates.size
    ? candidates
    : stage.style_codes;
}

function candidateScoresForScope(
  masters,
  line,
  customerCode,
  stage
) {
  const candidates = [];
  const styleCodes = candidateStyleCodesForLine(
    stage,
    line
  );

  for (const styleCode of styleCodes) {
    const candidate = scoreStyleCandidate(
      masters,
      line,
      customerCode,
      styleCode,
      stage.name,
      stage.scope_bonus
    );

    if (candidate) candidates.push(candidate);
  }

  candidates.sort(
    (left, right) => (
      right.score - left.score
      || right.core_score - left.core_score
      || left.style_code.localeCompare(right.style_code)
    )
  );

  return candidates;
}

function acceptableWinner(candidates, scopeName) {
  const best = candidates[0] || null;
  const second = candidates[1] || null;

  if (!best) {
    return {
      accepted: false,
      best: null,
      second: null,
      margin: null,
      minimum_score: null,
      minimum_margin: null
    };
  }

  const margin = second
    ? best.score - second.score
    : best.score;

  const minimumScore = scopeName === 'CUSTOMER_SPECIFIC'
    ? 1120
    : scopeName === 'STOCK'
      ? 1200
      : 1450;

  const minimumMargin = scopeName === 'CUSTOMER_SPECIFIC'
    ? 25
    : scopeName === 'STOCK'
      ? 45
      : 90;

  return {
    accepted: (
      best.score >= minimumScore
      && (
        !second
        || margin >= minimumMargin
      )
    ),
    best,
    second,
    margin,
    minimum_score: minimumScore,
    minimum_margin: minimumMargin
  };
}


function rowStyleIdentityTokens(row = {}) {
  return unique([
    row.Style,
    row['Master Style'],
    row['Style Alias']
  ].map(norm));
}

function exactAliasMatchedRows(
  masters,
  styleCode,
  customerCode,
  rawToken
) {
  const rows = customerPreferredRows(
    masters.skuByStyle.get(upper(styleCode)) || [],
    customerCode
  );

  return rows.filter(
    row => rowStyleIdentityTokens(row).includes(norm(rawToken))
  );
}

function quantitySemantics(line = {}) {
  return upper(
    line.raw?.quantity_semantics
    || line.raw_json?.quantity_semantics
  );
}

function colorOperationalEvidence(
  masters,
  styleCode,
  colorCode,
  line = {}
) {
  const quantity = positiveInteger(line.qty_total);
  const semantics = quantitySemantics(line);
  const sizeRaw = clean(line.size_raw || line.size_code);
  const plan = ratioPlan(
    masters,
    styleCode,
    colorCode,
    null
  );

  const evidence = {
    score: 0,
    compatible: false,
    nontrivial_ratio: false,
    ratio_total: null,
    scale: null,
    rule: null
  };

  if (!plan.valid || !quantity) {
    return evidence;
  }

  const eachSemantics = [
    'EACH',
    'ORDERED_UNITS',
    'TOTAL_EACH_UNDISTRIBUTED'
  ].includes(semantics);

  const oneBucketRatio = (
    plan.entries.length === 1
    && plan.ratio_total === 1
  );

  const exactRange = planMatchesRange(
    plan,
    sizeRaw
  );

  const casePack = positiveInteger(
    line.raw?.case_pack_raw
    || line.raw?.case_pack_candidate_raw
    || line.raw?.cs_pk_raw
    || line.raw_json?.case_pack_raw
    || line.raw_json?.case_pack_candidate_raw
    || line.raw_json?.cs_pk_raw
  );

  const exactCasePack = (
    casePack
    && casePack === plan.ratio_total
  );

  const divisible = quantity % plan.ratio_total === 0;

  evidence.compatible = Boolean(
    divisible
    && (
      eachSemantics
      || oneBucketRatio
      || exactRange
      || exactCasePack
    )
  );

  evidence.nontrivial_ratio = (
    plan.entries.length > 1
    || plan.ratio_total > 1
  );

  evidence.ratio_total = plan.ratio_total;
  evidence.scale = plan.scale;

  if (!evidence.compatible) {
    return evidence;
  }

  if (
    eachSemantics
    && (!sizeRaw || sizeRaw === '-')
    && evidence.nontrivial_ratio
  ) {
    evidence.score = 620;
    evidence.rule = 'UNDISTRIBUTED_EACH_COMPATIBLE_NONTRIVIAL_VR_SKU_Z_RATIO';
  } else if (exactRange && evidence.nontrivial_ratio) {
    evidence.score = 560;
    evidence.rule = 'EXACT_PRINTED_RANGE_COMPATIBLE_VR_SKU_Z_RATIO';
  } else if (exactCasePack && evidence.nontrivial_ratio) {
    evidence.score = 540;
    evidence.rule = 'EXACT_CASE_PACK_COMPATIBLE_VR_SKU_Z_RATIO';
  } else if (oneBucketRatio) {
    evidence.score = 70;
    evidence.rule = 'ONE_BUCKET_PC_COMPATIBLE';
  } else {
    evidence.score = 180;
    evidence.rule = 'COMPATIBLE_VR_SKU_Z_RATIO';
  }

  const masterUpc = uniqueMasterUpc(
    masters,
    styleCode,
    colorCode
  );

  if (masterUpc.upc) {
    evidence.score += 25;
  }

  return evidence;
}

function resolveStyle(masters, line, customerCode) {
  const existing = upper(line.style_code);
  const existingColor = upper(line.color_code);

  if (existing && masters.skuByStyle.has(existing)) {
    const rows = masters.skuByStyle.get(existing) || [];
    const exactPair = existingColor
      ? rows.some(row => upper(row.Clr) === existingColor)
      : false;

    const existingToken = norm(existing);
    const rawSupportsExisting = rawStyleVariants(line).some(
      variant => (
        baseStyleRelationScore(
          variant.token,
          existingToken
        ) >= 1290
        || styleBoundaryEvidence(
          variant.token,
          existingToken,
          customerPreferredRows(rows, customerCode)
        ).score >= 1480
      )
    );

    if (exactPair || rawSupportsExisting) {
      return {
        style_code: existing,
        rows,
        source: exactPair
          ? 'EXISTING_EXACT_OFFICIAL_STYLE_COLOR'
          : 'EXISTING_EXACT_OFFICIAL_STYLE_SUPPORTED_BY_RAW',
        score: 9999,
        margin: null,
        scope_name: 'EXACT_EXISTING',
        candidates: []
      };
    }
  }

  const exactUpc = exactUpcRow(masters, line);

  if (exactUpc.row) {
    return {
      style_code: upper(exactUpc.row.Style),
      rows: masters.skuByStyle.get(
        upper(exactUpc.row.Style)
      ) || [],
      matched_rows: [exactUpc.row],
      matched_alias_token: null,
      matched_alias_source: 'EXACT_OFFICIAL_UPC',
      source: 'EXACT_OFFICIAL_UPC',
      score: 9000,
      margin: null,
      scope_name: 'EXACT_UPC',
      candidates: []
    };
  }

  const exactSku = exactNormalizedSkuRow(
    masters,
    line,
    customerCode
  );

  if (exactSku.row) {
    return {
      style_code: upper(exactSku.row.Style),
      rows: masters.skuByStyle.get(
        upper(exactSku.row.Style)
      ) || [],
      matched_rows: [exactSku.row],
      matched_alias_token: exactSku.lookup_value,
      matched_alias_source: 'EXACT_OFFICIAL_NORMALIZED_SKU',
      source: 'EXACT_OFFICIAL_NORMALIZED_SKU',
      score: 8500,
      margin: null,
      scope_name: 'EXACT_SKU',
      candidates: []
    };
  }

  const rawTokens = rawStyleVariants(line);

  for (const rawVariant of rawTokens) {
    const directStyles = new Set();

    for (const customer of unique([
      upper(customerCode),
      'STOCK'
    ])) {
      const direct = masters.styleByCustomerNorm?.get(
        `${customer}|${rawVariant.token}`
      );

      for (const style of direct || []) {
        const styleCode = upper(style);

        if (
          styleCode
          && masters.skuByStyle.has(styleCode)
        ) {
          directStyles.add(styleCode);
        }
      }
    }

    if (directStyles.size === 1) {
      const [styleCode] = [...directStyles];
      const matchedRows = exactAliasMatchedRows(
        masters,
        styleCode,
        customerCode,
        rawVariant.token
      );

      return {
        style_code: styleCode,
        rows: masters.skuByStyle.get(styleCode) || [],
        matched_rows: matchedRows,
        matched_alias_token: rawVariant.token,
        matched_alias_source: rawVariant.source,
        source: 'EXACT_OFFICIAL_STYLE_ALIAS',
        score: 8000,
        margin: null,
        scope_name: 'MASTER_STYLE_ALIAS',
        candidates: []
      };
    }
  }

  const plan = scopePlan(masters, customerCode);
  const stageResults = [];

  for (const stage of plan.stages) {
    const candidates = candidateScoresForScope(
      masters,
      line,
      customerCode,
      stage
    );

    const verdict = acceptableWinner(
      candidates,
      stage.name
    );

    stageResults.push({
      scope_name: stage.name,
      candidate_count: candidates.length,
      best_score: verdict.best?.score || null,
      second_score: verdict.second?.score || null,
      margin: verdict.margin,
      minimum_score: verdict.minimum_score,
      minimum_margin: verdict.minimum_margin,
      accepted: verdict.accepted,
      candidates: candidates.slice(0, 8)
    });

    if (verdict.accepted) {
      return {
        style_code: verdict.best.style_code,
        rows: verdict.best.rows,
        matched_rows: exactAliasMatchedRows(
          masters,
          verdict.best.style_code,
          customerCode,
          verdict.best.relation?.variant?.token
          || verdict.best.boundary?.variant?.token
          || ''
        ),
        matched_alias_token: (
          verdict.best.relation?.variant?.token
          || verdict.best.boundary?.variant?.token
          || null
        ),
        matched_alias_source: (
          verdict.best.relation?.variant?.source
          || verdict.best.boundary?.variant?.source
          || null
        ),
        source: `SCOPED_UNIQUE_OFFICIAL_MASTER_STYLE_${stage.name}`,
        score: verdict.best.score,
        margin: verdict.margin,
        scope_name: stage.name,
        candidate: verdict.best,
        scope_plan: plan,
        stage_results: stageResults,
        candidates: candidates.slice(0, 8)
      };
    }
  }

  const bestStage = [...stageResults].sort(
    (left, right) => (
      (right.best_score || 0) - (left.best_score || 0)
    )
  )[0] || null;

  return {
    style_code: null,
    rows: [],
    source: 'NO_UNIQUE_OFFICIAL_STYLE_IN_CUSTOMER_STOCK_GLOBAL_SCOPES',
    score: bestStage?.best_score || 0,
    margin: bestStage?.margin ?? null,
    scope_name: bestStage?.scope_name || null,
    scope_plan: plan,
    stage_results: stageResults,
    candidates: bestStage?.candidates || []
  };
}

function boundaryPreferredColor(styleResolution) {
  return upper(
    styleResolution?.candidate?.boundary?.color_code
  );
}


function citiUndistributedEachOperationalColorOverride(
  candidates,
  line,
  customerCode
) {
  if (upper(customerCode) !== 'CITI') return null;
  if (hasPositiveSizeDistribution(line)) return null;

  const quantity = positiveInteger(line.qty_total);
  const semantics = quantitySemantics(line);
  const sizeRaw = clean(line.size_raw || line.size_code);

  if (!quantity) return null;
  if (
    ![
      'EACH',
      'ORDERED_UNITS',
      'TOTAL_EACH_UNDISTRIBUTED'
    ].includes(semantics)
  ) {
    return null;
  }

  if (sizeRaw && sizeRaw !== '-') return null;

  const compatible = (candidates || []).filter(
    candidate => (
      candidate.operational?.compatible === true
      && candidate.operational?.nontrivial_ratio === true
      && Number(candidate.operational_score || 0) >= 620
    )
  );

  if (compatible.length !== 1) return null;

  const [winner] = compatible;
  const ordinaryWinner = candidates?.[0] || null;

  // This rule is deliberately narrow. It only repairs a Citi line when the
  // plain color-text winner cannot produce a legal A2000 size distribution,
  // while exactly one other native STYLE/CLR pair has an official VR_SKU_Z
  // ratio compatible with the undivided EACH quantity.
  if (
    ordinaryWinner
    && ordinaryWinner.color_code !== winner.color_code
    && ordinaryWinner.operational?.compatible === true
  ) {
    return null;
  }

  return winner;
}

function resolveColor(masters, line, styleResolution, customerCode) {
  const styleCode = upper(styleResolution.style_code);
  const allRows = masters.skuByStyle.get(styleCode) || [];
  const customerRows = customerPreferredRows(allRows, customerCode);
  const aliasMatchedRows = customerPreferredRows(
    styleResolution.matched_rows || [],
    customerCode
  );
  const rows = aliasMatchedRows.length
    ? aliasMatchedRows
    : customerRows;
  const existing = upper(line.color_code);

  if (
    existing
    && rows.some(row => upper(row.Clr) === existing)
  ) {
    return {
      color_code: existing,
      row_candidates: rows.filter(
        row => upper(row.Clr) === existing
      ),
      source: 'EXISTING_EXACT_OFFICIAL_COLOR_FOR_STYLE',
      score: 9999,
      margin: null,
      candidates: []
    };
  }

  const exactUpc = exactUpcRow(masters, line);

  if (
    exactUpc.row
    && upper(exactUpc.row.Style) === styleCode
  ) {
    return {
      color_code: upper(exactUpc.row.Clr),
      row_candidates: customerRows.filter(
        row => upper(row.Clr) === upper(exactUpc.row.Clr)
      ),
      source: 'EXACT_OFFICIAL_UPC',
      score: 9000,
      margin: null,
      candidates: []
    };
  }

  const aliasColors = unique(
    aliasMatchedRows.map(row => upper(row.Clr))
  );

  if (aliasColors.length === 1) {
    const [colorCode] = aliasColors;

    return {
      color_code: colorCode,
      row_candidates: aliasMatchedRows.filter(
        row => upper(row.Clr) === colorCode
      ),
      source: 'EXACT_STYLE_ALIAS_ROW_UNIQUE_COLOR',
      score: 8200,
      margin: null,
      candidates: []
    };
  }

  const boundaryColor = boundaryPreferredColor(styleResolution);

  if (
    boundaryColor
    && customerRows.some(row => upper(row.Clr) === boundaryColor)
  ) {
    return {
      color_code: boundaryColor,
      row_candidates: customerRows.filter(
        row => upper(row.Clr) === boundaryColor
      ),
      source: 'OFFICIAL_STYLE_BOUNDARY_COLOR_SUFFIX',
      score: 7000,
      margin: null,
      candidates: []
    };
  }

  const byColor = new Map();

  for (const row of rows) {
    const code = upper(row.Clr);
    if (!code) continue;

    const textEvidence = explicitColorEvidence(row, line);
    const operationalEvidence = colorOperationalEvidence(
      masters,
      styleCode,
      code,
      line
    );

    const current = byColor.get(code);
    const score = (
      textEvidence.score
      + operationalEvidence.score
    );

    if (
      !current
      || score > current.score
      || (
        score === current.score
        && textEvidence.score > current.text_score
      )
    ) {
      byColor.set(code, {
        color_code: code,
        score,
        text_score: textEvidence.score,
        operational_score: operationalEvidence.score,
        source: textEvidence.source,
        operational: operationalEvidence,
        rows: rows.filter(
          candidate => upper(candidate.Clr) === code
        )
      });
    }
  }

  const candidates = [...byColor.values()].sort(
    (left, right) => (
      right.score - left.score
      || right.text_score - left.text_score
      || left.color_code.localeCompare(right.color_code)
    )
  );

  const citiOperationalOverride = (
    citiUndistributedEachOperationalColorOverride(
      candidates,
      line,
      customerCode
    )
  );

  if (citiOperationalOverride) {
    return {
      color_code: citiOperationalOverride.color_code,
      row_candidates: citiOperationalOverride.rows,
      source: 'CITI_UNDISTRIBUTED_EACH_UNIQUE_VR_SKU_Z_OPERATIONAL_COLOR',
      score: citiOperationalOverride.score,
      margin: null,
      candidates: candidates.slice(0, 12)
    };
  }

  if (candidates.length === 1) {
    return {
      color_code: candidates[0].color_code,
      row_candidates: candidates[0].rows,
      source: candidates[0].text_score
        ? 'UNIQUE_OFFICIAL_COLOR_WITH_EVIDENCE'
        : 'UNIQUE_OFFICIAL_COLOR_FOR_RESOLVED_STYLE',
      score: candidates[0].score || 650,
      margin: null,
      candidates
    };
  }

  const best = candidates[0] || null;
  const second = candidates[1] || null;

  if (!best) {
    return {
      color_code: null,
      row_candidates: [],
      source: 'NO_OFFICIAL_COLOR_FOR_STYLE',
      score: 0,
      margin: null,
      candidates: []
    };
  }

  const margin = second
    ? best.score - second.score
    : best.score;

  if (
    best.text_score < 850
    || (
      second
      && margin < 25
    )
  ) {
    return {
      color_code: null,
      row_candidates: best.rows,
      source: 'OFFICIAL_COLOR_NOT_UNIQUE_ENOUGH',
      score: best.score,
      margin,
      candidates: candidates.slice(0, 12)
    };
  }

  return {
    color_code: best.color_code,
    row_candidates: best.rows,
    source: best.operational_score >= 500
      ? 'OFFICIAL_COLOR_TEXT_PLUS_VR_SKU_Z_OPERATIONAL_EVIDENCE'
      : 'SCOPED_UNIQUE_OFFICIAL_MASTER_COLOR',
    score: best.score,
    margin,
    candidates: candidates.slice(0, 12)
  };
}

function exactBusinessRow(
  masters,
  styleCode,
  colorCode,
  customerCode
) {
  const rows = (
    masters.skuByStyle.get(upper(styleCode)) || []
  ).filter(
    row => upper(row.Clr) === upper(colorCode)
  );

  const preferred = customerPreferredRows(
    rows,
    customerCode
  );

  const tuples = collapseBusinessRows(preferred);

  return {
    row: tuples.length === 1
      ? tuples[0]
      : null,
    candidates: preferred,
    tuple_count: tuples.length
  };
}

function uniqueField(rows, field) {
  const values = unique(
    (rows || []).map(
      row => clean(row[field])
    )
  );

  return {
    value: values.length === 1
      ? values[0]
      : null,
    values
  };
}

function officialPairEvidence(
  masters,
  styleCode,
  colorCode,
  customerCode
) {
  const rows = (
    masters.skuByStyle.get(upper(styleCode)) || []
  ).filter(
    row => upper(row.Clr) === upper(colorCode)
  );

  const preferred = customerPreferredRows(
    rows,
    customerCode
  );

  return {
    rows: preferred,
    row_count: preferred.length,
    division: uniqueField(preferred, 'Div'),
    warehouse: uniqueField(preferred, 'Wh'),
    scale: uniqueField(preferred, 'Scale'),
    scale_abbr: uniqueField(preferred, 'Scale Abbr'),
    sku: uniqueField(preferred, 'Sku')
  };
}

function applyOfficialPairEvidence(line, evidence) {
  if (!evidence) return;

  if (evidence.sku.value) {
    line.internal_sku = line.internal_sku
      || evidence.sku.value;
    line.master_sku = line.master_sku
      || evidence.sku.value;
  }

  if (evidence.division.value) {
    line.master_division_code = evidence.division.value;
  }

  if (evidence.scale.value) {
    line.scale_code = line.scale_code
      || evidence.scale.value;
  }

  if (evidence.scale_abbr.value) {
    line.scale_abbr = line.scale_abbr
      || evidence.scale_abbr.value;
  }

  if (evidence.warehouse.value) {
    line.warehouse_code = line.warehouse_code
      || evidence.warehouse.value;
  }
}

function applyOfficialRow(line, row) {
  if (!row) return;

  line.style_code = upper(row.Style);
  line.color_code = upper(row.Clr);
  line.internal_sku = line.internal_sku
    || clean(row.Sku)
    || null;
  line.master_sku = line.master_sku
    || clean(row.Sku)
    || null;
  line.master_division_code = line.master_division_code
    || clean(row.Div)
    || null;
  line.scale_code = line.scale_code
    || clean(row.Scale)
    || null;
  line.scale_abbr = line.scale_abbr
    || clean(row['Scale Abbr'])
    || null;
  line.warehouse_code = line.warehouse_code
    || clean(row.Wh)
    || null;
}

function uniqueMasterUpc(
  masters,
  styleCode,
  colorCode
) {
  const rows = masters.upcByStyleColor?.get(
    `${upper(styleCode)}|${upper(colorCode)}`
  ) || [];

  const byUpc = new Map();

  for (const row of rows) {
    const upc = normalizeUpc(row['Upc No']);

    if (upc && !byUpc.has(upc)) {
      byUpc.set(upc, row);
    }
  }

  if (byUpc.size === 1) {
    const [upc, row] = [...byUpc.entries()][0];

    return {
      upc,
      row,
      rows,
      reason: 'UNIQUE_OFFICIAL_MASTER_UPC_FOR_STYLE_COLOR'
    };
  }

  return {
    upc: null,
    row: null,
    rows,
    reason: byUpc.size > 1
      ? 'MULTIPLE_OFFICIAL_MASTER_UPCS_FOR_STYLE_COLOR'
      : 'NO_OFFICIAL_MASTER_UPC_FOR_STYLE_COLOR'
  };
}

function masterUpcsBySize(
  masters,
  styleCode,
  colorCode
) {
  const rows = masters.upcByStyleColor?.get(
    `${upper(styleCode)}|${upper(colorCode)}`
  ) || [];

  const byKey = new Map();

  for (const row of rows) {
    const upc = normalizeUpc(row['Upc No']);
    const bucket = validBucket(row['Size Num']);

    if (!upc || !bucket) continue;

    const key = `${bucket}|${upc}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        size_name: clean(row['Size Name']),
        size_num: String(bucket),
        upc,
        scale: clean(row.Scale),
        sku: clean(row.Sku)
      });
    }
  }

  return [...byKey.values()];
}

function activeScaleRows(
  masters,
  styleCode,
  colorCode,
  scaleHint = null
) {
  let rows = masters.skuZByStyleColor?.get(
    `${upper(styleCode)}|${upper(colorCode)}`
  ) || [];

  const active = rows.filter(
    row => !clean(row.Active) || upper(row.Active) === 'Y'
  );

  if (active.length) rows = active;

  if (scaleHint) {
    const sameScale = rows.filter(
      row => upper(row.Scale) === upper(scaleHint)
    );

    if (sameScale.length) rows = sameScale;
  }

  return rows;
}

function ratioPlan(
  masters,
  styleCode,
  colorCode,
  scaleHint = null
) {
  const rows = activeScaleRows(
    masters,
    styleCode,
    colorCode,
    scaleHint
  );

  const byBucket = new Map();
  const scales = new Set();

  for (const row of rows) {
    const bucket = validBucket(row['Size Num']);
    const scaleQty = positiveInteger(row['Scale Qty']);

    if (!bucket || !scaleQty) continue;

    const record = {
      bucket,
      scale_qty: scaleQty,
      size_name: clean(row['Size Name']),
      scale: clean(row.Scale)
    };

    const existing = byBucket.get(bucket);

    if (
      existing
      && (
        existing.scale_qty !== record.scale_qty
        || upper(existing.size_name) !== upper(record.size_name)
      )
    ) {
      return {
        valid: false,
        reason: 'CONFLICTING_OFFICIAL_RATIO_ROWS',
        rows
      };
    }

    byBucket.set(bucket, record);

    if (record.scale) scales.add(record.scale);
  }

  const entries = [...byBucket.values()].sort(
    (left, right) => left.bucket - right.bucket
  );

  const ratioTotal = entries.reduce(
    (sum, item) => sum + item.scale_qty,
    0
  );

  if (
    !entries.length
    || !positiveInteger(ratioTotal)
    || scales.size > 1
  ) {
    return {
      valid: false,
      reason: scales.size > 1
        ? 'MULTIPLE_OFFICIAL_SCALES'
        : 'NO_POSITIVE_OFFICIAL_RATIO',
      rows
    };
  }

  return {
    valid: true,
    source: 'VR_SKU_Z',
    rows,
    entries,
    ratio_total: ratioTotal,
    scale: [...scales][0] || scaleHint || null
  };
}

function parseNumericRange(value) {
  const match = clean(value).match(
    /^(\d+(?:\.\d+)?)\s*(?:TO|THRU|THROUGH|-)\s*(\d+(?:\.\d+)?)$/i
  );

  if (!match) return null;

  const left = Number(match[1]);
  const right = Number(match[2]);

  if (
    !Number.isFinite(left)
    || !Number.isFinite(right)
  ) {
    return null;
  }

  return {
    min: Math.min(left, right),
    max: Math.max(left, right)
  };
}

function planMatchesRange(plan, sizeRaw) {
  const range = parseNumericRange(sizeRaw);

  if (!range || !plan?.valid) return false;

  const sizes = plan.entries.map(
    item => Number(item.size_name)
  );

  if (
    !sizes.length
    || sizes.some(value => !Number.isFinite(value))
  ) {
    return false;
  }

  return (
    Math.min(...sizes) === range.min
    && Math.max(...sizes) === range.max
  );
}

function applySingleSizeBucket(
  masters,
  line,
  styleCode,
  colorCode
) {
  if (hasPositiveSizeDistribution(line)) return false;

  const sizeToken = norm(
    line.size_raw
    || line.size_code
  );

  const quantity = positiveInteger(line.qty_total);

  if (!sizeToken || !quantity) return false;

  const rows = activeScaleRows(
    masters,
    styleCode,
    colorCode,
    line.scale_code
  ).filter(
    row => norm(row['Size Name']) === sizeToken
  );

  const buckets = unique(
    rows.map(
      row => validBucket(row['Size Num'])
    )
  );

  const scales = unique(
    rows.map(row => clean(row.Scale))
  );

  if (
    buckets.length !== 1
    || scales.length > 1
  ) {
    return false;
  }

  clearQtyBuckets(line);

  line[`qty_sz${buckets[0]}`] = quantity;
  line.scale_code = scales[0]
    || line.scale_code
    || null;

  line.raw = line.raw || {};
  const resolvedRow = rows.find(
    row => validBucket(row['Size Num']) === buckets[0]
  ) || rows[0] || null;

  line.raw.universal_official_qty_resolution = {
    status: 'APPLIED',
    source: 'VR_SKU_Z',
    rule: 'EXACT_PRINTED_SIZE_NAME_TO_OFFICIAL_SIZE_NUM',
    size_raw: clean(line.size_raw || line.size_code),
    size_num: buckets[0],
    size_name: clean(resolvedRow?.['Size Name']) || null,
    qty_bucket: `QTY_SZ${buckets[0]}`,
    quantity,
    scale: line.scale_code,
    size_names_by_bucket: {
      [`QTY_SZ${buckets[0]}`]: clean(resolvedRow?.['Size Name']) || null
    },
    distribution: {
      [`QTY_SZ${buckets[0]}`]: quantity
    }
  };

  return true;
}

function applyOfficialRatio(
  masters,
  line,
  styleCode,
  colorCode
) {
  if (hasPositiveSizeDistribution(line)) return false;

  const quantity = positiveInteger(line.qty_total);

  if (!quantity) return false;

  const plan = ratioPlan(
    masters,
    styleCode,
    colorCode,
    line.scale_code
  );

  if (
    !plan.valid
    || quantity % plan.ratio_total !== 0
  ) {
    return false;
  }

  const semantics = quantitySemantics(line);

  const casePack = positiveInteger(
    line.raw?.case_pack_raw
    || line.raw?.case_pack_candidate_raw
    || line.raw?.cs_pk_raw
    || line.raw_json?.case_pack_raw
    || line.raw_json?.case_pack_candidate_raw
    || line.raw_json?.cs_pk_raw
  );

  const oneBucketRatio = (
    plan.entries.length === 1
    && plan.ratio_total === 1
  );

  const eachSemantics = [
    'EACH',
    'ORDERED_UNITS',
    'TOTAL_EACH_UNDISTRIBUTED'
  ].includes(semantics);

  const exactRange = planMatchesRange(
    plan,
    line.size_raw
  );

  const exactCasePack = (
    casePack
    && casePack === plan.ratio_total
  );

  if (
    !oneBucketRatio
    && !eachSemantics
    && !exactRange
    && !exactCasePack
  ) {
    return false;
  }

  const multiplier = quantity / plan.ratio_total;

  clearQtyBuckets(line);

  for (const item of plan.entries) {
    line[`qty_sz${item.bucket}`] = (
      item.scale_qty * multiplier
    );
  }

  line.scale_code = plan.scale
    || line.scale_code
    || null;

  line.raw = line.raw || {};
  line.raw.universal_official_qty_resolution = {
    status: 'APPLIED',
    source: 'VR_SKU_Z',
    rule: oneBucketRatio
      ? 'SINGLE_OFFICIAL_SIZE_BUCKET'
      : exactRange
        ? 'PRINTED_SIZE_RANGE_EXACT_OFFICIAL_RATIO'
        : exactCasePack
          ? 'PRINTED_CASE_PACK_EXACT_OFFICIAL_RATIO_TOTAL'
          : 'ORDERED_EACH_QUANTITY_EXACT_OFFICIAL_RATIO',
    quantity_semantics: semantics || null,
    quantity,
    ratio_total: plan.ratio_total,
    pack_multiplier: multiplier,
    scale: plan.scale,
    size_names_by_bucket: Object.fromEntries(
      plan.entries.map(
        item => [
          `QTY_SZ${item.bucket}`,
          item.size_name || null
        ]
      )
    ),
    official_ratio: Object.fromEntries(
      plan.entries.map(
        item => [
          `QTY_SZ${item.bucket}`,
          item.scale_qty
        ]
      )
    ),
    distribution: Object.fromEntries(
      plan.entries.map(
        item => [
          `QTY_SZ${item.bucket}`,
          item.scale_qty * multiplier
        ]
      )
    )
  };

  return true;
}

function applyHeaderFromOfficialLines(
  parsed,
  masters
) {
  const header = parsed.header || {};
  header.raw = header.raw || {};

  const customerCode = upper(header.customer_code);
  const customer = customerCode
    ? masters.customerByCode?.get(customerCode)
    : null;

  if (customer) {
    if (!header.terms_code && clean(customer.Terms)) {
      header.terms_code = clean(customer.Terms);
    }

    if (!header.ship_via_code && clean(customer['Ship Via'])) {
      header.ship_via_code = clean(customer['Ship Via']);
    }

    if (!header.warehouse_code && clean(customer['Def Wh'])) {
      header.warehouse_code = clean(customer['Def Wh']);
    }
  }

  const exactNativeLines = (parsed.lines || []).filter(
    line => (
      line.raw?.universal_official_master_identity
        ?.exact_official_style_color_exists === true
    )
  );

  const divisions = unique(
    exactNativeLines.map(
      line => upper(
        line.master_division_code
        || line.division_code
      )
    )
  );

  const previousDivision = clean(header.division_code) || null;

  if (divisions.length === 1) {
    header.division_code = divisions[0];
    header.raw.universal_official_division_resolution = {
      status: 'APPLIED',
      source: 'VR_SKU_EXACT_RESOLVED_LINE_CONSENSUS',
      previous_division_code: previousDivision,
      resolved_division_code: divisions[0],
      exact_native_line_count: exactNativeLines.length,
      line_divisions: divisions
    };
  } else if (divisions.length > 1) {
    addConflictOnce(parsed, {
      field: 'division_code',
      code: 'multiple_official_line_divisions',
      severity: 'high',
      blocking: true,
      message: 'Resolved native A2000 lines point to multiple official VR_SKU divisions, so one ORDER_HD.DIV_NO cannot be selected safely.',
      official_line_divisions: divisions
    });

    header.raw.universal_official_division_resolution = {
      status: 'BLOCKED',
      source: 'VR_SKU_EXACT_RESOLVED_LINE_CONSENSUS',
      previous_division_code: previousDivision,
      resolved_division_code: null,
      exact_native_line_count: exactNativeLines.length,
      line_divisions: divisions
    };
  } else if (!header.division_code && customer && clean(customer.Div)) {
    header.division_code = clean(customer.Div);
    header.raw.universal_official_division_resolution = {
      status: 'FALLBACK_APPLIED',
      source: 'CUSTOMER_MASTER_DIV',
      previous_division_code: previousDivision,
      resolved_division_code: clean(customer.Div),
      exact_native_line_count: exactNativeLines.length,
      line_divisions: []
    };
  } else {
    header.raw.universal_official_division_resolution = {
      status: 'UNCHANGED',
      source: 'NO_UNIQUE_OFFICIAL_LINE_DIVISION',
      previous_division_code: previousDivision,
      resolved_division_code: clean(header.division_code) || null,
      exact_native_line_count: exactNativeLines.length,
      line_divisions: []
    };
  }

  const warehouses = unique(
    exactNativeLines.map(
      line => upper(line.warehouse_code)
    )
  );

  if (
    !header.warehouse_code
    && warehouses.length === 1
  ) {
    header.warehouse_code = warehouses[0];
  }

  if (
    !header.warehouse_code
    && customer
    && clean(customer['Def Wh'])
  ) {
    header.warehouse_code = clean(customer['Def Wh']);
  }

  for (const line of parsed.lines || []) {
    if (
      !line.warehouse_code
      && header.warehouse_code
    ) {
      line.warehouse_code = header.warehouse_code;
    }
  }
}

function summarizeCandidate(candidate) {
  return {
    style_code: candidate.style_code,
    score: candidate.score,
    core_score: candidate.core_score,
    scope_name: candidate.scope_name,
    scope_bonus: candidate.scope_bonus,
    raw_variant: candidate.relation?.variant
      ? {
          raw: candidate.relation.variant.raw,
          token: candidate.relation.variant.token,
          source: candidate.relation.variant.source
        }
      : candidate.boundary?.variant
        ? {
            raw: candidate.boundary.variant.raw,
            token: candidate.boundary.variant.token,
            source: candidate.boundary.variant.source
          }
        : null,
    boundary_rule: candidate.boundary?.rule || null,
    boundary_remainder: candidate.boundary?.remainder || null,
    boundary_color_code: candidate.boundary?.color_code || null,
    explicit_color_score: candidate.explicit_color?.score || 0,
    explicit_color_source: candidate.explicit_color?.source || null
  };
}

export function getOfficialMasterScopeStats(
  customerCode,
  providedMasters = null
) {
  const masters = providedMasters || loadMasterData();

  if (!masters?.loaded) {
    return {
      customer_code: upper(customerCode),
      master_loaded: false,
      customer_specific_style_count: 0,
      stock_style_count: 0,
      global_style_count: 0
    };
  }

  const plan = scopePlan(masters, customerCode);

  return {
    customer_code: plan.customer_code,
    master_loaded: true,
    customer_specific_style_count: plan.customer_specific_style_count,
    stock_style_count: plan.stock_style_count,
    global_style_count: plan.global_style_count,
    resolution_order: plan.stages.map(stage => stage.name)
  };
}

export function resolveOrderOfficialMasterIdentity(
  parsed,
  providedMasters = null
) {
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }

  const masters = providedMasters || loadMasterData();

  if (!masters?.loaded) {
    return parsed;
  }

  const customerCode = upper(
    parsed.header?.customer_code
  );

  const scopeStats = getOfficialMasterScopeStats(
    customerCode,
    masters
  );

  for (const line of parsed.lines || []) {
    line.raw = line.raw || {};

    const originalStyleCode = clean(line.style_code) || null;
    const originalColorCode = clean(line.color_code) || null;

    const styleResolution = resolveStyle(
      masters,
      line,
      customerCode
    );

    line.style_code = styleResolution.style_code || null;

    const colorResolution = line.style_code
      ? resolveColor(
          masters,
          line,
          styleResolution,
          customerCode
        )
      : {
          color_code: null,
          row_candidates: [],
          source: 'STYLE_UNRESOLVED',
          score: 0,
          margin: null,
          candidates: []
        };

    line.color_code = colorResolution.color_code || null;

    const exactRow = (
      line.style_code
      && line.color_code
    )
      ? exactBusinessRow(
          masters,
          line.style_code,
          line.color_code,
          customerCode
        )
      : {
          row: null,
          candidates: [],
          tuple_count: 0
        };

    const pairEvidence = (
      line.style_code
      && line.color_code
    )
      ? officialPairEvidence(
          masters,
          line.style_code,
          line.color_code,
          customerCode
        )
      : null;

    if (exactRow.row) {
      applyOfficialRow(
        line,
        exactRow.row
      );
    }

    applyOfficialPairEvidence(
      line,
      pairEvidence
    );

    if (
      line.style_code
      && line.color_code
    ) {
      const masterUpc = uniqueMasterUpc(
        masters,
        line.style_code,
        line.color_code
      );

      if (masterUpc.upc) {
        line.master_upc = masterUpc.upc;
      } else {
        const bySize = masterUpcsBySize(
          masters,
          line.style_code,
          line.color_code
        );

        if (bySize.length) {
          line.master_upcs_by_size = bySize;
        }
      }

      if (
        !line.warehouse_code
        && parsed.header?.warehouse_code
      ) {
        line.warehouse_code = parsed.header.warehouse_code;
      }

      applySingleSizeBucket(
        masters,
        line,
        line.style_code,
        line.color_code
      );

      applyOfficialRatio(
        masters,
        line,
        line.style_code,
        line.color_code
      );
    }

    const exactStyleExists = Boolean(
      line.style_code
      && masters.skuByStyle.has(
        upper(line.style_code)
      )
    );

    const exactStyleColorExists = Boolean(
      line.style_code
      && line.color_code
      && (
        masters.skuByStyle.get(
          upper(line.style_code)
        ) || []
      ).some(
        row => upper(row.Clr) === upper(line.color_code)
      )
    );

    line.raw.universal_official_master_identity = {
      policy: 'OFFICIAL_MASTERS_ONLY',
      resolver_version: 'customer_scoped_native_style_v4_6_7',
      status: exactStyleColorExists
        ? 'RESOLVED_TO_NATIVE_A2000_STYLE_COLOR'
        : 'UNRESOLVED_OR_AMBIGUOUS',
      customer_scope: scopeStats,
      original_style_code: originalStyleCode,
      original_color_code: originalColorCode,
      printed_style_raw: clean(line.style_raw) || null,
      printed_color_raw: clean(line.color_raw) || null,
      customer_upc_raw: clean(
        line.customer_upc
        || line.upc
        || line.raw?.customer_upc_raw
        || line.raw_json?.customer_upc_raw
      ) || null,
      style_code: clean(line.style_code) || null,
      color_code: clean(line.color_code) || null,
      style_source: styleResolution.source,
      style_scope: styleResolution.scope_name || null,
      style_score: styleResolution.score,
      style_margin: styleResolution.margin,
      matched_alias_token: styleResolution.matched_alias_token || null,
      matched_alias_source: styleResolution.matched_alias_source || null,
      matched_alias_row_count: (styleResolution.matched_rows || []).length,
      style_candidates: (
        styleResolution.candidates || []
      ).map(summarizeCandidate),
      style_stage_results: (
        styleResolution.stage_results || []
      ).map(stage => ({
        scope_name: stage.scope_name,
        candidate_count: stage.candidate_count,
        best_score: stage.best_score,
        second_score: stage.second_score,
        margin: stage.margin,
        minimum_score: stage.minimum_score,
        minimum_margin: stage.minimum_margin,
        accepted: stage.accepted,
        candidates: stage.candidates.map(summarizeCandidate)
      })),
      color_source: colorResolution.source,
      color_score: colorResolution.score,
      color_margin: colorResolution.margin,
      color_candidates: (
        colorResolution.candidates || []
      ).map(candidate => ({
        color_code: candidate.color_code,
        score: candidate.score,
        text_score: candidate.text_score ?? candidate.score,
        operational_score: candidate.operational_score || 0,
        source: candidate.source,
        operational_rule: candidate.operational?.rule || null,
        operational_scale: candidate.operational?.scale || null,
        operational_ratio_total: candidate.operational?.ratio_total || null,
        operational_compatible: candidate.operational?.compatible === true
      })),
      exact_official_style_exists: exactStyleExists,
      exact_official_style_color_exists: exactStyleColorExists,
      exact_business_tuple_count: exactRow.tuple_count,
      official_pair_evidence: pairEvidence
        ? {
            row_count: pairEvidence.row_count,
            division_values: pairEvidence.division.values,
            warehouse_values: pairEvidence.warehouse.values,
            scale_values: pairEvidence.scale.values,
            sku_values: pairEvidence.sku.values
          }
        : null,
      internal_sku: clean(line.internal_sku) || null,
      scale: clean(line.scale_code) || null,
      division: clean(
        line.master_division_code
        || line.division_code
      ) || null,
      warehouse: clean(line.warehouse_code) || null,
      master_upc: clean(line.master_upc) || null,
      master_upcs_by_size: line.master_upcs_by_size || []
    };
  }

  applyHeaderFromOfficialLines(
    parsed,
    masters
  );

  parsed.raw_enrichment = parsed.raw_enrichment || {};
  parsed.raw_enrichment.universal_official_master_identity = {
    policy: 'OFFICIAL_MASTERS_ONLY',
    resolver_version: 'customer_scoped_native_style_v4_6_7',
    customer_scope: scopeStats,
    line_count: (parsed.lines || []).length,
    native_style_color_count: (
      parsed.lines || []
    ).filter(
      line => (
        line.raw?.universal_official_master_identity
          ?.exact_official_style_color_exists
      )
    ).length
  };

  return parsed;
}

export function validateOrderOfficialMasterIdentity(
  order,
  providedMasters = null
) {
  const masters = providedMasters || loadMasterData();
  const errors = [];

  if (!masters?.loaded) {
    errors.push({
      code: 'OFFICIAL_MASTER_CACHE_NOT_LOADED',
      message: 'Official A2000 master cache is required before REST upload.'
    });

    return {
      valid: false,
      errors
    };
  }

  const customerCode = upper(
    order?.customer_code
    || order?.header?.customer_code
  );

  if (
    !customerCode
    || !masters.customerByCode.has(customerCode)
  ) {
    errors.push({
      code: 'NON_OFFICIAL_A2000_CUSTOMER',
      customer_code: customerCode || null,
      message: 'CUST_NO must exist in official Customer Master.'
    });
  }

  const lines = Array.isArray(order?.purchase_order_lines)
    ? order.purchase_order_lines
    : Array.isArray(order?.lines)
      ? order.lines
      : [];

  const officialLineDivisions = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = Number(line.line_no || index + 1);
    const style = upper(line.style_code);
    const color = upper(line.color_code);

    if (
      !style
      || !masters.skuByStyle.has(style)
    ) {
      errors.push({
        code: 'NON_OFFICIAL_A2000_STYLE',
        line_no: lineNo,
        style_code: style || null,
        style_raw: clean(line.style_raw) || null,
        message: 'ORDER_LI.STYLE is blocked because style_code is not an exact official VR_SKU STYLE.'
      });

      continue;
    }

    const styleRows = masters.skuByStyle.get(style) || [];
    const exactColorRows = styleRows.filter(
      row => upper(row.Clr) === color
    );

    if (
      !color
      || exactColorRows.length === 0
    ) {
      errors.push({
        code: 'NON_OFFICIAL_A2000_STYLE_COLOR',
        line_no: lineNo,
        style_code: style,
        color_code: color || null,
        color_raw: clean(line.color_raw) || null,
        message: 'ORDER_LI.STYLE/COLOR_NO is blocked because the exact pair does not exist in official VR_SKU.'
      });

      continue;
    }

    const evidence = officialPairEvidence(
      masters,
      style,
      color,
      customerCode
    );

    if (evidence.division.value) {
      officialLineDivisions.add(
        upper(evidence.division.value)
      );
    } else if (evidence.division.values.length > 1) {
      errors.push({
        code: 'AMBIGUOUS_OFFICIAL_LINE_DIVISION',
        line_no: lineNo,
        style_code: style,
        color_code: color,
        division_candidates: evidence.division.values,
        message: 'The exact official STYLE/COLOR pair has multiple VR_SKU divisions after customer/stock preference.'
      });
    }

    const lineWarehouse = upper(
      line.warehouse_code
      || order?.warehouse_code
      || order?.header?.warehouse_code
    );

    if (
      lineWarehouse
      && !masters.warehouseByCode.has(lineWarehouse)
    ) {
      errors.push({
        code: 'NON_OFFICIAL_A2000_WAREHOUSE',
        line_no: lineNo,
        warehouse_code: lineWarehouse,
        message: 'ORDER_LI.WHOUSE is not present in the official warehouse master.'
      });
    }
  }

  const headerDivision = upper(
    order?.division_code
    || order?.header?.division_code
  );

  const divisionValues = [...officialLineDivisions];

  if (divisionValues.length > 1) {
    errors.push({
      code: 'MULTIPLE_OFFICIAL_LINE_DIVISIONS',
      division_candidates: divisionValues,
      message: 'Resolved native A2000 lines span multiple official VR_SKU divisions, so one ORDER_HD.DIV_NO cannot be selected safely.'
    });
  }

  if (
    divisionValues.length === 1
    && headerDivision
    && headerDivision !== divisionValues[0]
  ) {
    errors.push({
      code: 'HEADER_DIVISION_NOT_MATCHING_OFFICIAL_LINES',
      header_division_code: headerDivision,
      official_line_division_code: divisionValues[0],
      message: 'ORDER_HD.DIV_NO does not match the unique official VR_SKU division of the resolved lines.'
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    official_line_divisions: divisionValues,
    header_division_code: headerDivision || null
  };
}
