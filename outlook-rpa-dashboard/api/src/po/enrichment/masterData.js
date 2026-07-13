import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A2000_V4_6_1_MASTER_PATH_RUNTIME_REPAIR
// Anchor master paths to the API source tree instead of process.cwd().
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const PROJECT_ROOT = path.resolve(API_ROOT, '..');

function resolveConfiguredPath(value, fallbackPath) {
  const raw = String(value || '').trim();
  if (!raw) return path.resolve(fallbackPath);
  if (path.isAbsolute(raw)) return path.resolve(raw);

  const candidates = [
    path.resolve(PROJECT_ROOT, raw),
    path.resolve(API_ROOT, raw),
    path.resolve(process.cwd(), raw)
  ];

  return candidates.find((candidate) => fs.existsSync(candidate))
    || candidates[0];
}

const MASTER_DIR = resolveConfiguredPath(
  process.env.A2000_MASTER_DIR,
  path.join(API_ROOT, 'masters')
);

const CACHE_DIR = resolveConfiguredPath(
  process.env.A2000_MASTER_CACHE_DIR,
  path.join(MASTER_DIR, 'cache')
);
let cache = null;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function norm(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normText(value) {
  return clean(value).toUpperCase().replace(/\s+/g, ' ');
}

const ADDRESS_TOKEN_ALIASES = new Map([
  ['STREET', 'ST'], ['ST', 'ST'],
  ['DRIVE', 'DR'], ['DR', 'DR'],
  ['AVENUE', 'AVE'], ['AVE', 'AVE'],
  ['PARKWAY', 'PKWY'], ['PKWY', 'PKWY'],
  ['ROAD', 'RD'], ['RD', 'RD'],
  ['BOULEVARD', 'BLVD'], ['BLVD', 'BLVD'],
  ['HIGHWAY', 'HWY'], ['HWY', 'HWY'],
  ['SUITE', 'STE'], ['STE', 'STE'],
  ['FLOOR', 'FL'], ['FL', 'FL'],
  ['WEST', 'W'], ['W', 'W'],
  ['EAST', 'E'], ['E', 'E'],
  ['NORTH', 'N'], ['N', 'N'],
  ['SOUTH', 'S'], ['S', 'S']
]);

function normAddressPart(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => ADDRESS_TOKEN_ALIASES.get(token) || token)
    .join('');
}

function addressKey(customer, address1, city, state, postal) {
  const cust = clean(customer).toUpperCase();
  const parts = [
    normAddressPart(address1),
    normAddressPart(city),
    normAddressPart(state),
    normAddressPart(postal)
  ];
  if (!cust || parts.some((part) => !part)) return '';
  return `${cust}|${parts.join('|')}`;
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  const value = String(line || '');
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const next = value[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map(clean);
}

function readCompactCsv(fileName) {
  const filePath = path.join(CACHE_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => clean(line));
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
    return row;
  });
}

function emptyCache(error = null) {
  return {
    loaded: false,
    masterDir: MASTER_DIR,
    cacheDir: CACHE_DIR,
    error,
    counts: {},
    customerByCode: new Map(),
    customerByName: new Map(),
    storeByCustomerStore: new Map(),
    storeByCustomerAddressNorm: new Map(),
    storesByCustomer: new Map(),
    defaultStoreByCustomer: new Map(),
    skuByStyleColor: new Map(),
    skuByStyle: new Map(),
    skuByNormalizedSku: new Map(),
    skuZByStyleColor: new Map(),
    skuZByStyleColorSize: new Map(),
    styleByCustomerNorm: new Map(),
    upcByStyleColor: new Map(),
    upcByStyleColorSize: new Map(),
    upcByValue: new Map(),
    sizeSlotsByScale: new Map(),
    colorByCode: new Map(),
    warehouseByCode: new Map()
  };
}

