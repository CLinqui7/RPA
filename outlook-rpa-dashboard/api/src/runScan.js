import { scanOutlook } from './rpa/outlookScanner.js';
import { createRun, finishRun, upsertEmails } from './runRepository.js';
import { saveDownloadedDocuments } from './documentRepository.js';
import { config } from './config.js';

export async function runScan() {
  const run = await createRun();
  try {
    const result = await scanOutlook({
      // If OUTLOOK_SCAN_MODE=search, use the invoice subject as search query by default.
      searchQuery: config.outlookSearchQuery || config.invoiceSubjectFilter || 'factura american'
    });

    const inserted = await upsertEmails(result.emails || [], { runId: run.id, allowDuplicates: true });
    const savedDocuments = await saveDownloadedDocuments(result.documents || [], result.logs || [], { runId: run.id, allowDuplicates: true });

    const finished = await finishRun(run.id, {
      status: 'success',
      scanned_count: result.emails?.length || 0,
      inserted_count: inserted.length,
      log: [
        ...(result.logs || []),
        `Accepted duplicate email rows: yes. Inserted ${inserted.length} email event row(s) for this run.`,
        `Saved ${savedDocuments.length} downloaded PDF document(s) in Supabase.`,
        `Subject filter used: ${config.invoiceSubjectFilter || 'factura american'}.`
      ]
    });
    return { run: finished, emails: inserted, documents: savedDocuments, logs: finished.log || result.logs };
  } catch (error) {
    const finished = await finishRun(run.id, {
      status: 'error',
      error_message: error.message,
      log: [{ error: error.message, stack: error.stack }]
    });
    return { run: finished, emails: [], documents: [], logs: [error.message] };
  }
}
