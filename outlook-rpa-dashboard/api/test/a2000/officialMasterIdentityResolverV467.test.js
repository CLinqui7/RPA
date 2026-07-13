
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrderOfficialMasterIdentity,
  validateOrderOfficialMasterIdentity
} from '../../src/po/enrichment/officialMasterIdentityResolver.js';

function sku(style, color, {
  customer = 'STOCK',
  desc = '',
  abbr = '',
  div = 'AL',
  scale = 'PC',
  wh = 'PE',
  alias = '',
  masterStyle = '',
  skuValue = null,
  packQty = '1'
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
    'Scale Abbr': scale === 'PC' ? 'PC' : '4..16',
    Wh: wh,
    Price: '',
    'Pack Qty': packQty,
    'Master Style': masterStyle,
    'Style Alias': alias,
    'Invoice Descr': ''
  };
}

function z(style, color, bucket, sizeName, qty, scale = 'PC', pack = 1) {
  return {
    Style: style,
    Clr: color,
    'Size Num': String(bucket),
    'Size Name': sizeName,
    'Scale Qty': String(qty),
    'Scale Pack Qty': String(pack),
    'Pack Qty': String(pack),
    Div: 'AL',
    Scale: scale,
    'Scale Abbr': scale === 'PC' ? 'PC' : '4..16',
    Active: 'Y'
  };
}

function upc(style, color, value, sizeNum = '0', sizeName = 'ALL', scale = 'PC') {
  return {
    'Upc No': value,
    Style: style,
    Clr: color,
    'Size Num': sizeNum,
    'Size Name': sizeName,
    Div: 'AL',
    Scale: scale,
    'Scale Abbr': scale === 'PC' ? 'PC' : '4..16',
    Sku: `${style}${color}`,
    Price: '',
    'Pack Qty': scale === 'PC' ? '1' : '6'
  };
}

function addMapArray(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildMasters(rows, zRows, upcRows) {
  const skuByStyle = new Map();
  const skuByNormalizedSku = new Map();
  const styleByCustomerNormSets = new Map();

  const norm = value => String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  for (const row of rows) {
    addMapArray(skuByStyle, row.Style, row);
    addMapArray(skuByNormalizedSku, norm(row.Sku), row);

    const customer = String(row.Customer || 'STOCK').toUpperCase();

    for (const token of [
      norm(row.Style),
      norm(row['Master Style']),
      norm(row['Style Alias'])
    ].filter(Boolean)) {
      const key = `${customer}|${token}`;

      if (!styleByCustomerNormSets.has(key)) {
        styleByCustomerNormSets.set(key, new Set());
      }

      styleByCustomerNormSets.get(key).add(row.Style);
    }
  }

  const styleByCustomerNorm = new Map(
    [...styleByCustomerNormSets.entries()].map(
      ([key, set]) => [key, [...set]]
    )
  );

  const skuZByStyleColor = new Map();

  for (const row of zRows) {
    addMapArray(
      skuZByStyleColor,
      `${row.Style}|${row.Clr}`,
      row
    );
  }

  const upcByStyleColor = new Map();
  const upcByValue = new Map();

  for (const row of upcRows) {
    addMapArray(
      upcByStyleColor,
      `${row.Style}|${row.Clr}`,
      row
    );
    addMapArray(
      upcByValue,
      String(row['Upc No']).replace(/\D/g, ''),
      row
    );
  }

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
      ['BEALLSOUTL', {
        Customer: 'BEALLSOUTL',
        Terms: 'X6',
        'Ship Via': 'CITYLOG',
        'Def Wh': 'PE',
        Div: 'H'
      }]
    ]),
    skuByStyle,
    skuByNormalizedSku,
    styleByCustomerNorm,
    skuZByStyleColor,
    upcByStyleColor,
    upcByValue,
    warehouseByCode: new Map([
      ['PE', { Wh: 'PE' }]
    ])
  };
}

function citiPrepackRows(style, alias, printedColor, genericCode, nativeCode, masterUpc) {
  return {
    rows: [
      sku(style, genericCode, {
        customer: 'CITI',
        desc: printedColor,
        abbr: printedColor.slice(0, 3),
        scale: 'PC',
        alias: '',
        packQty: '1'
      }),
      sku(style, nativeCode, {
        customer: 'CITI',
        desc: `${printedColor} 6`,
        abbr: `${printedColor.slice(0, 3)}V0`,
        scale: 'v0',
        alias,
        packQty: '6'
      })
    ],
    zRows: [
      z(style, genericCode, 1, 'PC', 1, 'PC', 1),
      z(style, nativeCode, 4, '7', 1, 'v0', 6),
      z(style, nativeCode, 5, '8/10', 2, 'v0', 6),
      z(style, nativeCode, 6, '12/14', 2, 'v0', 6),
      z(style, nativeCode, 7, '16', 1, 'v0', 6)
    ],
    upcRows: [
      upc(style, genericCode, `${masterUpc.slice(0, -1)}1`, '1', 'PC', 'PC'),
      upc(style, nativeCode, masterUpc, '0', 'ALL', 'v0')
    ]
  };
}

