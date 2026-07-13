import { supabase } from '../supabase.js';

const TABLE = 'a2000_rest_jobs';

function nowIso() {
  return new Date().toISOString();
}

export async function getA2000JobByKey(idempotencyKey) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function createOrLoadA2000Job({
  idempotencyKey,
  sourcePayloadHash,
  order
}) {
  const existing = await getA2000JobByKey(idempotencyKey);
  if (existing) return { job: existing, created: false };

  const row = {
    idempotency_key: idempotencyKey,
    source_payload_hash: sourcePayloadHash,
    document_id: order.document_id ? String(order.document_id) : null,
    purchase_order_id: order.id ? String(order.id) : null,
    customer_code: String(order.customer_code || ''),
    store_code: String(order.store_code || order.store_raw || ''),
    order_no: String(order.order_no || ''),
    division_code: String(order.division_code || ''),
    status: 'preflight_validated',
    order_snapshot: order,
    updated_at: nowIso()
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select('*')
    .single();

  if (!error) return { job: data, created: true };

  if (String(error.code || '') === '23505') {
    const concurrent = await getA2000JobByKey(idempotencyKey);
    if (concurrent) return { job: concurrent, created: false };
  }

  throw error;
}

export async function updateA2000Job(jobId, patch = {}) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      ...patch,
      updated_at: nowIso()
    })
    .eq('id', jobId)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}
