import {
  customerSkuAutoUploadEnabled,
  syncCustomerIdentifiersForDocuments
} from './a2000/customerSkus/customerIdentifierSync.js';
import { config } from './config.js';
import { saveDownloadedDocuments } from './documentRepository.js';
import {
  processScannedDocuments
} from './po/productionWorkflow.js';
import { scanOutlook } from './rpa/outlookScanner.js';
import {
  buildUnreadSearchAttempts,
  subjectFilterAlternatives
} from './rpa/outlookUnreadQueue.js';
import {
  createRun,
  finishRun,
  upsertEmails
} from './runRepository.js';

const RUN_SCAN_REPAIR_VERSION = 'RPA_OUTLOOK_RUNSCAN_ATOMIC_REPAIR_V2';

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['true', '1', 'yes', 'y'].includes(
    String(value).trim().toLowerCase()
  );
}

function dependencyMap() {
  return {
    scanOutlook,
    createRun,
    finishRun,
    upsertEmails,
    saveDownloadedDocuments,
    processScannedDocuments,
    syncCustomerIdentifiersForDocuments,
    customerSkuAutoUploadEnabled
  };
}

export function runScanDependencyStatus() {
  const dependencies = Object.fromEntries(
    Object.entries(dependencyMap()).map(([name, value]) => [
      name,
      typeof value
    ])
  );

  const missing = Object.entries(dependencies)
    .filter(([, type]) => type !== 'function')
    .map(([name]) => name);

  return {
    ok: missing.length === 0,
    version: RUN_SCAN_REPAIR_VERSION,
    dependencies,
    missing
  };
}

function emptyCustomerIdentifierResult({
  uploadRequested,
  stage = 'no_documents'
} = {}) {
  return {
    ok: true,
    stage,
    upload_requested: uploadRequested === true,
    document_count: 0,
    results: []
  };
}

function customerIdentifierSummary(result = {}) {
  const documentResults = Array.isArray(result.results)
    ? result.results
    : [];

  const orderResults = documentResults.flatMap(item => (
    Array.isArray(item?.results) ? item.results : []
  ));

  return {
    upload_requested: result.upload_requested === true,
    document_count: Number(
      result.document_count
      ?? documentResults.length
      ?? 0
    ),
    uploaded_count: orderResults.filter(
      item => item?.stage === 'customer_identifiers_uploaded'
    ).length,
    idempotent_count: orderResults.filter(
      item => item?.stage === 'customer_identifiers_already_synced'
    ).length,
    blocked_count: orderResults.filter(item => item?.ok === false).length,
    no_identifier_count: orderResults.filter(
      item => item?.stage === 'no_explicit_customer_identifiers'
    ).length
  };
}

async function safelyFinishRun(runId, patch, originalError = null) {
  try {
    return await finishRun(runId, patch);
  } catch (finishError) {
    const message = originalError?.message
      || patch?.error_message
      || finishError.message;

    console.error(
      '[RPA_STAGE] FINISH_RUN_FAILED',
      finishError.message
    );

    return {
      id: runId,
      status: patch?.status || 'error',
      error_message: message,
      finish_error: finishError.message,
      log: patch?.log || []
    };
  }
}

