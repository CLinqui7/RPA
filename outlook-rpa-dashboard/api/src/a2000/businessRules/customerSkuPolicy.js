import {
  clean,
  defaultMasterPath,
  isActive,
  isCertified,
  loadCsvMaster,
  normalizeCode
} from './masterLoader.js';
import { A2000PolicyError } from './errors.js';
import { buildProvenance } from './provenance.js';
import { resolveA2000Environment } from './environment.js';

const CUSTOMER_SKU_SOURCE_FIELDS = [
  'customer_sku_raw',
  'customer_sku',
  'customerSku',
  'cust_sku_raw',
  'cust_sku',
  'custSku',
  'cust_style1',
  'CUST_STYLE1'
];

const CUSTOMER_UPC_SOURCE_FIELDS = [
  'customer_upc_raw',
  'customer_upc',
  'customerUpc',
  'cust_upc_raw',
  'cust_upc',
  'custUpc',
  'cust_style2',
  'CUST_STYLE2'
];

const CUSTOMER_SKU_SEMANTIC_KEYS = new Set([
  'CUSTOMERSKU',
  'CUSTOMERSKURAW',
  'CUSTSKU',
  'CUSTSKURAW',
  'CUSTSTYLE1',
  'CUSTOMERSTYLE1'
]);

const CUSTOMER_UPC_SEMANTIC_KEYS = new Set([
  'CUSTOMERUPC',
  'CUSTOMERUPCRAW',
  'CUSTUPC',
  'CUSTUPCRAW',
  'CUSTSTYLE2',
  'CUSTOMERSTYLE2'
]);

const SEMANTIC_CONTAINERS = [
  'raw',
  'source',
  'parsed',
  'identifiers',
  'customer_identifiers',
  'customerIdentifiers'
];

const FORBIDDEN_SKU_FALLBACKS = [
  'sku',
  'SKU',
  'internal_sku',
  'internalSku',
  'style',
  'style_code',
  'ticket_sku',
  'master_sku'
];

const FORBIDDEN_UPC_FALLBACKS = [
  'upc',
  'UPC',
  'master_upc',
  'masterUpc',
  'internal_upc',
  'internalUpc',
  'internal_sku',
  'internalSku',
  'style_code',
  'style'
];

function normalizeSemanticKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function collectSemanticObjects(line) {
  const objects = [];

  if (line && typeof line === 'object' && !Array.isArray(line)) {
    objects.push({
      value: line,
      path: ''
    });
  }

  for (const container of SEMANTIC_CONTAINERS) {
    const value = line?.[container];

    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
    ) {
      objects.push({
        value,
        path: container
      });
    }
  }

  return objects;
}

function collectExplicitCandidates(
  line,
  canonicalFields,
  semanticKeys
) {
  const candidates = [];

  for (const field of canonicalFields) {
    const value = clean(line?.[field]);

    if (value) {
      candidates.push({
        value,
        field,
        source_path: field,
        source_kind: 'CANONICAL_FIELD'
      });
    }
  }

  for (const object of collectSemanticObjects(line)) {
    for (const [key, rawValue] of Object.entries(object.value)) {
      const normalized = normalizeSemanticKey(key);

      if (!semanticKeys.has(normalized)) continue;

      const value = clean(rawValue);
      if (!value) continue;

      const sourcePath = object.path
        ? `${object.path}.${key}`
        : key;

      candidates.push({
        value,
        field: key,
        source_path: sourcePath,
        source_kind: 'EXPLICIT_SEMANTIC_LABEL'
      });
    }
  }

  const uniqueBySourceAndValue = new Map();

  for (const candidate of candidates) {
    uniqueBySourceAndValue.set(
      `${candidate.source_path}|${candidate.value}`,
      candidate
    );
  }

  return [...uniqueBySourceAndValue.values()];
}

