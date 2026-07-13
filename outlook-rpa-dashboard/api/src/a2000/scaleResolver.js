import { quantitiesByBucket } from './restMapper.js';

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function intValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function escaped(value) {
  return String(value).replaceAll("'", "''");
}

function normalizeSize(value) {
  return clean(value)
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function expectedScaleFromLine(line = {}) {
  return clean(
    line.scale_code
    || line.raw?.a2000_size_mapping?.scale
    || line.raw?.a2000_scale_validation?.master?.scales?.[0]
    || line.raw?.sku_master?.scale
    || line.raw?.qty_bucket_resolution?.scale
    || line.raw_json?.a2000_size_mapping?.scale
    || line.raw_json?.a2000_scale_validation?.master?.scales?.[0]
    || line.raw_json?.sku_master?.scale
    || line.raw_json?.qty_bucket_resolution?.scale
  );
}

function printedSizeFromLine(line = {}) {
  return clean(
    line.size_raw
    || line.raw?.size_raw
    || line.raw_json?.size_raw
  );
}

function scaleDefinition(rows = []) {
  const ratio = {};
  const sizeNames = {};
  const divisions = new Set();
  const scales = new Set();
  const scalePackQty = new Set();

  for (const row of rows) {
    const bucket = intValue(row.SIZE_NUM);
    if (bucket < 1 || bucket > 18) continue;

    ratio[bucket] = intValue(row.SCALE_QTY);
    sizeNames[bucket] = clean(row.SIZE_NAME);

    if (clean(row.DIV)) divisions.add(clean(row.DIV));
    if (clean(row.SCALE)) scales.add(clean(row.SCALE));

    const pack = intValue(row.SCALE_PACK_QTY);
    if (pack > 0) scalePackQty.add(pack);
  }

  return {
    ratio,
    size_names: sizeNames,
    divisions: [...divisions],
    scales: [...scales],
    scale_pack_qty_values: [...scalePackQty].sort((a, b) => a - b)
  };
}

function ratioTotal(definition) {
  return Object.values(definition.ratio)
    .reduce((sum, quantity) => sum + Number(quantity || 0), 0);
}

function divisionErrors(definition, orderDivision) {
  if (
    clean(orderDivision)
    && definition.divisions.length
    && !definition.divisions.includes(clean(orderDivision))
  ) {
    return [{
      code: 'WRONG_DIVISION_FOR_STYLE',
      order_division: clean(orderDivision),
      master_divisions: definition.divisions
    }];
  }

  return [];
}

function definitionIntegrityErrors(definition) {
  const total = ratioTotal(definition);

  if (
    definition.scale_pack_qty_values.length === 1
    && definition.scale_pack_qty_values[0] !== total
  ) {
    return [{
      code: 'SCALE_PACK_QTY_MISMATCH',
      ratio_total: total,
      scale_pack_qty: definition.scale_pack_qty_values[0]
    }];
  }

  return [];
}

function exactPrintedSizeSlotValidation(line, definition, orderDivision) {
  const distribution = quantitiesByBucket(line);
  const positive = Object.entries(distribution)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([bucket, quantity]) => [Number(bucket), Number(quantity)]);

  if (positive.length !== 1) return null;

  const printedSize = normalizeSize(printedSizeFromLine(line));
  if (!printedSize) return null;

  const [bucket, quantity] = positive[0];
  const masterSize = normalizeSize(definition.size_names[bucket]);

  if (!masterSize || masterSize !== printedSize) return null;

  const errors = [
    ...divisionErrors(definition, orderDivision),
    ...definitionIntegrityErrors(definition)
  ];

  return {
    valid: errors.length === 0,
    errors,
    distribution,
    definition,
    ratio_total: ratioTotal(definition),
    pack_multiplier: null,
    exact_size_slot: {
      printed_size: printedSize,
      bucket,
      master_size_name: definition.size_names[bucket],
      order_qty: quantity
    }
  };
}

