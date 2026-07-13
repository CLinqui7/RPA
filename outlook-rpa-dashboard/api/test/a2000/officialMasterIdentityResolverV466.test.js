
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

test('CITI alias row keeps exact native color 0C9 and derives v0 size buckets', () => {
  const data = citiPrepackRows(
    '11KS306S9962',
    'KS306-S9962',
    'WHITE',
    '001',
    '0C9',
    '199347556759'
  );

  const masters = buildMasters(
    data.rows,
    data.zRows,
    data.upcRows
  );

  const parsed = parseLikeCiti({
    styleRaw: 'KS306-S9962',
    colorRaw: 'WHITE'
  });

  resolveOrderOfficialMasterIdentity(parsed, masters);

  const line = parsed.lines[0];

  assert.equal(line.style_code, '11KS306S9962');
  assert.equal(line.color_code, '0C9');
  assert.equal(line.master_upc, '199347556759');
  assert.equal(line.qty_sz4, 100);
  assert.equal(line.qty_sz5, 200);
  assert.equal(line.qty_sz6, 200);
  assert.equal(line.qty_sz7, 100);
  assert.equal(parsed.header.division_code, 'AL');
  assert.equal(parsed.header.warehouse_code, 'PE');

  const qty = line.raw.universal_official_qty_resolution;
  assert.deepEqual(qty.size_names_by_bucket, {
    QTY_SZ4: '7',
    QTY_SZ5: '8/10',
    QTY_SZ6: '12/14',
    QTY_SZ7: '16'
  });
});

test('CITI operational VR_SKU_Z evidence beats generic exact color text when alias rows are not color-unique', () => {
  const rows = [
    sku('11JANICET', '001', {
      customer: 'CITI',
      desc: 'WHITE',
      abbr: 'WHT',
      scale: 'PC',
      alias: 'JANICET',
      packQty: '1'
    }),
    sku('11JANICET', '0C8', {
      customer: 'CITI',
      desc: 'WHITE 6',
      abbr: 'WHTV0',
      scale: 'v0',
      alias: 'JANICET',
      packQty: '6'
    })
  ];

  const zRows = [
    z('11JANICET', '001', 1, 'PC', 1, 'PC', 1),
    z('11JANICET', '0C8', 4, '7', 1, 'v0', 6),
    z('11JANICET', '0C8', 5, '8/10', 2, 'v0', 6),
    z('11JANICET', '0C8', 6, '12/14', 2, 'v0', 6),
    z('11JANICET', '0C8', 7, '16', 1, 'v0', 6)
  ];

  const upcRows = [
    upc('11JANICET', '001', '199347000001', '1', 'PC', 'PC'),
    upc('11JANICET', '0C8', '199347000008', '0', 'ALL', 'v0')
  ];

  const parsed = parseLikeCiti({
    styleRaw: 'JANICET',
    colorRaw: 'WHITE',
    qty: 600,
    customerUpc: '400429913804'
  });

  resolveOrderOfficialMasterIdentity(
    parsed,
    buildMasters(rows, zRows, upcRows)
  );

  assert.equal(parsed.lines[0].style_code, '11JANICET');
  assert.equal(parsed.lines[0].color_code, '0C8');
  assert.equal(parsed.lines[0].qty_sz4, 100);
  assert.equal(parsed.lines[0].qty_sz5, 200);
  assert.equal(parsed.lines[0].qty_sz6, 200);
  assert.equal(parsed.lines[0].qty_sz7, 100);
});

test('Bealls documentary terminal variant letter resolves to exact native style base/42 only through master', () => {
  const rows = [
    sku('EHW436-42', 'P28', {
      customer: 'BEALLSOUTL',
      desc: 'PINK/BLACK',
      abbr: 'PNKBLK',
      div: 'H',
      scale: 'PC',
      alias: 'EHW436'
    }),
    sku('EHW452-42', '410', {
      customer: 'BEALLSOUTL',
      desc: 'RED/BLACK',
      abbr: 'REDBLK',
      div: 'H',
      scale: 'PC',
      alias: 'EHW452'
    })
  ];

  const zRows = [
    z('EHW436-42', 'P28', 1, 'PC', 1, 'PC', 1),
    z('EHW452-42', '410', 1, 'PC', 1, 'PC', 1)
  ];

  const upcRows = [
    upc('EHW436-42', 'P28', '199347366991', '1', 'PC', 'PC'),
    upc('EHW452-42', '410', '199347366992', '1', 'PC', 'PC')
  ];

  const masters = buildMasters(rows, zRows, upcRows);

  const parsed = {
    parser: 'bealls',
    header: {
      customer_code: 'BEALLSOUTL',
      store_code: '995',
      warehouse_code: 'PE',
      division_code: null,
      terms_code: 'X6'
    },
    lines: [
      {
        line_no: 2,
        style_raw: 'EHW436B',
        color_raw: 'Pink/Black',
        qty_total: 196,
        sales_price: 6,
        raw: { quantity_semantics: 'EACH' }
      },
      {
        line_no: 3,
        style_raw: 'EHW452A',
        color_raw: 'Red/Black',
        qty_total: 89,
        sales_price: 6,
        raw: { quantity_semantics: 'EACH' }
      }
    ],
    conflicts: []
  };

  resolveOrderOfficialMasterIdentity(parsed, masters);

  assert.equal(parsed.lines[0].style_code, 'EHW436-42');
  assert.equal(parsed.lines[0].color_code, 'P28');
  assert.equal(parsed.lines[0].qty_sz1, 196);
  assert.equal(parsed.lines[1].style_code, 'EHW452-42');
  assert.equal(parsed.lines[1].color_code, '410');
  assert.equal(parsed.lines[1].qty_sz1, 89);
  assert.equal(parsed.header.division_code, 'H');
});

test('resolver never accepts non-native style after variant search', () => {
  const masters = buildMasters([], [], []);

  const result = validateOrderOfficialMasterIdentity({
    customer_code: 'CITI',
    warehouse_code: 'PE',
    purchase_order_lines: [{
      line_no: 1,
      style_code: 'KS306-S9962',
      color_code: 'WHITE',
      warehouse_code: 'PE'
    }]
  }, masters);

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'NON_OFFICIAL_A2000_STYLE');
});