function chooseExplicitCandidate({
  line,
  canonicalFields,
  semanticKeys,
  missingCode,
  ambiguousCode,
  semantic,
  required,
  forbiddenFallbacks
}) {
  const candidates = collectExplicitCandidates(
    line,
    canonicalFields,
    semanticKeys
  );

  const distinctValues = [
    ...new Set(
      candidates.map((item) => item.value)
    )
  ];

  if (distinctValues.length > 1) {
    throw new A2000PolicyError(
      ambiguousCode,
      `Conflicting explicit ${semantic} values were found.`,
      {
        semantic,
        candidates,
        line_no:
          line?.line_no
          ?? line?.LINE_NO
          ?? null
      }
    );
  }

  if (!candidates.length) {
    if (required) {
      throw new A2000PolicyError(
        missingCode,
        `${semantic} is required but no explicit customer-labeled source field is present.`,
        {
          accepted_source_fields: canonicalFields,
          accepted_semantic_labels:
            [...semanticKeys],
          forbidden_fallback_fields:
            forbiddenFallbacks,
          line_no:
            line?.line_no
            ?? line?.LINE_NO
            ?? null
        }
      );
    }

    return null;
  }

  const canonical = candidates.find(
    (item) =>
      item.source_kind === 'CANONICAL_FIELD'
  );

  return canonical || candidates[0];
}

function resolveFieldLimit({
  environment,
  field,
  masterPath
}) {
  const master = loadCsvMaster(masterPath, {
    requiredColumns: [
      'contract',
      'field',
      'environment',
      'max_length',
      'active',
      'source',
      'certification_status'
    ]
  });

  const candidates = master.rows.filter((row) =>
    isActive(row.active)
    && isCertified(row.certification_status)
    && normalizeCode(row.contract) === 'ORDER_LI'
    && normalizeCode(row.field) === normalizeCode(field)
    && ['*', normalizeCode(environment)].includes(
      normalizeCode(row.environment)
    )
  );

  if (candidates.length !== 1) {
    throw new A2000PolicyError(
      'A2000_FIELD_LIMIT_RULE_MISSING',
      `Exactly one certified ${field} field limit is required.`,
      {
        field,
        environment: normalizeCode(environment),
        candidate_count: candidates.length,
        master_path: master.path
      }
    );
  }

  const row = candidates[0];
  const maxLength = Number(row.max_length);

  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new A2000PolicyError(
      'A2000_FIELD_LIMIT_INVALID',
      `${field} maximum length is invalid.`,
      {
        field,
        max_length: row.max_length,
        master_path: master.path,
        master_row: row.__row_number
      }
    );
  }

  return {
    row,
    maxLength,
    masterPath: master.path
  };
}

function orderContext(order, environment) {
  const customerCode = normalizeCode(
    order?.customer_code
    ?? order?.customerCode
    ?? order?.cust_no
    ?? order?.CUST_NO
  );

  const divisionCode = normalizeCode(
    order?.division_code
    ?? order?.divisionCode
    ?? order?.div_no
    ?? order?.DIV_NO
  );

  return {
    customerCode,
    divisionCode,
    environment: normalizeCode(environment)
  };
}

function policyScore(row, context) {
  let score = 0;

  for (const [field, actual] of [
    ['customer_code', context.customerCode],
    ['division_code', context.divisionCode],
    ['environment', context.environment]
  ]) {
    const expected = normalizeCode(row[field]);

    if (expected === '*') {
      score += 1;
    } else if (expected === actual) {
      score += 10;
    } else {
      return -1;
    }
  }

  return score;
}

