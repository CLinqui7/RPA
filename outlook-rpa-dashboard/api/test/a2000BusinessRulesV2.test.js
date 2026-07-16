import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyBusinessRulesToCsvRows,
  applyBusinessRulesToRestPayload,
  collectCustomerUpcEvidenceForLine,
  resolveA2000BusinessRules,
  resolveBackOrderPolicy,
  resolveCustomerSkuPolicy,
  resolveSecondCustomerStyleForLine,
  resolveSalesRepPolicy
} from '../src/a2000/businessRules/index.js';

async function fixtureMasters() {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'a2000-v26-')
  );

  const backOrder = path.join(dir, 'back-order.csv');
  const salesRep = path.join(dir, 'sales-rep.csv');
  const limits = path.join(dir, 'limits.csv');
  const customerIdentifiers = path.join(
    dir,
    'customer-identifiers.csv'
  );

  await fs.writeFile(backOrder, [
    'rule_id,customer_code,division_code,environment,value,ui_meaning,active,source,certification_status,notes',
    'R1,CITI,AL,AMEXTEST,Y,Cancel open lines,Y,TEST,TENANT_CERTIFIED,fixture'
  ].join('\n'));

  await fs.writeFile(salesRep, [
    'rule_id,division_code,sales_rep_code,sales_rep_name,active,source,certification_status,notes',
    'S1,AL,ALS,ALBERT SAYEGH,Y,TEST,TENANT_CERTIFIED,fixture'
  ].join('\n'));

  await fs.writeFile(limits, [
    'rule_id,contract,field,environment,max_length,active,source,certification_status,notes',
    'L1,ORDER_LI,CUST_STYLE1,AMEXTEST,6,Y,TEST,TENANT_CERTIFIED,fixture',
    'L2,ORDER_LI,CUST_STYLE2,AMEXTEST,6,Y,TEST,TENANT_CERTIFIED,fixture'
  ].join('\n'));

  await fs.writeFile(customerIdentifiers, [
    'rule_id,customer_code,division_code,environment,require_customer_sku,require_customer_upc,sku_target_field,upc_target_field,active,source,certification_status,notes',
    'C0,*,*,*,N,N,CUST_STYLE1,NOT_ORDER_LI,Y,TEST,TENANT_CERTIFIED,wildcard',
    'C1,CITI,AL,AMEXTEST,Y,N,CUST_STYLE1,NOT_ORDER_LI,Y,TEST,TENANT_CERTIFIED,fixture'
  ].join('\n'));

  return {
    backOrder,
    salesRep,
    limits,
    customerIdentifiers
  };
}

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

function paths(masters) {
  return {
    backOrder: masters.backOrder,
    salesRep: masters.salesRep,
    fieldLimits: masters.limits,
    customerIdentifiers:
      masters.customerIdentifiers
  };
}

test('Cancel open lines remains BACK_ORDER Y', async () => {
  const masters = await fixtureMasters();

  const result = resolveBackOrderPolicy({
    order,
    environment: 'AMEXTEST',
    masterPath: masters.backOrder
  });

  assert.equal(result.value, 'Y');
  assert.equal(
    result.provenance.ui_meaning,
    'Cancel open lines'
  );
});

test('AL continues to resolve ALS / ALBERT SAYEGH', async () => {
  const masters = await fixtureMasters();

  const result = resolveSalesRepPolicy({
    order,
    masterPath: masters.salesRep
  });

  assert.equal(result.value, 'ALS');
  assert.equal(result.name, 'ALBERT SAYEGH');
});

test('Customer SKU maps to CUST_STYLE1', async () => {
  const masters = await fixtureMasters();

  const result = resolveCustomerSkuPolicy({
    line: order.lines[0],
    order,
    required: true,
    environment: 'AMEXTEST',
    fieldLimitsPath: masters.limits
  });

  assert.equal(result.value, '845746');
  assert.equal(
    result.provenance.target_field,
    'CUST_STYLE1'
  );
});

