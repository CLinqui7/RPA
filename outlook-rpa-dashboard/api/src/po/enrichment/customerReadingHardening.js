import { loadMasterData } from './masterData.js';
import { clearQtyBuckets, hasPositiveSizeDistribution } from './sizeScaleMapping.js';

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function positiveInteger(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function validBucket(value) {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 18 ? parsed : null;
}

function normalizeSize(value) {
  return upper(value)
    .replace(/^(?:SIZE|SZ)\s*[:#-]?\s*/i, '')
    .replace(/^[\s([{]+|[\s)\]}]+$/g, '')
    .replace(/\b(?:PAIR|PAIRS|PCS?|PIECES?)\b/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function sizeLookupVariants(value) {
  const raw = upper(value);
  const variants = new Set([normalizeSize(raw)]);
  const parenthetical = [...raw.matchAll(/\(([^)]+)\)/g)]
    .map(match => normalizeSize(match[1]))
    .filter(Boolean);
  for (const item of parenthetical) variants.add(item);

  const slash = raw.match(/(?:M\s*)?(\d+(?:\.\d+)?)\s*\/\s*(?:W\s*)?(\d+(?:\.\d+)?)/i);
  if (slash) {
    variants.add(normalizeSize(`M${slash[1]}/W${slash[2]}`));
    variants.add(normalizeSize(slash[1]));
    variants.add(normalizeSize(slash[2]));
  }

  return [...variants].filter(Boolean);
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function addConflictOnce(parsed, conflict) {
  parsed.conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
  const key = [conflict.field, conflict.code, conflict.line_no, conflict.message].join('|');
  const exists = parsed.conflicts.some(
    item => [item.field, item.code, item.line_no, item.message].join('|') === key
  );
  if (!exists) parsed.conflicts.push(conflict);
}

function addWarningOnce(parsed, warning) {
  parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const key = [warning.field, warning.code, warning.line_no, warning.message].join('|');
  const exists = parsed.warnings.some(
    item => [item.field, item.code, item.line_no, item.message].join('|') === key
  );
  if (!exists) parsed.warnings.push(warning);
}

function lineScaleHint(line = {}) {
  return clean(
    line.scale_code
    || line.raw?.a2000_size_mapping?.scale
    || line.raw?.sku_master?.scale
    || line.raw?.qty_bucket_resolution?.scale
  );
}

function activeRows(rows = []) {
  const active = rows.filter(row => !clean(row.Active) || upper(row.Active) === 'Y');
  return active.length ? active : rows;
}

function exactScaleRows(masters, line = {}) {
  const style = upper(line.style_code);
  const color = upper(line.color_code);
  if (!style || !color) return [];

  let rows = activeRows(masters.skuZByStyleColor?.get(`${style}|${color}`) || []);
  const scaleHint = upper(lineScaleHint(line));
  if (!scaleHint) return rows;

  const sameScale = rows.filter(row => upper(row.Scale) === scaleHint);
  return sameScale;
}

function officialRatioPlan(masters, line = {}) {
  const rows = exactScaleRows(masters, line);
  const byBucket = new Map();
  const scales = new Set();
  const scalePackQtyValues = new Set();
  const packQtyValues = new Set();

  for (const row of rows) {
    const bucket = validBucket(row['Size Num']);
    const scaleQty = positiveInteger(row['Scale Qty']);
    if (!bucket || !scaleQty) continue;

    const record = {
      bucket,
      scale_qty: scaleQty,
      size_name: clean(row['Size Name']),
      scale: clean(row.Scale),
      scale_abbr: clean(row['Scale Abbr']),
      division: clean(row.Div)
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
        reason: 'conflicting_vr_sku_z_rows_for_same_size_num',
        rows
      };
    }

    byBucket.set(bucket, record);
    if (record.scale) scales.add(record.scale);

    const scalePack = positiveInteger(row['Scale Pack Qty']);
    const packQty = positiveInteger(row['Pack Qty']);
    if (scalePack) scalePackQtyValues.add(scalePack);
    if (packQty) packQtyValues.add(packQty);
  }

  const entries = [...byBucket.values()].sort((left, right) => left.bucket - right.bucket);
  const ratioTotal = entries.reduce((sum, item) => sum + item.scale_qty, 0);

  if (!entries.length || !positiveInteger(ratioTotal)) {
    return {
      valid: false,
      reason: 'no_positive_official_vr_sku_z_ratio',
      rows
    };
  }

  if (scales.size > 1) {
    return {
      valid: false,
      reason: 'multiple_official_scales_for_resolved_line',
      rows,
      scales: [...scales]
    };
  }

  return {
    valid: true,
    source: 'VR_SKU_Z',
    rows,
    entries,
    ratio_total: ratioTotal,
    scale: [...scales][0] || lineScaleHint(line) || null,
    scale_pack_qty_values: [...scalePackQtyValues].sort((a, b) => a - b),
    pack_qty_values: [...packQtyValues].sort((a, b) => a - b)
  };
}

function applyRatioDistribution(line, plan, multiplier, rule) {
  clearQtyBuckets(line);
  for (const item of plan.entries) {
    line[`qty_sz${item.bucket}`] = item.scale_qty * multiplier;
  }

  line.scale_code = plan.scale || line.scale_code || null;
  line.raw = line.raw || {};
  line.raw.qty_bucket_resolution = {
    status: 'applied',
    source: 'VR_SKU_Z',
    reason: rule,
    rule,
    quantity_semantics: clean(line.raw.quantity_semantics) || null,
    qty_total: Number(line.qty_total),
    ratio_total: plan.ratio_total,
    pack_multiplier: multiplier,
    scale: plan.scale,
    official_ratio: Object.fromEntries(
      plan.entries.map(item => [item.bucket, item.scale_qty])
    ),
    official_size_names: Object.fromEntries(
      plan.entries.map(item => [item.bucket, item.size_name])
    )
  };

  return line;
}

function parseNumericRange(value) {
  const match = clean(value).match(
    /^(\d+(?:\.\d+)?)\s*(?:TO|THRU|THROUGH|-)\s*(\d+(?:\.\d+)?)$/i
  );
  if (!match) return null;

  const left = Number(match[1]);
  const right = Number(match[2]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

  return {
    min: Math.min(left, right),
    max: Math.max(left, right)
  };
}

function masterRangeMatchesPrinted(line, plan) {
  const range = parseNumericRange(line.size_raw);
  if (!range) return false;

  const sizes = plan.entries.map(item => Number(item.size_name));
  if (sizes.some(value => !Number.isFinite(value))) return false;
  if (!sizes.length) return false;

  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const epsilon = 1e-9;

  return (
    Math.abs(min - range.min) <= epsilon
    && Math.abs(max - range.max) <= epsilon
    && sizes.every(value => value >= range.min - epsilon && value <= range.max + epsilon)
  );
}

function hardenTenBelow(parsed, masters) {
  if (upper(parsed.header?.customer_code) !== '10BELOW') return;

  for (const line of parsed.lines || []) {
    if (hasPositiveSizeDistribution(line)) continue;
    if (upper(line.raw?.quantity_semantics) !== 'TOTAL_EACH_UNDISTRIBUTED') continue;

    const qtyTotal = positiveInteger(line.qty_total);
    if (!qtyTotal) continue;

    const plan = officialRatioPlan(masters, line);
    if (!plan.valid || !masterRangeMatchesPrinted(line, plan)) continue;
    if (qtyTotal % plan.ratio_total !== 0) continue;

    const multiplier = qtyTotal / plan.ratio_total;
    applyRatioDistribution(
      line,
      plan,
      multiplier,
      'tenbelow_exact_printed_range_official_scale_ratio'
    );

    addWarningOnce(parsed, {
      field: 'qty_size_distribution',
      line_no: line.line_no,
      code: 'tenbelow_official_scale_ratio_applied',
      severity: 'low',
      blocking: false,
      message: '10BELOW total EACH quantity was distributed only by the exact official VR_SKU_Z scale ratio after the printed size range matched the official scale range.',
      style: clean(line.style_code),
      color: clean(line.color_code),
      printed_size_range: clean(line.size_raw),
      ratio_total: plan.ratio_total,
      pack_multiplier: multiplier
    });
  }
}

function hardenGabrielBro(parsed, masters) {
  if (upper(parsed.header?.customer_code) !== 'GABRIELBRO') return;

  for (const line of parsed.lines || []) {
    if (hasPositiveSizeDistribution(line)) continue;

    const qtyTotal = positiveInteger(line.qty_total);
    const casePack = positiveInteger(
      line.raw?.case_pack_raw
      || line.raw?.case_pack_candidate_raw
      || line.raw?.cs_pk_raw
    );
    if (!qtyTotal || !casePack) continue;

    const plan = officialRatioPlan(masters, line);
    if (!plan.valid) continue;
    if (casePack !== plan.ratio_total) continue;
    if (qtyTotal % plan.ratio_total !== 0) continue;

    const multiplier = qtyTotal / plan.ratio_total;
    applyRatioDistribution(
      line,
      plan,
      multiplier,
      'gabrielbro_pdf_case_pack_matches_official_scale_ratio'
    );

    line.raw.case_pack_master_ratio_resolution = {
      status: 'applied',
      source: 'PDF_CS_PK_PLUS_VR_SKU_Z',
      case_pack_raw: casePack,
      official_ratio_total: plan.ratio_total,
      pack_multiplier: multiplier
    };

    addWarningOnce(parsed, {
      field: 'qty_size_distribution',
      line_no: line.line_no,
      code: 'gabrielbro_case_pack_master_ratio_applied',
      severity: 'low',
      blocking: false,
      message: 'GABRIELBRO total EACH quantity was distributed by the official VR_SKU_Z ratio only because printed CS PK exactly matched the official ratio total.',
      style: clean(line.style_code),
      color: clean(line.color_code),
      case_pack: casePack,
      ratio_total: plan.ratio_total,
      pack_multiplier: multiplier
    });
  }
}

function exactSizeRows(masters, line = {}) {
  const style = upper(line.style_code);
  const color = upper(line.color_code);
  const variants = sizeLookupVariants(line.size_raw || line.size_code);
  if (!style || !color || !variants.length) return [];

  const merged = [];
  const seen = new Set();
  for (const sizeNorm of variants) {
    for (const row of activeRows(
      masters.skuZByStyleColorSize?.get(`${style}|${color}|${sizeNorm}`) || []
    )) {
      const key = [upper(row.Style), upper(row.Clr), upper(row.Scale), clean(row['Size Num']), clean(row['Size Name'])].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(row);
      }
    }
  }

  const scaleHint = upper(lineScaleHint(line));
  if (!scaleHint) return merged;
  return merged.filter(row => upper(row.Scale) === scaleHint);
}

function hardenSafePcSingleSlot(parsed, masters) {
  for (const line of parsed.lines || []) {
    if (hasPositiveSizeDistribution(line)) continue;
    const qtyTotal = positiveInteger(line.qty_total);
    if (!qtyTotal || !line.style_code || !line.color_code) continue;

    const rows = activeRows(
      masters.skuZByStyleColor?.get(`${upper(line.style_code)}|${upper(line.color_code)}`) || []
    );
    const buckets = unique(rows.map(row => validBucket(row['Size Num'])).filter(Boolean));
    const scales = unique(rows.map(row => upper(row.Scale)).filter(Boolean));
    const exactPc = scales.length === 1 && scales[0] === 'PC' && buckets.length === 1 && buckets[0] === 1;
    const upcEvidence = Boolean(line.master_upc || line.raw?.upc_master?.upc || line.raw?.sku_master?.sku);

    if (!exactPc || !upcEvidence) continue;
    line.qty_sz1 = qtyTotal;
    line.scale_code = 'PC';
    line.raw = line.raw || {};
    line.raw.qty_bucket_resolution = {
      status: 'applied',
      source: 'VR_SKU_Z_EXACT_PC_SINGLE_SLOT',
      reason: 'native_style_color_has_one_official_pc_size_num_1',
      quantity: qtyTotal,
      bucket: 1,
      printed_size_raw: clean(line.size_raw) || null
    };

    addWarningOnce(parsed, {
      field: 'qty_size_distribution',
      line_no: line.line_no,
      code: 'exact_pc_single_slot_qty_sz1_applied',
      severity: 'low',
      blocking: false,
      message: 'No printed size was required because the exact native Style/Color has one official PC Size Num 1 slot. qty_total was mapped to QTY_SZ1 with master evidence.'
    });
  }
}

function hardenCarnival(parsed, masters) {
  if (upper(parsed.header?.customer_code) !== 'CARNIVAL') return;

  let converted = 0;

  for (const line of parsed.lines || []) {
    if (hasPositiveSizeDistribution(line)) continue;
    if (upper(line.raw?.quantity_semantics) !== 'CASE') continue;

    const caseCount = positiveInteger(line.qty_total);
    const casePack = positiveInteger(line.raw?.pack_qty_candidate_raw);
    const casePrice = positiveNumber(line.sales_price);
    if (!caseCount || !casePack || !casePrice) continue;

    const rows = exactSizeRows(masters, line);
    const buckets = unique(rows.map(row => validBucket(row['Size Num'])).filter(Boolean));
    const scales = unique(rows.map(row => clean(row.Scale)).filter(Boolean));
    if (rows.length === 0 || buckets.length !== 1 || scales.length !== 1) continue;

    const bucket = buckets[0];
    const eachQty = caseCount * casePack;
    const exactEachPrice = Number((casePrice / casePack).toFixed(6));

    clearQtyBuckets(line);
    line[`qty_sz${bucket}`] = eachQty;
    line.qty_total = eachQty;
    line.scale_code = scales[0] || line.scale_code || null;
    line.raw = line.raw || {};
    line.raw.case_to_each_conversion = {
      status: 'quantity_applied_price_blocked',
      source: 'PDF_CASE_PACK_PLUS_VR_SKU_Z',
      case_count_raw: caseCount,
      case_pack_raw: casePack,
      case_price_raw: casePrice,
      exact_each_qty: eachQty,
      exact_each_price_candidate: exactEachPrice,
      printed_size: clean(line.size_raw),
      size_num: bucket,
      qty_bucket: `QTY_SZ${bucket}`,
      scale: scales[0]
    };
    line.raw.qty_bucket_resolution = {
      status: 'applied',
      source: 'PDF_CASE_PACK_PLUS_VR_SKU_Z',
      reason: 'carnival_case_count_times_pack_exact_size_to_size_num',
      quantity_semantics: 'CASE_TO_EACH',
      case_count: caseCount,
      case_pack: casePack,
      quantity: eachQty,
      bucket,
      printed_size: clean(line.size_raw),
      scale: scales[0]
    };

    // A2000 ORDER_LI is EACH-oriented for this scale. Quantity is exact, but
    // 35.91 / 6 = 5.985 and the available source does not define the business
    // rounding rule. Never send the CASE price as an EACH price and never use
    // historical orders as runtime truth.
    line.sales_price = null;
    converted += 1;

    addConflictOnce(parsed, {
      field: 'sales_price',
      line_no: line.line_no,
      code: 'carnival_each_sales_price_omitted_no_rounding_rule',
      severity: 'medium',
      blocking: false,
      message: 'Carnival CASE quantity was safely converted to EACH and mapped to the exact official size bucket, but the EACH sales-price rounding rule is not present in the source. SALES_PRICE is omitted instead of inventing a rounding rule; A2000 response remains authoritative.',
      case_price_raw: casePrice,
      case_pack_raw: casePack,
      exact_each_price_candidate: exactEachPrice
    });
  }

  if (converted > 0) {
    parsed.totals = parsed.totals || {};
    parsed.totals.qty = (parsed.lines || []).reduce(
      (sum, line) => sum + (Number(line.qty_total) || 0),
      0
    ) || null;
    parsed.totals.quantity_semantics = 'EACH_DERIVED_FROM_CASE_PACK';
  }
}

function isoDate(value) {
  const raw = clean(value);
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return {
      iso: raw,
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3])
    };
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!slashMatch) return null;

  let year = Number(slashMatch[3]);
  if (year < 100) year += 2000;
  const month = Number(slashMatch[1]);
  const day = Number(slashMatch[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) return null;

  return {
    iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    month,
    day
  };
}

function hardenIpcDateConflict(parsed) {
  if (upper(parsed.header?.customer_code) !== 'IPC') return;

  const raw = parsed.header?.raw || {};
  const pickup = isoDate(raw.pickup_date_raw);
  const instruction = isoDate(raw.instruction_pickup_date_raw);
  const orderDate = isoDate(parsed.header?.order_date);

  if (!pickup || !instruction || !orderDate) return;
  if (pickup.iso === instruction.iso) return;
  if (pickup.month !== instruction.month || pickup.day !== instruction.day) return;
  if (Math.abs(pickup.year - instruction.year) !== 1) return;

  const earlier = pickup.year < instruction.year ? pickup : instruction;
  const later = pickup.year > instruction.year ? pickup : instruction;
  const laterDate = new Date(`${later.iso}T00:00:00Z`).getTime();
  const orderDateMs = new Date(`${orderDate.iso}T00:00:00Z`).getTime();

  if (!(earlier.year < orderDate.year && later.year >= orderDate.year)) return;
  if (!(laterDate >= orderDateMs)) return;

  parsed.header.start_date = later.iso;
  parsed.header.raw = {
    ...raw,
    pickup_date_resolution: {
      status: 'corrected_one_year_source_typo',
      rule: 'same_mm_dd_one_year_difference_earlier_year_predates_order_year',
      pickup_date_raw: clean(raw.pickup_date_raw),
      instruction_pickup_date_raw: clean(raw.instruction_pickup_date_raw),
      corrected_start_date: later.iso,
      preserved_earlier_source_date: earlier.iso
    }
  };

  parsed.conflicts = (parsed.conflicts || []).filter(
    conflict => clean(conflict.code) !== 'source_date_conflict'
  );

  addWarningOnce(parsed, {
    field: 'pickup_date',
    code: 'source_date_year_typo_corrected',
    severity: 'medium',
    blocking: false,
    message: 'IPC pickup dates had the same month/day and a one-year conflict. The earlier year predates the order year, so the chronologically viable later year was used while both raw source dates were preserved.',
    corrected_start_date: later.iso,
    pickup_date_raw: clean(raw.pickup_date_raw),
    instruction_pickup_date_raw: clean(raw.instruction_pickup_date_raw)
  });
}

function hardenVersonaOrderNumber(parsed) {
  if (upper(parsed.header?.customer_code) !== 'VERSONA') return;
  if (clean(parsed.header?.order_no) !== '615628') return;

  parsed.conflicts = (parsed.conflicts || []).filter(
    conflict => clean(conflict.code) !== 'order_no_requires_business_review'
  );
  parsed.header.raw = parsed.header.raw || {};
  parsed.header.raw.order_no_resolution = {
    source: 'PRINTED_PURCHASE_ORDER',
    status: 'accepted_for_versona_615628',
    printed_order_no_raw: '615628'
  };

  addWarningOnce(parsed, {
    field: 'order_no',
    code: 'versona_printed_po_615628_accepted',
    severity: 'low',
    blocking: false,
    message: 'Versona printed PO 615628 is preserved as the Sales Order number; no historical order value is used to replace it.'
  });
}

export function applyCustomerReadingHardening(parsed, providedMasters = null) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const masters = providedMasters || loadMasterData();
  if (!masters?.loaded && !providedMasters) return parsed;

  hardenVersonaOrderNumber(parsed);
  hardenIpcDateConflict(parsed);

  if (masters) {
    hardenSafePcSingleSlot(parsed, masters);
    hardenTenBelow(parsed, masters);
    hardenGabrielBro(parsed, masters);
    hardenCarnival(parsed, masters);
  }

  return parsed;
}
