import {
  clean,
  defaultMasterPath,
  isActive,
  isCertified,
  loadCsvMaster,
  normalizeCode
} from './masterLoader.js';
import { A2000PolicyError } from './errors.js';
import { buildProvenance } from './provenance.js';
import { resolveA2000Environment } from './environment.js';

function pick(order, names) {
  for (const name of names) {
    const value = clean(order?.[name]);
    if (value) return value;
  }
  return '';
}

function matchScore(row, context) {
  let score = 0;
  for (const [column, actual] of [
    ['customer_code', context.customerCode],
    ['division_code', context.divisionCode],
    ['environment', context.environment]
  ]) {
    const expected = normalizeCode(row[column]);
    if (expected === '*') {
      score += 1;
    } else if (expected === actual) {
      score += 10;
    } else {
      return -1;
    }
  }
  return score;
}

export function resolveBackOrderPolicy({
  order,
  environment = resolveA2000Environment(),
  masterPath = process.env.A2000_BACK_ORDER_POLICY_MASTER
    || defaultMasterPath('a2000_back_order_policy.csv')
}) {
  const context = {
    customerCode: normalizeCode(pick(order, [
      'customer_code', 'customerCode', 'cust_no', 'CUST_NO'
    ])),
    divisionCode: normalizeCode(pick(order, [
      'division_code', 'divisionCode', 'div_no', 'DIV_NO'
    ])),
    environment: normalizeCode(environment)
  };

  const master = loadCsvMaster(masterPath, {
    requiredColumns: [
      'rule_id', 'customer_code', 'division_code', 'environment',
      'value', 'active', 'source', 'certification_status'
    ]
  });

  const candidates = master.rows
    .filter((row) => isActive(row.active))
    .filter((row) => isCertified(row.certification_status))
    .map((row) => ({ row, score: matchScore(row, context) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    throw new A2000PolicyError(
      'A2000_BACK_ORDER_RULE_MISSING',
      'No certified Back Order policy matches customer, division and environment.',
      { ...context, master_path: master.path }
    );
  }

  const bestScore = candidates[0].score;
  const best = candidates.filter((candidate) => candidate.score === bestScore);
  const distinctValues = new Set(best.map((candidate) => normalizeCode(candidate.row.value)));
  if (best.length > 1 && distinctValues.size > 1) {
    throw new A2000PolicyError(
      'A2000_BACK_ORDER_RULE_AMBIGUOUS',
      'Multiple certified Back Order rules conflict.',
      {
        ...context,
        rule_ids: best.map((candidate) => candidate.row.rule_id),
        master_path: master.path
      }
    );
  }

  const row = best[0].row;
  const value = normalizeCode(row.value);
  if (!value) {
    throw new A2000PolicyError(
      'A2000_BACK_ORDER_VALUE_MISSING',
      'The selected Back Order rule has no value.',
      { rule_id: row.rule_id, master_path: master.path }
    );
  }

  return {
    value,
    provenance: buildProvenance({
      source: row.source,
      ruleId: row.rule_id,
      certificationStatus: row.certification_status,
      originalValue: row.value,
      details: {
        customer_code: context.customerCode,
        division_code: context.divisionCode,
        environment: context.environment,
        ui_meaning: row.ui_meaning || null,
        master_path: master.path,
        master_row: row.__row_number
      }
    })
  };
}
