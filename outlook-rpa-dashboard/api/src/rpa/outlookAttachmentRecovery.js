function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).replace(/\s+/g, ' ').trim();
}

export function normalizedAttachmentName(value) {
  return clean(value).toLowerCase();
}

export function isPdfFileName(value) {
  return /\.pdf$/i.test(clean(value));
}

export function isPdfMagic(buffer) {
  if (!buffer) return false;
  const value = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(buffer);
  return value.subarray(0, 5).toString('ascii') === '%PDF-';
}

export function isBulkAttachmentDownloadAction(value) {
  const text = clean(value).toLowerCase();
  return (
    /\bdownload\s+all\b/.test(text)
    || /\bsave\s+all\b/.test(text)
    || /\bdescargar\s+todo(?:s)?\b/.test(text)
    || /\bguardar\s+todo(?:s)?\b/.test(text)
    || /\ball\s+attachments?\b/.test(text)
    || /\btodos?\s+los\s+adjuntos?\b/.test(text)
  );
}

export function mergePdfAttachmentNames(...groups) {
  const seen = new Set();
  const out = [];

  for (const group of groups) {
    for (const value of group || []) {
      const name = clean(
        typeof value === 'string'
          ? value
          : value?.fileName
      );

      if (!isPdfFileName(name)) continue;

      const key = normalizedAttachmentName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }

  return out;
}

export function attachmentCoverage(
  expectedNames = [],
  existingNames = [],
  downloadedNames = []
) {
  const expected = mergePdfAttachmentNames(expectedNames);
  const available = new Set(
    mergePdfAttachmentNames(
      existingNames,
      downloadedNames
    ).map(normalizedAttachmentName)
  );

  const missing = expected.filter(
    name => !available.has(
      normalizedAttachmentName(name)
    )
  );

  return {
    expected,
    expected_count: expected.length,
    available_count: expected.length - missing.length,
    missing,
    missing_count: missing.length,
    complete: expected.length > 0
      ? missing.length === 0
      : downloadedNames.length > 0
  };
}


export function isAttachmentExpanderLabel(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return (
    /\bshow all\s+\d+\s+attachments?\b/i.test(text)
    || /\bmostrar (?:todos? los|los)\s+\d+\s+archivos adjuntos\b/i.test(text)
    || /\bmostrar (?:todos? los|los)\s+\d+\s+adjuntos\b/i.test(text)
  );
}

export function isZipMagic(buffer) {
  if (!buffer) return false;
  const value = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(buffer);
  const signature = value.subarray(0, 4).toString('hex').toLowerCase();
  return ['504b0304', '504b0506', '504b0708'].includes(signature);
}

export function pdfArchiveEntries(entries = []) {
  const seen = new Set();
  const out = [];

  for (const entryValue of entries || []) {
    const entry = clean(entryValue).replace(/\\/g, '/');
    if (!entry || entry.endsWith('/')) continue;

    const baseName = entry.split('/').pop() || '';
    if (!isPdfFileName(baseName)) continue;

    const key = normalizedAttachmentName(baseName);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push({
      entry,
      fileName: baseName
    });
  }

  return out;
}

