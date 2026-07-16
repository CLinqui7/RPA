import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { A2000PolicyError } from './errors.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '../../../..');
const cache = new Map();

export function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function normalizeCode(value) {
  return clean(value).toUpperCase();
}

export function defaultMasterPath(fileName) {
  return path.join(projectRoot, 'api', 'masters', fileName);
}

function parseCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(value.trim());
      value = '';
      continue;
    }
    value += char;
  }
  cells.push(value.trim());
  return cells;
}

export function loadCsvMaster(filePath, { requiredColumns = [], bypassCache = false } = {}) {
  const resolved = path.resolve(filePath);
  if (!bypassCache && cache.has(resolved)) return cache.get(resolved);

  if (!fs.existsSync(resolved)) {
    throw new A2000PolicyError(
      'A2000_POLICY_MASTER_MISSING',
      `A2000 policy master is missing: ${resolved}`,
      { file_path: resolved }
    );
  }

  const lines = fs.readFileSync(resolved, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (lines.length < 2) {
    throw new A2000PolicyError(
      'A2000_POLICY_MASTER_EMPTY',
      `A2000 policy master has no data rows: ${resolved}`,
      { file_path: resolved }
    );
  }

  const headers = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  for (const column of requiredColumns) {
    if (!headers.includes(column.toLowerCase())) {
      throw new A2000PolicyError(
        'A2000_POLICY_MASTER_COLUMN_MISSING',
        `Missing column ${column} in ${resolved}`,
        { file_path: resolved, missing_column: column }
      );
    }
  }

  const rows = lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const record = { __row_number: index + 2, __file_path: resolved };
    headers.forEach((header, cellIndex) => {
      record[header] = clean(values[cellIndex]);
    });
    return record;
  });

  const result = { path: resolved, headers, rows };
  cache.set(resolved, result);
  return result;
}

export function isActive(value) {
  return ['Y', 'YES', 'TRUE', '1'].includes(normalizeCode(value));
}

export function isCertified(value) {
  return ['CERTIFIED', 'TENANT_CERTIFIED', 'RUNTIME_CERTIFIED'].includes(
    normalizeCode(value)
  );
}

export function clearMasterCache() {
  cache.clear();
}
