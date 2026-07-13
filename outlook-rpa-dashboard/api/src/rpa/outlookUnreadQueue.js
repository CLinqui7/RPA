function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalize(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function subjectFilterAlternatives(subjectFilter = 'factura american') {
  const configured = clean(subjectFilter)
    .split('|')
    .map(value => value.replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);

  const values = new Set(configured);

  const normalizedConfigured = configured.map(normalize);
  const mentionsAmericanInvoice = normalizedConfigured.some(value => (
    value.includes('american')
    && (value.includes('factura') || value.includes('facturas'))
  ));

  if (mentionsAmericanInvoice || values.size === 0) {
    values.add('factura american');
    values.add('facturas american');
  }

  return [...values];
}

export function buildUnreadSearchAttempts({
  configuredQuery = '',
  subjectFilter = 'factura american'
} = {}) {
  const configured = clean(configuredQuery);
  const attempts = [];

  const unreadOnly = value => {
    const compact = clean(value).replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return /\bisread\s*:\s*no\b/i.test(compact)
      ? compact
      : `${compact} isread:no`;
  };

  if (configured) attempts.push(unreadOnly(configured));

  for (const subject of subjectFilterAlternatives(subjectFilter)) {
    const safe = subject.replace(/"/g, '');
    attempts.push(`subject:"${safe}" isread:no`);
    attempts.push(`"${safe}" isread:no`);
  }

  // Broad search remains unread-only. If Outlook search still returns zero,
  // runScan uses the independent raw Inbox DOM fallback.
  attempts.push('american isread:no');

  return [...new Set(
    attempts
      .map(value => value.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  )];
}

export function rowUnreadDecision(meta = {}, query = '') {
  if (meta.isRead === true && meta.isUnread !== true) {
    return {
      accept: false,
      source: 'explicit_read_dom_state'
    };
  }

  if (meta.isUnread === true) {
    return {
      accept: true,
      source: meta.readStateSource || 'explicit_unread_dom_state'
    };
  }

  // Only trust Outlook's unread operator in an actual search result.
  // Never use this shortcut for the raw inbox DOM fallback.
  if (
    /\bisread\s*:\s*no\b/i.test(clean(query))
    && !/__INBOX_DOM_UNREAD_FALLBACK__/i.test(clean(query))
  ) {
    return {
      accept: true,
      source: 'outlook_unread_search_result'
    };
  }

  return {
    accept: false,
    source: 'unread_state_unknown'
  };
}

export function stableRowFingerprint({
  text = '',
  combined = '',
  index = null
} = {}) {
  return normalize(`${text}|${combined}|${index ?? ''}`)
    .replace(/[^a-z0-9@._| -]+/g, '')
    .slice(0, 900);
}

export function completeAttachmentCoverage({
  expected = [],
  existing = [],
  downloaded = []
} = {}) {
  const key = value => normalize(value).replace(/[^a-z0-9.]+/g, '');
  const expectedKeys = [...new Set(expected.map(key).filter(Boolean))];
  const availableKeys = new Set([
    ...existing.map(key),
    ...downloaded.map(key)
  ].filter(Boolean));
  const missing = expectedKeys.filter(item => !availableKeys.has(item));

  return {
    expected_count: expectedKeys.length,
    available_count: expectedKeys.filter(item => availableKeys.has(item)).length,
    missing,
    complete: expectedKeys.length > 0 && missing.length === 0
  };
}
