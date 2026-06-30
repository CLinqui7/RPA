import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pdfParse from 'pdf-parse';
import { supabase } from '../supabase.js';

const execFileAsync = promisify(execFile);

export async function downloadDocumentBuffer(document) {
  if (!document.storage_bucket || !document.storage_path) {
    throw new Error(`Document ${document.id} has no storage bucket/path`);
  }

  const { data, error } = await supabase.storage
    .from(document.storage_bucket)
    .download(document.storage_path);

  if (error) throw error;
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function extractWithPdfParse(buffer) {
  const result = await pdfParse(buffer);
  return result.text || '';
}

async function hasPdftotext() {
  try {
    await execFileAsync('pdftotext', ['-v'], { timeout: 3000 });
    return true;
  } catch (error) {
    // poppler's pdftotext returns version on stderr and may exit non-zero on some builds;
    // if command exists, ENOENT will not be present.
    return error?.code !== 'ENOENT';
  }
}

async function extractWithPdftotextLayout(buffer) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2000-pdf-'));
  const pdfPath = path.join(tmpDir, 'source.pdf');
  try {
    await fs.writeFile(pdfPath, buffer);
    const { stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
      timeout: 15000,
      maxBuffer: 20 * 1024 * 1024
    });
    return stdout || '';
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function scoreTextForTables(text = '') {
  const t = String(text || '');
  let score = 0;
  if (/SKU\s+MFG\s+Style\s+MFG\s+Color/i.test(t)) score += 5;
  if (/DEPT\.\s*NUMBER\s*:\s*\d+/i.test(t)) score += 2;
  if (/ORDER\s+NUMBER\s*:\s*\d+/i.test(t)) score += 2;
  if (/\b\d{7,12}\s+[A-Z0-9]+/i.test(t)) score += 3;
  if (/\$\s*\d+(?:\.\d{2})?\s+\d{1,6}\b/.test(t)) score += 3;
  return score;
}

export async function extractPdfTextFromBuffer(buffer) {
  const engine = String(process.env.PDF_TEXT_ENGINE || 'auto').toLowerCase();
  const debug = String(process.env.PDF_TEXT_DEBUG || '').toLowerCase() === 'true';

  if (engine === 'pdfparse') {
    return extractWithPdfParse(buffer);
  }

  if (engine === 'pdftotext' || engine === 'auto') {
    if (await hasPdftotext()) {
      try {
        const layoutText = await extractWithPdftotextLayout(buffer);
        if (engine === 'pdftotext') return layoutText;

        // In auto mode, prefer pdftotext when it preserves tabular rows better.
        const pdfParseText = await extractWithPdfParse(buffer).catch(() => '');
        const layoutScore = scoreTextForTables(layoutText);
        const parseScore = scoreTextForTables(pdfParseText);
        if (debug) {
          console.log(`[pdfText] pdftotext score=${layoutScore}, pdf-parse score=${parseScore}`);
        }
        return layoutScore >= parseScore ? layoutText : pdfParseText;
      } catch (error) {
        if (debug) console.warn(`[pdfText] pdftotext failed, falling back to pdf-parse: ${error.message}`);
        return extractWithPdfParse(buffer);
      }
    }
  }

  return extractWithPdfParse(buffer);
}

export async function extractPdfTextFromDocument(document) {
  const buffer = await downloadDocumentBuffer(document);
  return extractPdfTextFromBuffer(buffer);
}