export async function runScan() {
  const dependencyStatus = runScanDependencyStatus();

  if (!dependencyStatus.ok) {
    throw new Error(
      `RUN_SCAN_DEPENDENCY_BINDING_FAILED: ${
        dependencyStatus.missing.join(', ')
      }`
    );
  }

  console.log('[RPA_STAGE] CREATE_RUN_STARTED');
  const run = await createRun();
  console.log(`[RPA_STAGE] CREATE_RUN_COMPLETED id=${run.id}`);

  try {
    const subjects = subjectFilterAlternatives(
      config.invoiceSubjectFilter || 'factura american'
    );

    const attempts = buildUnreadSearchAttempts({
      configuredQuery: config.outlookSearchQuery,
      subjectFilter: config.invoiceSubjectFilter || 'factura american'
    });

    const maxEmails = Math.max(
      1,
      Number(config.outlookMaxEmails || 25)
    );

    const mergedEmails = new Map();
    const mergedDocuments = new Map();
    const mergedLogs = [
      `RUN_SCAN_REPAIR_VERSION=${RUN_SCAN_REPAIR_VERSION}`,
      `OUTLOOK_EFFECTIVE_SUBJECT_FILTER=${config.invoiceSubjectFilter}`,
      `OUTLOOK_SUBJECT_ALIASES=${subjects.join(' | ')}`,
      `OUTLOOK_SEARCH_ATTEMPT_COUNT=${attempts.length}`,
      `OUTLOOK_MAX_EMAILS=${maxEmails}`
    ];

    const mergeResult = (result = {}, label) => {
      for (const line of result.logs || []) {
        mergedLogs.push(`[${label}] ${line}`);
      }

      for (const email of result.emails || []) {
        const key = email.externalKey
          || `${email.subject}|${email.senderEmail}|${
            email.receivedAt
          }|${email.poNumber}`;

        if (!mergedEmails.has(key)) {
          mergedEmails.set(key, email);
        }
      }

      for (const document of result.documents || []) {
        const key = document.raw?.sha256
          || document.externalKey
          || `${document.emailExternalKey}|${
            document.fileName
          }|${document.localPath}`;

        if (!mergedDocuments.has(key)) {
          mergedDocuments.set(key, document);
        }
      }
    };

    for (
      let attemptIndex = 0;
      attemptIndex < attempts.length;
      attemptIndex += 1
    ) {
      const query = attempts[attemptIndex];

      mergedLogs.push(
        `OUTLOOK_UNREAD_ATTEMPT=${attemptIndex + 1}/${attempts.length}`
        + `|QUERY=${query}`
      );

      console.log(
        `[RPA_STAGE] OUTLOOK_SEARCH_STARTED `
        + `attempt=${attemptIndex + 1}/${attempts.length}`
      );

      const result = await scanOutlook({
        maxEmails,
        searchQuery: query,
        forceInbox: false
      });

      console.log(
        `[RPA_STAGE] OUTLOOK_SEARCH_COMPLETED `
        + `attempt=${attemptIndex + 1} `
        + `emails=${result.emails?.length || 0} `
        + `pdfs=${result.documents?.length || 0}`
      );

      mergeResult(result, `SEARCH_${attemptIndex + 1}`);

      mergedLogs.push(
        `OUTLOOK_UNREAD_ATTEMPT_RESULT=${attemptIndex + 1}`
        + `|EMAILS=${result.emails?.length || 0}`
        + `|PDFS=${result.documents?.length || 0}`
        + `|MERGED_EMAILS=${mergedEmails.size}`
        + `|MERGED_PDFS=${mergedDocuments.size}`
      );

      if (
        (result.emails?.length || 0) > 0
        || (result.documents?.length || 0) > 0
      ) {
        break;
      }
    }

    const inboxFallbackEnabled = boolEnv(
      process.env.OUTLOOK_ENABLE_INBOX_FALLBACK,
      true
    );

    if (mergedEmails.size === 0 && inboxFallbackEnabled) {
      mergedLogs.push(
        'OUTLOOK_SEARCH_ATTEMPTS_EMPTY=YES'
        + '|NEXT=RAW_INBOX_DOM_FALLBACK'
      );

      console.log('[RPA_STAGE] OUTLOOK_FALLBACK_STARTED');

      const fallback = await scanOutlook({
        maxEmails,
        searchQuery: '',
        forceInbox: true
      });

      mergeResult(fallback, 'INBOX_FALLBACK');

      mergedLogs.push(
        'OUTLOOK_INBOX_FALLBACK_RESULT'
        + `|EMAILS=${fallback.emails?.length || 0}`
        + `|PDFS=${fallback.documents?.length || 0}`
        + `|MERGED_EMAILS=${mergedEmails.size}`
        + `|MERGED_PDFS=${mergedDocuments.size}`
      );
    }

    if (mergedEmails.size === 0 && !inboxFallbackEnabled) {
      mergedLogs.push(
        'OUTLOOK_SEARCH_ATTEMPTS_EMPTY=YES'
        + '|INBOX_FALLBACK_DISABLED=YES'
        + '|RESULT=COMPLETED_WITH_ZERO_MATCHES'
      );
    }

    const result = {
      emails: [...mergedEmails.values()],
      documents: [...mergedDocuments.values()],
      logs: mergedLogs
    };

    console.log(
      `[RPA_STAGE] SAVE_EMAILS_STARTED count=${result.emails.length}`
    );

    const inserted = await upsertEmails(result.emails, {
      runId: run.id,
      allowDuplicates: false
    });

    console.log(
      `[RPA_STAGE] SAVE_DOCUMENTS_STARTED `
      + `count=${result.documents.length}`
    );

    const savedDocuments = await saveDownloadedDocuments(
      result.documents,
      result.logs,
      {
        runId: run.id,
        allowDuplicates: false
      }
    );

    console.log(
      `[RPA_STAGE] PROCESS_DOCUMENTS_STARTED `
      + `count=${savedDocuments.length}`
    );

    // Reading Outlook never creates ORDER_HD or ORDER_LI.
    const processing = await processScannedDocuments(
      savedDocuments,
      { uploadToA2000: false }
    );

    const identifierUploadRequested =
      customerSkuAutoUploadEnabled();

    let customerIdentifierSync = emptyCustomerIdentifierResult({
      uploadRequested: identifierUploadRequested
    });

    if (savedDocuments.length > 0) {
      try {
        customerIdentifierSync =
          await syncCustomerIdentifiersForDocuments(
            savedDocuments.map(document => document.id),
            { upload: identifierUploadRequested }
          );
      } catch (error) {
        customerIdentifierSync = {
          ok: false,
          stage: 'customer_identifier_sync_error',
          upload_requested: identifierUploadRequested,
          document_count: savedDocuments.length,
          results: [],
          error: error.message
        };
      }
    }

    const identifierSummary = customerIdentifierSummary(
      customerIdentifierSync
    );

    const attachmentOccurrences = result.emails.reduce(
      (sum, email) => (
        sum + Number(
          email.raw?.attachment_occurrence_coverage?.expected_count
          || email.raw?.attachment_coverage
            ?.occurrence_coverage?.expected_count
          || email.attachments?.length
          || 0
        )
      ),
      0
    );

    const finished = await safelyFinishRun(run.id, {
      status: 'success',
      scanned_count: result.emails.length,
      inserted_count: inserted.length,
      error_message: null,
      log: [
        ...result.logs,
        `UNREAD_ONLY=true. Matching emails processed: ${
          result.emails.length
        }.`,
        `Attachment occurrences recovered: ${
          attachmentOccurrences
        }.`,
        `Unique PDF documents saved: ${savedDocuments.length}.`,
        `Documents parsed: ${
          processing.processed_document_count
        }.`,
        'A2000 Sales Order auto-upload requested: no.',
        `Customer SKU/UPC master sync: ${
          identifierSummary.upload_requested
            ? 'write enabled'
            : 'preflight only'
        }; documents=${identifierSummary.document_count}; `
        + `uploaded=${identifierSummary.uploaded_count}; `
        + `idempotent=${identifierSummary.idempotent_count}; `
        + `blocked=${identifierSummary.blocked_count}; `
        + `without identifiers=${
          identifierSummary.no_identifier_count
        }.`,
        `Unread search attempts: ${attempts.join(' || ')}.`,
        `Inbox DOM fallback used: ${
          mergedLogs.some(
            line => line.includes('RAW_INBOX_DOM_FALLBACK')
          )
            ? 'yes'
            : 'no'
        }.`
      ]
    });

    console.log('[RPA_STAGE] FINISHED_SUCCESS');

    return {
      ok: true,
      version: RUN_SCAN_REPAIR_VERSION,
      run: finished,
      emails: inserted,
      documents: savedDocuments,
      processing,
      customer_identifiers: customerIdentifierSync,
      logs: finished.log || result.logs
    };
  } catch (error) {
    console.error('[RPA_STAGE] FAILED', error);

    const finished = await safelyFinishRun(
      run.id,
      {
        status: 'error',
        error_message: error.message,
        log: [{
          error: error.message,
          stack: error.stack
        }]
      },
      error
    );

    return {
      ok: false,
      version: RUN_SCAN_REPAIR_VERSION,
      error: error.message,
      run: finished,
      emails: [],
      documents: [],
      processing: null,
      customer_identifiers: null,
      logs: [error.message]
    };
  }
}