function addToSetMap(map, key, value) {
  if (!key || !value) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function buildFromCompactCsv() {
  const manifestPath = path.join(CACHE_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return emptyCache(`Compact master cache not found. Build it with: python3 api/scripts/build-master-cache.py ${MASTER_DIR}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const cacheVersion = Number(manifest.version || 0);
  if (
    cacheVersion < 9
    || manifest.source_policy !== 'official_masters_only'
    || manifest.customer_profile_policy !== 'master_only_all_customers_v1'
    || manifest.store_csv_policy !== 'reject_shifted_columns_preserve_customer_store_keys_v1'
    || manifest.size_bucket_policy !== 'vr_sku_z_size_num_to_qty_szn_v1'
  ) {
    return emptyCache(`Compact master cache v9 with official_masters_only + hardened store CSV + VR_SKU_Z SIZE_NUM bucket policy is required. Rebuild with: python3 api/scripts/build-master-cache.py ${MASTER_DIR}`);
  }
  const customers = readCompactCsv('customers.csv');
  const stores = readCompactCsv('stores.csv');
  const skuRows = readCompactCsv('sku.csv');
  const skuZRows = readCompactCsv('sku_z.csv');
  const upcRows = readCompactCsv('upc.csv');
  const colorRows = readCompactCsv('colors.csv');
  const warehouseRows = readCompactCsv('warehouses.csv');

  const customerByCode = new Map();
  const customerNameCodeSets = new Map();
  for (const row of customers) {
    const code = clean(row.customer).toUpperCase();
    if (!code) continue;
    customerByCode.set(code, {
      Customer: code,
      'Cust Name': row.name,
      Terms: row.terms,
      'Terms Description': row.terms_description,
      'Ship Via': row.ship_via,
      'Def Wh': row.def_wh,
      Div: row.div,
      Active: row.active,
      'Addr 1': row.addr1,
      City: row.city,
      State: row.state,
      Postal: row.postal
    });
    if (row.name_norm) {
      if (!customerNameCodeSets.has(row.name_norm)) customerNameCodeSets.set(row.name_norm, new Set());
      customerNameCodeSets.get(row.name_norm).add(code);
    }
  }
  const customerByName = new Map();
  for (const [nameNorm, codes] of customerNameCodeSets.entries()) {
    if (codes.size !== 1) continue;
    const [code] = [...codes];
    const row = customerByCode.get(code);
    if (row) customerByName.set(nameNorm, row);
  }

  const storeByCustomerStore = new Map();
  const storesByCustomer = new Map();
  for (const row of stores) {
    const customer = clean(row.customer).toUpperCase();
    const store = clean(row.store).toUpperCase();
    if (!customer || !store) continue;
    const rec = {
      Customer: customer,
      Store: store,
      'St Name': row.name,
      'St Addr 1': row.addr1,
      'St City': row.city,
      'St State': row.state,
      'St Postal': row.postal,
      'Ship Via': row.ship_via,
      Wh: row.wh,
      Active: row.active,
      'Source Row Status': row.source_row_status || 'ok'
    };
    storeByCustomerStore.set(`${customer}|${store}`, rec);
    if (!storesByCustomer.has(customer)) storesByCustomer.set(customer, []);
    storesByCustomer.get(customer).push(rec);
  }

  const storeByCustomerAddressNorm = new Map();
  for (const [customer, rows] of storesByCustomer.entries()) {
    for (const row of rows) {
      const key = addressKey(customer, row['St Addr 1'], row['St City'], row['St State'], row['St Postal']);
      if (!key) continue;
      if (!storeByCustomerAddressNorm.has(key)) storeByCustomerAddressNorm.set(key, []);
      storeByCustomerAddressNorm.get(key).push(row);
    }
  }

  const defaultStoreByCustomer = new Map();
  for (const [customer, rows] of storesByCustomer.entries()) {
    const active = rows.filter((row) => clean(row.Active).toUpperCase() === 'Y');
    const preferred = active.find((row) => clean(row.Store).toUpperCase() === 'SAME')
      || active.find((row) => clean(row.Store).toUpperCase() === 'MASTR')
      || active[0]
      || rows.find((row) => clean(row.Store).toUpperCase() === 'SAME')
      || rows[0]
      || null;
    if (preferred) defaultStoreByCustomer.set(customer, preferred);
  }

  const skuByStyleColor = new Map();
  const skuByStyle = new Map();
  const skuByNormalizedSku = new Map();
  const styleByCustomerNormSets = new Map();
  for (const row of skuRows) {
    const style = clean(row.style).toUpperCase();
    const clr = clean(row.clr).toUpperCase();
    if (!style) continue;
    const rec = {
      Style: style,
      Clr: clr,
      'Style Descr': row.style_descr,
      'Clr Desc': row.clr_desc,
      'Clr Abbr': row.clr_abbr,
      Sku: row.sku,
      'Sku Descr': row.sku_descr,
      Scale: row.scale,
      'Scale Abbr': row.scale_abbr,
      Div: row.div,
      Customer: row.customer || 'STOCK',
      'Master Style': row.master_style,
      'Style Alias': row.style_alias,
      'Invoice Descr': row.invoice_descr,
      Price: row.price,
      'Pack Qty': row.pack_qty,
      Wh: row.wh
    };
    if (style && clr && !skuByStyleColor.has(`${style}|${clr}`)) skuByStyleColor.set(`${style}|${clr}`, rec);
    if (!skuByStyle.has(style)) skuByStyle.set(style, []);
    skuByStyle.get(style).push(rec);
    const skuNorm = norm(row.sku);
    if (skuNorm) {
      if (!skuByNormalizedSku.has(skuNorm)) skuByNormalizedSku.set(skuNorm, []);
      skuByNormalizedSku.get(skuNorm).push(rec);
    }
    const customer = clean(row.customer).toUpperCase() || 'STOCK';
    [row.style_norm, row.master_style_norm, row.style_alias_norm].filter(Boolean).forEach((token) => addToSetMap(styleByCustomerNormSets, `${customer}|${token}`, style));
  }
  const styleByCustomerNorm = new Map([...styleByCustomerNormSets.entries()].map(([key, set]) => [key, [...set]]));

  const skuZByStyleColor = new Map();
  const skuZByStyleColorSize = new Map();
  for (const row of skuZRows) {
    const style = clean(row.style).toUpperCase();
    const clr = clean(row.clr).toUpperCase();
    if (!style || !clr) continue;

    const rec = {
      Style: style,
      Clr: clr,
      Sku: row.sku,
      'Size Name': row.size_name,
      'Size Num': row.size_num,
      'Scale Qty': row.scale_qty,
      'Scale Pack Qty': row.scale_pack_qty,
      'Pack Qty': row.pack_qty,
      Div: row.div,
      Scale: row.scale,
      'Scale Abbr': row.scale_abbr,
      Active: row.active
    };

    const key = `${style}|${clr}`;
    if (!skuZByStyleColor.has(key)) skuZByStyleColor.set(key, []);
    skuZByStyleColor.get(key).push(rec);

    if (row.size_norm) {
      const sizeKey = `${style}|${clr}|${row.size_norm}`;
      if (!skuZByStyleColorSize.has(sizeKey)) skuZByStyleColorSize.set(sizeKey, []);
      skuZByStyleColorSize.get(sizeKey).push(rec);
    }
  }

  const upcByStyleColor = new Map();
  const upcByStyleColorSize = new Map();
  const upcByValue = new Map();
  const sizeSlotsByScale = new Map();
  for (const row of upcRows) {
    const style = clean(row.style).toUpperCase();
    const clr = clean(row.clr).toUpperCase();
    if (!style || !clr) continue;
    const rec = {
      'Upc No': row.upc,
      Style: style,
      Clr: clr,
      'Clr Desc': row.clr_desc,
      'Clr Abbr': row.clr_abbr,
      'Size Name': row.size_name,
      'Size Num': row.size_num,
      Sku: row.sku,
      Div: row.div,
      Scale: row.scale,
      'Scale Abbr': row.scale_abbr,
      Price: row.price,
      'Pack Qty': row.pack_qty
    };
    const upc = clean(row.upc).replace(/[^0-9]/g, '');
    if (upc) {
      if (!upcByValue.has(upc)) upcByValue.set(upc, []);
      upcByValue.get(upc).push(rec);
    }
    const key = `${style}|${clr}`;
    if (!upcByStyleColor.has(key)) upcByStyleColor.set(key, []);
    upcByStyleColor.get(key).push(rec);
    if (row.size_norm) {
      const sizeKey = `${style}|${clr}|${row.size_norm}`;
      if (!upcByStyleColorSize.has(sizeKey)) upcByStyleColorSize.set(sizeKey, []);
      upcByStyleColorSize.get(sizeKey).push(rec);
    }
    const scaleCode = clean(row.scale).toUpperCase();
    const sizeNum = Number.parseInt(clean(row.size_num), 10);
    if (scaleCode && Number.isInteger(sizeNum) && sizeNum >= 1 && sizeNum <= 18) {
      if (!sizeSlotsByScale.has(scaleCode)) sizeSlotsByScale.set(scaleCode, new Map());
      const slotMap = sizeSlotsByScale.get(scaleCode);
      if (!slotMap.has(sizeNum)) slotMap.set(sizeNum, new Set());
      slotMap.get(sizeNum).add(clean(row.size_name).toUpperCase());
    }
  }

  const colorByCode = new Map();
  for (const row of colorRows) {
    const code = clean(row.code).toUpperCase();
    if (code) colorByCode.set(code, { 'Color Code': code, 'Color Abbr': row.abbr, 'Color Description': row.description, 'Nrf Color No': row.nrf, Active: row.active });
  }

  const warehouseByCode = new Map();
  for (const row of warehouseRows) {
    const code = clean(row.wh).toUpperCase();
    if (code) warehouseByCode.set(code, { Wh: code, 'Wh Name': row.name, 'Wh Type': row.type, 'Wh Addr 1': row.addr1, 'Wh Addr 2': row.addr2, 'Wh City': row.city, 'Wh State': row.state, 'Wh Postal': row.postal, 'Wh Country': row.country, 'Wh Active': row.active });
  }

  return {
    loaded: true,
    masterDir: MASTER_DIR,
    cacheDir: CACHE_DIR,
    counts: manifest.counts || {},
    customerByCode,
    customerByName,
    storeByCustomerStore,
    storeByCustomerAddressNorm,
    storesByCustomer,
    defaultStoreByCustomer,
    skuByStyleColor,
    skuByStyle,
    skuByNormalizedSku,
    skuZByStyleColor,
    skuZByStyleColorSize,
    styleByCustomerNorm,
    upcByStyleColor,
    upcByStyleColorSize,
    upcByValue,
    sizeSlotsByScale,
    colorByCode,
    warehouseByCode
  };
}

export function loadMasterData() {
  if (cache) return cache;
  try {
    cache = buildFromCompactCsv();
  } catch (error) {
    cache = emptyCache(error.message);
  }
  return cache;
}

export function normalizeMasterToken(value) {
  return norm(value);
}

export function cleanMasterValue(value) {
  return clean(value);
}

export function normalizeMasterText(value) {
  return normText(value);
}

export function normalizeMasterAddressParts({ customer, address1, city, state, postal } = {}) {
  return addressKey(customer, address1, city, state, postal);
}