export function resolveCustomerIdentifierRequirements({
  order,
  environment = resolveA2000Environment(),
  policyPath = process.env.A2000_CUSTOMER_IDENTIFIER_POLICY_MASTER
    || defaultMasterPath('a2000_customer_identifier_policy.csv')
}) {
  const context = orderContext(order, environment);
  const master = loadCsvMaster(policyPath, {
    requiredColumns: [
      'rule_id',
      'customer_code',
      'division_code',
      'environment',
      'require_customer_sku',
      'require_customer_upc',
      'sku_target_field',
      'upc_target_field',
      'active',
      'source',
      'certification_status'
    ]
  });

  const candidates = master.rows
    .filter((row) => isActive(row.active))
    .filter((row) => isCertified(row.certification_status))
    .map((row) => ({
      row,
      score: policyScore(row, context)
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    return {
      requireCustomerSku: false,
      requireCustomerUpc: false,
      skuTargetField: 'CUST_STYLE1',
      upcTargetField: 'CUST_STYLE2',
      provenance: null
    };
  }

  const bestScore = candidates[0].score;
  const best = candidates.filter(
    (item) => item.score === bestScore
  );

  if (best.length !== 1) {
    throw new A2000PolicyError(
      'A2000_CUSTOMER_IDENTIFIER_RULE_AMBIGUOUS',
      'Multiple customer identifier policies match the order.',
      {
        ...context,
        rule_ids:
          best.map((item) => item.row.rule_id),
        master_path: master.path
      }
    );
  }

  const row = best[0].row;
  const skuTargetField =
    normalizeCode(row.sku_target_field);
  const upcTargetField =
    normalizeCode(row.upc_target_field);

  if (skuTargetField !== 'CUST_STYLE1') {
    throw new A2000PolicyError(
      'A2000_CUSTOMER_IDENTIFIER_TARGET_INVALID',
      'Certified Customer SKU target must be CUST_STYLE1.',
      {
        sku_target_field: row.sku_target_field,
        rule_id: row.rule_id
      }
    );
  }

  if (!['NOT_ORDER_LI', 'CUST_STYLE2'].includes(upcTargetField)) {
    throw new A2000PolicyError(
      'A2000_CUSTOMER_UPC_TARGET_INVALID',
      'Customer UPC target must remain NOT_ORDER_LI until a separate certified interface is discovered.',
      {
        upc_target_field: row.upc_target_field,
        rule_id: row.rule_id
      }
    );
  }

  return {
    requireCustomerSku:
      isActive(row.require_customer_sku),
    requireCustomerUpc:
      isActive(row.require_customer_upc),
    skuTargetField,
    upcTargetField,
    provenance: buildProvenance({
      source:
        row.source,
      ruleId:
        row.rule_id,
      certificationStatus:
        row.certification_status,
      details: {
        customer_code:
          context.customerCode,
        division_code:
          context.divisionCode,
        environment:
          context.environment,
        sku_target_field:
          skuTargetField,
        upc_target_field:
          upcTargetField,
        requirement_mode:
          (
            isActive(row.require_customer_sku)
            || isActive(row.require_customer_upc)
          )
            ? 'REQUIRED'
            : 'OPTIONAL_WHEN_EXPLICIT',
        master_path:
          master.path,
        master_row:
          row.__row_number
      }
    })
  };
}

export function resolveCustomerSkuPolicy({
  line,
  order = {},
  required = Boolean(
    line?.customer_sku_required
    ?? order?.customer_sku_required
  ),
  environment = resolveA2000Environment(),
  fieldLimitsPath =
    process.env.A2000_FIELD_LIMITS_MASTER
    || defaultMasterPath('a2000_field_limits.csv')
}) {
  const found = chooseExplicitCandidate({
    line,
    canonicalFields:
      CUSTOMER_SKU_SOURCE_FIELDS,
    semanticKeys:
      CUSTOMER_SKU_SEMANTIC_KEYS,
    missingCode:
      'A2000_CUSTOMER_SKU_MISSING',
    ambiguousCode:
      'A2000_CUSTOMER_SKU_AMBIGUOUS',
    semantic:
      'CUSTOMER_SKU',
    required,
    forbiddenFallbacks:
      FORBIDDEN_SKU_FALLBACKS
  });

  if (!found) {
    return {
      value: '',
      provenance: null
    };
  }

  const limit = resolveFieldLimit({
    environment,
    field: 'CUST_STYLE1',
    masterPath: fieldLimitsPath
  });

  if (found.value.length > limit.maxLength) {
    throw new A2000PolicyError(
      'CUST_STYLE1_TOO_LONG',
      'Customer SKU exceeds the certified CUST_STYLE1 length and will not be truncated.',
      {
        value: found.value,
        length: found.value.length,
        max_length: limit.maxLength,
        source_field:
          found.source_path,
        line_no:
          line?.line_no
          ?? line?.LINE_NO
          ?? null
      }
    );
  }

  return {
    value:
      found.value,
    provenance: buildProvenance({
      source:
        `purchase_order_line.${found.source_path}`,
      certificationStatus:
        limit.row.certification_status,
      originalValue:
        found.value,
      details: {
        semantic:
          'CUSTOMER_SKU',
        target_field:
          'CUST_STYLE1',
        source_field:
          found.source_path,
        source_kind:
          found.source_kind,
        max_length:
          limit.maxLength,
        forbidden_generic_sku_fallback:
          true,
        limit_source:
          limit.row.source,
        field_limit_master:
          limit.masterPath,
        field_limit_master_row:
          limit.row.__row_number
      }
    })
  };
}

export function resolveCustomerUpcPolicy({
  line,
  order = {},
  required = Boolean(
    line?.customer_upc_required
    ?? order?.customer_upc_required
  ),
  environment = resolveA2000Environment(),
  fieldLimitsPath =
    process.env.A2000_FIELD_LIMITS_MASTER
    || defaultMasterPath('a2000_field_limits.csv')
}) {
  const found = chooseExplicitCandidate({
    line,
    canonicalFields:
      CUSTOMER_UPC_SOURCE_FIELDS,
    semanticKeys:
      CUSTOMER_UPC_SEMANTIC_KEYS,
    missingCode:
      'A2000_CUSTOMER_UPC_MISSING',
    ambiguousCode:
      'A2000_CUSTOMER_UPC_AMBIGUOUS',
    semantic:
      'CUSTOMER_UPC',
    required,
    forbiddenFallbacks:
      FORBIDDEN_UPC_FALLBACKS
  });

  if (!found) {
    return {
      value: '',
      provenance: null
    };
  }

  if (!/^\d{8,14}$/.test(found.value)) {
    throw new A2000PolicyError(
      'A2000_CUSTOMER_UPC_FORMAT_INVALID',
      'Customer UPC must be the customer-provided 8 to 14 digit identifier.',
      {
        value:
          found.value,
        source_field:
          found.source_path,
        line_no:
          line?.line_no
          ?? line?.LINE_NO
          ?? null
      }
    );
  }

  const limit = resolveFieldLimit({
    environment,
    field: 'CUST_STYLE2',
    masterPath: fieldLimitsPath
  });

  if (found.value.length > limit.maxLength) {
    throw new A2000PolicyError(
      'CUST_STYLE2_TOO_LONG',
      'Customer UPC exceeds the certified CUST_STYLE2 length and will not be truncated.',
      {
        value:
          found.value,
        length:
          found.value.length,
        max_length:
          limit.maxLength,
        source_field:
          found.source_path,
        line_no:
          line?.line_no
          ?? line?.LINE_NO
          ?? null
      }
    );
  }

  return {
    value:
      found.value,
    provenance: buildProvenance({
      source:
        `purchase_order_line.${found.source_path}`,
      certificationStatus:
        limit.row.certification_status,
      originalValue:
        found.value,
      details: {
        semantic:
          'CUSTOMER_UPC',
        target_field:
          'CUST_STYLE2',
        source_field:
          found.source_path,
        source_kind:
          found.source_kind,
        max_length:
          limit.maxLength,
        master_upc_accepted:
          false,
        internal_sku_accepted:
          false,
        generic_upc_accepted:
          false,
        limit_source:
          limit.row.source,
        field_limit_master:
          limit.masterPath,
        field_limit_master_row:
          limit.row.__row_number
      }
    })
  };
}

export const customerSkuSourceFields =
  Object.freeze([
    ...CUSTOMER_SKU_SOURCE_FIELDS
  ]);

export const customerUpcSourceFields =
  Object.freeze([
    ...CUSTOMER_UPC_SOURCE_FIELDS
  ]);

export const customerSkuSemanticKeys =
  Object.freeze([
    ...CUSTOMER_SKU_SEMANTIC_KEYS
  ]);

export const customerUpcSemanticKeys =
  Object.freeze([
    ...CUSTOMER_UPC_SEMANTIC_KEYS
  ]);
