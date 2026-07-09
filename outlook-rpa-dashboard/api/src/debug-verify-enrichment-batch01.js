import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrder } from './po/parsers/index.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(scriptDir, '../training/enrichment_fixtures/batch01');
const fixturePdfRoot = path.resolve(scriptDir, '../training/parser_fixture_pdfs');

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
    for (const [key, value] of Object.entries(expected)) failures.push(...compareSubset(actual[key], value, `${pointer}.${key}`));
    return failures;
  }
  if (!equalValue(actual, expected)) failures.push(`${pointer}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  return failures;
}

const fixtureFiles = await walkJson(fixtureRoot);
const results = [];

for (const fixtureFile of fixtureFiles) {
  const fixture = JSON.parse(await fs.readFile(fixtureFile, 'utf8'));
  const pdfFile = path.join(fixturePdfRoot, fixture.source_pdf_file);
  try {
    const buffer = await fs.readFile(pdfFile);
    const text = await extractPdfTextFromBuffer(buffer);
    const parsed = parsePurchaseOrder({
      text,
      fileName: fixture.source_pdf_file,
      document: { file_name: fixture.source_pdf_file }
    });
    const failures = compareSubset(parsed, fixture.expected);
    results.push({
      fixture: path.basename(fixtureFile),
      source_pdf_file: fixture.source_pdf_file,
      result: failures.length ? 'FAIL' : 'PASS',
      failures
    });
  } catch (error) {
    results.push({
      fixture: path.basename(fixtureFile),
      source_pdf_file: fixture.source_pdf_file,
      result: 'ERROR',
      failures: [error.stack || error.message]
    });
  }
}

for (const result of results) {
  console.log(`${result.result} ${result.fixture}`);
  for (const failure of result.failures) console.log(`  - ${failure}`);
}

const failed = results.filter((result) => result.result !== 'PASS');
console.log(`\nBATCH01 ENRICHMENT: ${results.length - failed.length}/${results.length} PASS`);
process.exitCode = failed.length ? 1 : 0;