function masterUpcsBySizeValidation(line, definition, orderDivision, expectedScale) {
  const distribution = quantitiesByBucket(line);
  const positive = Object.entries(distribution)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([bucket, quantity]) => [Number(bucket), Number(quantity)]);

  if (positive.length < 2) return null;

  const evidence = Array.isArray(line.master_upcs_by_size)
    ? line.master_upcs_by_size
    : Array.isArray(line.raw?.master_upcs_by_size)
      ? line.raw.master_upcs_by_size
      : Array.isArray(line.raw_json?.master_upcs_by_size)
        ? line.raw_json.master_upcs_by_size
        : [];

  const evidenceMeta = line.raw?.upc_master_by_size
    || line.raw_json?.upc_master_by_size
    || {};

  if (
    clean(evidenceMeta.source) !== 'VR_UPC_STYLE_EXACT_PRINTED_SIZE_GRID'
    || clean(evidenceMeta.reason) !== 'all_printed_sizes_unique_master_upc'
  ) {
    return null;
  }

  if (evidence.length !== positive.length) return null;

  const evidenceByBucket = new Map();

  for (const item of evidence) {
    const bucket = intValue(item.size_num);
    const qty = Number(item.qty_raw);
    const upc = clean(item.upc);
    const scale = clean(item.scale);

    if (bucket < 1 || bucket > 18 || !Number.isFinite(qty) || qty <= 0 || !upc) {
      return null;
    }

    if (
      expectedScale
      && scale
      && scale.toUpperCase() !== expectedScale.toUpperCase()
    ) {
      return null;
    }

    if (evidenceByBucket.has(bucket)) return null;
    evidenceByBucket.set(bucket, { qty, upc, scale, size_raw: item.size_raw ?? null });
  }

  for (const [bucket, quantity] of positive) {
    const item = evidenceByBucket.get(bucket);
    if (!item || Math.abs(item.qty - quantity) > 0.000001) return null;
  }

  const errors = [
    ...divisionErrors(definition, orderDivision),
    ...definitionIntegrityErrors(definition)
  ];

  return {
    valid: errors.length === 0,
    errors,
    distribution,
    definition,
    ratio_total: ratioTotal(definition),
    pack_multiplier: null,
    exact_master_upcs_by_size: [...evidenceByBucket.entries()].map(([bucket, item]) => ({
      bucket,
      ...item
    }))
  };
}

function pcSingleBucketMasterFallback(line, expectedScale) {
  const distribution = quantitiesByBucket(line);
  const positive = Object.entries(distribution)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([bucket, quantity]) => [Number(bucket), Number(quantity)]);

  if (clean(expectedScale).toUpperCase() !== 'PC') return null;
  if (positive.length !== 1 || positive[0][0] !== 1) return null;

  const printedSize = normalizeSize(printedSizeFromLine(line));
  const allowedSingleSizes = new Set([
    'ONESZ',
    'ONE SIZE',
    'ONE-SIZE',
    'OS',
    'OSFA',
    'ALL',
    'PC'
  ]);

  if (!allowedSingleSizes.has(printedSize)) return null;

  const masterUpc = clean(line.master_upc || line.raw?.master_upc || line.raw_json?.master_upc);
  const source = clean(
    line.master_upc_source
    || line.raw?.master_upc_source
    || line.raw_json?.master_upc_source
  );

  if (!masterUpc || !source.startsWith('VR_UPC_STYLE_')) return null;

  return {
    valid: true,
    errors: [],
    distribution,
    definition: {
      ratio: { 1: 1 },
      size_names: { 1: printedSize },
      divisions: [],
      scales: ['PC'],
      scale_pack_qty_values: [1]
    },
    ratio_total: 1,
    pack_multiplier: positive[0][1],
    official_master_pc_fallback: {
      master_upc: masterUpc,
      master_upc_source: source,
      printed_size: printedSize,
      bucket: 1,
      order_qty: positive[0][1]
    }
  };
}