function parseLikeCiti({
  styleRaw,
  colorRaw,
  qty = 600,
  customerUpc = '400431982829'
}) {
  return {
    parser: 'cititrends',
    header: {
      customer_code: 'CITI',
      store_code: 'SAME',
      division_code: null,
      warehouse_code: null,
      terms_code: 'X6'
    },
    lines: [{
      line_no: 1,
      customer_sku: '0115-080900-0000001-0010-00000',
      upc: customerUpc,
      style_raw: styleRaw,
      color_raw: colorRaw,
      size_raw: '-',
      qty_total: qty,
      sales_price: 6.5,
      raw: {
        customer_upc_raw: customerUpc,
        quantity_semantics: 'EACH'
      }
    }],
    conflicts: []
  };
}


test('CITI 0000194450 line 2 chooses unique operationally compatible 0C2 and derives v0 buckets', () => {
  const rows = [
    sku('11KS306S9739', '003', {
      customer: 'CITI',
      desc: 'BLACK',
      abbr: 'BLK',
      div: 'AL',
      scale: 'vp',
      alias: '',
      packQty: '7'
    }),
    sku('11KS306S9739', '0C2', {
      customer: 'CITI',
      desc: 'BLACK MULTI PREPACK',
      abbr: 'BLKV0',
      div: 'AL',
      scale: 'v0',
      alias: '',
      packQty: '6'
    })
  ];

  const zRows = [
    z('11KS306S9739', '003', 1, '4', 1, 'vp', 7),
    z('11KS306S9739', '003', 2, '5', 1, 'vp', 7),
    z('11KS306S9739', '003', 3, '6', 1, 'vp', 7),
    z('11KS306S9739', '003', 4, '7', 1, 'vp', 7),
    z('11KS306S9739', '003', 5, '8/10', 1, 'vp', 7),
    z('11KS306S9739', '003', 6, '12/14', 1, 'vp', 7),
    z('11KS306S9739', '003', 7, '16', 1, 'vp', 7),
    z('11KS306S9739', '0C2', 4, '7', 1, 'v0', 6),
    z('11KS306S9739', '0C2', 5, '8/10', 2, 'v0', 6),
    z('11KS306S9739', '0C2', 6, '12/14', 2, 'v0', 6),
    z('11KS306S9739', '0C2', 7, '16', 1, 'v0', 6)
  ];

  const upcRows = [
    upc('11KS306S9739', '003', '400000020846', '1', '4', 'vp'),
    upc('11KS306S9739', '0C2', '199347556766', '0', 'ALL', 'v0')
  ];

  const parsed = parseLikeCiti({
    styleRaw: 'KS306-S9739',
    colorRaw: 'BLACK-OFF BLACK',
    qty: 600,
    customerUpc: '400431982744'
  });

  resolveOrderOfficialMasterIdentity(
    parsed,
    buildMasters(rows, zRows, upcRows)
  );

  const line = parsed.lines[0];
  assert.equal(line.style_code, '11KS306S9739');
  assert.equal(line.color_code, '0C2');
  assert.equal(line.scale_code, 'v0');
  assert.equal(line.master_upc, '199347556766');
  assert.equal(line.qty_sz4, 100);
  assert.equal(line.qty_sz5, 200);
  assert.equal(line.qty_sz6, 200);
  assert.equal(line.qty_sz7, 100);
  assert.equal(
    [line.qty_sz4, line.qty_sz5, line.qty_sz6, line.qty_sz7]
      .reduce((sum, value) => sum + Number(value || 0), 0),
    600
  );
  assert.equal(
    line.raw.universal_official_master_identity.color_source,
    'CITI_UNDISTRIBUTED_EACH_UNIQUE_VR_SKU_Z_OPERATIONAL_COLOR'
  );
});

test('CITI operational override refuses to force a color when two nontrivial VR_SKU_Z candidates are compatible', () => {
  const rows = [
    sku('11AMBIG', '003', {
      customer: 'CITI',
      desc: 'BLACK',
      scale: 'vp',
      alias: 'AMBIG',
      packQty: '6'
    }),
    sku('11AMBIG', '0C2', {
      customer: 'CITI',
      desc: 'BLACK PREPACK',
      scale: 'v0',
      packQty: '6'
    })
  ];

  const zRows = [
    z('11AMBIG', '003', 4, '7', 1, 'vp', 6),
    z('11AMBIG', '003', 5, '8/10', 2, 'vp', 6),
    z('11AMBIG', '003', 6, '12/14', 2, 'vp', 6),
    z('11AMBIG', '003', 7, '16', 1, 'vp', 6),
    z('11AMBIG', '0C2', 4, '7', 1, 'v0', 6),
    z('11AMBIG', '0C2', 5, '8/10', 2, 'v0', 6),
    z('11AMBIG', '0C2', 6, '12/14', 2, 'v0', 6),
    z('11AMBIG', '0C2', 7, '16', 1, 'v0', 6)
  ];

  const parsed = parseLikeCiti({
    styleRaw: 'AMBIG',
    colorRaw: 'BLACK',
    qty: 600
  });

  resolveOrderOfficialMasterIdentity(
    parsed,
    buildMasters(rows, zRows, [])
  );

  assert.notEqual(
    parsed.lines[0].raw.universal_official_master_identity.color_source,
    'CITI_UNDISTRIBUTED_EACH_UNIQUE_VR_SKU_Z_OPERATIONAL_COLOR'
  );
});
