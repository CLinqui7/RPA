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

function getDivision(order) {
  for (const field of ['division_code', 'divisionCode', 'div_no', 'DIV_NO']) {
    const value = clean(order?.[field]);
    if (value) return normalizeCode(value);
  }
  return '';
}

function getCustomer(order) {
  for (const field of ['customer_code', 'customerCode', 'cust_no', 'CUST_NO']) {
    const value = clean(order?.[field]);
    if (value) return normalizeCode(value);
  }
  return '';
}

function resolveCertifiedDivisionRule({ divisionCode, masterPath }) {
  const master = loadCsvMaster(masterPath, {
    requiredColumns: [
      'division_code', 'sales_rep_code', 'sales_rep_name',
      'active', 'source', 'certification_status'
    ]
  });
  const matches = master.rows.filter((row) =>
    isActive(row.active)
    && isCertified(row.certification_status)
    && normalizeCode(row.division_code) === divisionCode
  );
  if (!matches.length) return { found: false, master };
  const codes = new Set(matches.map((row) => normalizeCode(row.sales_rep_code)));
  if (matches.length !== 1 || codes.size !== 1) {
    throw new A2000PolicyError(
      'A2000_SALES_REP_RULE_AMBIGUOUS',
      'The division has conflicting active sales representatives.',
      { division_code: divisionCode, master_rows: matches.map((row) => row.__row_number), master_path: master.path }
    );
  }
  const row = matches[0];
  return {
    found: true,
    value: normalizeCode(row.sales_rep_code),
    name: clean(row.sales_rep_name),
    optional: false,
    provenance: buildProvenance({
      source: row.source,
      ruleId: row.rule_id || null,
      certificationStatus: row.certification_status,
      originalValue: row.sales_rep_code,
      details: {
        resolution_mode: 'CERTIFIED_DIVISION_RULE',
        division_code: divisionCode,
        sales_rep_name: clean(row.sales_rep_name),
        exported_field: 'SMAN1_NO',
        omit_export_field: false,
        master_path: master.path,
        master_row: row.__row_number
      }
    })
  };
}

function resolveOfficialCustomerMaster({ customerCode, divisionCode, customerMasterPath, divisionMasterPath }) {
  const master = loadCsvMaster(customerMasterPath, {
    requiredColumns: ['Customer', 'Cust Name', 'Rep1', 'Rep2', 'Rep3', 'Active']
  });
  const customerRows = master.rows.filter((row) =>
    isActive(row.active) && normalizeCode(row.customer) === customerCode
  );
  if (!customerRows.length) {
    throw new A2000PolicyError(
      'A2000_CUSTOMER_MASTER_ROW_MISSING',
      'The customer does not exist as one active exact row in the official Customer Master.',
      { customer_code: customerCode, division_code: divisionCode, customer_master_path: master.path, division_master_path: divisionMasterPath }
    );
  }
  if (customerRows.length !== 1) {
    throw new A2000PolicyError(
      'A2000_CUSTOMER_MASTER_ROW_AMBIGUOUS',
      'The official Customer Master contains multiple active exact rows for this customer.',
      { customer_code: customerCode, division_code: divisionCode, customer_master_rows: customerRows.map((row) => row.__row_number), customer_master_path: master.path }
    );
  }
  const row = customerRows[0];
  const rep1 = normalizeCode(row.rep1);
  const rep2 = normalizeCode(row.rep2);
  const rep3 = normalizeCode(row.rep3);
  if (rep1) {
    return {
      value: rep1,
      name: rep1,
      optional: false,
      provenance: buildProvenance({
        source: 'A2000_CUSTOMER_MASTER_EXPORT_2026-07-02',
        ruleId: `SR-CUSTOMER-${customerCode}-REP1`,
        certificationStatus: 'TENANT_CERTIFIED',
        originalValue: row.rep1,
        details: {
          resolution_mode: 'OFFICIAL_CUSTOMER_MASTER_REP1',
          customer_code: customerCode,
          customer_name: clean(row['cust name']),
          division_code: divisionCode,
          sales_rep_name: rep1,
          customer_master_rep1: rep1,
          customer_master_rep2: rep2 || null,
          customer_master_rep3: rep3 || null,
          exported_field: 'SMAN1_NO',
          omit_export_field: false,
          rep2_rep3_exported: false,
          master_path: master.path,
          master_row: row.__row_number
        }
      })
    };
  }
  return {
    value: null,
    name: null,
    optional: true,
    provenance: buildProvenance({
      source: 'A2000_CUSTOMER_MASTER_EXPORT_2026-07-02',
      ruleId: `SR-CUSTOMER-${customerCode}-A2000-DEFAULT`,
      certificationStatus: 'TENANT_CERTIFIED',
      originalValue: null,
      details: {
        resolution_mode: 'A2000_MASTER_DEFAULT_OMIT_SMAN1_NO',
        customer_code: customerCode,
        customer_name: clean(row['cust name']),
        division_code: divisionCode,
        customer_master_rep1: null,
        customer_master_rep2: rep2 || null,
        customer_master_rep3: rep3 || null,
        exported_field: null,
        omit_export_field: true,
        reason: 'The active exact Customer Master row has blank Rep1. SMAN1_NO is omitted so A2000 applies its own official customer/division default.',
        master_path: master.path,
        master_row: row.__row_number
      }
    })
  };
}

export function resolveSalesRepPolicy({
  order,
  masterPath = process.env.A2000_DIVISION_SALES_REP_MASTER || defaultMasterPath('division_sales_rep_master.csv'),
  customerMasterPath = process.env.A2000_CUSTOMER_MASTER_SNAPSHOT || defaultMasterPath('customer_master_snapshot_20260702.csv')
}) {
  const divisionCode = getDivision(order);
  const customerCode = getCustomer(order);
  if (!divisionCode) {
    throw new A2000PolicyError(
      'A2000_DIVISION_MISSING_FOR_SALES_REP',
      'A division is required before resolving the sales representative.',
      { customer_code: customerCode || null, division_code: null }
    );
  }
  const divisionRule = resolveCertifiedDivisionRule({ divisionCode, masterPath });
  if (divisionRule.found) return divisionRule;
  if (!customerCode) {
    throw new A2000PolicyError(
      'A2000_CUSTOMER_MISSING_FOR_SALES_REP',
      'The division has no certified representative and the customer is missing.',
      { division_code: divisionCode, division_master_path: divisionRule.master.path }
    );
  }
  return resolveOfficialCustomerMaster({
    customerCode,
    divisionCode,
    customerMasterPath,
    divisionMasterPath: divisionRule.master.path
  });
}
