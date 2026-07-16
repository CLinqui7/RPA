import { syncCustomerIdentifiersForDocuments, customerSkuAutoUploadEnabled } from './a2000/customerSkus/customerIdentifierSync.js';
import { config } from './config.js';
import {
  buildUnreadSearchAttempts,
  subjectFilterAlternatives
} from './rpa/outlookUnreadQueue.js';

import {
  createRun,
  finishRun
} from './runRepository.js';
export async function runScan() {
  console.log('[RPA_STAGE] CREATE_RUN_STARTED');
  const run = await createRun();
  console.log(`[RPA_STAGE] CREATE_RUN_COMPLETED id=${run.id}`);

  try {
    const subjects = subjectFilterAlternatives(
      config.invoiceSubjectFilter || 'factura american'
    );
    const allAttempts = buildUnreadSearchAttempts({
      configuredQuery: config.outlookSearchQuery,
      subjectFilter: config.invoiceSubjectFilter || 'factura american'
    });

    // Fast mode: use only the first Outlook search attempt.
    // If it finds nothing, move immediately to the raw Inbox fallback.
    const attempts = allAttempts.slice(0, 1);
    const maxEmails = Math.max(1, Number(config.outlookMaxEmails || 25));
    const mergedEmails = new Map();
    const mergedDocuments = new Map();
    const mergedLogs = [
      `OUTLOOK_EFFECTIVE_SUBJECT_FILTER=${config.invoiceSubjectFilter}`,
      `OUTLOOK_SUBJECT_ALIASES=${subjects.join(' | ')}`
    ];

    const mergeResult = (result, label) => {
      for (const line of result.logs || []) {
        mergedLogs.push(`[${label}] ${line}`);
      }

      for (const email of result.emails || []) {
        const key = email.externalKey
          || `${email.subject}|${email.senderEmail}|${email.receivedAt}|${email.poNumber}`;
        if (!mergedEmails.has(key)) mergedEmails.set(key, email);
      }

      for (const document of result.documents || []) {
        const key = document.raw?.sha256
          || document.externalKey
          || `${document.emailExternalKey}|${document.fileName}|${document.localPath}`;
        if (!mergedDocuments.has(key)) mergedDocuments.set(key, document);
      }
    };

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const query = attempts[attemptIndex];

      mergedLogs.push(
        `OUTLOOK_UNREAD_ATTEMPT=${attemptIndex + 1}/${attempts.length}`
        + `|QUERY=${query}`
      );

      console.log(`[RPA_STAGE] OUTLOOK_SEARCH_STARTED attempt=${attemptIndex + 1}`);
      const result = await scanOutlook({
        maxEmails,
        searchQuery: query,
        forceInbox: false
      });

      console.log(`[RPA_STAGE] OUTLOOK_SEARCH_COMPLETED attempt=${attemptIndex + 1} emails=${result.emails?.length || 0} pdfs=${result.documents?.length || 0}`);
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

    const inboxFallbackEnabled =
      String(process.env.OUTLOOK_ENABLE_INBOX_FALLBACK || '')
        .trim()
        .toLowerCase() === 'true';

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
        `OUTLOOK_INBOX_FALLBACK_RESULT`
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

    console.log(`[RPA_STAGE] SAVE_EMAILS_STARTED count=${result.emails.length}`);
    const inserted = await upsertEmails(result.emails, {
      runId: run.id,
      allowDuplicates: false
    });

    console.log(`[RPA_STAGE] SAVE_DOCUMENTS_STARTED count=${result.documents.length}`);
    const savedDocuments = await saveDownloadedDocuments(
      result.documents,
      result.logs,
      {
        runId: run.id,
        allowDuplicates: false
      }
    );

    // Reading Outlook never creates A2000 Sales Orders.
    console.log(`[RPA_STAGE] PROCESS_DOCUMENTS_STARTED count=${savedDocuments.length}`);
    const processing = await processScannedDocuments(savedDocuments, {
      uploadToA2000: false
    });

    let customerIdentifierSync;
    try {
      customerIdentifierSync = await syncCustomerIdentifiersForDocuments(
        savedDocuments.map(document => document.id),
        { upload: customerSkuAutoUploadEnabled() }
      );
    } catch (error) {
      customerIdentifierSync = {
        ok: false,
        stage: 'customer_identifier_sync_error',
        error: error.message
      };
    }

    const customerIdentifiers = await syncCustomerIdentifiersForDocuments(
      savedDocuments.map(document => document.id),
      { upload: customerSkuAutoUploadEnabled() }
    );

    const attachmentOccurrences = result.emails.reduce((sum, email) => (
      sum + Number(
        email.raw?.attachment_occurrence_coverage?.expected_count
        || email.raw?.attachment_coverage?.occurrence_coverage?.expected_count
        || email.attachments?.length
        || 0
      )
    ), 0);

    const finished = await finishRun(run.id, {
      status: 'success',
      scanned_count: result.emails.length,
      inserted_count: inserted.length,
      log: [
        ...result.logs,
        `UNREAD_ONLY=true. Matching emails processed: ${result.emails.length}.`,
        `Attachment occurrences recovered: ${attachmentOccurrences}.`,
        `Unique PDF documents saved: ${savedDocuments.length}.`,
        `Documents parsed: ${processing.processed_document_count}.`,
        'A2000 auto-upload requested: no.',
        `Customer identifier sync: ${customerIdentifierSync?.ok ? 'ok' : 'review'}; uploads=${customerIdentifierSync?.results?.filter(item => item.results?.some(order => order.stage === 'customer_identifiers_uploaded')).length || 0}.`,
        `Customer SKU/UPC master sync: ${customerIdentifiers.upload_requested ? 'write enabled' : 'preflight only'}; ${customerIdentifiers.results?.length || 0} document(s).`,
        `Unread search attempts: ${attempts.join(' || ')}.`,
        `Inbox DOM fallback used: ${mergedLogs.some(line => line.includes('RAW_INBOX_DOM_FALLBACK')) ? 'yes' : 'no'}.`
      ]
    });

    console.log('[RPA_STAGE] FINISHED_SUCCESS');
    return {
      customerIdentifierSync,
      run: finished,
      emails: inserted,
      documents: savedDocuments,
      processing,
      customer_identifiers: customerIdentifiers,
      logs: finished.log || result.logs
    };
  } catch (error) {
    const finished = await finishRun(run.id, {
      status: 'error',
      error_message: error.message,
      log: [{ error: error.message, stack: error.stack }]
    });

    return {
      run: finished,
      emails: [],
      documents: [],
      processing: null,
      logs: [error.message]
    };
  }
}
