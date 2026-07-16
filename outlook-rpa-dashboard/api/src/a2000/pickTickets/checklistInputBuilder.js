import { consolidatePickTicketRows } from './distropClassifier.js';

export function buildChecklistInput(group) {
  const expected = group.expected_pick_tickets || [];
  const missing = expected.filter((item) => item.status !== 'PDF_VALIDATED');
  const data = consolidatePickTicketRows(group.source_rows || []);
  const controlReady = Boolean(group.checklist_control_no);
  return {
    group_key: group.group_key,
    customer_code: group.customer_code,
    division_code: group.division_code,
    order_no: group.order_no,
    classification: group.classification,
    checklist_control_no: group.checklist_control_no || null,
    checklist_control_identity_type:
      group.checklist_control_identity_type || 'PENDING',
    checklist_control_pending_reason:
      group.checklist_control_pending_reason || null,
    status: missing.length || !controlReady ? 'IN_PROGRESS' : 'READY',
    expected_pick_ticket_count: expected.length,
    validated_pick_ticket_count: expected.length - missing.length,
    missing_pick_tickets: missing.map((item) => item.pick_ticket_no),
    original_report_files: group.original_report_files || [],
    consolidated_summary: data.consolidated_summary,
    traceability: data.traceability
  };
}
