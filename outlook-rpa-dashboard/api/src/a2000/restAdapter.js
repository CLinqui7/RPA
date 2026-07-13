import { supabase } from '../supabase.js';
import { A2000RestClient } from './restClient.js';
import { A2000ScaleResolver } from './scaleResolver.js';
import {
  buildIdempotencyKey,
  mapOrderHd,
  mapOrderLi,
  quantitiesByBucket,
  validateInternalOrder
} from './restMapper.js';
import {
  createOrLoadA2000Job,
  updateA2000Job
} from './orderJobRepository.js';
import {
  blockingA2000Conflicts
} from './strictImport.js';
import {
  validateOrderOfficialMasterIdentity
} from '../po/enrichment/officialMasterIdentityResolver.js';

const HEADER_CREATED_LINES_FAILED = 'HEADER_CREATED_LINES_FAILED';

function intish(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function uploadSucceeded(result, minimumUpdated = 1) {
  return (
    result?.httpStatus === 200
    && result?.body?.status === 'Success'
    && intish(result?.body?.updated) >= minimumUpdated
  );
}

function resultAudit(result) {
  return {
    http_status: result?.httpStatus ?? 0,
    transport_ok: result?.transportOk ?? false,
    content_type: result?.contentType ?? null,
    duplicate_keys: result?.duplicateKeys || [],
    raw_body: result?.rawBody || '',
    parsed_body: result?.body || null,
    transport_error: result?.transportError || null
  };
}

function verifyHeaderRows(order, viewerRows = []) {
  const expected = mapOrderHd(order);
  const row = viewerRows.length === 1 ? viewerRows[0] : null;

  const checks = {
    customer_match: Boolean(row)
      && String(row.CUSTOMER || '') === String(expected.CUST_NO || ''),
    order_no_match: Boolean(row)
      && String(row.ORDER_NO || '') === String(expected.ORDER_NO || ''),
    store_match: Boolean(row)
      && String(row.STORE || '') === String(expected.STORE_NO || ''),
    division_match: Boolean(row)
      && String(row.DIV || '') === String(expected.DIV_NO || ''),
    terms_match: Boolean(row)
      && String(row.TERMS || '') === String(expected.TERM_NO || ''),
    warehouse_match: Boolean(row)
      && String(row.DEF_WH || '') === String(expected.DEF_WHOUSE || '')
  };

  if (expected.SHIP_VIA_NO) {
    checks.ship_via_match = Boolean(row)
      && String(row.SHIP_VIA || '') === String(expected.SHIP_VIA_NO || '');
  }

  return {
    expected,
    count: viewerRows.length,
    row,
    checks,
    valid: (
      viewerRows.length === 1
      && Object.values(checks).every(Boolean)
    )
  };
}

function canonicalExpectedLine(row) {
  const quantities = {};

  for (let i = 1; i <= 18; i += 1) {
    const value = Number(row[`QTY_SZ${i}`] || 0);
    if (value > 0) quantities[i] = value;
  }

  return {
    line_no: Number(row.LINE_NO),
    style: String(row.STYLE || ''),
    color: String(row.COLOR_NO || ''),
    warehouse: String(row.WHOUSE || ''),
    quantities
  };
}

function verifyLineRows(expectedRows, viewerRows) {
  const actualByLineNo = new Map(
    (viewerRows || []).map(row => [Number(row.LINE_NO), row])
  );

  const checks = expectedRows.map(row => {
    const expected = canonicalExpectedLine(row);
    const actual = actualByLineNo.get(expected.line_no) || null;
    const bucketChecks = {};

    for (let i = 1; i <= 18; i += 1) {
      const expectedQty = Number(expected.quantities[i] || 0);
      const actualQty = Number(actual?.[`OPEN_SZ${i}`] || 0);

      if (expectedQty || actualQty) {
        bucketChecks[`SZ${i}`] = {
          expected: expectedQty,
          actual: actualQty,
          match: expectedQty === actualQty
        };
      }
    }

    const expectedTotal = Object.values(expected.quantities)
      .reduce((sum, quantity) => sum + Number(quantity || 0), 0);

    return {
      line_no: expected.line_no,
      found: Boolean(actual),
      style_match: Boolean(actual) && String(actual.STYLE || '') === expected.style,
      color_match: Boolean(actual) && String(actual.CLR || '') === expected.color,
      warehouse_match: Boolean(actual) && String(actual.WH || '') === expected.warehouse,
      price_match: Boolean(actual)
        && Math.abs(Number(actual.PRICE || 0) - Number(row.SALES_PRICE || 0)) < 0.000001,
      order_qty_match: Boolean(actual)
        && Number(actual.ORDER_QTY || 0) === expectedTotal,
      bucket_checks: bucketChecks,
      buckets_match: Object.values(bucketChecks).every(item => item.match)
    };
  });

  return {
    expected_count: expectedRows.length,
    actual_count: viewerRows.length,
    checks,
    valid: (
      viewerRows.length === expectedRows.length
      && checks.every(check => (
        check.found
        && check.style_match
        && check.color_match
        && check.warehouse_match
        && check.price_match
        && check.order_qty_match
        && check.buckets_match
      ))
    )
  };
}

export class A2000RestAdapter {
  constructor({
    client = new A2000RestClient()
  } = {}) {
    this.client = client;
    this.scaleResolver = new A2000ScaleResolver(client);
  }

  async loadPurchaseOrder(orderId) {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('*, purchase_order_lines(*)')
      .eq('id', orderId)
      .single();

    if (error) throw error;
    return data;
  }

  async verifyExpected(order, seqOrderNo, lineRows) {
    const [headerVerification, lineVerification] = await Promise.all([
      this.client.verifyHeader(seqOrderNo, order.order_no),
      this.client.verifyLines(seqOrderNo)
    ]);

    const headerCheck = verifyHeaderRows(
      order,
      headerVerification.rows
    );

    const lineCheck = verifyLineRows(
      lineRows,
      lineVerification.rows
    );

    return {
      valid: headerCheck.valid && lineCheck.valid,
      header: headerCheck,
      lines: lineCheck
    };
  }

  async preflight(order) {
    const validation = validateInternalOrder(order);
    const idempotencyKey = buildIdempotencyKey(order);
    const sourceGuardErrors = [];
    const blockingConflicts = blockingA2000Conflicts(order);
    const nativeMasterIdentity = validateOrderOfficialMasterIdentity(order);

    if (order.status && String(order.status).toLowerCase() !== 'parsed') {
      sourceGuardErrors.push({
        code: 'ORDER_STATUS_NOT_PARSED',
        status: order.status,
        message: 'Only parsed Internal Orders may enter the A2000 REST adapter.'
      });
    }

    if (blockingConflicts.length) {
      sourceGuardErrors.push({
        code: 'BLOCKING_A2000_CONFLICTS',
        conflict_count: blockingConflicts.length,
        conflicts: blockingConflicts
      });
    }

    if (!nativeMasterIdentity.valid) {
      sourceGuardErrors.push({
        code: 'OFFICIAL_MASTER_IDENTITY_GUARD_FAILED',
        error_count: nativeMasterIdentity.errors.length,
        errors: nativeMasterIdentity.errors,
        message: 'A2000 REST upload is blocked unless every ORDER_LI STYLE/COLOR_NO pair is an exact official VR_SKU identity.'
      });
    }

    const sourceGuard = {
      valid: sourceGuardErrors.length === 0,
      errors: sourceGuardErrors
    };

    const lines = Array.isArray(order.purchase_order_lines)
      ? order.purchase_order_lines
      : Array.isArray(order.lines)
        ? order.lines
        : [];

    let liveScaleValidation = {
      valid: false,
      lines: [],
      skipped: true
    };

    if (validation.valid && sourceGuard.valid) {
      liveScaleValidation = {
        ...(await this.scaleResolver.validateOrder(order)),
        skipped: false
      };
    }

    return {
      valid: (
        validation.valid
        && sourceGuard.valid
        && liveScaleValidation.valid
      ),
      validation,
      source_guard: sourceGuard,
      official_master_identity: nativeMasterIdentity,
      live_scale_validation: liveScaleValidation,
      idempotency_key: idempotencyKey,
      header_preview: mapOrderHd(order),
      line_preview_without_seq: lines.map((line, index) => ({
        line_no: Number(line.line_no || index + 1),
        style: line.style_code,
        color: line.color_code,
        warehouse: line.warehouse_code || order.warehouse_code,
        quantities_by_bucket: quantitiesByBucket(line)
      }))
    };
  }

  async uploadOrderById(orderId, options = {}) {
    const order = await this.loadPurchaseOrder(orderId);
    return this.uploadOrder(order, options);
  }

  async uploadOrder(order, {
    confirmWrite = false
  } = {}) {
    const preflight = await this.preflight(order);

    if (!preflight.valid) {
      return {
        ok: false,
        stage: 'failed_preflight',
        preflight
      };
    }

    if (!confirmWrite) {
      return {
        ok: true,
        stage: 'preflight_only',
        preflight
      };
    }

    this.client.assertWriteEnvironment();
    this.client.assertProductionUploadIsolation();
    this.client.assertSharedLineUploadCleared();

    const idempotencyKey = preflight.idempotency_key;

    const { job: initialJob, created } = await createOrLoadA2000Job({
      idempotencyKey,
      sourcePayloadHash: idempotencyKey,
      order
    });

    let job = initialJob;

    if (job.status === 'completed') {
      return {
        ok: true,
        stage: 'completed_existing',
        idempotent: true,
        created_job: created,
        job,
        preflight
      };
    }

    if (['reconciliation_required', 'manual_review'].includes(job.status)) {
      return {
        ok: false,
        stage: job.status,
        job,
        preflight
      };
    }

    if (job.status === 'failed_header') {
      return {
        ok: false,
        stage: 'failed_header_existing',
        job,
        preflight,
        message: 'The exact idempotency payload already had a definite Header failure. Correct source/mapping and create a new idempotency payload. Do not blind-retry ORDER_HD.'
      };
    }

    if (job.status === 'header_uploading' && !job.a2000_seq_order_no) {
      job = await updateA2000Job(job.id, {
        status: 'reconciliation_required',
        last_error: {
          code: 'AMBIGUOUS_PREVIOUS_HEADER_WRITE',
          message: 'Job was found in header_uploading without persisted SEQ_ORDER_NO. Do not repost ORDER_HD automatically.'
        }
      });

      return {
        ok: false,
        stage: 'reconciliation_required',
        job,
        preflight
      };
    }

    const lines = Array.isArray(order.purchase_order_lines)
      ? order.purchase_order_lines
      : order.lines;

    let seqOrderNo = job.a2000_seq_order_no
      ? Number(job.a2000_seq_order_no)
      : null;

    if (['lines_uploading', 'verifying'].includes(job.status) && seqOrderNo) {
      const expectedRows = lines.map((line, index) => (
        mapOrderLi(order, line, seqOrderNo, index + 1)
      ));

      const verification = await this.verifyExpected(
        order,
        seqOrderNo,
        expectedRows
      );

      if (verification.valid) {
        job = await updateA2000Job(job.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          last_error: null
        });

        return {
          ok: true,
          stage: 'completed_after_reconciliation',
          idempotent: true,
          job,
          preflight,
          verification
        };
      }

      job = await updateA2000Job(job.id, {
        status: 'reconciliation_required',
        last_error: {
          code: 'AMBIGUOUS_PREVIOUS_LINES_WRITE',
          message: 'Job was left in an in-flight Lines state and exact expected Lines are not fully visible. Do not repost ORDER_LI automatically.',
          verification
        }
      });

      return {
        ok: false,
        stage: 'reconciliation_required',
        job,
        preflight,
        verification
      };
    }

    if (!seqOrderNo) {
      const headerRow = mapOrderHd(order);
      const headerRequest = {
        IGNORE_ERRORS: 'N',
        [this.client.headerPayloadKey]: [headerRow]
      };

      job = await updateA2000Job(job.id, {
        status: 'header_uploading',
        attempt_count: Number(job.attempt_count || 0) + 1,
        header_request: headerRequest,
        last_error: null
      });

      const headerResult = await this.client.upload(
        this.client.headerUploadId,
        headerRequest
      );

      const headerAudit = resultAudit(headerResult);

      if (!headerResult.transportOk) {
        job = await updateA2000Job(job.id, {
          status: 'reconciliation_required',
          header_response_raw: headerAudit.raw_body,
          header_response_json: headerAudit.parsed_body,
          last_error: {
            code: 'AMBIGUOUS_HEADER_TRANSPORT_FAILURE',
            transport_error: headerAudit.transport_error
          }
        });

        return {
          ok: false,
          stage: 'reconciliation_required',
          job,
          preflight,
          header: headerAudit
        };
      }

      const responseSeq = headerResult.body?.data?.[0]?.SEQ_ORDER_NO;

      if (!uploadSucceeded(headerResult, 1) || responseSeq === null || responseSeq === undefined) {
        job = await updateA2000Job(job.id, {
          status: 'failed_header',
          header_response_raw: headerAudit.raw_body,
          header_response_json: headerAudit.parsed_body,
          last_error: {
            code: 'HEADER_UPLOAD_FAILED',
            http_status: headerAudit.http_status,
            body: headerAudit.parsed_body
          }
        });

        return {
          ok: false,
          stage: 'failed_header',
          job,
          preflight,
          header: headerAudit
        };
      }

      seqOrderNo = Number(responseSeq);

      job = await updateA2000Job(job.id, {
        status: 'header_created',
        a2000_seq_order_no: seqOrderNo,
        a2000_ctrl_no: seqOrderNo,
        header_response_raw: headerAudit.raw_body,
        header_response_json: headerAudit.parsed_body,
        header_uploaded_at: new Date().toISOString(),
        last_error: null
      });
    }

    if (
      job.status === 'failed_lines'
      && String(process.env.A2000_ORDER_LI_CLEARED || '').toUpperCase() !== 'YES'
    ) {
      return {
        ok: false,
        stage: 'failed_lines_pending_clear',
        job,
        preflight,
        message: 'Header already exists. Inspect/export/CLEAR the configured ORDER_LI Upload Utility pending file, then set A2000_ORDER_LI_CLEARED=YES and resume. Do not recreate the Header.'
      };
    }

    const lineRows = lines.map((line, index) => (
      mapOrderLi(order, line, seqOrderNo, index + 1)
    ));

    const preLineVerification = await this.client.verifyLines(seqOrderNo);

    if (preLineVerification.rows.length) {
      const alreadyVisible = verifyLineRows(lineRows, preLineVerification.rows);

      if (alreadyVisible.valid) {
        job = await updateA2000Job(job.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          last_error: null
        });

        return {
          ok: true,
          stage: 'completed_existing_lines_verified',
          idempotent: true,
          job,
          preflight,
          verification: {
            lines: alreadyVisible
          }
        };
      }

      job = await updateA2000Job(job.id, {
        status: 'reconciliation_required',
        last_error: {
          code: 'UNEXPECTED_LINES_VISIBLE_BEFORE_POST',
          current_line_count: preLineVerification.rows.length,
          line_verification: alreadyVisible
        }
      });

      return {
        ok: false,
        stage: 'reconciliation_required',
        job,
        preflight
      };
    }

    const linesRequest = {
      IGNORE_ERRORS: 'N',
      [this.client.linePayloadKey]: lineRows
    };

    job = await updateA2000Job(job.id, {
      status: 'lines_uploading',
      lines_request: linesRequest,
      last_error: null
    });

    const lineResult = await this.client.upload(
      this.client.lineUploadId,
      linesRequest
    );

    const lineAudit = resultAudit(lineResult);

    if (!lineResult.transportOk) {
      const verification = await this.verifyExpected(
        order,
        seqOrderNo,
        lineRows
      );

      if (verification.valid) {
        job = await updateA2000Job(job.id, {
          status: 'completed',
          lines_response_raw: lineAudit.raw_body,
          lines_response_json: lineAudit.parsed_body,
          completed_at: new Date().toISOString(),
          last_error: null
        });

        return {
          ok: true,
          stage: 'completed_after_lines_transport_reconciliation',
          job,
          preflight,
          lines: lineAudit,
          verification
        };
      }

      job = await updateA2000Job(job.id, {
        status: 'reconciliation_required',
        lines_response_raw: lineAudit.raw_body,
        lines_response_json: lineAudit.parsed_body,
        last_error: {
          code: 'AMBIGUOUS_LINES_TRANSPORT_FAILURE',
          transport_error: lineAudit.transport_error,
          verification
        }
      });

      return {
        ok: false,
        stage: 'reconciliation_required',
        job,
        preflight,
        lines: lineAudit,
        verification
      };
    }

    if (!uploadSucceeded(lineResult, lineRows.length)) {
      const visibleAfterFailure = await this.client.verifyLines(seqOrderNo);
      const nextStatus = visibleAfterFailure.rows.length === 0
        ? 'failed_lines'
        : 'reconciliation_required';

      job = await updateA2000Job(job.id, {
        status: nextStatus,
        lines_response_raw: lineAudit.raw_body,
        lines_response_json: lineAudit.parsed_body,
        last_error: {
          code: nextStatus === 'failed_lines'
            ? HEADER_CREATED_LINES_FAILED
            : 'LINES_UPLOAD_FAILED_BUT_ROWS_VISIBLE',
          http_status: lineAudit.http_status,
          body: lineAudit.parsed_body,
          visible_line_count: visibleAfterFailure.rows.length,
          important: 'Header remains created. Resume Lines using persisted a2000_seq_order_no. Never recreate Header.'
        }
      });

      return {
        ok: false,
        stage: nextStatus,
        job,
        preflight,
        lines: lineAudit,
        visible_lines_after_failure: visibleAfterFailure.rows
      };
    }

    job = await updateA2000Job(job.id, {
      status: 'verifying',
      lines_response_raw: lineAudit.raw_body,
      lines_response_json: lineAudit.parsed_body,
      lines_uploaded_at: new Date().toISOString(),
      last_error: null
    });

    const [headerVerification, lineVerification] = await Promise.all([
      this.client.verifyHeader(seqOrderNo, order.order_no),
      this.client.verifyLines(seqOrderNo)
    ]);

    const verifiedHeader = verifyHeaderRows(
      order,
      headerVerification.rows
    );

    const verifiedLines = verifyLineRows(
      lineRows,
      lineVerification.rows
    );

    if (!verifiedHeader.valid || !verifiedLines.valid) {
      job = await updateA2000Job(job.id, {
        status: 'reconciliation_required',
        last_error: {
          code: 'VIEWER_VERIFICATION_MISMATCH',
          header_verification: verifiedHeader,
          line_verification: verifiedLines
        }
      });

      return {
        ok: false,
        stage: 'reconciliation_required',
        job,
        preflight,
        verification: {
          header: verifiedHeader,
          lines: verifiedLines
        }
      };
    }

    job = await updateA2000Job(job.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      last_error: null
    });

    return {
      ok: true,
      stage: 'completed',
      idempotent: false,
      job,
      preflight,
      a2000: {
        seq_order_no: seqOrderNo,
        ctrl_no: seqOrderNo
      },
      verification: {
        header: verifiedHeader,
        lines: verifiedLines
      }
    };
  }
}
