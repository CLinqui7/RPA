import crypto from 'node:crypto';

function first(text, patterns) {
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1];
    if (value) return String(value).trim();
  }
  return null;
}

export function parsePickTicketPage(text) {
  return {
    pick_ticket_no: first(text, [
      /Pick\s*Ticket\s*#?\s*:?\s*(\d+)/i,
      /\bPICKTKT\s*:?\s*(\d+)/i
    ]),
    control_no: first(text, [/Ctrl\s*#?\s*:?\s*(\d+)/i]),
    order_no: first(text, [/Order\s*#?\s*:?\s*([A-Z0-9-]+)/i]),
    store_no: first(text, [/Store\s*#?\s*:?\s*([A-Z0-9-]+)/i]),
    warehouse: first(text, [/Warehouse\s*:?\s*([A-Z0-9-]+)/i])
  };
}

export function parsePickTicketPdfText(text) {
  return String(text)
    .split('\f')
    .map((pageText, index) => ({
      page_number: index + 1,
      page_text: pageText,
      identifiers: parsePickTicketPage(pageText)
    }))
    .filter((page) => page.page_text.trim());
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function hasPdfMagic(buffer) {
  return buffer.length >= 5
    && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}
