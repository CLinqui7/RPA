import { cleanSubject } from '../parser.js';

function clean(value) {
  return String(value ?? '')
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function filterAlternatives(subjectFilter = '') {
  return clean(subjectFilter)
    .split('|')
    .map(clean)
    .filter(Boolean);
}

function isSystemLine(value = '') {
  const line = clean(value);
  if (!line) return true;

  return (
    /^(navigation pane|inbox|sent items|drafts|deleted items|archive|junk email|search folders)$/i.test(line)
    || /^(reply|reply all|forward|download all|save all|show all|show message history|hide message history)$/i.test(line)
    || /^(caution:|this is an external email|please take care when clicking)/i.test(line)
    || /^(to:|cc:|from:|sent:|subject:)/i.test(line)
    || /^[A-Z]{1,3}$/.test(line)
    || /^\d{1,2}:\d{2}\s*(?:AM|PM)?$/i.test(line)
    || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b/i.test(line)
    || /^Inbox\b/i.test(line)
  );
}

export function outlookRowLines(rowText = '') {
  return String(rowText ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(clean)
    .filter(Boolean);
}

export function configuredSubjectFromRow(
  rowText = '',
  subjectFilter = ''
) {
  const alternatives = filterAlternatives(subjectFilter);
  if (!alternatives.length) return null;

  const lines = outlookRowLines(rowText);

  for (const line of lines) {
    const normalizedLine = normalize(line);

    for (const alternative of alternatives) {
      const normalizedAlternative = normalize(alternative);

      if (
        normalizedAlternative
        && normalizedLine.includes(normalizedAlternative)
      ) {
        return line;
      }
    }
  }

  return null;
}

function senderBeforeSubject(lines, subjectLine) {
  const subjectIndex = lines.findIndex(
    line => normalize(line) === normalize(subjectLine)
  );

  if (subjectIndex <= 0) return null;

  for (let index = subjectIndex - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (isSystemLine(line)) continue;
    if (line.includes('@')) continue;
    if (/\.(pdf|xlsx?|csv|docx?)\b/i.test(line)) continue;

    return line;
  }

  return null;
}

export function inferOutlookMessageMetadata({
  rawSubject = '',
  rowText = '',
  bodyText = '',
  subjectFilter = ''
} = {}) {
  const lines = outlookRowLines(rowText);
  const exactConfiguredSubject = configuredSubjectFromRow(
    rowText,
    subjectFilter
  );

  const raw = clean(rawSubject);
  const rawIsUseful = (
    raw
    && !isSystemLine(raw)
    && !/^(navigation pane)$/i.test(raw)
  );

  const fallbackSubject = cleanSubject({
    subject: rawIsUseful ? raw : '',
    rowText,
    bodyText
  });

  const subject = (
    exactConfiguredSubject
    || (rawIsUseful ? raw : null)
    || fallbackSubject
    || 'Sin asunto claro'
  ).slice(0, 160);

  let senderName = senderBeforeSubject(
    lines,
    exactConfiguredSubject || subject
  );

  if (!senderName) {
    senderName = lines.find(line => (
      !isSystemLine(line)
      && !line.includes('@')
      && normalize(line) !== normalize(subject)
      && !/\.(pdf|xlsx?|csv|docx?)\b/i.test(line)
    )) || null;
  }

  return {
    subject,
    senderName,
    subjectSource: exactConfiguredSubject
      ? 'message_list_exact_configured_subject'
      : rawIsUseful
        ? 'reading_pane_heading'
        : 'clean_subject_fallback',
    senderSource: senderName
      ? 'message_list_line_before_subject'
      : 'not_resolved',
    configuredSubjectLine: exactConfiguredSubject,
    rejectedRawSubject: raw && !rawIsUseful ? raw : null
  };
}
