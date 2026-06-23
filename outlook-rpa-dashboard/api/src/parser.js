const KNOWN_PEOPLE = [
  { id: 'carlos', name: 'Carlos Linqui', role: 'user', emails: ['carlos.linqui@axnygroup.com', 'linquicarloss@gmail.com'], aliases: ['carlos', 'carlos linqui', 'linqui', '@carlos'] },
  { id: 'routing', name: 'Routing', role: 'group', emails: ['routing@axnygroup.com'], aliases: ['routing', 'routing team', '@routing'] },
  { id: 'warehouse', name: 'Warehouse', role: 'group', emails: [], aliases: ['warehouse', 'bodega', '@warehouse'] },
  { id: 'shipping', name: 'Shipping', role: 'group', emails: [], aliases: ['shipping', 'shipping team', '@shipping'] },
  { id: 'luis', name: 'Luis Salvador', role: 'operator', emails: ['luis.salvador@axnygroup.com'], aliases: ['luis', 'luis salvador'] },
  { id: 'rafael', name: 'Rafael Martinez', role: 'operator', emails: ['rafael.martinez@axnygroup.com'], aliases: ['rafael', 'rafael martinez'] }
];

const CUSTOMER_PATTERNS = [
  'FASHION NOVA', 'MARSHALLS', 'TARGET', 'BURLINGTON', 'TJ MAXX', 'T.J. MAXX',
  'ROSS', 'WALMART', 'MACY', 'NORDSTROM', 'ELI-BELT-SAMPLES', 'ELI BELT SAMPLES'
];

