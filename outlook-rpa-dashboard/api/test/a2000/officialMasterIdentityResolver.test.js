import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOfficialMasterScopeStats,
  resolveOrderOfficialMasterIdentity,
  validateOrderOfficialMasterIdentity
} from '../../src/po/enrichment/officialMasterIdentityResolver.js';

function sku(style, color, {
  customer = 'STOCK',
  desc = '',
  abbr = '',
  div = 'AL',
  scale = 'v0',
  wh = 'PE',
  skuValue = null
} = {}) {
  return {
    Style: style,
    Clr: color,
    Sku: skuValue || `${style}${color}`,
    Customer: customer,
    'Clr Desc': desc,
    'Clr Abbr': abbr,
    Div: div,
    Scale: scale,
    'Scale Abbr': '4..16',
    Wh: wh,
    Price: '',
    'Pack Qty': '6'
  };
}

function z(style, color, bucket, sizeName, qty, scale = 'v0') {
  return {
    Style: style,
    Clr: color,
    'Size Num': String(bucket),
    'Size Name': sizeName,
    'Scale Qty': String(qty),
    'Scale Pack Qty': '6',
    'Pack Qty': '6',
    Div: 'AL',
    Scale: scale,
    'Scale Abbr': '4..16',
    Active: 'Y'
  };
}

function masters() {
  const rows = [
    sku('11JANCET', '0C9', {
      customer: 'CITI',
      desc: 'WHITE 6',
      abbr: 'WHTV0'
    }),
    sku('11KS306S9962', '0C9', {
      customer: 'CITI',
      desc: 'WHITE 6',
      abbr: 'WHTV0'
    }),
    sku('11KS306S9962X', '599', {
      customer: 'OTHER',
      desc: 'GREEN',
      abbr: 'GRN'
    }),
    sku('EHH433-42', 'PLT', {
      customer: 'ZUMIEZ',
      desc: 'PINK',
      abbr: 'PNK',
      div: 'H',
      scale: 'PC'
    }),
    sku('W7EH00184-42', '078', {
      customer: 'VARIETYWHO',
      desc: 'MULTI',
      abbr: 'MLT',
      div: 'FA',
      scale: 'PC'
    }),
    sku('PL1977NL-42', '861', {
      customer: 'OLLIES',
      desc: 'LIGHT RED',
      abbr: 'LGRD',
      div: 'PC',
      scale: 'PC'
    }),
    sku('03HOSTARYK', '001', {
      customer: 'BEALLSOUTL',
      desc: 'WHITE',
      abbr: 'WHT',
      div: 'MJ',
      scale: 'KL'
    }),
    sku('GLOBALJANCET', '003', {
      customer: 'OTHER',
      desc: 'BLACK',
      abbr: 'BLK'
    }),
    sku('STOCKRANDOM', '001', {
      customer: 'STOCK',
      desc: 'WHITE',
      abbr: 'WHT',
      div: 'MJ',
      scale: 'PC'
    })
  ];

  const skuByStyle = new Map();

  for (const row of rows) {
    if (!skuByStyle.has(row.Style)) skuByStyle.set(row.Style, []);
    skuByStyle.get(row.Style).push(row);
  }

  const upcByStyleColor = new Map([
    ['11JANCET|0C9', [{
      'Upc No': '199347000001',
      Style: '11JANCET',
      Clr: '0C9',
      'Size Num': '0',
      'Size Name': 'ALL',
      Div: 'AL',
      Scale: 'v0',
      Sku: '11JANCET0C9'
    }]],
    ['11KS306S9962|0C9', [{
      'Upc No': '199347556759',
      Style: '11KS306S9962',
      Clr: '0C9',
      'Size Num': '0',
      'Size Name': 'ALL',
      Div: 'AL',
      Scale: 'v0',
      Sku: '11KS306S99620C9'
    }]],
    ['PL1977NL-42|861', [{
      'Upc No': '199347506808',
      Style: 'PL1977NL-42',
      Clr: '861',
      'Size Num': '1',
      'Size Name': 'PC',
      Div: 'PC',
      Scale: 'PC',
      Sku: 'PL1977NL-42 861'
    }]]
  ]);

  return {
    loaded: true,
    customerByCode: new Map([
      ['CITI', {
        Customer: 'CITI',
        Terms: 'X6',
        'Ship Via': 'ROUTING',
        'Def Wh': 'PE',
        Div: 'FA'
      }],
      ['ZUMIEZ', {
        Customer: 'ZUMIEZ',
        Terms: '6C',
        'Def Wh': 'PE',
        Div: 'H'
      }],
      ['VARIETYWHO', {
        Customer: 'VARIETYWHO',
        Terms: 'C4',
        'Def Wh': 'PE',
        Div: 'FA'
      }],
      ['OLLIES', {
        Customer: 'OLLIES',
        Terms: '3A',
        'Def Wh': 'PE',
        Div: 'PC'
      }],
      ['BEALLSOUTL', {
        Customer: 'BEALLSOUTL',
        Terms: 'X6',
        'Def Wh': 'PE',
        Div: 'MJ'
      }]
    ]),
    skuByStyle,
    skuByNormalizedSku: new Map(),
    styleByCustomerNorm: new Map(),
    upcByValue: new Map([
      ['199347506808', upcByStyleColor.get('PL1977NL-42|861')]
    ]),
    upcByStyleColor,
    skuZByStyleColor: new Map([
      ['11JANCET|0C9', [
        z('11JANCET', '0C9', 4, '4', 1),
        z('11JANCET', '0C9', 5, '6', 2),
        z('11JANCET', '0C9', 6, '8', 2),
        z('11JANCET', '0C9', 7, '10', 1)
      ]],
      ['11KS306S9962|0C9', [
        z('11KS306S9962', '0C9', 4, '4', 1),
        z('11KS306S9962', '0C9', 5, '6', 2),
        z('11KS306S9962', '0C9', 6, '8', 2),
        z('11KS306S9962', '0C9', 7, '10', 1)
      ]],
      ['PL1977NL-42|861', [
        z('PL1977NL-42', '861', 1, 'PC', 1, 'PC')
      ]]
    ]),
    warehouseByCode: new Map([
      ['PE', { Wh: 'PE' }]
    ])
  };
}

