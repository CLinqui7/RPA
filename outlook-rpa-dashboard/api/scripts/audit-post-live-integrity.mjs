import { supabase } from '../src/supabase.js';

function clean(value) {
  return String(value ?? '').trim();
}

function normalize(value) {
  return clean(value).toUpperCase().replace(/\s+/g, ' ');
}

function groupBy(items, keyFn) {
  const groups = new Map();

  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return groups;
}

const [
  emailResult,
  documentResult,
  orderResult
] = await Promise.all([
  supabase
    .from('email_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500),
  supabase
    .from('documents')
    .select('id,created_at,external_key,email_external_key,subject,file_name,sha256,status,detected_customer,detected_po,raw')
    .order('created_at', { ascending: false })
    .limit(1000),
  supabase
    .from('purchase_orders')
    .select('id,created_at,document_id,customer_code,order_no,order_instance_key,store_code,status,raw_json')
    .order('created_at', { ascending: false })
    .limit(1000)
]);

for (const [label, result] of [
  ['email_events', emailResult],
  ['documents', documentResult],
  ['purchase_orders', orderResult]
]) {
  if (result.error) {
    throw new Error(
      `${label}: ${result.error.message}`
    );
  }
}

const emails = emailResult.data || [];
const documents = documentResult.data || [];
const orders = orderResult.data || [];

const metadataAnomalies = emails
  .filter(event => {
    const subject = clean(event.subject);
    const sender = clean(event.sender_name);
    const rawSubject = clean(event.raw?.rawSubject);
    const analysisSubject = clean(
      event.raw?.analysis?.cleanSubject
    );

    return (
      (subject && sender && subject.toLowerCase() === sender.toLowerCase())
      || subject.includes('|')
      || /navigation pane/i.test(rawSubject)
      || (
        analysisSubject
        && subject
        && analysisSubject.toLowerCase() !== subject.toLowerCase()
      )
    );
  })
  .map(event => ({
    id: event.id,
    created_at: event.created_at,
    subject: event.subject,
    sender_name: event.sender_name,
    raw_subject: event.raw?.rawSubject || null,
    analysis_subject:
      event.raw?.analysis?.cleanSubject || null,
    external_key: event.external_key
  }));

const contentAliasGroups = [
  ...groupBy(
    documents.filter(document => clean(document.sha256)),
    document => clean(document.sha256)
  ).entries()
]
  .filter(([, rows]) => rows.length > 1)
  .map(([sha256, rows]) => ({
    sha256,
    document_count: rows.length,
    documents: rows.map(row => ({
      id: row.id,
      created_at: row.created_at,
      file_name: row.file_name,
      subject: row.subject,
      external_key: row.external_key,
      email_external_key: row.email_external_key
    }))
  }));

const ordersByDocument = groupBy(
  orders,
  order => clean(order.document_id)
);

const duplicateOrderGroups = [
  ...groupBy(
    orders,
    order => [
      normalize(order.customer_code),
      normalize(order.order_no),
      normalize(order.order_instance_key)
    ].join('|')
  ).entries()
]
  .filter(([, rows]) => {
    const documentIds = new Set(
      rows.map(row => clean(row.document_id))
    );
    return rows.length > 1 && documentIds.size > 1;
  })
  .map(([identity, rows]) => ({
    identity,
    order_count: rows.length,
    document_count: new Set(
      rows.map(row => clean(row.document_id))
    ).size,
    orders: rows.map(row => ({
      id: row.id,
      document_id: row.document_id,
      status: row.status,
      created_at: row.created_at
    }))
  }));

const staleWriteReporting = orders
  .filter(order => {
    const audit =
      order.raw_json?.customer_identifier_sync;

    return (
      audit?.stage === 'customer_identifiers_uploaded'
      && audit?.response?.ok === true
      && audit?.a2000_write_performed !== true
    );
  })
  .map(order => ({
    id: order.id,
    customer_code: order.customer_code,
    order_no: order.order_no,
    document_id: order.document_id,
    stage:
      order.raw_json?.customer_identifier_sync?.stage,
    response_ok:
      order.raw_json?.customer_identifier_sync
        ?.response?.ok,
    a2000_write_performed:
      order.raw_json?.customer_identifier_sync
        ?.a2000_write_performed ?? null
  }));

const report = {
  generated_at: new Date().toISOString(),
  counts: {
    email_events_checked: emails.length,
    documents_checked: documents.length,
    purchase_orders_checked: orders.length,
    metadata_anomalies: metadataAnomalies.length,
    content_alias_groups: contentAliasGroups.length,
    duplicate_order_groups: duplicateOrderGroups.length,
    stale_customer_identifier_write_reporting:
      staleWriteReporting.length
  },
  metadata_anomalies: metadataAnomalies,
  content_alias_groups: contentAliasGroups,
  duplicate_order_groups: duplicateOrderGroups,
  stale_customer_identifier_write_reporting:
    staleWriteReporting,
  policies: {
    duplicate_orders_deleted: false,
    reason:
      'Read-only audit. Duplicate order cleanup requires a separately reviewed canonical identity migration.',
    protected_checklists_modified: false
  }
};

console.log(JSON.stringify(report, null, 2));
