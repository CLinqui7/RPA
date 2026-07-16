import {
  applyBusinessRulesToCsvRows,
  applyBusinessRulesToRestPayload
} from './businessRules/index.js';

const order = {
  customer_code: 'CITI',
  division_code: 'AL',
  lines: [{
    line_no: 1,
    customer_sku_raw: '845746',
    customer_upc_raw: '199347334531',
    internal_sku: 'EH324-0ML'
  }]
};

const csv = applyBusinessRulesToCsvRows({
  order,
  headerRow: {
    ORDER_NO: '1930901'
  },
  lineRows: [{
    LINE_NO: 1
  }],
  environment: 'AMEXTEST'
});

const rest = applyBusinessRulesToRestPayload(
  {
    IGNORE_ERRORS: 'N',
    ORDER_HD: [{
      ORDER_NO: '1930901'
    }],
    ORDER_LI: [{
      LINE_NO: 1
    }]
  },
  order,
  {
    environment: 'AMEXTEST'
  }
);

const assertions = {
  pt_customer_sku_is_cust_style1:
    csv.lines[0].CUST_STYLE1 === '845746',
  customer_upc_is_not_cust_style2:
    csv.lines[0].CUST_STYLE2 === '',
  rest_matches_csv:
    rest.ORDER_LI[0].CUST_STYLE1
      === csv.lines[0].CUST_STYLE1
    && rest.ORDER_LI[0].CUST_STYLE2
      === csv.lines[0].CUST_STYLE2,
  cancel_open_lines:
    csv.header.BACK_ORDER === 'Y',
  sales_rep:
    csv.header.SMAN1_NO === 'ALS',
  upc_evidence_preserved:
    csv.business_rules
      .values.lines[0]
      .customer_upc_evidence
      === '199347334531'
};

console.log(JSON.stringify({
  support_ticket: '373471',
  confirmed_path: {
    source:
      'Sales Order line Customer Style field before picking',
    api_field:
      'ORDER_LI.CUST_STYLE1',
    pick_ticket_print_option:
      'Customer SKU'
  },
  corrected_mapping: {
    CUST_STYLE1:
      csv.lines[0].CUST_STYLE1,
    CUST_STYLE2:
      csv.lines[0].CUST_STYLE2,
    customer_upc_evidence:
      csv.business_rules
        .values.lines[0]
        .customer_upc_evidence
  },
  assertions,
  warnings:
    csv.business_rules.warnings,
  a2000_http_calls: 0,
  a2000_writes: 0,
  supabase_writes: 0
}, null, 2));

if (
  Object.values(assertions)
    .some((value) => value !== true)
) {
  process.exit(1);
}

console.log(
  'PT_CUSTOMER_SKU_MAPPING_QA=PASS'
);
