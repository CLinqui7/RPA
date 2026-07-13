function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function positiveNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function intValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function validBucket(value) {
  const parsed = Number.parseInt(clean(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 18
    ? parsed
    : null;
}

function normalizeSize(value) {
  return upper(value).replace(/[^A-Z0-9]/g, '');
}

function lineScaleHint(line = {}) {
  return clean(
    line.scale_code
    || line.raw?.a2000_size_mapping?.scale
    || line.raw?.sku_master?.scale
    || line.raw?.qty_bucket_resolution?.scale
    || line.raw_json?.a2000_size_mapping?.scale
    || line.raw_json?.sku_master?.scale
    || line.raw_json?.qty_bucket_resolution?.scale
  );
}

export function quantitiesByBucket(line = {}) {
  const out = {};

  for (let bucket = 1; bucket <= 18; bucket += 1) {
    const quantity = positiveNumber(line[`qty_sz${bucket}`]);
    if (quantity > 0) out[bucket] = quantity;
  }

  return out;
}

export function hasPositiveSizeDistribution(line = {}) {
  return Object.keys(quantitiesByBucket(line)).length > 0;
}

export function distributionTotal(line = {}) {
  return Object.values(quantitiesByBucket(line))
    .reduce((sum, quantity) => sum + Number(quantity || 0), 0);
}

export function clearQtyBuckets(line = {}) {
  for (let bucket = 1; bucket <= 18; bucket += 1) {
    line[`qty_sz${bucket}`] = null;
  }

  return line;
}

function activeRows(rows = []) {
  const active = rows.filter(
    row => !clean(row.Active) || upper(row.Active) === 'Y'
  );

  return active.length ? active : rows;
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function scaleRowsForLine(masters, line = {}) {
  const style = upper(line.style_code);
  const color = upper(line.color_code);
  if (!style || !color) return [];

  let rows = masters.skuZByStyleColor?.get(`${style}|${color}`) || [];
  rows = activeRows(rows);

  const scaleHint = upper(lineScaleHint(line));
  if (scaleHint) {
    const sameScale = rows.filter(row => upper(row.Scale) === scaleHint);
    if (sameScale.length) rows = sameScale;
  }

  return rows;
}

export function mapExtractedSizeToBucket(line = {}, masters = {}) {
  if (hasPositiveSizeDistribution(line)) {
    return {
      attempted: false,
      applied: false,
      reason: 'existing_positive_qty_distribution_preserved',
      source: null,
      existing_distribution: quantitiesByBucket(line)
    };
  }

  const semantics = upper(
    line.raw?.quantity_semantics
    || line.raw_json?.quantity_semantics
  );

  if (!['EACH', 'ORDERED_UNITS'].includes(semantics)) {
    return {
      attempted: false,
      applied: false,
      reason: 'quantity_semantics_not_safe_for_size_bucket_mapping',
      quantity_semantics: semantics || null
    };
  }

  const style = upper(line.style_code);
  const color = upper(line.color_code);
  const printedSize = clean(line.size_raw || line.size_code);
  const sizeNorm = normalizeSize(printedSize);
  const quantity = positiveNumber(line.qty_total ?? line.quantity);

  if (!style || !color) {
    return {
      attempted: false,
      applied: false,
      reason: 'missing_resolved_style_or_color'
    };
  }

  if (!printedSize || ['-', '.'].includes(printedSize)) {
    return {
      attempted: true,
      applied: false,
      reason: 'missing_meaningful_printed_size',
      printed_size: printedSize || null
    };
  }

  if (!sizeNorm) {
    return {
      attempted: true,
      applied: false,
      reason: 'printed_size_normalizes_empty',
      printed_size: printedSize
    };
  }

  if (!quantity) {
    return {
      attempted: true,
      applied: false,
      reason: 'missing_positive_quantity',
      printed_size: printedSize
    };
  }

  let candidates = masters.skuZByStyleColorSize?.get(
    `${style}|${color}|${sizeNorm}`
  ) || [];

  candidates = activeRows(candidates);

  const scaleHint = upper(lineScaleHint(line));
  if (scaleHint) {
    const sameScale = candidates.filter(row => upper(row.Scale) === scaleHint);
    if (sameScale.length) candidates = sameScale;
  }

  const buckets = uniqueValues(
    candidates
      .map(row => validBucket(row['Size Num']))
      .filter(Boolean)
      .map(String)
  ).map(Number);

  const scales = uniqueValues(
    candidates
      .map(row => clean(row.Scale))
      .filter(Boolean)
  );

  if (!candidates.length) {
    return {
      attempted: true,
      applied: false,
      reason: 'no_exact_vr_sku_z_style_color_size_row',
      source: 'VR_SKU_Z',
      style,
      color,
      printed_size: printedSize,
      size_norm: sizeNorm,
      candidate_count: 0
    };
  }

  if (buckets.length !== 1) {
    return {
      attempted: true,
      applied: false,
      reason: 'ambiguous_vr_sku_z_size_num',
      source: 'VR_SKU_Z',
      style,
      color,
      printed_size: printedSize,
      size_norm: sizeNorm,
      candidate_count: candidates.length,
      candidate_buckets: buckets,
      candidate_scales: scales
    };
  }

  if (scales.length !== 1) {
    return {
      attempted: true,
      applied: false,
      reason: 'ambiguous_vr_sku_z_scale',
      source: 'VR_SKU_Z',
      style,
      color,
      printed_size: printedSize,
      size_norm: sizeNorm,
      candidate_count: candidates.length,
      candidate_buckets: buckets,
      candidate_scales: scales
    };
  }

  const bucket = buckets[0];
  const row = candidates.find(
    candidate => validBucket(candidate['Size Num']) === bucket
  );

  clearQtyBuckets(line);
  line[`qty_sz${bucket}`] = quantity;
  line.size_bucket = bucket;
  line.scale_code = clean(row?.Scale) || line.scale_code || null;
  line.scale_abbr = clean(row?.['Scale Abbr']) || line.scale_abbr || null;

  return {
    attempted: true,
    applied: true,
    reason: 'exact_vr_sku_z_size_name_to_size_num',
    source: 'VR_SKU_Z',
    style,
    color,
    printed_size: printedSize,
    size_norm: sizeNorm,
    bucket,
    quantity,
    size_num: bucket,
    size_name: clean(row?.['Size Name']) || printedSize,
    scale: clean(row?.Scale),
    scale_abbr: clean(row?.['Scale Abbr']),
    scale_qty: intValue(row?.['Scale Qty']),
    scale_pack_qty: intValue(row?.['Scale Pack Qty']),
    pack_qty: intValue(row?.['Pack Qty']),
    division: clean(row?.Div),
    active: clean(row?.Active),
    candidate_count: candidates.length
  };
}

export function scaleRatioFromRows(rows = []) {
  const ratio = {};
  const sizeNames = {};
  const scalePackQtyValues = new Set();
  const packQtyValues = new Set();
  const scales = new Set();
  const divisions = new Set();

  for (const row of rows || []) {
    const bucket = validBucket(row['Size Num']);
    if (!bucket) continue;

    ratio[bucket] = intValue(row['Scale Qty']);
    sizeNames[bucket] = clean(row['Size Name']);

    const scalePack = intValue(row['Scale Pack Qty']);
    const pack = intValue(row['Pack Qty']);

    if (scalePack > 0) scalePackQtyValues.add(scalePack);
    if (pack > 0) packQtyValues.add(pack);
    if (clean(row.Scale)) scales.add(clean(row.Scale));
    if (clean(row.Div)) divisions.add(clean(row.Div));
  }

  return {
    ratio,
    size_names: sizeNames,
    scale_pack_qty_values: [...scalePackQtyValues].sort((a, b) => a - b),
    pack_qty_values: [...packQtyValues].sort((a, b) => a - b),
    scales: [...scales],
    divisions: [...divisions]
  };
}

export function validateDistributionAgainstScaleRows(line = {}, rows = []) {
  const distribution = quantitiesByBucket(line);
  const master = scaleRatioFromRows(rows);
  const errors = [];

  if (!Object.keys(master.ratio).length) {
    errors.push({
      code: 'NO_SCALE_ROWS',
      message: 'No usable VR_SKU_Z Size Num / Scale Qty rows were available.'
    });

    return {
      valid: false,
      errors,
      distribution,
      master,
      pack_multiplier: null
    };
  }

  const positiveRatioBuckets = Object.entries(master.ratio)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([bucket]) => Number(bucket));

  if (!positiveRatioBuckets.length) {
    errors.push({
      code: 'NO_POSITIVE_SCALE_QTY',
      message: 'VR_SKU_Z contains no positive SCALE_QTY values for the selected Style/Color/Scale.'
    });
  }

  const multipliers = [];

  for (let bucket = 1; bucket <= 18; bucket += 1) {
    const orderQty = Number(distribution[bucket] || 0);
    const ratioQty = Number(master.ratio[bucket] || 0);

    if (ratioQty === 0 && orderQty > 0) {
      errors.push({
        code: 'QTY_IN_ZERO_RATIO_BUCKET',
        bucket,
        size_name: master.size_names[bucket] || null,
        order_qty: orderQty,
        scale_qty: ratioQty
      });
      continue;
    }

    if (ratioQty > 0 && orderQty <= 0) {
      errors.push({
        code: 'MISSING_REQUIRED_RATIO_BUCKET',
        bucket,
        size_name: master.size_names[bucket] || null,
        order_qty: orderQty,
        scale_qty: ratioQty
      });
      continue;
    }

    if (ratioQty > 0) {
      const multiplier = orderQty / ratioQty;

      if (!Number.isInteger(multiplier) || multiplier <= 0) {
        errors.push({
          code: 'NON_INTEGER_PACK_MULTIPLIER',
          bucket,
          size_name: master.size_names[bucket] || null,
          order_qty: orderQty,
          scale_qty: ratioQty,
          multiplier
        });
      }

      multipliers.push(Number(multiplier.toFixed(9)));
    }
  }

  const uniqueMultipliers = [...new Set(multipliers)];

  if (uniqueMultipliers.length > 1) {
    errors.push({
      code: 'OUT_OF_RATIO',
      multipliers: uniqueMultipliers
    });
  }

  const ratioTotal = Object.values(master.ratio)
    .reduce((sum, quantity) => sum + Number(quantity || 0), 0);

  const scalePackQty = master.scale_pack_qty_values.length === 1
    ? master.scale_pack_qty_values[0]
    : null;

  if (scalePackQty !== null && ratioTotal !== scalePackQty) {
    errors.push({
      code: 'SCALE_PACK_QTY_MISMATCH',
      ratio_total: ratioTotal,
      scale_pack_qty: scalePackQty
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    distribution,
    master,
    ratio_total: ratioTotal,
    pack_multiplier: uniqueMultipliers.length === 1
      ? uniqueMultipliers[0]
      : null
  };
}

function aggregateKey(line = {}) {
  return [
    upper(line.style_code),
    upper(line.color_code),
    clean(line.sales_price),
    upper(line.warehouse_code),
    upper(lineScaleHint(line))
  ].join('|');
}

export function aggregateCitiSizeRows(lines = [], masters = {}, conflicts = []) {
  const groups = new Map();
  const passthrough = [];

  (lines || []).forEach((line, index) => {
    const mapping = line.raw?.a2000_size_mapping || null;

    if (
      !mapping?.applied
      || mapping.source !== 'VR_SKU_Z'
      || !line.style_code
      || !line.color_code
      || !lineScaleHint(line)
      || !hasPositiveSizeDistribution(line)
    ) {
      passthrough.push({
        original_index: index,
        line
      });
      return;
    }

    const key = aggregateKey(line);

    if (!groups.has(key)) {
      const base = {
        ...line,
        customer_sku: null,
        ticket_sku: null,
        customer_upc: null,
        master_upc: null,
        size_raw: null,
        size_code: null,
        qty_total: 0,
        raw: {
          ...(line.raw || {}),
          a2000_size_aggregation: {
            applied: true,
            source: 'cititrends_per_size_rows_vr_sku_z',
            key,
            source_rows: []
          }
        }
      };

      clearQtyBuckets(base);

      groups.set(key, {
        original_index: index,
        line: base
      });
    }

    const group = groups.get(key).line;

    for (let bucket = 1; bucket <= 18; bucket += 1) {
      const quantity = positiveNumber(line[`qty_sz${bucket}`]);
      if (!quantity) continue;

      group[`qty_sz${bucket}`] = (
        positiveNumber(group[`qty_sz${bucket}`])
        + quantity
      );
    }

    group.qty_total = distributionTotal(group);

    group.raw.a2000_size_aggregation.source_rows.push({
      line_no: line.line_no ?? null,
      customer_sku: line.customer_sku ?? null,
      customer_upc: line.customer_upc ?? line.ticket_sku ?? null,
      master_upc: line.master_upc ?? null,
      size_raw: line.size_raw ?? line.size_code ?? null,
      size_bucket: line.size_bucket ?? null,
      qty_total: line.qty_total ?? null,
      mapping: line.raw?.a2000_size_mapping || null
    });
  });

  const aggregated = [
    ...groups.values(),
    ...passthrough
  ]
    .sort((left, right) => left.original_index - right.original_index)
    .map(item => item.line);

  for (const line of aggregated) {
    if (!line.raw?.a2000_size_aggregation?.applied) continue;

    const rows = scaleRowsForLine(masters, line);
    const validation = validateDistributionAgainstScaleRows(line, rows);

    line.raw = {
      ...(line.raw || {}),
      a2000_scale_validation: {
        source: 'VR_SKU_Z_compact_master',
        ...validation
      }
    };

    if (!validation.valid) {
      conflicts.push({
        field: 'size_ratio',
        code: 'a2000_scale_ratio_mismatch',
        severity: 'high',
        blocking: true,
        line_no: line.line_no ?? null,
        style_code: line.style_code || null,
        color_code: line.color_code || null,
        message: 'Mapped Citi size distribution does not match the official VR_SKU_Z SCALE_QTY ratio.',
        errors: validation.errors
      });
    }
  }

  return aggregated.map((line, index) => ({
    ...line,
    line_no: index + 1,
    qty_total: hasPositiveSizeDistribution(line)
      ? distributionTotal(line)
      : line.qty_total
  }));
}
