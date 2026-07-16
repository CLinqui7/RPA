function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function firstValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function positiveBuckets(source = {}) {
  const output = {};

  for (let index = 1; index <= 18; index += 1) {
    const keys = [
      `qty_sz${index}`,
      `QTY_SZ${index}`,
      `SZ${index}`
    ];
    let value = 0;

    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        value = Number(source[key] || 0);
        break;
      }
    }

    if (Number.isFinite(value) && value > 0) {
      output[`QTY_SZ${index}`] = value;
    }
  }

  return output;
}

function bucketSum(buckets = {}) {
  return Object.values(buckets)
    .reduce((sum, value) => sum + Number(value || 0), 0);
}

export function resolveChecklistQtyBuckets(line = {}) {
  const effectiveQty = Number(line.effective?.quantity || 0);
  const pt = line.pick_ticket || {};
  const hardcopy = line.hardcopy || {};
  const ptBuckets = {
    ...positiveBuckets(pt.qty_buckets || {}),
    ...positiveBuckets(pt.size_buckets || {}),
    ...positiveBuckets(pt)
  };

  if (Object.keys(ptBuckets).length) {
    return {
      buckets: ptBuckets,
      source: 'PICK_TICKET_SIZE_BUCKETS',
      exact: true
    };
  }

  const hardcopyBuckets = positiveBuckets(hardcopy);

  if (
    Object.keys(hardcopyBuckets).length
    && bucketSum(hardcopyBuckets) === effectiveQty
  ) {
    return {
      buckets: hardcopyBuckets,
      source: 'HARDCOPY_BUCKETS_TOTAL_MATCHES_PICK_TICKET',
      exact: true
    };
  }

  const hardcopyEntries = Object.entries(hardcopyBuckets);
  const sizeName = clean(
    pt.size_name
    || hardcopy.size_code
    || hardcopy.size_raw
  ).toUpperCase();

  if (
    effectiveQty > 0
    && (
      hardcopyEntries.length === 1
      || ['PC', 'OS', 'ONE'].includes(sizeName)
    )
  ) {
    const bucket = hardcopyEntries[0]?.[0] || 'QTY_SZ1';
    return {
      buckets: { [bucket]: effectiveQty },
      source: 'SINGLE_SIZE_PICK_TICKET_TOTAL',
      exact: true
    };
  }

  return {
    buckets: {},
    source: 'NO_EXACT_SIZE_DISTRIBUTION_AVAILABLE',
    exact: false
  };
}

function rawValue(raw = {}, ...keys) {
  const sources = [raw, raw?.raw, raw?.metadata, raw?.source];

  for (const key of keys) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const value = source[key];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      return value;
    }
  }

  return null;
}

