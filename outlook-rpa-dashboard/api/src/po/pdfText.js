import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pdfParse from 'pdf-parse';

const execFileAsync = promisify(execFile);

export async function downloadDocumentBuffer(document) {
  if (!document.storage_bucket || !document.storage_path) {
    throw new Error(`Document ${document.id} has no storage bucket/path`);
  }

  // Lazy import keeps local PDF parser fixtures independent from Supabase credentials.
  const { supabase } = await import('../supabase.js');

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
  // Layout-preserving table anchors for customer-specific raw parsers.
  // Require wide column spacing so collapsed pdf-parse text does not receive the same bonus.
  if (/^Ln\s{2,}SKU\s{2,}Description\s{2,}UPC Number\s+Model#/im.test(t)) score += 6;
  if (/^PO\s{2,}QUANTITY\s{2,}UNIT\s{2,}ITEM NUMBER\s{2,}DESCRIPTION/im.test(t)) score += 6;
  if (/VENDOR STYLE\s{10,}DESCRIPTION\s{10,}REORDER/im.test(t)) score += 6;
  if (/^\s*QTY\s{2,}ITEM #\s{2,}DESCRIPTION\s{2,}UNIT PRICE\s{2,}LINE TOTAL/im.test(t)) score += 7;
  if (/Vendor Style Number\s{2,}Vendor Description\s{2,}NRF Color Desc\s{2,}Backstage Cost\s{2,}Total Units/i.test(t)) score += 7;
  if (/PLN\s*#\s*\/\s*Item\s*#.*Line Status/im.test(t)) score += 7;
  if (/Zumiez #:\s*\d+.*Vendor Style:/is.test(t) && /Cost\/Unit/i.test(t)) score += 7;
  if (/FINELINE HANG TAG/i.test(t) && /BYR#/i.test(t) && /AMERICAN EXCHANGE GROUP/i.test(t)) score += 7;
  if (/Color\/Size\/Diff Summary/i.test(t) && /Cato Style/i.test(t) && /Carton ID #\s{2,}Vendor Style #/i.test(t)) score += 8;
  if (/ROUTING AND DISTRIBUTION INSTRUCTIONS/i.test(t) && /Vendor Style #\s{2,}TJX Style #/i.test(t) && /Total Units/i.test(t)) score += 8;
  if (/DOMESTIC PO NO:/i.test(t) && /PG\/LN\s{2,}CATG\s{2,}UNIT COST/i.test(t) && /VENDOR\s{2,}STYLE/i.test(t)) score += 8;
  if (/Style No\.\s{2,}Description\s{2,}Qty\s{2,}U\/M\s{2,}Inner\s{2,}Case/i.test(t) && /Sb-Class/i.test(t)) score += 8;
  if (/\*\*\s*S\s*T\s*O\s*C\s*K\s*#\s*\*\*.*DESCRIPTION\s{2,}COLOR\s{2,}QUANTITY/im.test(t)) score += 7;
  if (/^\s*QTY\s{2,}CASES\s{2,}WD\s{2,}-\s{2,}\d+/im.test(t) && /^\s*[\d,]+\s{2,}TOTALS\s{2,}/im.test(t)) score += 7;
  if (/Internal Item #\s*\//i.test(t) && /Ticket\s+CS\s+Total/i.test(t) && /Vendor Original/i.test(t) && /GabrielAP@gabes\.net/i.test(t)) score += 7;
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

        // In auto mode, strong customer-table signatures are sufficient evidence
        // to keep the layout-preserving extractor. Do not invoke pdf-parse merely
        // to compare scores in those cases: some customer fonts trigger noisy
        // TrueType warnings even when pdftotext already produced a clean table.
        const layoutScore = scoreTextForTables(layoutText);
        if (layoutScore >= 7) {
          if (debug) console.log(`[pdfText] strong pdftotext layout score=${layoutScore}; skipping pdf-parse comparison`);
          return layoutText;
        }

        const pdfParseText = await extractWithPdfParse(buffer).catch(() => '');
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
