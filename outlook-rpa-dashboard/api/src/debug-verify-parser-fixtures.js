import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parseRawPurchaseOrder } from './po/parsers/index.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(scriptDir, '../training/parser_fixtures');
const fixturePdfRoot = path.resolve(scriptDir, '../training/parser_fixture_pdfs');
let pdfFiles = process.argv.slice(2);

async function walkFiles(dir, predicate) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full, predicate));
    else if (entry.isFile() && predicate(entry.name)) files.push(full);
  }
  return files;
}

async function walkJson(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkJson(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
  }
  return files;
}

function equalValue(actual, expected) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) <= 0.000001;
  }
  return Object.is(actual, expected);
}

function compareSubset(actual, expected, pointer = '$') {
  const failures = [];

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${pointer}: expected array, received ${typeof actual}`];
    if (actual.length !== expected.length) failures.push(`${pointer}.length: expected ${expected.length}, received ${actual.length}`);
    const limit = Math.min(actual.length, expected.length);
    for (let i = 0; i < limit; i += 1) failures.push(...compareSubset(actual[i], expected[i], `${pointer}[${i}]`));
    return failures;
  }

  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${pointer}: expected object, received ${actual === null ? 'null' : typeof actual}`];
    }
    for (const [key, value] of Object.entries(expected)) {
      failures.push(...compareSubset(actual[key], value, `${pointer}.${key}`));
    }
    return failures;
  }

  if (!equalValue(actual, expected)) {
    failures.push(`${pointer}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
  return failures;
}

if (!pdfFiles.length) {
  pdfFiles = await walkFiles(fixturePdfRoot, (name) => /\.pdf$/i.test(name));
}

const pdfByBasename = new Map(pdfFiles.map((file) => [path.basename(file), file]));
const fixtureFiles = await walkJson(fixtureRoot);
const results = [];

for (const fixtureFile of fixtureFiles) {
  const fixture = JSON.parse(await fs.readFile(fixtureFile, 'utf8'));
  const sourcePdfFile = fixture.source_pdf_file;
  const pdfFile = pdfByBasename.get(sourcePdfFile);
  if (!pdfFile) continue;

  try {
    const buffer = await fs.readFile(pdfFile);
    const text = await extractPdfTextFromBuffer(buffer);
    const parsed = parseRawPurchaseOrder({
      text,
      fileName: path.basename(pdfFile),
      document: { file_name: path.basename(pdfFile) }
    });
    const failures = compareSubset(parsed, fixture.expected);
    results.push({
      fixture: path.relative(fixtureRoot, fixtureFile),
      source_pdf_file: sourcePdfFile,
      result: failures.length ? 'FAIL' : 'PASS',
      failures
    });
  } catch (error) {
    results.push({
      fixture: path.relative(fixtureRoot, fixtureFile),
      source_pdf_file: sourcePdfFile,
      result: 'ERROR',
      failures: [error.stack || error.message]
    });
  }
}

if (!results.length) {
  console.error('No fixture matched the PDF basenames supplied.');
  process.exit(1);
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((result) => result.result !== 'PASS');
process.exitCode = failed.length ? 1 : 0;
