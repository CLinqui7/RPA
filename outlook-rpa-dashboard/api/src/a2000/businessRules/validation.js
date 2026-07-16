import { A2000PolicyError } from './errors.js';

export function collectPolicyResult(fn) {
  try {
    return { ok: true, value: fn(), error: null };
  } catch (error) {
    if (error instanceof A2000PolicyError) {
      return { ok: false, value: null, error: error.toJSON() };
    }
    throw error;
  }
}

export function throwIfPolicyErrors(errors) {
  if (!errors.length) return;
  throw new A2000PolicyError(
    'A2000_BUSINESS_RULES_FAILED',
    'A2000 business-rule validation failed.',
    { errors }
  );
}
