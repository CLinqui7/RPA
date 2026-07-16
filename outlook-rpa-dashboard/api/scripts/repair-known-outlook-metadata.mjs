import { supabase } from '../src/supabase.js';
import { analyzeEmail } from '../src/parser.js';

const args = Object.fromEntries(
  process.argv.slice(2).map(item => {
    const [key, ...rest] = item.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  })
);

const emailId = args['email-id'];
const documentId = args['document-id'];
const subject = String(args.subject || '').trim();
const senderName = String(args['sender-name'] || '').trim();

if (!emailId || !documentId || !subject) {
  throw new Error(
    'Usage: node scripts/repair-known-outlook-metadata.mjs '
    + '--email-id=<uuid> --document-id=<uuid> '
    + '--subject="facturas american" '
    + '--sender-name="carlos linqui"'
  );
}

const { data: email, error: emailError } = await supabase
  .from('email_events')
  .select('*')
  .eq('id', emailId)
  .single();

if (emailError) throw emailError;

const { data: document, error: documentError } = await supabase
  .from('documents')
  .select('*')
  .eq('id', documentId)
  .single();

if (documentError) throw documentError;

const analysis = analyzeEmail({
  ...email,
  subject,
  senderName: senderName || email.sender_name,
  senderEmail: email.sender_email,
  snippet: email.snippet,
  bodyText: email.body_text,
  raw: email.raw
});

const repairedRaw = {
  ...(email.raw || {}),
  analysis,
  metadata_repair: {
    repaired_at: new Date().toISOString(),
    reason:
      'OUTLOOK_MESSAGE_LIST_SUBJECT_WAS_REPLACED_BY_NAVIGATION_HEADING',
    previous_subject: email.subject,
    previous_sender_name: email.sender_name,
    previous_analysis_subject:
      email.raw?.analysis?.cleanSubject || null,
    external_key_preserved: true
  }
};

const { data: updatedEmail, error: updateEmailError } =
  await supabase
    .from('email_events')
    .update({
      subject,
      sender_name:
        senderName || email.sender_name,
      message_type:
        analysis.messageType || email.message_type,
      po_number:
        analysis.poNumber || email.po_number,
      customer_name:
        analysis.customerName || email.customer_name,
      operator_name:
        analysis.operatorName || email.operator_name,
      raw: repairedRaw
    })
    .eq('id', emailId)
    .select('*')
    .single();

if (updateEmailError) throw updateEmailError;

const documentRaw = {
  ...(document.raw || {}),
  metadata_repair: {
    repaired_at: new Date().toISOString(),
    previous_subject: document.subject,
    source_email_event_id: emailId
  }
};

const { data: updatedDocument, error: updateDocumentError } =
  await supabase
    .from('documents')
    .update({
      subject,
      raw: documentRaw
    })
    .eq('id', documentId)
    .select('*')
    .single();

if (updateDocumentError) throw updateDocumentError;

console.log(JSON.stringify({
  ok: true,
  email: {
    id: updatedEmail.id,
    subject: updatedEmail.subject,
    sender_name: updatedEmail.sender_name,
    external_key: updatedEmail.external_key,
    analysis_subject:
      updatedEmail.raw?.analysis?.cleanSubject || null
  },
  document: {
    id: updatedDocument.id,
    subject: updatedDocument.subject,
    external_key: updatedDocument.external_key,
    sha256: updatedDocument.sha256
  },
  external_keys_changed: false,
  orders_deleted: false,
  a2000_writes_performed: false
}, null, 2));
