import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  customerSkuAutoUploadEnabled,
  preflightCustomerIdentifiers,
  reconcilePendingCustomerIdentifiers,
  startCustomerIdentifierWatcher,
  syncCustomerIdentifiersForDocument,
  syncCustomerIdentifiersForOrder
} from './customerSkus/customerIdentifierSync.js';
import { supabase } from '../supabase.js';
import {
  checklistPathForPickTicketDocument,
  generateChecklistForPickTicketDocument
} from './pickTickets/controlChecklistService.js';
import {
  listPickTicketDocuments,
  pickTicketPdfByDocumentId,
  pickTicketPersistenceWatcherStatus,
  reconcilePickTicketDirectory,
  startPickTicketPersistenceWatcher
} from './pickTickets/pickTicketDocumentService.js';
import {
  listPickTicketSnapshots,
  pickTicketSnapshotWatcherStatus,
  reconcilePickTicketSnapshots,
  startPickTicketSnapshotWatcher
} from './pickTickets/pickTicketSnapshotService.js';
import {
  listOperationalOrders,
  uploadOrderWorkflow
} from '../po/productionWorkflow.js';

async function orderById(orderId) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('id', orderId)
    .single();
  if (error) throw error;
  return data;
}

export function createOperationalExtensionsRouter() {
  const router = express.Router();

  router.get('/operational-extensions/status', (_req, res) => {
    res.json({
      ok: true,
      customer_identifiers: {
        auto_upload_enabled: customerSkuAutoUploadEnabled(),
        upload_id: process.env.A2000_CUSTOMER_SKUS_UPLOAD_ID
          || 'CUST_SKUS',
        policy: 'EXPLICIT_CUSTOMER_IDENTIFIERS_ONLY',
        missing_identifier_behavior: (
          'OMIT_FIELD_AND_SKIP_EMPTY_LINES'
        )
      },
      pick_ticket_snapshot_watcher: pickTicketSnapshotWatcherStatus(),
      pick_ticket_pdf_watcher: pickTicketPersistenceWatcherStatus(),
      source_precedence: (
        'PICK_TICKET_PDF_THEN_SNAPSHOT_THEN_HARDCOPY'
      ),
      checklist_policy: (
        'EXISTING_APPROVED_TEMPLATE_ONLY_ONE_PER_CONTROL'
      ),
      sales_order_refresh_existing_orders: (
        'A2000_DESKTOP_UPDATE_CUSTOMER_SKUS_FROM_CUSTOMER_MASTER'
      )
    });
  });

  router.get('/customer-identifiers/status', (_req, res) => {
    res.json({
      ok: true,
      auto_upload_enabled: customerSkuAutoUploadEnabled(),
      upload_id: process.env.A2000_CUSTOMER_SKUS_UPLOAD_ID
        || 'CUST_SKUS',
      policy: 'EXPLICIT_CUSTOMER_IDENTIFIERS_ONLY',
      missing_identifier_behavior: (
        'OMIT_FIELD_AND_SKIP_EMPTY_LINES'
      ),
      sales_order_refresh: (
        'NEW_ORDERS_SYNC_BEFORE_CREATE_EXISTING_ORDERS_MANUAL_BUTTON'
      ),
      pick_ticket_data_source: (
        'VR_ORDER_LI_SNAPSHOT_BEFORE_PDF'
      ),
      pick_ticket_pdf_required_for_data: false
    });
  });

  router.post('/customer-identifiers/reconcile', async (req, res) => {
    try {
      const result = await reconcilePendingCustomerIdentifiers({
        limit: Number(req.body?.limit || 200),
        upload: req.body?.upload !== false
      });
      res.status(result.ok ? 200 : 409).json({
        ok: result.ok,
        result
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post(
    '/orders/:id/customer-identifiers/preflight',
    async (req, res) => {
      try {
        const order = await orderById(req.params.id);
        const result = await preflightCustomerIdentifiers(order);
        res.status(result.valid ? 200 : 409).json({
          ok: result.valid,
          result
        });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    }
  );

  router.post('/orders/:id/customer-identifiers/sync', async (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          ok: false,
          code: 'EXPLICIT_CONFIRMATION_REQUIRED',
          error: (
            'Send {"confirm":true}. '
            + 'This operation writes CUST_SKUS.'
          )
        });
      }
      const result = await syncCustomerIdentifiersForOrder(
        req.params.id,
        { upload: true }
      );
      res.status(result.ok ? 200 : 409).json({
        ok: result.ok,
        result
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/documents/:id/customer-identifiers/sync', async (req, res) => {
    try {
      const upload = req.body?.upload === true;
      const result = await syncCustomerIdentifiersForDocument(
        req.params.id,
        { upload }
      );
      res.status(result.ok ? 200 : 409).json({
        ok: result.ok,
        result
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/orders/:id/complete-flow', async (req, res) => {
    try {
      if (req.body?.confirm_order_li_cleared !== true) {
        return res.status(400).json({
          ok: false,
          code: 'ORDER_LI_CLEAR_CONFIRMATION_REQUIRED',
          error: (
            'confirm_order_li_cleared=true is required '
            + 'before ORDER_HD/ORDER_LI writes.'
          )
        });
      }

      const customerIdentifiers = await syncCustomerIdentifiersForOrder(
        req.params.id,
        { upload: true }
      );

      if (!customerIdentifiers.ok) {
        return res.status(409).json({
          ok: false,
          stage: 'customer_identifier_sync_failed',
          customer_identifiers: customerIdentifiers,
          a2000_order_created: false
        });
      }

      const orderUpload = await uploadOrderWorkflow(
        req.params.id,
        { confirmOrderLiCleared: true }
      );
      const ok = orderUpload.ok === true;

      res.status(ok ? 200 : 409).json({
        ok,
        stage: ok
          ? 'complete_flow_uploaded'
          : 'sales_order_upload_failed',
        customer_identifiers: customerIdentifiers,
        sales_order: orderUpload,
        preflight: orderUpload.preflight || null,
        upload: orderUpload.upload || null
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/complete-flow-all', async (req, res) => {
    try {
      if (req.body?.confirm_order_li_cleared !== true) {
        return res.status(400).json({
          ok: false,
          code: 'ORDER_LI_CLEAR_CONFIRMATION_REQUIRED',
          error: (
            'confirm_order_li_cleared=true is required '
            + 'before ORDER_HD/ORDER_LI writes.'
          )
        });
      }

      const limit = Math.max(1, Number(req.body?.limit || 50));
      const orders = await listOperationalOrders({
        limit: Math.max(limit * 4, 200)
      });
      const candidates = orders
        .filter(order => order.stage1_certified)
        .filter(order => order.reading_valid)
        .filter(order => order.a2000_local_ready)
        .filter(order => order.a2000_job?.status !== 'completed')
        .slice(0, limit);
      const results = [];
      let halted = false;

      for (const order of candidates) {
        if (halted) {
          results.push({
            ok: false,
            purchase_order_id: order.id,
            customer_code: order.customer_code,
            order_no: order.order_no,
            stage: 'skipped_after_uncertain_write_failure'
          });
          continue;
        }

        const customerIdentifiers = await syncCustomerIdentifiersForOrder(
          order,
          { upload: true }
        );

        if (!customerIdentifiers.ok) {
          results.push({
            ok: false,
            purchase_order_id: order.id,
            customer_code: order.customer_code,
            order_no: order.order_no,
            stage: 'customer_identifier_sync_failed',
            customer_identifiers: customerIdentifiers,
            sales_order: null
          });
          continue;
        }

        const salesOrder = await uploadOrderWorkflow(order.id, {
          confirmOrderLiCleared: true
        });
        const ok = salesOrder.ok === true;

        results.push({
          ok,
          purchase_order_id: order.id,
          customer_code: order.customer_code,
          order_no: order.order_no,
          stage: ok
            ? 'complete_flow_uploaded'
            : 'sales_order_upload_failed',
          customer_identifiers: customerIdentifiers,
          sales_order: salesOrder,
          preflight: salesOrder.preflight || null,
          upload: salesOrder.upload || null
        });

        if (
          !ok
          && ![
            'failed_preflight',
            'a2000_service_unavailable',
            'customer_not_stage1_certified'
          ].includes(salesOrder.stage)
        ) {
          halted = true;
        }
      }

      const completed = results.filter(item => item.ok).length;
      const failed = results.filter(item => (
        !item.ok
        && !String(item.stage).startsWith('skipped')
      )).length;
      const skipped = results.filter(item => (
        String(item.stage).startsWith('skipped')
      )).length;
      const ok = !halted && failed === 0;

      res.status(ok ? 200 : 409).json({
        ok,
        workflow: {
          stage: halted
            ? 'bulk_halted_after_write_failure'
            : 'bulk_complete_flow_finished',
          candidate_count: candidates.length,
          completed_count: completed,
          failed_count: failed,
          skipped_count: skipped,
          halted,
          results
        }
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/pick-tickets', async (req, res) => {
    try {
      const rows = await listPickTicketDocuments({
        limit: Number(req.query.limit || 500)
      });
      res.json({ ok: true, count: rows.length, pick_tickets: rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/pick-ticket-snapshots', async (req, res) => {
    try {
      const rows = await listPickTicketSnapshots({
        limit: Number(req.query.limit || 500)
      });
      res.json({ ok: true, count: rows.length, snapshots: rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/pick-ticket-snapshots/reconcile', async (req, res) => {
    try {
      const result = await reconcilePickTicketSnapshots({
        limit: Number(req.body?.limit || 200),
        orderId: req.body?.order_id || null
      });
      res.status(result.ok ? 200 : 409).json({
        ok: result.ok,
        result
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/pick-tickets/reconcile', async (req, res) => {
    try {
      const snapshots = await reconcilePickTicketSnapshots({
        limit: Number(req.body?.limit || 200),
        orderId: req.body?.order_id || null
      });
      const pdfs = await reconcilePickTicketDirectory({
        force: req.body?.force_pdf === true
      });
      const ok = snapshots.ok && pdfs.ok;
      res.status(ok ? 200 : 409).json({
        ok,
        result: {
          snapshots,
          pdfs,
          matched_count: snapshots.matched_count
            + pdfs.matched_count,
          unmatched_count: snapshots.unmatched_count
            + pdfs.unmatched_count,
          excluded_parent_count: (
            snapshots.excluded_parent_count
            + pdfs.excluded_parent_count
          ),
          pdf_required_for_data: false
        }
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/pick-tickets/:id/pdf', async (req, res) => {
    try {
      const loaded = await pickTicketPdfByDocumentId(req.params.id);
      const disposition = String(req.query.download || '') === '1'
        ? 'attachment'
        : 'inline';
      const fileName = String(
        loaded.file_name || 'pick-ticket.pdf'
      ).replaceAll('"', '');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${fileName}"`
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(loaded.buffer);
    } catch (error) {
      res.status(404).json({ ok: false, error: error.message });
    }
  });

  router.get('/pick-tickets/:id/checklist-input', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('documents')
        .select('*')
        .eq('id', req.params.id)
        .in('source', [
          'a2000_pick_ticket_observer',
          'a2000_pick_ticket_snapshot'
        ])
        .single();
      if (error) throw error;

      const filePath = data.raw?.checklist_input_path;
      if (!filePath) {
        return res.status(409).json({
          ok: false,
          code: 'CHECKLIST_INPUT_NOT_READY',
          error: (
            'The Pick Ticket is not exactly matched '
            + 'to a purchase order/control.'
          )
        });
      }

      const input = JSON.parse(await fs.readFile(filePath, 'utf8'));
      res.json({ ok: true, input });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/pick-tickets/:id/checklist', async (req, res) => {
    try {
      const result = await generateChecklistForPickTicketDocument(
        req.params.id,
        { force: req.body?.force === true }
      );
      res.status(result.ok ? 200 : 409).json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/pick-tickets/:id/checklist/download', async (req, res) => {
    try {
      const filePath = await checklistPathForPickTicketDocument(
        req.params.id
      );

      if (!filePath) {
        const generated = await generateChecklistForPickTicketDocument(
          req.params.id
        );

        if (!generated.ok) {
          return res.status(404).json(generated);
        }

        return res.download(
          generated.file_path,
          path.basename(generated.file_path)
        );
      }

      return res.download(filePath, path.basename(filePath));
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
}

let startState = null;

export async function startOperationalExtensions() {
  if (startState) return startState;

  startCustomerIdentifierWatcher();
  startPickTicketSnapshotWatcher();
  startPickTicketPersistenceWatcher();

  startState = {
    ok: true,
    customer_sku_auto_upload: customerSkuAutoUploadEnabled(),
    customer_identifier_watcher: true,
    pick_ticket_snapshot_observer: true,
    pick_ticket_persistence: true,
    pdf_required_for_pick_ticket_data: false,
    pick_ticket_checklist_generation: true
  };

  return startState;
}
