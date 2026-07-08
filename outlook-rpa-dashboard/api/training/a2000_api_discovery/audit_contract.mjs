import fs from 'node:fs';
import path from 'node:path';
import {
  A2000_HEADER_COLUMNS,
  A2000_LINE_COLUMNS,
} from '../../src/a2000/csv.js';

const discoveryDir = path.resolve(
  'api/training/a2000_api_discovery'
);

const orderHdPath = path.join(
  discoveryDir,
  'ORDER_HD.define.json'
);

const orderLiPath = path.join(
  discoveryDir,
  'ORDER_LI.define.json'
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function escapeCsv(value) {
  const text = String(value ?? '');

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function auditContract(name, csvColumns, defineColumns) {
  const csvSet = new Set(csvColumns);
  const defineSet = new Set(defineColumns);

  const fields = [];

  for (const [index, field] of csvColumns.entries()) {
    fields.push({
      contract: name,
      field,
      csv: true,
      apiDefine: defineSet.has(field),
      csvOrder: index + 1,
      defineOrder: defineColumns.indexOf(field) + 1 || null,
      status: defineSet.has(field) ? 'MATCH' : 'CSV_ONLY',
    });
  }

  for (const [index, field] of defineColumns.entries()) {
    if (csvSet.has(field)) continue;

    fields.push({
      contract: name,
      field,
      csv: false,
      apiDefine: true,
      csvOrder: null,
      defineOrder: index + 1,
      status: 'DEFINE_ONLY',
    });
  }

  return {
    name,
    csvFieldCount: csvColumns.length,
    defineFieldCount: defineColumns.length,
    matchCount: fields.filter((f) => f.status === 'MATCH').length,
    csvOnlyCount: fields.filter((f) => f.status === 'CSV_ONLY').length,
    defineOnlyCount: fields.filter((f) => f.status === 'DEFINE_ONLY').length,
    fields,
  };
}

const orderHd = readJson(orderHdPath);
const orderLi = readJson(orderLiPath);

if (
  !Array.isArray(orderHd.ORDER_HD) ||
  typeof orderHd.ORDER_HD[0] !== 'object'
) {
  throw new Error('Invalid ORDER_HD define response');
}

if (
  !Array.isArray(orderLi.ORDER_LI) ||
  typeof orderLi.ORDER_LI[0] !== 'object'
) {
  throw new Error('Invalid ORDER_LI define response');
}

const headerDefineColumns = Object.keys(orderHd.ORDER_HD[0]);
const lineDefineColumns = Object.keys(orderLi.ORDER_LI[0]);

const audit = {
  generatedAt: new Date().toISOString(),
  source: {
    csv: 'api/src/a2000/csv.js',
    orderHd: 'ORDER_HD.define.json',
    orderLi: 'ORDER_LI.define.json',
  },
  contracts: [
    auditContract(
      'ORDER_HD',
      A2000_HEADER_COLUMNS,
      headerDefineColumns
    ),
    auditContract(
      'ORDER_LI',
      A2000_LINE_COLUMNS,
      lineDefineColumns
    ),
  ],
};

const jsonPath = path.join(
  discoveryDir,
  'contract_audit.json'
);

fs.writeFileSync(
  jsonPath,
  JSON.stringify(audit, null, 2) + '\n'
);

const csvColumns = [
  'contract',
  'field',
  'csv',
  'api_define',
  'csv_order',
  'define_order',
  'status',
];

const csvRows = [
  csvColumns.join(','),
];

for (const contract of audit.contracts) {
  for (const field of contract.fields) {
    csvRows.push([
      contract.name,
      field.field,
      field.csv,
      field.apiDefine,
      field.csvOrder ?? '',
      field.defineOrder ?? '',
      field.status,
    ].map(escapeCsv).join(','));
  }
}

const csvPath = path.join(
  discoveryDir,
  'contract_audit.csv'
);

fs.writeFileSync(
  csvPath,
  csvRows.join('\r\n') + '\r\n'
);

const md = [];

md.push('# A2000 Upload Contract Audit');
md.push('');
md.push(`Generated: ${audit.generatedAt}`);
md.push('');

for (const contract of audit.contracts) {
  md.push(`## ${contract.name}`);
  md.push('');
  md.push(`- CSV fields: ${contract.csvFieldCount}`);
  md.push(`- API Define fields: ${contract.defineFieldCount}`);
  md.push(`- MATCH: ${contract.matchCount}`);
  md.push(`- CSV_ONLY: ${contract.csvOnlyCount}`);
  md.push(`- DEFINE_ONLY: ${contract.defineOnlyCount}`);
  md.push('');
  md.push('| Field | CSV Order | Define Order | Status |');
  md.push('|---|---:|---:|---|');

  for (const field of contract.fields) {
    md.push(
      `| ${field.field} | ${field.csvOrder ?? ''} | ${field.defineOrder ?? ''} | ${field.status} |`
    );
  }

  md.push('');
}

const mdPath = path.join(
  discoveryDir,
  'CONTRACT_AUDIT.md'
);

fs.writeFileSync(
  mdPath,
  md.join('\n') + '\n'
);

for (const contract of audit.contracts) {
  console.log(`=== ${contract.name} ===`);
  console.log(`CSV_FIELDS=${contract.csvFieldCount}`);
  console.log(`DEFINE_FIELDS=${contract.defineFieldCount}`);
  console.log(`MATCH=${contract.matchCount}`);
  console.log(`CSV_ONLY=${contract.csvOnlyCount}`);
  console.log(`DEFINE_ONLY=${contract.defineOnlyCount}`);

  console.log(
    'CSV_ONLY_FIELDS=' +
    contract.fields
      .filter((f) => f.status === 'CSV_ONLY')
      .map((f) => f.field)
      .join(',')
  );

  console.log(
    'DEFINE_ONLY_FIELDS=' +
    contract.fields
      .filter((f) => f.status === 'DEFINE_ONLY')
      .map((f) => f.field)
      .join(',')
  );

  console.log();
}

console.log(`JSON=${jsonPath}`);
console.log(`CSV=${csvPath}`);
console.log(`MD=${mdPath}`);
