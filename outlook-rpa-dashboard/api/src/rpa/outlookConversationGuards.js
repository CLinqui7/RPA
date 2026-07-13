function normalizeLabel(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function boolFromData(value) {
  if (value === true || String(value).toLowerCase() === 'true') return true;
  if (value === false || String(value).toLowerCase() === 'false') return false;
  return null;
}

export function classifyOutlookReadState({
  dataIsRead = null,
  labels = [],
  classText = '',
  maxFontWeight = 0
} = {}) {
  const explicitData = boolFromData(dataIsRead);
  if (explicitData === true) {
    return { isUnread: false, isRead: true, source: 'data_is_read_true' };
  }
  if (explicitData === false) {
    return { isUnread: true, isRead: false, source: 'data_is_read_false' };
  }

  const normalized = labels.map(normalizeLabel).filter(Boolean);
  const markAsRead = normalized.some(label => [
    'mark as read',
    'marcar como leido',
    'marcar como leído'
  ].includes(label));
  const markAsUnread = normalized.some(label => [
    'mark as unread',
    'marcar como no leido',
    'marcar como no leído'
  ].includes(label));

  if (markAsRead && !markAsUnread) {
    return {
      isUnread: true,
      isRead: false,
      source: 'mark_as_read_action_visible'
    };
  }
  if (markAsUnread && !markAsRead) {
    return {
      isUnread: false,
      isRead: true,
      source: 'mark_as_unread_action_visible'
    };
  }

  const exactUnread = normalized.some(label => [
    'unread',
    'no leido',
    'no leído',
    'sin leer'
  ].includes(label));
  const exactRead = normalized.some(label => [
    'read',
    'leido',
    'leído'
  ].includes(label));

  if (exactUnread && !exactRead) {
    return { isUnread: true, isRead: false, source: 'exact_unread_label' };
  }
  if (exactRead && !exactUnread) {
    return { isUnread: false, isRead: true, source: 'exact_read_label' };
  }

  const normalizedClass = normalizeLabel(classText);
  if (/(^|[\s_-])(unread|isunread)([\s_-]|$)/i.test(normalizedClass)) {
    return { isUnread: true, isRead: false, source: 'unread_class_token' };
  }

  if (Number(maxFontWeight || 0) >= 600) {
    return { isUnread: true, isRead: false, source: 'bold_unread_row' };
  }

  return { isUnread: false, isRead: false, source: 'unknown' };
}

export function attachmentOccurrenceCoverage({
  expected = [],
  recovered = []
} = {}) {
  const expectedSet = new Set(expected.map(String));
  const recoveredSet = new Set(recovered.map(String));
  const missing = [...expectedSet].filter(key => !recoveredSet.has(key));

  return {
    expected_count: expectedSet.size,
    recovered_count: [...expectedSet]
      .filter(key => recoveredSet.has(key))
      .length,
    missing,
    complete: expectedSet.size === 0 || missing.length === 0
  };
}