function resolve(customer, styleRaw, colorRaw = '', extra = {}) {
  const parsed = {
    parser: 'test',
    header: {
      customer_code: customer,
      store_code: 'SAME'
    },
    lines: [{
      line_no: 1,
      style_raw: styleRaw,
      color_raw: colorRaw,
      qty_total: extra.qty_total || 600,
      customer_upc: extra.customer_upc || null,
      raw: {
        quantity_semantics: extra.quantity_semantics || 'EACH'
      }
    }]
  };

  resolveOrderOfficialMasterIdentity(parsed, masters());
  return parsed;
}

test('customer scope exists and is searched before global styles', () => {
  const stats = getOfficialMasterScopeStats('CITI', masters());

  assert.equal(stats.customer_specific_style_count, 2);
  assert.deepEqual(
    stats.resolution_order,
    ['CUSTOMER_SPECIFIC', 'STOCK', 'GLOBAL_LAST_RESORT']
  );
});

test('JANCEET resolves only inside CITI customer style scope to native 11JANCET', () => {
  const parsed = resolve('CITI', 'JANCEET', 'WHITE');

  assert.equal(parsed.lines[0].style_code, '11JANCET');
  assert.equal(parsed.lines[0].color_code, '0C9');
  assert.equal(parsed.lines[0].master_upc, '199347000001');
  assert.equal(
    parsed.lines[0].raw.universal_official_master_identity.style_scope,
    'CUSTOMER_SPECIFIC'
  );
  assert.equal(parsed.lines[0].qty_sz4, 100);
  assert.equal(parsed.lines[0].qty_sz5, 200);
  assert.equal(parsed.lines[0].qty_sz6, 200);
  assert.equal(parsed.lines[0].qty_sz7, 100);
  assert.equal(parsed.header.division_code, 'AL');
  assert.equal(
    parsed.header.raw.universal_official_division_resolution.source,
    'VR_SKU_EXACT_RESOLVED_LINE_CONSENSUS'
  );
  assert.equal(
    parsed.header.raw.universal_official_division_resolution.previous_division_code,
    null
  );
  assert.equal(
    parsed.lines[0].raw.universal_official_master_identity.customer_upc_raw,
    null
  );
});

test('KS306-S9962 uses customer style scope and native numeric prefix', () => {
  const parsed = resolve('CITI', 'KS306-S9962', 'WHITE');

  assert.equal(parsed.lines[0].style_code, '11KS306S9962');
  assert.equal(parsed.lines[0].color_code, '0C9');
  assert.equal(parsed.lines[0].master_upc, '199347556759');
  assert.equal(
    parsed.lines[0].raw.universal_official_master_identity.style_scope,
    'CUSTOMER_SPECIFIC'
  );
});

test('concatenated Zumiez style plus color suffix is split by official style boundary', () => {
  const parsed = resolve('ZUMIEZ', 'EHH43342PLT', 'PINK', {
    qty_total: 600
  });

  assert.equal(parsed.lines[0].style_code, 'EHH433-42');
  assert.equal(parsed.lines[0].color_code, 'PLT');
  assert.equal(
    parsed.lines[0].raw.universal_official_master_identity.color_source,
    'OFFICIAL_STYLE_BOUNDARY_COLOR_SUFFIX'
  );
});

