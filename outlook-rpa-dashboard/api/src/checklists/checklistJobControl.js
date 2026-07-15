function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Extract the actual A2000 control number from an optional REST job row.
 *
 * Supabase lookups legitimately return no job for orders that have not yet
 * been sent to A2000. The repair command must treat that state as pending,
 * not crash while reading properties from null.
 */
export function actualControlFromJob(job) {
  if (!job || typeof job !== 'object') return '';
  return clean(job.a2000_ctrl_no || job.a2000_seq_order_no);
}
