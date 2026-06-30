import { scanOutlook } from './rpa/outlookScanner.js';
import { createRun, finishRun, upsertEmails } from './runRepository.js';
import { saveDownloadedDocuments } from './documentRepository.js';

export async function runScan() {
  const run = await createRun();
  try {
    const result = await scanOutlook();
    const inserted = await upsertEmails(result.emails || []);
    const savedDocuments = await saveDownloadedDocuments(result.documents || [], result.logs || []);
    const finished = await finishRun(run.id, {
      status: 'success',
      scanned_count: result.emails?.length || 0,
      inserted_count: inserted.length,
      log: [
        ...(result.logs || []),
        `Saved ${savedDocuments.length} downloaded PDF document(s) in Supabase.`
      ]
    });
    return { run: finished, emails: inserted, documents: savedDocuments, logs: result.logs };
  } catch (error) {
    const finished = await finishRun(run.id, {
      status: 'error',
      error_message: error.message,
      log: [{ error: error.message, stack: error.stack }]
    });
    return { run: finished, emails: [], documents: [], logs: [error.message] };
  }
}