test('partial printed color suffix is completed only inside the resolved style', () => {
  const parsed = resolve(
    'VARIETYWHO',
    'W7EH00184-42-07',
    ''
  );

  assert.equal(parsed.lines[0].style_code, 'W7EH00184-42');
  assert.equal(parsed.lines[0].color_code, '078');
});

test('exact UPC corrects a typo in printed style', () => {
  const parsed = resolve(
    'OLLIES',
    'PL17977NL-42',
    '',
    {
      customer_upc: '199347506808',
      qty_total: 4896
    }
  );

  assert.equal(parsed.lines[0].style_code, 'PL1977NL-42');
  assert.equal(parsed.lines[0].color_code, '861');
  assert.equal(parsed.lines[0].master_upc, '199347506808');
  assert.equal(parsed.lines[0].qty_sz1, 4896);
});

test('existing exact official Bealls native style/color remains untouched', () => {
  const parsed = {
    parser: 'bealls',
    header: {
      customer_code: 'BEALLSOUTL'
    },
    lines: [{
      line_no: 1,
      style_raw: '03HOSTAR-Y',
      style_code: '03HOSTARYK',
      color_raw: 'White',
      color_code: '001',
      qty_total: 46,
      qty_sz5: 46,
      warehouse_code: 'PE',
      raw: {}
    }]
  };

  resolveOrderOfficialMasterIdentity(parsed, masters());

  assert.equal(parsed.lines[0].style_code, '03HOSTARYK');
  assert.equal(parsed.lines[0].color_code, '001');
  assert.equal(parsed.lines[0].qty_sz5, 46);
});

test('customer UPC stays separate from master UPC and does not overwrite native identity', () => {
  const parsed = resolve(
    'CITI',
    'KS306-S9962',
    'WHITE',
    {
      customer_upc: '400431982829',
      qty_total: 600
    }
  );

  assert.equal(parsed.lines[0].customer_upc, '400431982829');
  assert.equal(parsed.lines[0].master_upc, '199347556759');
  assert.notEqual(
    parsed.lines[0].customer_upc,
    parsed.lines[0].master_upc
  );
  assert.equal(
    parsed.lines[0].raw.universal_official_master_identity.customer_upc_raw,
    '400431982829'
  );
});

test('official line division overrides an existing generic header division', () => {
  const parsed = {
    parser: 'cititrends',
    header: {
      customer_code: 'CITI',
      store_code: 'SAME',
      division_code: 'FA'
    },
    lines: [{
      line_no: 1,
      style_raw: 'KS306-S9962',
      color_raw: 'WHITE',
      qty_total: 600,
      raw: {
        quantity_semantics: 'EACH'
      }
    }]
  };

  resolveOrderOfficialMasterIdentity(parsed, masters());

  assert.equal(parsed.header.division_code, 'AL');
  assert.equal(
    parsed.header.raw.universal_official_division_resolution.previous_division_code,
    'FA'
  );
  assert.equal(
    parsed.header.raw.universal_official_division_resolution.resolved_division_code,
    'AL'
  );
});

test('REST guard blocks a header division that disagrees with the official line division', () => {
  const result = validateOrderOfficialMasterIdentity({
    customer_code: 'CITI',
    division_code: 'FA',
    warehouse_code: 'PE',
    purchase_order_lines: [{
      line_no: 1,
      style_code: '11KS306S9962',
      color_code: '0C9',
      warehouse_code: 'PE'
    }]
  }, masters());

  assert.equal(result.valid, false);
  assert.equal(
    result.errors.some(
      error => error.code === 'HEADER_DIVISION_NOT_MATCHING_OFFICIAL_LINES'
    ),
    true
  );
});

test('REST guard blocks raw or non-native style', () => {
  const result = validateOrderOfficialMasterIdentity({
    customer_code: 'CITI',
    warehouse_code: 'PE',
    purchase_order_lines: [{
      line_no: 1,
      style_raw: 'JANCEET',
      style_code: 'JANCEET',
      color_code: '0C9',
      warehouse_code: 'PE'
    }]
  }, masters());

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'NON_OFFICIAL_A2000_STYLE');
});

test('REST guard accepts exact native style/color pair', () => {
  const result = validateOrderOfficialMasterIdentity({
    customer_code: 'CITI',
    warehouse_code: 'PE',
    purchase_order_lines: [{
      line_no: 1,
      style_code: '11JANCET',
      color_code: '0C9',
      warehouse_code: 'PE'
    }]
  }, masters());

  assert.equal(result.valid, true);
});
