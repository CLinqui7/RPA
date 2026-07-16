import { resolveA2000Environment } from './environment.js';
import { resolveBackOrderPolicy } from './backOrderPolicy.js';
import { resolveSalesRepPolicy } from './salesRepPolicy.js';
import {
  resolveCustomerIdentifierRequirements,
  resolveCustomerSkuPolicy,
  resolveCustomerUpcPolicy
} from './customerSkuPolicy.js';
import {
  collectPolicyResult,
  throwIfPolicyErrors
} from './validation.js';

export { A2000PolicyError } from './errors.js';
export { resolveA2000Environment } from './environment.js';
export { resolveBackOrderPolicy } from './backOrderPolicy.js';
export { resolveSalesRepPolicy } from './salesRepPolicy.js';
export {
  resolveCustomerIdentifierRequirements,
  resolveCustomerSkuPolicy,
  resolveCustomerUpcPolicy,
  customerSkuSourceFields,
  customerUpcSourceFields
} from './customerSkuPolicy.js';

const CUSTOMER_UPC_EVIDENCE_FIELDS = [
  'customer_upc_raw',
  'customer_upc',
  'customerUpc',
  'cust_upc_raw',
  'cust_upc',
  'custUpc'
];

const SECOND_CUSTOMER_STYLE_FIELDS = [
  'customer_style2_raw',
  'customer_style2',
  'customerStyle2',
  'second_customer_style',
  'secondCustomerStyle'
];

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function firstExplicit(line, fields) {
  for (const field of fields) {
    const value = clean(line?.[field]);
    if (value) {
      return {
        value,
        source_field: field
      };
    }
  }

  return {
    value: '',
    source_field: null
  };
}

export function collectCustomerUpcEvidenceForLine(line) {
  const found = firstExplicit(
    line,
    CUSTOMER_UPC_EVIDENCE_FIELDS
  );

  return {
    value: found.value,
    provenance: found.value
      ? {
          source:
            `purchase_order_line.${found.source_field}`,
          semantic: 'CUSTOMER_UPC_EVIDENCE',
          target_field: null,
          source_field: found.source_field,
          exported_to_order_li: false,
          reason:
            'Customer UPC belongs to the Customer SKUs/Packing maintenance data. No certified ORDER_LI target has been proven.'
        }
      : null
  };
}

export function resolveSecondCustomerStyleForLine(line) {
  const found = firstExplicit(
    line,
    SECOND_CUSTOMER_STYLE_FIELDS
  );

  if (found.value.length > 6) {
    const error = new Error(
      'Second Customer Style exceeds the guarded six-character limit.'
    );
    error.code = 'CUST_STYLE2_TOO_LONG';
    error.details = {
      value: found.value,
      length: found.value.length,
      max_length: 6,
      source_field: found.source_field
    };
    throw error;
  }

  return {
    value: found.value,
    provenance: found.value
      ? {
          source:
            `purchase_order_line.${found.source_field}`,
          semantic: 'SECOND_CUSTOMER_STYLE',
          target_field: 'CUST_STYLE2',
          source_field: found.source_field,
          original_value: found.value
        }
      : null
  };
}

export function resolveA2000BusinessRules({
  order,
  lines = order?.lines || [],
  environment = resolveA2000Environment(),
  customerSkuRequired = null,
  paths = {}
}) {
  const errors = [];
  const warnings = [];

  const backOrder = collectPolicyResult(() =>
    resolveBackOrderPolicy({
      order,
      environment,
      masterPath: paths.backOrder
    })
  );
  if (!backOrder.ok) errors.push(backOrder.error);

  const salesRep = collectPolicyResult(() =>
    resolveSalesRepPolicy({
      order,
      masterPath: paths.salesRep,
      customerMasterPath: paths.customerMaster
    })
  );
  if (!salesRep.ok) errors.push(salesRep.error);

  const requirements = collectPolicyResult(() =>
    resolveCustomerIdentifierRequirements({
      order,
      environment,
      policyPath: paths.customerIdentifiers
    })
  );
  if (!requirements.ok) errors.push(requirements.error);

  const lineRules = lines.map((line, index) => {
    const skuRequired = customerSkuRequired === null
      ? Boolean(
          line?.customer_sku_required
          ?? requirements.value?.requireCustomerSku
          ?? false
        )
      : typeof customerSkuRequired === 'function'
        ? Boolean(customerSkuRequired(line, index))
        : Boolean(customerSkuRequired);

    const sku = collectPolicyResult(() =>
      resolveCustomerSkuPolicy({
        line,
        order,
        required: skuRequired,
        environment,
        fieldLimitsPath: paths.fieldLimits
      })
    );

    const secondStyle = collectPolicyResult(() =>
      resolveSecondCustomerStyleForLine(line)
    );

    if (!sku.ok) {
      errors.push({
        ...sku.error,
        details: {
          ...sku.error.details,
          line_index: index
        }
      });
    }

    if (!secondStyle.ok) {
      errors.push({
        ...secondStyle.error,
        details: {
          ...secondStyle.error.details,
          line_index: index
        }
      });
    }

    const upcEvidence =
      collectCustomerUpcEvidenceForLine(line);

    if (upcEvidence.value) {
      warnings.push({
        code:
          'A2000_CUSTOMER_UPC_NOT_EXPORTED_TO_ORDER_LI',
        message:
          'Customer UPC was preserved as evidence but was not written to CUST_STYLE2.',
        details: {
          line_index: index,
          value: upcEvidence.value,
          source_field:
            upcEvidence.provenance.source_field,
          target_field: null
        }
      });
    }

    return {
      sku: sku.ok
        ? sku.value
        : { value: null, provenance: null },
      secondStyle: secondStyle.ok
        ? secondStyle.value
        : { value: null, provenance: null },
      upcEvidence
    };
  });

  throwIfPolicyErrors(errors);

  return {
    values: {
      back_order: backOrder.value.value,
      salesman1_code: salesRep.value.value,
      lines: lineRules.map((result) => ({
        cust_style1: result.sku.value,
        cust_style2: result.secondStyle.value,
        customer_upc_evidence:
          result.upcEvidence.value
      }))
    },
    provenance: {
      back_order: backOrder.value.provenance,
      salesman1_code: salesRep.value.provenance,
      customer_identifier_policy:
        requirements.value.provenance,
      lines: lineRules.map((result) => ({
        cust_style1: result.sku.provenance,
        cust_style2:
          result.secondStyle.provenance,
        customer_upc_evidence:
          result.upcEvidence.provenance
      }))
    },
    errors: [],
    warnings
  };
}

