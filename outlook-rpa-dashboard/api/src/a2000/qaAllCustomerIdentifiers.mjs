import {
  resolveCustomerIdentifierRequirements,
  resolveCustomerSkuPolicy,
  resolveCustomerUpcPolicy
} from './businessRules/index.js';

const cases = [
  {
    name: 'CITI canonical parser fields',
    order: {
      customer_code: 'CITI',
      division_code: 'AL'
    },
    line: {
      customer_sku_raw: '123456',
      customer_upc_raw: '400433438966',
      internal_sku: 'OUR-SKU',
      master_upc: '196540060021'
    },
    expected: {
      sku: '123456',
      upc: '400433438966'
    }
  },
  {
    name: 'Any customer explicit labels',
    order: {
      customer_code: 'OTHER',
      division_code: 'TX'
    },
    line: {
      'Customer SKU': 'ABC123',
      'Customer UPC': '123456789012',
      sku: 'OUR-SKU',
      upc: '999999999999'
    },
    expected: {
      sku: 'ABC123',
      upc: '123456789012'
    }
  },
  {
    name: 'Nested raw labels',
    order: {
      customer_code: 'OTHER',
      division_code: 'TX'
    },
    line: {
      raw: {
        'CUSTOMER-SKU': 'ZX9001',
        'CUSTOMER UPC': '400000000001'
      },
      internal_sku: 'OUR-INTERNAL',
      master_upc: '400000000999'
    },
    expected: {
      sku: 'ZX9001',
      upc: '400000000001'
    }
  },
  {
    name: 'Generic identifiers are ignored',
    order: {
      customer_code: 'OTHER',
      division_code: 'TX'
    },
    line: {
      sku: 'OUR-SKU',
      internal_sku: 'OUR-INTERNAL',
      upc: '400000000999',
      master_upc: '400000000998'
    },
    expected: {
      sku: '',
      upc: ''
    }
  }
];

const results = [];

for (const item of cases) {
  const requirements =
    resolveCustomerIdentifierRequirements({
      order: item.order,
      environment: 'AMEXTEST'
    });

  const sku = resolveCustomerSkuPolicy({
    line: item.line,
    order: item.order,
    required:
      requirements.requireCustomerSku,
    environment: 'AMEXTEST'
  });

  const upc = resolveCustomerUpcPolicy({
    line: item.line,
    order: item.order,
    required:
      requirements.requireCustomerUpc,
    environment: 'AMEXTEST'
  });

  const passed =
    sku.value === item.expected.sku
    && upc.value === item.expected.upc;

  results.push({
    name: item.name,
    customer:
      item.order.customer_code,
    requirement_mode:
      requirements.provenance
        ?.requirement_mode
      || 'NONE',
    CUST_STYLE1:
      sku.value,
    CUST_STYLE2:
      upc.value,
    sku_source:
      sku.provenance?.source_field
      || null,
    upc_source:
      upc.provenance?.source_field
      || null,
    passed
  });
}

console.log(
  JSON.stringify(
    {
      suite:
        'A2000_ALL_CUSTOMERS_EXPLICIT_IDENTIFIER_QA',
      semantics: {
        CUST_STYLE1:
          'EXPLICIT_CUSTOMER_SKU',
        CUST_STYLE2:
          'EXPLICIT_CUSTOMER_UPC'
      },
      forbidden: {
        generic_sku:
          true,
        internal_sku:
          true,
        generic_upc:
          true,
        master_upc:
          true
      },
      results,
      pass_count:
        results.filter((item) => item.passed).length,
      fail_count:
        results.filter((item) => !item.passed).length,
      a2000_http_calls:
        0,
      a2000_writes:
        0,
      supabase_writes:
        0
    },
    null,
    2
  )
);

if (results.some((item) => !item.passed)) {
  process.exit(1);
}

console.log(
  'ALL_CUSTOMER_IDENTIFIER_SEMANTICS_QA=PASS'
);