test('Customer UPC is evidence and is not CUST_STYLE2', () => {
  const evidence =
    collectCustomerUpcEvidenceForLine(
      order.lines[0]
    );

  assert.equal(
    evidence.value,
    '199347334531'
  );
  assert.equal(
    evidence.provenance.target_field,
    null
  );
  assert.equal(
    evidence.provenance.exported_to_order_li,
    false
  );
});

test('second Customer Style uses CUST_STYLE2 only when explicit', () => {
  const result =
    resolveSecondCustomerStyleForLine({
      customer_style2_raw: 'TEST'
    });

  assert.equal(result.value, 'TEST');
  assert.equal(
    result.provenance.target_field,
    'CUST_STYLE2'
  );
});

test('Customer UPC cannot become second Customer Style', () => {
  const result =
    resolveSecondCustomerStyleForLine({
      customer_upc_raw: '199347334531'
    });

  assert.equal(result.value, '');
  assert.equal(result.provenance, null);
});

test('CITI requires Customer SKU but not Customer UPC in ORDER_LI', async () => {
  const masters = await fixtureMasters();

  const skuOnlyOrder = {
    ...order,
    lines: [{
      customer_sku_raw: '845746'
    }]
  };

  const result = resolveA2000BusinessRules({
    order: skuOnlyOrder,
    lines: skuOnlyOrder.lines,
    environment: 'AMEXTEST',
    paths: paths(masters)
  });

  assert.equal(
    result.values.lines[0].cust_style1,
    '845746'
  );

  assert.equal(
    result.values.lines[0].cust_style2,
    ''
  );
});

test('missing CITI Customer SKU still blocks', async () => {
  const masters = await fixtureMasters();

  const missingSkuOrder = {
    ...order,
    lines: [{
      customer_upc_raw: '199347334531'
    }]
  };

  assert.throws(
    () => resolveA2000BusinessRules({
      order: missingSkuOrder,
      lines: missingSkuOrder.lines,
      environment: 'AMEXTEST',
      paths: paths(masters)
    }),
    (error) =>
      error.code === 'A2000_BUSINESS_RULES_FAILED'
      && error.details.errors.some(
        (item) =>
          item.code
            === 'A2000_CUSTOMER_SKU_MISSING'
      )
  );
});

test('CSV and REST export PT Customer SKU identically', async () => {
  const masters = await fixtureMasters();
  const sharedPaths = paths(masters);

  const csv = applyBusinessRulesToCsvRows({
    order,
    headerRow: {
      ORDER_NO: '1930901'
    },
    lineRows: [{
      LINE_NO: 1
    }],
    environment: 'AMEXTEST',
    paths: sharedPaths
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
      environment: 'AMEXTEST',
      paths: sharedPaths
    }
  );

  assert.equal(
    csv.lines[0].CUST_STYLE1,
    '845746'
  );

  assert.equal(
    rest.ORDER_LI[0].CUST_STYLE1,
    '845746'
  );

  assert.equal(
    csv.lines[0].CUST_STYLE2,
    ''
  );

  assert.equal(
    rest.ORDER_LI[0].CUST_STYLE2,
    ''
  );
});

test('Customer UPC creates a warning, not an ORDER_LI value', async () => {
  const masters = await fixtureMasters();

  const result = resolveA2000BusinessRules({
    order,
    lines: order.lines,
    environment: 'AMEXTEST',
    paths: paths(masters)
  });

  assert.equal(
    result.values.lines[0]
      .customer_upc_evidence,
    '199347334531'
  );

  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code
          === 'A2000_CUSTOMER_UPC_NOT_EXPORTED_TO_ORDER_LI'
    )
  );
});

test('generic internal SKU cannot substitute Customer SKU', async () => {
  const masters = await fixtureMasters();

  assert.throws(
    () => resolveCustomerSkuPolicy({
      line: {
        internal_sku: 'EH324-0ML',
        sku: 'EH3240ML'
      },
      order,
      required: true,
      environment: 'AMEXTEST',
      fieldLimitsPath: masters.limits
    }),
    (error) =>
      error.code
        === 'A2000_CUSTOMER_SKU_MISSING'
  );
});
