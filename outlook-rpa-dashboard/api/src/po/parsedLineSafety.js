function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsedLineSafetyReport(parsed = {}) {
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const printedQty = numberOrNull(parsed?.totals?.qty);
  const calculatedQty = lines.reduce((sum, line) => {
    const qty = numberOrNull(line?.qty_total);
    return sum + (qty === null ? 0 : qty);
  }, 0);
  const blockingConflicts = (Array.isArray(parsed.conflicts) ? parsed.conflicts : [])
    .filter(conflict => conflict?.blocking === true);

  if (printedQty !== null && printedQty > 0 && lines.length === 0) {
    return {
      ok: false,
      code: 'PURCHASE_ORDER_LINES_EMPTY_BLOCKED',
      message: 'The document prints a positive total quantity but the parser produced zero lines. Existing persisted lines must not be deleted.',
      printed_qty: printedQty,
      calculated_qty: calculatedQty,
      line_count: 0,
      blocking_conflicts: blockingConflicts
    };
  }

  if (lines.length > 0 && printedQty !== null && printedQty !== calculatedQty) {
    return {
      ok: false,
      code: 'PURCHASE_ORDER_LINE_TOTAL_MISMATCH_BLOCKED',
      message: 'The sum of parsed line quantities does not match the printed total quantity.',
      printed_qty: printedQty,
      calculated_qty: calculatedQty,
      line_count: lines.length,
      blocking_conflicts: blockingConflicts
    };
  }

  if (blockingConflicts.length > 0) {
    return {
      ok: false,
      code: 'PURCHASE_ORDER_BLOCKING_CONFLICTS',
      message: 'The parsed purchase order contains blocking conflicts and may not replace persisted lines.',
      printed_qty: printedQty,
      calculated_qty: calculatedQty,
      line_count: lines.length,
      blocking_conflicts: blockingConflicts
    };
  }

  return {
    ok: true,
    code: null,
    message: null,
    printed_qty: printedQty,
    calculated_qty: calculatedQty,
    line_count: lines.length,
    blocking_conflicts: []
  };
}

export function assertParsedOrderLinesSafe(parsed = {}) {
  const report = parsedLineSafetyReport(parsed);
  if (report.ok) return report;
  const error = new Error(`${report.code}: ${report.message}`);
  error.code = report.code;
  error.details = report;
  throw error;
}