function validateDistribution(line, definition, orderDivision) {
  const distribution = quantitiesByBucket(line);
  const errors = [];
  const multipliers = [];

  const ratioBuckets = Object.entries(definition.ratio)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([bucket]) => Number(bucket));

  if (!ratioBuckets.length) {
    errors.push({
      code: 'NO_POSITIVE_SCALE_QTY',
      message: 'Live VR_SKU_Z contains no positive SCALE_QTY values for this Style/Color/Scale. The REST adapter will not invent a ratio.'
    });
  }

  for (let bucket = 1; bucket <= 18; bucket += 1) {
    const orderQty = Number(distribution[bucket] || 0);
    const ratioQty = Number(definition.ratio[bucket] || 0);

    if (ratioQty === 0 && orderQty > 0) {
      errors.push({
        code: 'QTY_IN_ZERO_RATIO_BUCKET',
        bucket,
        size_name: definition.size_names[bucket] || null,
        order_qty: orderQty,
        scale_qty: ratioQty
      });
      continue;
    }

    if (ratioQty > 0 && orderQty <= 0) {
      errors.push({
        code: 'MISSING_REQUIRED_RATIO_BUCKET',
        bucket,
        size_name: definition.size_names[bucket] || null,
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

  errors.push(...divisionErrors(definition, orderDivision));
  errors.push(...definitionIntegrityErrors(definition));

  return {
    valid: errors.length === 0,
    errors,
    distribution,
    definition,
    ratio_total: ratioTotal(definition),
    pack_multiplier: uniqueMultipliers.length === 1
      ? uniqueMultipliers[0]
      : null
  };
}

export class A2000ScaleResolver {
  constructor(client) {
    this.client = client;
    this.cache = new Map();
  }

  async rowsFor(styleCode, colorCode) {
    const style = clean(styleCode).toUpperCase();
    const color = clean(colorCode).toUpperCase();
    const key = `${style}|${color}`;

    if (this.cache.has(key)) return this.cache.get(key);

    const result = await this.client.viewer('VR_SKU_Z', {
      columns: [
        'STYLE',
        'CLR',
        'SKU',
        'SCALE',
        'SCALE_ABBR',
        'SIZE_NUM',
        'SIZE_NAME',
        'SCALE_QTY',
        'SCALE_PACK_QTY',
        'PACK_QTY',
        'DIV',
        'SKU_ACTIVE'
      ],
      filter: (
        `STYLE = '${escaped(style)}' `
        + `AND CLR = '${escaped(color)}'`
      ),
      sort: 'SIZE_NUM'
    });

    if (result.httpStatus !== 200) {
      throw new Error(
        `VR_SKU_Z lookup failed for ${style}/${color}. HTTP ${result.httpStatus}`
      );
    }

    this.cache.set(key, result.rows);
    return result.rows;
  }

  async validateLine(order, line, index) {
    const rows = await this.rowsFor(
      line.style_code,
      line.color_code
    );

    const expectedScale = expectedScaleFromLine(line);

    const activeRows = rows.filter(
      row => (
        !clean(row.SKU_ACTIVE)
        || clean(row.SKU_ACTIVE).toUpperCase() === 'Y'
      )
    );

    const pool = activeRows.length ? activeRows : rows;

    const sameScale = expectedScale
      ? pool.filter(
        row => (
          clean(row.SCALE).toUpperCase()
          === expectedScale.toUpperCase()
        )
      )
      : pool;

    const selected = sameScale.length ? sameScale : pool;

    const scaleValues = [
      ...new Set(
        selected
          .map(row => clean(row.SCALE))
          .filter(Boolean)
      )
    ];

    if (!selected.length) {
      const fallback = pcSingleBucketMasterFallback(line, expectedScale);

      if (fallback) {
        return {
          line_no: line.line_no ?? index + 1,
          style_code: line.style_code,
          color_code: line.color_code,
          expected_scale: expectedScale || null,
          selected_scales: ['PC'],
          source: 'OFFICIAL_MASTER_UPC_PC_SINGLE_BUCKET_FALLBACK',
          ...fallback
        };
      }

      return {
        valid: false,
        line_no: line.line_no ?? index + 1,
        style_code: line.style_code,
        color_code: line.color_code,
        errors: [{
          code: 'STYLE_COLOR_NOT_IN_VR_SKU_Z',
          message: 'No live VR_SKU_Z rows were found.'
        }]
      };
    }

    if (expectedScale && !sameScale.length) {
      return {
        valid: false,
        line_no: line.line_no ?? index + 1,
        style_code: line.style_code,
        color_code: line.color_code,
        expected_scale: expectedScale,
        errors: [{
          code: 'EXPECTED_SCALE_NOT_IN_LIVE_VR_SKU_Z',
          expected_scale: expectedScale,
          available_scales: [
            ...new Set(
              pool.map(row => clean(row.SCALE)).filter(Boolean)
            )
          ]
        }]
      };
    }

    if (!expectedScale && scaleValues.length > 1) {
      return {
        valid: false,
        line_no: line.line_no ?? index + 1,
        style_code: line.style_code,
        color_code: line.color_code,
        errors: [{
          code: 'AMBIGUOUS_SCALE',
          scales: scaleValues
        }]
      };
    }

    const definition = scaleDefinition(selected);

    const exactSize = exactPrintedSizeSlotValidation(
      line,
      definition,
      order.division_code
    );

    if (exactSize) {
      return {
        line_no: line.line_no ?? index + 1,
        style_code: line.style_code,
        color_code: line.color_code,
        expected_scale: expectedScale || null,
        selected_scales: definition.scales,
        source: 'LIVE_VR_SKU_Z_EXACT_PRINTED_SIZE_SLOT',
        ...exactSize
      };
    }

    const exactMultiSize = masterUpcsBySizeValidation(
      line,
      definition,
      order.division_code,
      expectedScale
    );

    if (exactMultiSize) {
      return {
        line_no: line.line_no ?? index + 1,
        style_code: line.style_code,
        color_code: line.color_code,
        expected_scale: expectedScale || null,
        selected_scales: definition.scales,
        source: 'EXACT_MASTER_UPCS_BY_SIZE_DISTRIBUTION',
        ...exactMultiSize
      };
    }

    const validation = validateDistribution(
      line,
      definition,
      order.division_code
    );

    return {
      line_no: line.line_no ?? index + 1,
      style_code: line.style_code,
      color_code: line.color_code,
      expected_scale: expectedScale || null,
      selected_scales: definition.scales,
      source: 'LIVE_VR_SKU_Z',
      ...validation
    };
  }

  async validateOrder(order) {
    const lines = Array.isArray(order.purchase_order_lines)
      ? order.purchase_order_lines
      : Array.isArray(order.lines)
        ? order.lines
        : [];

    const results = [];

    for (let index = 0; index < lines.length; index += 1) {
      results.push(
        await this.validateLine(order, lines[index], index)
      );
    }

    return {
      valid: (
        results.length > 0
        && results.every(result => result.valid)
      ),
      lines: results
    };
  }
}
