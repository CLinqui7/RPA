import { scanOutlook } from './rpa/outlookScanner.js';
import { createRun, finishRun, upsertEmails } from './runRepository.js';

export async function runScan() {
  const run = await createRun();
  try {
    const result = await scanOutlook();
    const inserted = await upsertEmails(result.emails);
    const finished = await finishRun(run.id, {
      status: 'success',
      scanned_count: result.emails.length,
      inserted_count: inserted.length,
      log: result.logs
    });
    return { run: finished, emails: inserted, logs: result.logs };
  } catch (error) {
    const finished = await finishRun(run.id, {
      status: 'error',
      error_message: error.message,
      log: [{ error: error.message, stack: error.stack }]
    });
    return { run: finished, emails: [], logs: [error.message] };
  }
}