const NOISE_PATTERNS = [
  /ticket\s*\[#?\d+\]/i,
  /has\s+new\s+comment\s+added/i,
  /status\s+has\s+been\s+changed/i,
  /gogenuity/i,
  /message\s+was\s+blocked/i,
  /wasn'?t\s+delivered/i,
  /remote\s+server\s+returned/i,
  /diagnostic\s+information\s+for\s+administrators/i,
  /microsoft\s+account\s+was\s+temporarily\s+blocked/i
];

const RESPONSE_DONE_PATTERNS = [
  /\bdone\b/i,
  /\bsent\b/i,
  /\bconfirmed\b/i,
  /\bprocessed\b/i,
  /\bcompleted\b/i,
  /\balready\s+sent\b/i,
  /\brouted\b/i,
  /\basn\s+sent\b/i,
  /\bshipped\b/i,
  /\breceived\b/i,
  /much\s+obliged/i,
  /thank\s+you/i,
  /thanks/i
];

const RESPONSE_NEEDED_PATTERNS = [
  /please\s+confirm/i,
  /please\s+advise/i,
  /any\s+update/i,
  /waiting\s+for/i,
  /follow\s*up/i,
  /please\s+help/i,
  /please\s+process/i,
  /please\s+route/i,
  /please\s+review/i,
  /needs?\s+to\s+be/i,
  /must\s+be/i,
  /required/i,
  /\?\s*$/m
];

const HARD_URGENCY_PATTERNS = [
  /\burgent\b/i,
  /\burgente\b/i,
  /\basap\b/i,
  /route\s+today/i,
  /please\s+route\s+today/i,
  /needed\s+today/i,
  /today\s+please/i,
  /before\s+eod/i,
  /\bcritical\b/i,
  /\bpriority\b/i
];

function compact(text = '') {
  return normalizeText(text).replace(/\s+/g, ' ').trim();
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[•●◦]/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function uniqueById(items = []) {
  const map = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanPo(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function formatPoLabel(poNumber) {
  if (!poNumber) return null;
  const value = String(poNumber).trim();
  return /^PO/i.test(value) ? value : `PO ${value}`;
}

export function extractEmails(text = '') {
  const matches = normalizeText(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(email => email.toLowerCase()))];
}

export function extractPoNumber(text = '') {
  const normalized = normalizeText(text);
  const patterns = [
    /\bPO\s*#?\s*[:\-]?\s*([A-Z]{0,4}\d[\dA-Z]*(?:[\s-]+\d[\dA-Z]*)*)\b/i,
    /\bPurchase\s+Order\s*#?\s*[:\-]?\s*([A-Z]{0,4}\d[\dA-Z]*(?:[\s-]+\d[\dA-Z]*)*)\b/i,
    /\bCustomer\s+PO\s*#?\s*[:\-]?\s*([A-Z]{0,4}\d[\dA-Z]*(?:[\s-]+\d[\dA-Z]*)*)\b/i,
    /\bRetailer\s+PO\s*#?\s*[:\-]?\s*([A-Z]{0,4}\d[\dA-Z]*(?:[\s-]+\d[\dA-Z]*)*)\b/i,
    /\bOrder\s*#?\s*[:\-]?\s*([A-Z]{0,4}\d[\dA-Z]*(?:[\s-]+\d[\dA-Z]*)*)\b/i,
    /\bFastTrak\s+Order\s*#?\s*([A-Z0-9\-]{4,})\b/i,
    /\bFineLine\s+Order\s+Confirmation\s*#?\s*([A-Z0-9\-]{4,})\b/i,
    /\b(PO\d{5,})\b/i,
    /\b(\d{2}\s+\d{5,})\b/i,
    /\b#\s*([0-9]{5,})\b/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return cleanPo(match[1]);
  }
  return null;
}

export function extractPtNumber(text = '') {
  const normalized = normalizeText(text);
  const patterns = [
    /\bPT\s*#?\s*[:\-]?\s*([0-9]{5,}(?:\s*-\s*[0-9]{5,})?)\b/i,
    /\bPick\s+Ticket\s*#?\s*[:\-]?\s*([0-9]{5,}(?:\s*-\s*[0-9]{5,})?)\b/i,
    /\bPT\s+([0-9]{5,})\b/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return cleanPo(match[1]).replace(/\s*-\s*/g, ' - ');
  }
  return null;
}

export function extractShipWindow(text = '') {
  const normalized = normalizeText(text);
  const match = normalized.match(/\bShip\s*Window\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})\s*(?:-|to|–|—)\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i);
  if (!match) return null;
  return { start: match[1], end: match[2], label: `${match[1]} - ${match[2]}` };
}

export function extractCancelDate(text = '') {
  const normalized = normalizeText(text);
  const patterns = [
    /\bCancel\s*Date\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
    /\bCancel\s*By\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
    /\bCancel\s*After\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i,
    /\bCancel\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return { raw: match[1], date: parseDate(match[1]), label: match[1] };
  }
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  const yearRaw = Number(match[3]);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  const date = new Date(Date.UTC(year, month, day, 12, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function daysUntil(dateIso) {
  if (!dateIso) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = new Date(dateIso).getTime();
  return Math.ceil((target - today) / 86400000);
}

export function extractCustomer(text = '') {
  const normalized = normalizeText(text);
  const upper = normalized.toUpperCase();
  for (const customer of CUSTOMER_PATTERNS) {
    if (upper.includes(customer)) return customer.replace('T.J. MAXX', 'TJ MAXX');
  }
  const patterns = [
    /attached\s+(?:documents\s+)?for\s+([A-Z][A-Z0-9 &.\-]{2,40})(?:\s+PO|\s*:|\.|\n)/i,
    /Please\s+see\s+attached\s+for\s+([A-Z][A-Z0-9 &.\-]{2,40})(?:\s|\.|\n)/i,
    /for\s+([A-Z][A-Z0-9 &.\-]{2,40})\s+PO/i,
    /PE\s*-\s*X\s*-\s*([A-Z][A-Z0-9 &.\-]{2,40})\s*-/i,
    /PO\s*-\s*([A-Z][A-Z0-9 &.\-]{2,40})\s*-/i,
    /Retailer:\s*\n?\s*([A-Z][A-Z0-9 &.\-]{2,40})/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return compact(match[1]).replace(/[.:;,-]+$/, '').toUpperCase();
  }
  return null;
}

function getLines(text = '') {
  return normalizeText(text).split('\n').map(line => compact(line)).filter(Boolean);
}

function isBadSubjectLine(line = '') {
  const value = compact(line);
  if (!value || value.length < 3) return true;
  if (/^(navigation pane|inbox|sent items|drafts|deleted items|archive|junk email|search folders)$/i.test(value)) return true;
  if (/^(reply|reply all|forward|download all|save all|show all|show message history|hide message history)$/i.test(value)) return true;
  if (/^(summarize this email|caution:|this is an external email)/i.test(value)) return true;
  if (/^(to:|cc:|from:|sent:|subject:)/i.test(value)) return true;
  if (/^[A-Z]{1,3}$/.test(value)) return true;
  if (/^\d+\s+attachments?/i.test(value)) return true;
  if (/\.(pdf|xlsx?|csv|docx?)\b/i.test(value) && value.length < 70) return true;
  return false;
}

export function cleanSubject({ subject = '', rowText = '', bodyText = '' } = {}) {
  const direct = compact(subject).replace(/^Subject:\s*/i, '');
  if (direct && !isBadSubjectLine(direct)) return direct;
  const lines = [...getLines(bodyText), ...getLines(rowText)];
  const candidates = lines.filter(line => !isBadSubjectLine(line));
  const strong = candidates.find(line => /\b(PO|PT|Order|Routing|Confirmation|enviado|urgent|urgente|Marshalls|Target|Fashion Nova|Ship Window|Cancel Date)\b/i.test(line));
  return (strong || candidates[0] || direct || 'Sin asunto claro').slice(0, 160);
}

export function detectPeople(text = '') {
  return detectExplicitMentions(text).people;
}

export function detectExplicitMentions(text = '') {
  const normalized = normalizeText(text);
  const found = [];
  const mentions = [];
  const regex = /(^|[^\w.%+-])@([a-z0-9._-]{2,40})\b/gi;
  const ignored = new Set(['gmail', 'gmail.com', 'axnygroup', 'axnygroup.com', 'outlook', 'microsoft', 'gogenuity', 'finelinetech']);
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    const handle = match[2].toLowerCase();
    if (ignored.has(handle) || handle.includes('.com')) continue;
    mentions.push(`@${handle}`);
    const known = KNOWN_PEOPLE.find(person => person.aliases.some(alias => alias.replace(/^@/, '').toLowerCase() === handle));
    if (known) found.push(known);
    else found.push({ id: handle, name: `@${handle}`, role: 'mention', emails: [], aliases: [`@${handle}`] });
  }

  return {
    handles: [...new Set(mentions)],
    people: uniqueById(found).map(person => ({
      id: person.id,
      name: person.name,
      role: person.role,
      email: person.emails?.[0] || null
    }))
  };
}

function detectOperator(text = '', senderEmail = '') {
  const combined = `${text}\n${senderEmail || ''}`.toLowerCase();
  const operator = KNOWN_PEOPLE.find(person => person.role === 'operator' && (
    person.emails.some(email => combined.includes(email.toLowerCase())) ||
    person.aliases.some(alias => combined.includes(alias.toLowerCase()))
  ));
  return operator?.name || null;
}

function classifyBySignals({ cleanSubject = '', body = '', snippet = '' }) {
  const text = `${cleanSubject}\n${snippet}\n${body}`;
  const lower = text.toLowerCase();
  if (NOISE_PATTERNS.some(pattern => pattern.test(text))) return 'noise';
  if (/\bpo\s+enviado\b|please\s+see\s+(the\s+)?attached|attached\s+documents|ship\s*window|\bPT\s*\d+/i.test(text)) return 'order';
  if (/please\s+route\s+today|please\s+process|please\s+help\s+us\s+processing/i.test(text)) return 'order';
  if (/\bre:|\bfw:|reply|respond|much obliged|thank you|thanks|confirmed|approved|done|processed|completed|already sent|sent\b|routed/i.test(lower)) return 'response';
  if (/ticket|comment added|assigned to|in progress|closed/i.test(lower)) return 'ticket';
  if (/po|purchase order|order confirmation|fastrak order|fineline order|new order/i.test(lower)) return 'order';
  return 'unknown';
}

export function classifyEmail({ subject = '', body = '', snippet = '' }) {
  const clean = cleanSubject({ subject, rowText: snippet, bodyText: body });
  return classifyBySignals({ cleanSubject: clean, body, snippet });
}

function detectPriority(text = '', cancelDate = null) {
  const cancelDays = daysUntil(cancelDate?.date);
  if (typeof cancelDays === 'number' && cancelDays <= 7) return 'high';
  if (HARD_URGENCY_PATTERNS.some(pattern => pattern.test(text))) return 'high';
  if (/ship\s*window|please\s+process|please\s+review|please\s+help|attached|PO\s*[:#]?/i.test(text)) return 'medium';
  return 'low';
}

function detectImportantReasons(text = '', { shipWindow = null, cancelDate = null, priority = 'low' } = {}) {
  const reasons = [];
  const cancelDays = daysUntil(cancelDate?.date);
  if (/\burgent\b|\burgente\b/i.test(text)) reasons.push('Dice urgente');
  if (/\basap\b/i.test(text)) reasons.push('ASAP');
  if (/please\s+route\s+today|route\s+today/i.test(text)) reasons.push('Route today');
  if (typeof cancelDays === 'number' && cancelDays <= 7) reasons.push(`Cancel Date próxima: ${cancelDate.label}`);
  if (/don'?t\s+send\s+(the\s+)?asn|do\s+not\s+send\s+asn/i.test(text)) reasons.push('No enviar ASN');
  if (shipWindow) reasons.push(`Ship Window ${shipWindow.label}`);
  if (/attached|attachments?|\.pdf|\.xlsx?/i.test(text)) reasons.push('Tiene adjuntos');
  if (priority === 'high' && !reasons.length) reasons.push('Prioridad por regla operativa');
  return [...new Set(reasons)];
}

function buildSummary({ customerName, poNumber, ptNumber, shipWindow, cancelDate, messageType, priority, explicitMentions, bodyText = '' }) {
  const entity = [customerName, formatPoLabel(poNumber), ptNumber ? `PT ${ptNumber}` : null].filter(Boolean).join(' · ') || 'Correo operativo';
  const typeLabel = messageType === 'order' ? 'orden' : messageType === 'response' ? 'respuesta' : messageType === 'ticket' ? 'ticket' : 'correo';
  const urgency = priority === 'high' ? 'urgente' : priority === 'medium' ? 'normal' : 'baja prioridad';
  const owner = explicitMentions.handles.length ? `Mención: ${explicitMentions.handles.join(', ')}.` : 'Sin @ asignado.';
  const dates = [shipWindow ? `Ship Window ${shipWindow.label}` : null, cancelDate ? `Cancel Date ${cancelDate.label}` : null].filter(Boolean).join(' · ');
  const bodyHint = compact(bodyText)
    .replace(/Caution:.*?Department/i, '')
    .replace(/Best regards,?.*/i, '')
    .slice(0, 150);
  return `${entity}: ${typeLabel} ${urgency}. ${owner}${dates ? ` ${dates}.` : ''}${bodyHint ? ` Nota: ${bodyHint}` : ''}`.trim();
}

function buildAction({ messageType, priority, requiresResponse, assignedTo = [], reasons = [], cancelDate }) {
  if (messageType === 'noise') return 'No requiere acción operativa. Cerrar si no corresponde.';
  if (reasons.includes('No enviar ASN')) return 'Validar instrucción crítica: no enviar ASN.';
  if (reasons.includes('Route today')) return 'Procesar routing hoy y responder al grupo.';
  if (cancelDate && priority === 'high') return `Revisar antes de Cancel Date ${cancelDate.label}.`;
  if (requiresResponse && assignedTo.length) return `Esperar respuesta de ${assignedTo.map(p => p.name).join(', ')} o hacer seguimiento.`;
  if (requiresResponse) return 'Requiere seguimiento, pero no tiene @ asignado.';
  if (messageType === 'order') return 'Revisar adjuntos, PO/PT y confirmar siguiente paso operativo.';
  return 'Revisar y marcar como revisado si no requiere acción.';
}

export function analyzeEmail(email = {}) {
  const rawSubject = email.subject || '';
  const rowText = email.snippet || email.raw?.rowText || '';
  const bodyText = email.bodyText || email.body_text || email.body || '';
  const allText = normalizeText(`${rawSubject}\n${rowText}\n${bodyText}`);
  const subject = cleanSubject({ subject: rawSubject, rowText, bodyText });
  const poNumber = email.poNumber || email.po_number || extractPoNumber(allText);
  const ptNumber = extractPtNumber(allText);
  const shipWindow = extractShipWindow(allText);
  const cancelDate = extractCancelDate(allText);
  const customerName = email.customerName || email.customer_name || extractCustomer(allText);
  const senderEmail = (email.senderEmail || email.sender_email || extractEmails(allText)[0] || null)?.toLowerCase?.() || null;
  const operatorName = email.operatorName || email.operator_name || detectOperator(allText, senderEmail);
  const explicitMentions = detectExplicitMentions(allText);
  const assignedTo = explicitMentions.people;
  const priority = detectPriority(allText, cancelDate);
  const reasons = detectImportantReasons(allText, { shipWindow, cancelDate, priority });
  const messageType = classifyBySignals({ cleanSubject: subject, body: bodyText, snippet: rowText });
  const completionDetected = RESPONSE_DONE_PATTERNS.some(pattern => pattern.test(allText));
  const responseNeededByWords = RESPONSE_NEEDED_PATTERNS.some(pattern => pattern.test(allText));
  const requiresResponse = messageType !== 'noise' && !completionDetected && (priority === 'high' || responseNeededByWords || assignedTo.length > 0);
  const isOperational = messageType !== 'noise' && (Boolean(poNumber || ptNumber || customerName) || requiresResponse || priority !== 'low');
  const threadKey = poNumber ? `po:${poNumber.toLowerCase()}` : ptNumber ? `pt:${ptNumber.toLowerCase()}` : customerName ? `customer:${customerName.toLowerCase()}` : `subject:${subject.toLowerCase().slice(0, 60)}`;
  const displayTitle = [customerName, formatPoLabel(poNumber), ptNumber ? `PT ${ptNumber}` : null].filter(Boolean).join(' · ') || subject;
  const assignmentLabel = assignedTo.length ? assignedTo.map(p => p.name).join(', ') : 'Sin @ asignado';

  const analysis = {
    cleanSubject: subject,
    displayTitle,
    customerName,
    poNumber,
    ptNumber,
    shipWindow,
    cancelDate,
    operatorName,
    mentionedPeople: assignedTo,
    assignedTo,
    explicitMentionHandles: explicitMentions.handles,
    hasExplicitMention: explicitMentions.handles.length > 0,
    assignmentLabel,
    priority,
    importantReasons: reasons,
    messageType,
    requiresResponse,
    completionDetected,
    responseStatus: completionDetected ? 'responded' : requiresResponse ? 'awaiting_response' : 'info_only',
    isOperational,
    threadKey,
    summary: buildSummary({ customerName, poNumber, ptNumber, shipWindow, cancelDate, messageType, priority, explicitMentions, bodyText }),
    recommendedAction: '',
    tags: [priority === 'high' ? 'urgente' : null, requiresResponse ? 'sin respuesta' : null, messageType].filter(Boolean)
  };
  analysis.recommendedAction = buildAction({ messageType, priority, requiresResponse, assignedTo, reasons, cancelDate });
  return analysis;
}

export function correlateEvents(events = []) {
  const enriched = events.map(event => {
    const fresh = analyzeEmail(event);
    const existing = event.raw?.analysis || {};
    const analysis = { ...fresh, ...existing, cleanSubject: existing.cleanSubject || fresh.cleanSubject };
    return { ...event, analysis };
  });

  const byThread = new Map();
  for (const event of enriched) {
    const key = event.analysis?.threadKey;
    if (!key) continue;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(event);
  }

  for (const thread of byThread.values()) {
    thread.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    for (const event of thread) {
      if (!event.analysis?.requiresResponse || event.analysis.responseStatus === 'responded') continue;
      const eventTime = new Date(event.created_at || 0).getTime();
      const assignedIds = new Set((event.analysis.assignedTo || []).map(person => person.id));
      const responder = thread.find(candidate => {
        if (candidate.id === event.id) return false;
        const candidateTime = new Date(candidate.created_at || 0).getTime();
        if (candidateTime < eventTime) return false;
        const ca = candidate.analysis || {};
        if (ca.completionDetected) return true;
        if (ca.messageType === 'response') {
          if (!assignedIds.size) return true;
          const sender = `${candidate.sender_email || ''} ${candidate.sender_name || ''} ${ca.operatorName || ''}`.toLowerCase();
          return [...assignedIds].some(id => sender.includes(id));
        }
        return false;
      });

      if (responder) {
        event.analysis.responseStatus = 'responded';
        event.analysis.respondedBy = responder.sender_email || responder.sender_name || responder.analysis?.operatorName || 'Respuesta detectada';
        event.analysis.respondedAt = responder.created_at || null;
        event.analysis.recommendedAction = `Respuesta detectada de ${event.analysis.respondedBy}. Validar y cerrar si todo está completo.`;
        event.analysis.tags = [...new Set([...(event.analysis.tags || []).filter(tag => tag !== 'sin respuesta'), 'respondido'])];
      }
    }
  }

  return enriched.map(event => ({
    ...event,
    subject: event.analysis.cleanSubject || event.subject,
    customer_name: event.analysis.customerName || event.customer_name,
    operator_name: event.analysis.operatorName || event.operator_name,
    po_number: event.analysis.poNumber || event.po_number,
    message_type: event.analysis.messageType || event.message_type
  }));
}

export function stableKey(email) {
  const raw = `${email.subject || ''}|${email.senderEmail || ''}|${email.receivedAt || ''}|${email.poNumber || ''}|${email.ptNumber || ''}|${email.snippet || ''}`;
  return Buffer.from(raw).toString('base64').slice(0, 160);
}

export { KNOWN_PEOPLE };
