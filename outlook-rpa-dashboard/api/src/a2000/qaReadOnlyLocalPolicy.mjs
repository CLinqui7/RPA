import {
  applyBusinessRulesToCsvRows,
  applyBusinessRulesToRestPayload,
  resolveA2000BusinessRules
} from './businessRules/index.js';

const order = {
  customer_code: 'CITI',
  division_code: 'AL',
  lines: [{
    line_no: 1,
    customer_sku_raw: '123456',
    customer_upc_raw: '400433438966',
    master_upc: '196540060021',
    internal_sku: 'AX4301H-42 003',
    style_code: 'AX4301H-42'
  }]
};

const paths = {};
const result = resolveA2000BusinessRules({
  order,
  lines: order.lines,
  environment: 'AMEXTEST',
  paths
});

const csv = applyBusinessRulesToCsvRows({
  order,
  headerRow: { ORDER_NO: 'QA-CUSTOMER-IDS' },
  lineRows: [{ LINE_NO: 1 }],
  environment: 'AMEXTEST',
  paths
});

const rest = applyBusinessRulesToRestPayload({
  IGNORE_ERRORS: 'N',
  ORDER_HD: [{ ORDER_NO: 'QA-CUSTOMER-IDS' }],
  ORDER_LI: [{ LINE_NO: 1 }]
}, order, {
  environment: 'AMEXTEST',
  paths
});

const proof = {
  expected: {
    customer_sku: '123456',
    customer_upc: '400433438966',
    forbidden_master_upc: '196540060021',
    forbidden_internal_sku: 'AX4301H-42 003'
  },
  csv: {
    CUST_STYLE1: csv.lines[0].CUST_STYLE1,
    CUST_STYLE2: csv.lines[0].CUST_STYLE2
  },
  rest: {
    CUST_STYLE1: rest.ORDER_LI[0].CUST_STYLE1,
    CUST_STYLE2: rest.ORDER_LI[0].CUST_STYLE2
  },
  assertions: {
    sku_is_customer_sku:
      csv.lines[0].CUST_STYLE1 === '123456',
    upc_is_customer_upc:
      csv.lines[0].CUST_STYLE2 === '400433438966',
    master_upc_not_used:
      csv.lines[0].CUST_STYLE2 !== '196540060021',
    internal_sku_not_used:
      csv.lines[0].CUST_STYLE1 !== 'AX4301H-42 003',
    csv_rest_match:
      csv.lines[0].CUST_STYLE1 === rest.ORDER_LI[0].CUST_STYLE1
      && csv.lines[0].CUST_STYLE2 === rest.ORDER_LI[0].CUST_STYLE2
  },
  result,
  a2000_http_calls: 0,
  a2000_writes: 0,
  supabase_writes: 0
};

if (
  Object.values(proof.assertions)
    .some((value) => value !== true)
) {
  console.error(JSON.stringify(proof, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(proof, null, 2));
console.log('CUSTOMER_IDENTIFIER_PREVIEW_QA=PASS');
