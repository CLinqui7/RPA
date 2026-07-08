import { applyA2000HeaderDefaults } from './a2000Defaults.js';
import { normalizeStyleColor } from './styleColorRules.js';

export function normalizeForA2000(parsed) {
  const parser = parsed?.parser || '';
  const header = applyA2000HeaderDefaults(parsed?.header || {}, parser);

  const lines = (parsed?.lines || []).map((line) => {
    const normalized = normalizeStyleColor({
      customerRaw: header.customer_raw,
      parser,
      styleRaw: line.style_raw,
      colorRaw: line.color_raw
    });

    return {
      ...line,
      style_code: line.style_code || normalized.style_code,
      color_code: line.color_code || normalized.color_code,
      warehouse_code: line.warehouse_code || header.warehouse_code || null
    };
  });

  return {
    ...parsed,
    header,
    lines,
    raw_normalization: {
      applied: true,
      note: 'Applied deterministic style/color splitting and conservative warehouse/division defaults based on Hermanito audit.'
    }
  };
}