export function resolveBackOrderForOrder(
  order,
  options = {}
) {
  return resolveBackOrderPolicy({
    order,
    environment:
      options.environment
      || resolveA2000Environment(),
    masterPath: options.masterPath
  });
}

export function resolveSalesRepForOrder(
  order,
  options = {}
) {
  return resolveSalesRepPolicy({
    order,
    masterPath: options.masterPath,
    customerMasterPath: options.customerMasterPath
  });
}

export function resolveCustomerSkuForLine(
  line,
  order = {},
  options = {}
) {
  return resolveCustomerSkuPolicy({
    line,
    order,
    required: Boolean(
      options.required
      ?? line?.customer_sku_required
      ?? order?.customer_sku_required
    ),
    environment:
      options.environment
      || resolveA2000Environment(),
    fieldLimitsPath: options.fieldLimitsPath
  });
}

/**
 * Compatibility helper only.
 * Customer UPC is NOT an ORDER_LI.CUST_STYLE2 value.
 */
export function resolveCustomerUpcForLine(
  line,
  order = {},
  options = {}
) {
  return resolveCustomerUpcPolicy({
    line,
    order,
    required: Boolean(options.required),
    environment:
      options.environment
      || resolveA2000Environment(),
    fieldLimitsPath: options.fieldLimitsPath
  });
}

// A2000_OPTIONAL_SMAN1_RESTORE_V1
function assignOptionalSalesRep(target, salesRepCode) {
  const value = clean(salesRepCode);
  if (value) target.SMAN1_NO = value;
  else delete target.SMAN1_NO;
  return target;
}

export function applyBusinessRulesToCsvRows({
  order,
  headerRow,
  lineRows,
  environment = resolveA2000Environment(),
  paths = {}
}) {
  const resolution = resolveA2000BusinessRules({
    order,
    lines: order?.lines || [],
    environment,
    paths
  });

  return {
    header: assignOptionalSalesRep({
      ...headerRow,
      BACK_ORDER: resolution.values.back_order
    }, resolution.values.salesman1_code),
    lines: lineRows.map((row, index) => ({
      ...row,
      CUST_STYLE1:
        resolution.values.lines[index]?.cust_style1
        ?? '',
      CUST_STYLE2:
        resolution.values.lines[index]?.cust_style2
        ?? ''
    })),
    business_rules: resolution
  };
}

export function applyBusinessRulesToRestPayload(
  payload,
  order,
  options = {}
) {
  const headers = Array.isArray(payload?.ORDER_HD)
    ? payload.ORDER_HD
    : [];
  const lines = Array.isArray(payload?.ORDER_LI)
    ? payload.ORDER_LI
    : [];

  if (headers.length !== 1) {
    throw new Error(
      'REST payload must contain exactly one ORDER_HD row.'
    );
  }

  const resolution = resolveA2000BusinessRules({
    order,
    lines: order?.lines || [],
    environment:
      options.environment
      || resolveA2000Environment(),
    paths: options.paths || {}
  });

  return {
    ...payload,
    ORDER_HD: [assignOptionalSalesRep({
      ...headers[0],
      BACK_ORDER: resolution.values.back_order
    }, resolution.values.salesman1_code)],
    ORDER_LI: lines.map((row, index) => ({
      ...row,
      CUST_STYLE1:
        resolution.values.lines[index]?.cust_style1
        ?? '',
      CUST_STYLE2:
        resolution.values.lines[index]?.cust_style2
        ?? ''
    })),
    __business_rules: resolution
  };
}

export function preflightA2000BusinessRules(input) {
  return resolveA2000BusinessRules(input);
}
