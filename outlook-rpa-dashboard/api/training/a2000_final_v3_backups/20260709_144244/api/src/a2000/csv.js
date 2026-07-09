function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function rowsToCsv(columns, rows, { includeHeader = true } = {}) {
  const body = rows.map(row => columns.map(col => escapeCsv(row[col])).join(',')).join('\r\n');
  if (!includeHeader) return body ? `${body}\r\n` : '';
  const header = columns.join(',');
  return body ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}

// Exact A2000 distro/header import layout based on functional file:
// "po 0000193750 distro header".
export const A2000_HEADER_COLUMNS = [
  'SEQ_ORDER_NO',
  'CUST_NO',
  'STORE_NO',
  'ORDER_NO',
  'ORDER_DATE',
  'START_DATE',
  'CANCEL_DATE',
  'BOOK_DATE',
  'CUST_DEPT',
  'REGION',
  'DC_NO',
  'DIV_NO',
  'BOOK_SEASON',
  'SHIP_VIA_NO',
  'PRIORITY',
  'TERM_NO',
  'DISC_CODE',
  'FACTOR_NO',
  'FACTOR_APPR_NO',
  'SMAN1_NO',
  'SMAN2_NO',
  'SMAN3_NO',
  'SMAN1_COMM',
  'SMAN2_COMM',
  'SMAN3_COMM',
  'USER_REF1',
  'USER_REF2',
  'BACK_ORDER',
  'MASTER_INVOICE',
  'REORDER',
  'TAG',
  'ORDER_ALIAS',
  'CURRENCY',
  'EXCHANGE_RATE',
  'USER_REF3',
  'USER_REF4',
  'USER_REF5',
  'DEF_WHOUSE',
  'SH_RULE',
  'FIRST_COST_RULE',
  'PRICE_LIST_ID',
  'PROMO_CODE',
  'ORDER_TYPE',
  'ORDER_HOLD',
  'EVENT_DATE',
  'SALES_TAX1',
  'SALES_TAX2',
  'SALES_TAX1L',
  'TAX_AUTH',
  'STNAME',
  'STADDR_1',
  'STADDR_2',
  'STCITY',
  'STSTATE',
  'POSTAL',
  'COUNTRY',
  'TEL',
  'E_MAIL',
  'TAX_EXEMPT'
];

// Exact A2000 distro/lines import layout based on functional file:
// "po 0000190313 distro lines".
export const A2000_LINE_COLUMNS = [
  'SEQ_ORDER_NO',
  'LINE_NO',
  'CUST_NO',
  '_NO',
  'ORDER_NO',
  'STYLE',
  'COLOR_NO',
  'SALES_PRICE',
  'WHOUSE',
  'QTY_SZ1',
  'QTY_SZ2',
  'QTY_SZ3',
  'QTY_SZ4',
  'QTY_SZ5',
  'QTY_SZ6',
  'QTY_SZ7',
  'QTY_SZ8',
  'QTY_SZ9',
  'QTY_SZ10',
  'QTY_SZ11',
  'QTY_SZ12',
  'QTY_SZ13',
  'QTY_SZ14',
  'QTY_SZ15',
  'QTY_SZ16',
  'QTY_SZ17',
  'QTY_SZ18',
  'SIZE_NO',
  'CUST_STYLE1',
  'CUST_STYLE2',
  'SUB_STYLE',
  'SUB_COLOR_NO',
  'REF',
  'ORDER_ALIAS',
  'LIST_PRICE',
  'SMAN1_NO',
  'SMAN2_NO',
  'SMAN3_NO',
  'SMAN1_COMM',
  'SMAN2_COMM',
  'SMAN3_COMM'
];

// Kept for old UI/debug imports. The actual exported import files now use A2000_* columns.
export const DEMO_HEADER_COLUMNS = A2000_HEADER_COLUMNS;
export const DEMO_LINE_COLUMNS = A2000_LINE_COLUMNS;
