import { applyA2000HeaderDefaults } from './a2000Defaults.js';
import { normalizeStyleColor } from './styleColorRules.js';

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isCiti(parser, header) {
  return clean(parser).toLowerCase() === 'cititrends' || clean(header?.customer_code).toUpperCase() === 'CITI';
}

export function normalizeForA2000(parsed) {
  const parser = parsed?.parser || '';
  const header = applyA2000HeaderDefaults(parsed?.header || {}, parser);
  const citiStrict = isCiti(parser, header);

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
      // Citi line warehouse is not printed on the PO. Do not inherit PE/HT unless an approved mapping source supplies it.
      warehouse_code: line.warehouse_code || (citiStrict ? null : header.warehouse_code) || null
    };
  });

  return {
    ...parsed,
    header,
    lines,
    raw_normalization: {
      applied: true,
      note: 'Applied meaning-preserving shape normalization only. Known customer parsers keep printed style/color raw until exact or uniquely supported official-master enrichment resolves final A2000 codes.'
    }
  };
}
