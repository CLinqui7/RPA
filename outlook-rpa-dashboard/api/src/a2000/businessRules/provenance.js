export function buildProvenance({
  source,
  ruleId = null,
  certificationStatus = null,
  originalValue = null,
  details = {}
}) {
  return {
    source,
    rule_id: ruleId,
    certification_status: certificationStatus,
    original_value: originalValue,
    ...details
  };
}
