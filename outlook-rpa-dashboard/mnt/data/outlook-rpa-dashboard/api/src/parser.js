export function extractPoNumber(text = '') {
  const patterns = [
    /\bPO\s*#?\s*[:\-]?\s*([A-Z0-9\-]{4,})\b/i,
    /\bOrder\s*#?\s*[:\-]?\s*([A-Z0-9\-]{4,})\b/i,
    /\bFastTrak\s+Order\s*#?\s*([A-Z0-9\-]{4,})\b/i,
    /\bFineLine\s+Order\s+Confirmation\s*#?\s*([A-Z0-9\-]{4,})\b/i,
    /\b#\s*([0-9]{5,})\b/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

export function classifyEmail({ subject = '', body = '', snippet = '' }) {
  const text = `${subject}\n${snippet}\n${body}`.toLowerCase();
  if (/reply|respond|much obliged|thank you|confirmed|approved|unblocked|please try|status/i.test(text)) return 'response';
  if (/po|purchase order|order confirmation|fastrak order|fineline order|new order/i.test(text)) return 'order';
  if (/ticket|comment added|status has been changed/i.test(text)) return 'ticket';
  return 'unknown';
}

export function stableKey(email) {
  const raw = `${email.subject || ''}|${email.senderEmail || ''}|${email.receivedAt || ''}|${email.snippet || ''}`;
  return Buffer.from(raw).toString('base64').slice(0, 120);
}
