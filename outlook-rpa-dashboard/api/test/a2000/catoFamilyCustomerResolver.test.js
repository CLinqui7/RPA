import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCatoFamilyCustomerFromOfficialMaster
} from '../../src/po/enrichment/catoFamilyCustomerResolver.js';

function addMapArray(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function sku(style, color, customer) {
  return {
    Style: style,
    Clr: color,
    Sku: `${style}${color}`,
    Customer: customer,
    'Clr Desc': 'V SILVER',
    'Clr Abbr': 'SIL',
    Div: 'DA',
    Scale: 'PC',
    'Scale Abbr': 'PC',
    Wh: 'PE',
    Price: '7',
    'Pack Qty': '1',
    'Master Style': '',
    'Style Alias': '',
    'Invoice Descr': ''
  };
}

function mastersFor(rows) {
  const skuByStyle = new Map();
  const skuByNormalizedSku = new Map();
  const styleByCustomerNorm = new Map();

  const norm = value => String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  for (const row of rows) {
    addMapArray(skuByStyle, row.Style, row);
    addMapArray(skuByNormalizedSku, norm(row.Sku), row);
    styleByCustomerNorm.set(
      `${String(row.Customer).toUpperCase()}|${norm(row.Style)}`,
      [row.Style]
    );
  }

  return {
    loaded: true,
    customerByCode: new Map([
      ['CATO', { Customer: 'CATO' }],
      ['ITSFASHION', { Customer: 'ITSFASHION' }],
      ['VERSONA', { Customer: 'VERSONA' }]
    ]),
    skuByStyle,
    skuByNormalizedSku,
    styleByCustomerNorm,
    skuZByStyleColor: new Map(),
    upcByStyleColor: new Map(),
    upcByValue: new Map(),
    warehouseByCode: new Map([['PE', { Wh: 'PE' }]])
  };
}

function rawCatoOrder() {
  return {
    parser: 'catocorp',
    document_identity: {
      customer_candidates: ['CATO', 'ITSFASHION', 'VERSONA']
    },
    header: {
      customer_code: null,
      order_no: '615628',
      raw: {}
    },
    lines: [
      {
        line_no: 1,
        style_raw: 'SNSB0363S-LB-B46',
        color_raw: 'V SILVER',
        qty_total: 198,
        raw: { quantity_semantics: 'EACH' }
      },
      {
        line_no: 2,
        style_raw: 'SRB7030S-LB-B46',
        color_raw: 'V SILVER',
        qty_total: 120,
        raw: { quantity_semantics: 'EACH' }
      }
    ],
    conflicts: [{
      field: 'customer_code',
      code: 'cato_banner_identity_ambiguous',
      blocking: true
    }]
  };
}

test('Cato-family PO 615628 resolves uniquely to VERSONA from exact VR_SKU customer ownership', () => {
  const rows = [
    sku('SNSB0363S-LB', 'B46', 'VERSONA'),
    sku('SRB7030S-LB', 'B46', 'VERSONA')
  ];

  const parsed = rawCatoOrder();
  resolveCatoFamilyCustomerFromOfficialMaster(
    parsed,
    mastersFor(rows)
  );

  assert.equal(parsed.header.customer_code, 'VERSONA');
  assert.equal(
    parsed.header.raw.cato_family_customer_resolution.source,
    'VR_SKU_EXACT_CUSTOMER_OWNERSHIP'
  );
  assert.equal(
    parsed.conflicts.some(
      conflict => conflict.code === 'cato_banner_identity_ambiguous'
    ),
    false
  );
});

test('Cato-family customer remains unresolved when exact STYLE/CLR ownership is not unique', () => {
  const rows = [
    sku('SNSB0363S-LB', 'B46', 'VERSONA'),
    sku('SRB7030S-LB', 'B46', 'VERSONA'),
    sku('SNSB0363S-LB', 'B46', 'CATO'),
    sku('SRB7030S-LB', 'B46', 'CATO')
  ];

  const parsed = rawCatoOrder();
  resolveCatoFamilyCustomerFromOfficialMaster(
    parsed,
    mastersFor(rows)
  );

  assert.equal(parsed.header.customer_code, null);
  assert.equal(
    parsed.conflicts.some(
      conflict => conflict.code === 'cato_banner_identity_ambiguous'
    ),
    true
  );
});