export function buildChecklistPayloadFromAuthoritativeInput({
  input,
  order,
  template
} = {}) {
  const orderRaw = order?.raw_json?.header?.raw
    || order?.raw_json?.header
    || {};
  const header = {
    control_no: input.control_no,
    a2000_control_no: input.control_no,
    control_status: 'A2000_ASSIGNED',
    internal_control_key: input.control_identity,
    purchase_order_id: order?.id || input.purchase_order_id,
    customer_code: input.customer_code,
    order_no: input.order_no,
    order_date: order?.order_date || null,
    start_date: order?.start_date || null,
    cancel_date: order?.cancel_date || null,
    store_code: input.store_code || order?.store_code || null,
    division_code: order?.division_code || null,
    terms_code: order?.terms_code || null,
    warehouse_code: input.warehouse_code
      || order?.warehouse_code
      || null,
    dept_code: firstValue(order?.dept_code, order?.dept_raw),
    ship_via: firstValue(
      order?.ship_via_code,
      rawValue(orderRaw, 'ship_via_raw', 'ship_via')
    ),
    pick_ticket_no: input.pick_ticket_no,
    tickets: rawValue(
      orderRaw,
      'tickets_raw',
      'ticketing_raw',
      'preticket_raw'
    ),
    tracking: rawValue(
      orderRaw,
      'tracking_raw',
      'tracking_no_raw',
      'tracking_number_raw'
    ),
    dc_name: rawValue(
      orderRaw,
      'dc_name_raw',
      'store_name_raw',
      'ship_to_name_raw'
    ),
    source_precedence: input.source_precedence,
    checklist_scope: 'ONE_CHECKLIST_PER_CONTROL'
  };

  const lines = (input.lines || []).map((line, index) => {
    const hardcopy = line.hardcopy || {};
    const pt = line.pick_ticket || {};
    const raw = hardcopy.raw_json || {};
    const resolution = resolveChecklistQtyBuckets(line);
    const output = {
      control_no: input.control_no,
      customer_code: input.customer_code,
      style_code: line.effective?.style,
      color_code: line.effective?.color,
      customer_style: firstValue(
        hardcopy.style_raw,
        pt.customer_style,
        pt.customer_style1
      ),
      manufacturer_style: rawValue(
        raw,
        'manufacturer_style_raw',
        'mfg_style_raw',
        'vendor_style_raw'
      ),
      customer_color: firstValue(
        hardcopy.color_raw,
        pt.customer_color
      ),
      customer_sku: line.effective?.customer_sku,
      customer_upc: line.effective?.customer_upc,
      customer_sku_upc: firstValue(
        line.effective?.customer_sku,
        line.effective?.customer_upc
      ),
      qty_total: Number(line.effective?.quantity || 0),
      size_raw: firstValue(pt.size_name, hardcopy.size_raw),
      sales_price: firstValue(pt.price, hardcopy.sales_price),
      retail_price: firstValue(
        hardcopy.list_price,
        rawValue(
          raw,
          'retail_price_raw',
          'retail_price',
          'list_price_raw'
        )
      ),
      description: firstValue(
        pt.description,
        hardcopy.description
      ),
      order_no: input.order_no,
      order_date: order?.order_date || null,
      start_date: order?.start_date || null,
      cancel_date: order?.cancel_date || null,
      store_code: input.store_code || order?.store_code || null,
      division_code: order?.division_code || null,
      terms_code: order?.terms_code || null,
      warehouse_code: firstValue(
        pt.warehouse_code,
        hardcopy.warehouse_code,
        input.warehouse_code,
        order?.warehouse_code
      ),
      line_warehouse_code: firstValue(
        pt.warehouse_code,
        hardcopy.warehouse_code
      ),
      dept_code: firstValue(
        order?.dept_code,
        order?.dept_raw,
        rawValue(raw, 'dept_code', 'dept_raw')
      ),
      pick_ticket_no: input.pick_ticket_no,
      cartons: rawValue(
        raw,
        'cartons_raw',
        'carton_count_raw',
        'carton_qty_raw',
        'cartons'
      ),
      carton_id: rawValue(
        raw,
        'carton_id_raw',
        'carton_id',
        'carton_identifier_raw'
      ),
      tickets: firstValue(
        rawValue(raw, 'tickets_raw', 'ticketing_raw', 'preticket_raw'),
        header.tickets
      ),
      tracking: firstValue(
        rawValue(
          raw,
          'tracking_raw',
          'tracking_no_raw',
          'tracking_number_raw'
        ),
        header.tracking
      ),
      sub_sku: rawValue(
        raw,
        'sub_sku_raw',
        'sub_sku',
        'substitution_sku_raw'
      ),
      sub_style: rawValue(
        raw,
        'sub_style_raw',
        'sub_style',
        'substitution_style_raw'
      ),
      sub_color: rawValue(
        raw,
        'sub_color_raw',
        'sub_color',
        'substitution_color_raw'
      ),
      dc_name: firstValue(
        rawValue(raw, 'dc_name_raw', 'store_name_raw'),
        header.dc_name
      ),
      packing_instructions: rawValue(
        raw,
        'packing_instructions_raw',
        'packing_instructions',
        'pack_instructions_raw'
      ),
      pln_no: rawValue(
        raw,
        'pln_no_raw',
        'pln_raw',
        'pln_no'
      ),
      qty_buckets: resolution.buckets,
      qty_bucket_source: resolution.source,
      qty_bucket_exact: resolution.exact,
      source_precedence: input.source_precedence,
      source_line_no: line.line_no || index + 1
    };

    for (let sizeIndex = 1; sizeIndex <= 18; sizeIndex += 1) {
      output[`qty_sz${sizeIndex}`] = (
        resolution.buckets[`QTY_SZ${sizeIndex}`]
        || null
      );
    }

    return output;
  });

  return {
    header,
    lines,
    authoritative_input: {
      control_identity: input.control_identity,
      conflict_count: input.conflict_count,
      source_precedence: input.source_precedence,
      pick_ticket_scope_policy: input.pick_ticket_scope_policy
    },
    template_profile: {
      customer_code: template.customer_code,
      checklist_status: template.checklist_status,
      production_status: template.production_status,
      schema: template.schema,
      sha256: template.sha256,
      resolution_mode: template.resolution_mode,
      registry_version: template.registry_version,
      runtime_policy: template.runtime_policy
    }
  };
}
