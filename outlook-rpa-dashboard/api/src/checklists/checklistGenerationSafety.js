export function validateChecklistEngineResult(engine = {}) {
  const lineCount = Number(engine?.line_count ?? 0);
  if (!Number.isFinite(lineCount) || lineCount < 1) {
    return {
      ok: false,
      reason: 'CHECKLIST_EMPTY_OUTPUT',
      line_count: Number.isFinite(lineCount) ? lineCount : 0
    };
  }
  return { ok: true, reason: null, line_count: lineCount };
}
