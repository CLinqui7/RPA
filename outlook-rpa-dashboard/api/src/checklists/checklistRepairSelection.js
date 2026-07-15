import {
  checklistControlGroupKey,
  checklistInternalControlKey,
  provisionalChecklistControlNo
} from './checklistControlIdentity.js';
import { actualControlFromJob } from './checklistJobControl.js';

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function purchaseOrderLineCount(order = {}) {
  if (Array.isArray(order.purchase_order_lines)) return order.purchase_order_lines.length;
  const explicit = Number(order.purchase_order_line_count ?? order.line_count ?? 0);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : 0;
}

function headerCompleteness(order = {}) {
  const fields = [
    order.customer_code,
    order.order_no,
    order.store_code,
    order.order_instance_key,
    order.status,
    order.raw_json
  ];
  return fields.reduce((score, value) => {
    if (value === null || value === undefined) return score;
    if (typeof value === 'string' && !value.trim()) return score;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return score;
    return score + 1;
  }, 0);
}

export function buildChecklistRepairCandidate({ order, canonicalCustomerCode, job = null }) {
  const lineCount = purchaseOrderLineCount(order);
  return {
    order,
    canonical_customer_code: canonicalCustomerCode,
    internal_control_key: checklistInternalControlKey(order),
    provisional_control_no: provisionalChecklistControlNo(order),
    actual_control_no: actualControlFromJob(job) || null,
    a2000_job_status: clean(job?.status) || null,
    a2000_job_updated_at: clean(job?.updated_at) || null,
    source_line_count: lineCount,
    data_score: (lineCount * 100000) + (headerCompleteness(order) * 100)
  };
}

function candidateSort(a, b) {
  if (b.source_line_count !== a.source_line_count) {
    return b.source_line_count - a.source_line_count;
  }
  if (b.data_score !== a.data_score) return b.data_score - a.data_score;
  const aCreated = Date.parse(a.order?.created_at || '') || 0;
  const bCreated = Date.parse(b.order?.created_at || '') || 0;
  return bCreated - aCreated;
}

export function selectChecklistRepairGroups(candidates = []) {
  const groups = new Map();

  for (const candidate of candidates) {
    const groupKey = checklistControlGroupKey(
      candidate.order,
      candidate.canonical_customer_code
    );
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(candidate);
  }

  return [...groups.entries()].map(([groupKey, groupCandidates]) => {
    const sorted = [...groupCandidates].sort(candidateSort);
    const representative = sorted[0];
    const duplicates = sorted.slice(1);
    const actualControls = [...new Set(
      groupCandidates.map(item => clean(item.actual_control_no)).filter(Boolean)
    )];
    const actualControlCandidates = groupCandidates
      .filter(item => clean(item.actual_control_no))
      .sort((a, b) => {
        const aUpdated = Date.parse(a.a2000_job_updated_at || '') || 0;
        const bUpdated = Date.parse(b.a2000_job_updated_at || '') || 0;
        return bUpdated - aUpdated;
      });

    return {
      group_key: groupKey,
      representative,
      duplicates,
      actual_control_no: actualControls.length === 1 ? actualControls[0] : null,
      actual_control_source_order_id: actualControls.length === 1
        ? actualControlCandidates[0]?.order?.id || null
        : null,
      conflicting_actual_controls: actualControls,
      has_control_conflict: actualControls.length > 1,
      source_order_count: groupCandidates.length,
      total_source_line_count: groupCandidates.reduce(
        (total, item) => total + item.source_line_count,
        0
      )
    };
  });
}

export function checklistRepairGroupSafety(group = {}) {
  if (group.has_control_conflict) {
    return {
      ok: false,
      reason: 'CONFLICTING_A2000_CONTROLS',
      details: group.conflicting_actual_controls || []
    };
  }
  if (!group.representative || Number(group.representative.source_line_count || 0) < 1) {
    return {
      ok: false,
      reason: 'CHECKLIST_SOURCE_LINES_MISSING',
      details: []
    };
  }
  return { ok: true, reason: null, details: [] };
}
