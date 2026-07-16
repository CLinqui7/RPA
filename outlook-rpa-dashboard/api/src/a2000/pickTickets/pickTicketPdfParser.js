import {
  identifiersFromPickTicketText
} from './pickTicketCore.js';

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHeader(section = '') {
  const identity = identifiersFromPickTicketText(section);
  const customer = section.match(
    /^\s*([A-Z0-9][A-Z0-9 ]{1,30})\s+[A-Z0-9 ]+\s+Term\s*:/im
  )?.[1];
  const warehouse = section.match(
    /Warehouse\s*:\s*([A-Z0-9-]+)/i
  )?.[1];

  return {
    ...identity,
    customer_code: clean(customer).split(/\s+/)[0] || '',
    warehouse_code: clean(warehouse)
  };
}

function parseLines(section = '') {
  const lines = [];
  const sourceLines = String(section).split(/\r?\n/);
  let current = null;

  const linePattern = (
    /^\s*([A-Z0-9][A-Z0-9-]{3,})\s+([A-Z0-9]{2,4})\s+(.+?)\s+(\d{1,3})\s+(.*?)\s+(\d+(?:\.\d+)?)\s*$/
  );

  for (const sourceLine of sourceLines) {
    const match = sourceLine.match(linePattern);

    if (match) {
      current = {
        style: clean(match[1]),
        color: clean(match[2]),
        color_description: clean(match[3]),
        line_no: numberOrNull(match[4]),
        description: clean(match[5]),
        pick_qty: numberOrNull(match[6]),
        source_line: sourceLine
      };
      lines.push(current);
      continue;
    }

    const upc = sourceLine.match(/^\s*(\d{12,14})\s*$/)?.[1];
    if (current && upc && !current.printed_upc) {
      current.printed_upc = upc;
      continue;
    }

    const size = sourceLine.match(/^\s*(PC|OS|ONE|XS|S|M|L|XL|XXL|\d+X)\s*$/i)?.[1];
    if (current && size && !current.size_name) {
      current.size_name = size.toUpperCase();
    }
  }

  return lines;
}

export function splitPickTicketSections(text = '') {
  const source = String(text || '');
  const formFeed = source
    .split(/\f+/)
    .map(item => item.trim())
    .filter(Boolean);

  if (formFeed.length > 1) return formFeed;

  const matches = [...source.matchAll(
    /(?=Pick\s+Ticket[\s\S]{0,400}?Pick\s+Ticket\s*#)/gi
  )];

  if (matches.length <= 1) return source.trim() ? [source] : [];

  const output = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? source.length;
    output.push(source.slice(start, end).trim());
  }
  return output.filter(Boolean);
}

export function parsePickTicketPdfText(text = '') {
  return splitPickTicketSections(text).map((section, index) => ({
    page_index: index + 1,
    identity: parseHeader(section),
    lines: parseLines(section),
    raw_text: section
  }));
}
