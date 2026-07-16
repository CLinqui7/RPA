import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { attachmentOccurrenceCoverage, classifyOutlookReadState } from './outlookConversationGuards.js';
import { inferOutlookMessageMetadata } from './outlookMessageMetadata.js';
import { completeAttachmentCoverage, rowUnreadDecision, stableRowFingerprint, subjectFilterAlternatives } from './outlookUnreadQueue.js';
import { config } from '../config.js';
import {
  downloadedDocumentFileNamesForEmail
} from '../documentRepository.js';
import {
  attachmentCoverage,
  isAttachmentExpanderLabel,
  isBulkAttachmentDownloadAction,
  isPdfFileName,
  isPdfMagic,
  isZipMagic,
  mergePdfAttachmentNames,
  pdfArchiveEntries,
  normalizedAttachmentName
} from './outlookAttachmentRecovery.js';

// A2000_V4_6_7_OUTLOOK_ATTACHMENT_RECOVERY
// A2000_V4_7_1_FAST_OUTLOOK_DOWNLOAD
import { analyzeEmail, cleanSubject, extractPoNumber, extractPtNumber, stableKey } from '../parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '../..');
const userDataDir = path.resolve(apiRoot, '.auth/outlook-profile');
const downloadsPath = path.resolve(apiRoot, 'downloads');
const invoiceDownloadsPath = path.resolve(apiRoot, config.invoiceLocalDownloadDir);
const debugPath = path.resolve(apiRoot, 'debug');

const searchSelectors = [
  'input[aria-label="Search"]',
  'input[placeholder="Search"]',
  'input[aria-label*="Buscar"]',
  'input[placeholder*="Buscar"]',
  '[role="searchbox"] input',
  '[aria-label="Search"]',
  '[aria-label*="Search"] input'
];

const rowSelectors = [
  '[data-automationid="MessageListItem"]',
  '[role="listbox"] [role="option"]',
  '[aria-label*="Message list"] [role="listitem"]',
  '[aria-label*="Lista de mensajes"] [role="listitem"]',
  '[role="option"]'
];

const bodySelectors = [
  '[role="main"] [aria-label*="Message body"]',
  '[role="main"] [aria-label*="Cuerpo del mensaje"]',
  '[aria-label*="Message body"]',
  '[aria-label*="Cuerpo del mensaje"]',
  '[data-testid="message-body"]',
  '[role="document"]',
  '[role="main"]'
];

const downloadActionSelectors = [
  'button[aria-label*="Download"]',
  'button[title*="Download"]',
  'button:has-text("Download")',
  '[role="menuitem"]:has-text("Download")',
  '[role="button"]:has-text("Download")',
  'button[aria-label*="Descargar"]',
  'button[title*="Descargar"]',
  'button:has-text("Descargar")',
  '[role="menuitem"]:has-text("Descargar")',
  '[role="button"]:has-text("Descargar")'
];

async function ensureDirs() {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(downloadsPath, { recursive: true });
  await fs.mkdir(invoiceDownloadsPath, { recursive: true });
  await fs.mkdir(debugPath, { recursive: true });
}

async function safeText(locator, fallback = '') {
  try {
    return (await locator.innerText({ timeout: 2500 })).trim();
  } catch {
    return fallback;
  }
}

async function firstVisible(page, candidates, timeout = 2500) {
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch {}
  }
  return null;
}

async function screenshot(page, name, logs) {
  const filePath = path.join(debugPath, name);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
    logs.push(`Debug screenshot saved: ${filePath}`);
  } catch (error) {
    logs.push(`Could not save debug screenshot: ${error.message}`);
  }
}

function normalizeForMatch(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function subjectMatchesInvoiceFilter(subject = '') {
  const normalizedSubject = normalizeForMatch(subject);
  const alternatives = subjectFilterAlternatives(
    config.invoiceSubjectFilter || 'factura american'
  );

  return alternatives.some(value => (
    normalizedSubject.includes(normalizeForMatch(value))
  ));
}

function isProbablySystemRow(text = '') {
  const compact = text.toLowerCase();
  return (
    compact.includes('new mail') ||
    compact.includes('delete') ||
    compact.includes('archive') ||
    compact.includes('quick steps') ||
    compact.includes('select all') ||
    compact.length < 6
  );
}

function isSentFolderRow(text = '') {
  const normalized = normalizeForMatch(text);
  return (
    normalized.includes('sent items') ||
    normalized.includes('sent mail') ||
    normalized.includes('elementos enviados') ||
    normalized.includes('correo enviado') ||
    normalized.includes('po enviado') ||
    normalized.includes('enviado')
  );
}

async function getRowMeta(row) {
  const raw = await row.evaluate(element => {
    const text = (element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    const nodes = [
      element,
      ...element.querySelectorAll(
        '[aria-label], [title], [data-isread], [data-is-read], [class]'
      )
    ];

    const labels = [];
    const classes = [];
    let dataIsRead = null;
    let maxFontWeight = 0;

    for (const node of nodes.slice(0, 500)) {
      const aria = node.getAttribute?.('aria-label');
      const title = node.getAttribute?.('title');
      const dataA = node.getAttribute?.('data-isread');
      const dataB = node.getAttribute?.('data-is-read');
      const className = typeof node.className === 'string'
        ? node.className
        : node.getAttribute?.('class');

      if (aria) labels.push(aria);
      if (title) labels.push(title);
      if (className) classes.push(className);
      if (dataIsRead === null && dataA !== null) dataIsRead = dataA;
      if (dataIsRead === null && dataB !== null) dataIsRead = dataB;

      try {
        const style = window.getComputedStyle(node);
        const weight = Number.parseInt(style.fontWeight, 10);
        if (Number.isFinite(weight)) {
          maxFontWeight = Math.max(maxFontWeight, weight);
        }
      } catch {}
    }

    return {
      text,
      combined: `${text} ${labels.join(' ')} ${classes.join(' ')}`
        .replace(/\s+/g, ' ')
        .trim(),
      labels,
      classText: classes.join(' '),
      dataIsRead,
      maxFontWeight
    };
  }).catch(() => ({
    text: '',
    combined: '',
    labels: [],
    classText: '',
    dataIsRead: null,
    maxFontWeight: 0
  }));

  const state = classifyOutlookReadState({
    dataIsRead: raw.dataIsRead,
    labels: raw.labels,
    classText: raw.classText,
    maxFontWeight: raw.maxFontWeight
  });

  return {
    ...raw,
    isUnread: state.isUnread,
    isRead: state.isRead,
    readStateSource: state.source
  };
}

async function clickFirstVisibleEnabled(locator, logs, label, timeout = 1800) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    try {
      const visible = await item.isVisible({ timeout: 400 }).catch(() => false);
      const enabled = await item.isEnabled({ timeout: 400 }).catch(() => false);
      if (!visible || !enabled) continue;
      await item.click({ timeout });
      await item.page().waitForTimeout(700);
      logs.push(`Clicked ${label}: index ${i}`);
      return true;
    } catch (error) {
      logs.push(`Could not click ${label} index ${i}: ${error.message}`);
    }
  }
  return false;
}

async function tryMarkAsReadFromVisibleMenu(page, logs) {
  const exactName = /^(Mark as read|Read|Marcar como leído|Marcar como leido)$/i;
  const menuItem = page.getByRole('menuitem', { name: exactName }).first();

  if (await menuItem.isVisible({ timeout: 900 }).catch(() => false)) {
    await menuItem.click({ timeout: 1800 });
    logs.push('OUTLOOK_MARK_READ_ACTION=exact_menu_item');
    return true;
  }

  return false;
}

async function rowStillLooksUnread(row) {
  if (!row) return null;
  const meta = await getRowMeta(row);
  if (meta.isUnread && !meta.isRead) return true;
  if (meta.isRead && !meta.isUnread) return false;
  return null;
}

async function markCurrentMessageAsRead(page, logs, row = null) {
  if (!config.invoiceMarkAsRead) return true;

  const query = String(page.__a2000CurrentSearchQuery || '').toLowerCase();
  const unreadSearch = query.includes('isread:no');

  const verify = async label => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.waitForTimeout(attempt === 0 ? 600 : 850);

      if (row) {
        const visible = await row.isVisible({ timeout: 350 }).catch(() => false);
        if (!visible && unreadSearch) {
          logs.push(`OUTLOOK_MARK_READ_VERIFIED=${label}|SOURCE=row_left_unread_results`);
          return true;
        }

        const meta = await getRowMeta(row);
        if (meta.isRead && !meta.isUnread) {
          logs.push(`OUTLOOK_MARK_READ_VERIFIED=${label}|SOURCE=${meta.readStateSource}`);
          return true;
        }
      }
    }
    return false;
  };

  if (await verify('already_read')) return true;

  if (row) {
    const rowAction = row.getByRole('button', {
      name: /^(Mark as read|Marcar como leído|Marcar como leido)$/i
    }).first();

    if (await rowAction.isVisible({ timeout: 800 }).catch(() => false)) {
      try {
        await rowAction.click({ timeout: 1800, force: true });
        logs.push('OUTLOOK_MARK_READ_ACTION=row_exact_button');
        if (await verify('row_exact_button')) return true;
      } catch (error) {
        logs.push(`OUTLOOK_MARK_READ_ACTION_ERROR=row_exact_button|MESSAGE=${error.message}`);
      }
    }
  }

  const toolbarAction = page.getByRole('button', {
    name: /^(Mark as read|Marcar como leído|Marcar como leido)$/i
  }).first();

  if (await toolbarAction.isVisible({ timeout: 800 }).catch(() => false)) {
    try {
      await toolbarAction.click({ timeout: 1800, force: true });
      logs.push('OUTLOOK_MARK_READ_ACTION=toolbar_exact_button');
      if (await verify('toolbar_exact_button')) return true;
    } catch (error) {
      logs.push(`OUTLOOK_MARK_READ_ACTION_ERROR=toolbar_exact_button|MESSAGE=${error.message}`);
    }
  }

  if (row) {
    try {
      await row.click({ button: 'right', timeout: 1800, force: true });
      await page.waitForTimeout(600);
      if (await tryMarkAsReadFromVisibleMenu(page, logs)) {
        if (await verify('context_exact_menu')) return true;
      }
    } catch (error) {
      logs.push(`OUTLOOK_MARK_READ_ACTION_ERROR=context_menu|MESSAGE=${error.message}`);
    } finally {
      await page.keyboard.press('Escape').catch(() => null);
    }
  }

  try {
    if (row) await row.click({ timeout: 1200, force: true }).catch(() => null);
    await page.keyboard.press('Control+Q');
    logs.push('OUTLOOK_MARK_READ_ACTION=keyboard_control_q');
    if (await verify('keyboard_control_q')) return true;
  } catch (error) {
    logs.push(`OUTLOOK_MARK_READ_ACTION_ERROR=keyboard_control_q|MESSAGE=${error.message}`);
  }

  logs.push('OUTLOOK_MARK_READ_FAILED=verification_never_reached_read_state');
  return false;
}

async function getRows(page, logs) {
  for (const selector of rowSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      logs.push(`Found ${count} candidate rows with selector: ${selector}`);
      return locator;
    }
  }
  return null;
}

async function openOutlookPage(page, logs) {
  const targetUrl = config.outlookUrl || 'https://outlook.office.com/mail/inbox';
  logs.push(`Opening Outlook Web: ${targetUrl}`);
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.outlookLoadTimeoutMs
  });
  logs.push(`Current URL: ${page.url()}`);
  await page.waitForTimeout(3500);
}

async function waitForOutlookReady(page, logs) {
  const searchBox = await firstVisible(page, searchSelectors, 3500);
  if (searchBox) return { ready: true, searchBox };

  logs.push(`Search box not visible. Login may be required. Waiting ${config.outlookLoginGraceMs} ms.`);
  await page.waitForTimeout(config.outlookLoginGraceMs);

  const finalSearchBox = await firstVisible(page, searchSelectors, 2000);
  if (finalSearchBox) return { ready: true, searchBox: finalSearchBox };

  const rows = await getRows(page, logs);
  if (rows) return { ready: true, searchBox: null };

  return { ready: false, searchBox: null };
}

async function searchMessages(page, searchBox, searchQuery, logs) {
  if (!searchBox || !searchQuery) {
    logs.push('Search skipped. Scanning visible inbox rows.');
    return;
  }

  logs.push(`Searching Outlook with query: ${searchQuery}`);
  await searchBox.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(searchQuery);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);
}

async function clearSearchIfPossible(page, logs) {
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  } catch {}

  const searchBox = await firstVisible(page, searchSelectors, 800);
  if (!searchBox) return;

  try {
    await searchBox.click({ timeout: 1000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    logs.push('Cleared Outlook search box so scanner can read recent inbox rows.');
  } catch {
    logs.push('Could not clear Outlook search box. Continuing with current visible rows.');
  }
}

function extractAttachmentNames(text = '') {
  const matches = String(text).match(/[^\n\r\t<>:\"|?*]{2,160}\.(?:pdf|xlsx?|csv|docx?)/gi) || [];
  return [...new Set(matches.map(name => name.replace(/^[\s\uE000-\uF8FF]+|[\s\uE000-\uF8FF]+$/g, '').trim()).filter(Boolean))];
}

function extractPdfFileName(text = '') {
  const match = String(text).match(/[^\n\r\t<>:\"|?*]{2,160}\.pdf/i);
  return match?.[0]?.trim() || null;
}

function guessReceivedAt(text = '') {
  const compact = String(text).replace(/\s+/g, ' ');
  const match = compact.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?\s*\d{1,2}:\d{2}\s*(?:AM|PM)?/i);
  return match?.[0] || null;
}

async function readBestBodyText(page, rowText) {
  for (const selector of bodySelectors) {
    const text = await safeText(page.locator(selector).first(), '');
    if (text && text.length > Math.max(50, rowText.length * 0.5)) return text;
  }
  return rowText;
}

function safeFileName(name = 'attachment.pdf') {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned || 'attachment'}.pdf`;
}

function documentExternalKey(email, fileName = '') {
  // Stable key per email + attachment filename. Do not include localPath because
  // every download gets a timestamped path and that creates duplicate rows.
  const normalizedFileName = safeFileName(fileName || 'attachment.pdf').toLowerCase();
  const hash = crypto
    .createHash('sha256')
    .update(`${email.externalKey || ''}|${normalizedFileName}`)
    .digest('hex')
    .slice(0, 24);
  return `${email.externalKey || 'email'}|pdf|${hash}`;
}

async function saveDownload(download, email, fallbackName, logs) {
  const suggestedName = download.suggestedFilename();
  const suggested = String(suggestedName || '').trim();

  if (suggested && !isPdfFileName(suggested)) {
    logs.push(`REJECTED_NON_PDF_DOWNLOAD|SUGGESTED=${suggested}|REASON=filename_not_pdf`);
    return null;
  }

  const fileName = safeFileName(
    suggested || fallbackName || `outlook-${Date.now()}.pdf`
  );

  if (!isPdfFileName(fileName)) {
    logs.push(`REJECTED_NON_PDF_DOWNLOAD|FILE=${fileName}|REASON=target_not_pdf`);
    return null;
  }

  const dayFolder = new Date().toISOString().slice(0, 10);
  const folder = path.join(invoiceDownloadsPath, dayFolder);
  await fs.mkdir(folder, { recursive: true });

  const targetPath = path.join(folder, `${Date.now()}-${fileName}`);
  await download.saveAs(targetPath);

  const buffer = await fs.readFile(targetPath);

  if (!isPdfMagic(buffer)) {
    await fs.unlink(targetPath).catch(() => null);
    logs.push(`REJECTED_NON_PDF_DOWNLOAD|FILE=${fileName}|REASON=pdf_magic_missing`);
    return null;
  }

  const record = {
    externalKey: documentExternalKey(email, fileName),
    emailExternalKey: email.externalKey,
    subject: email.subject,
    senderName: email.senderName,
    senderEmail: email.senderEmail,
    fileName,
    localPath: targetPath,
    downloadedAt: new Date().toISOString(),
    raw: {
      suggestedName,
      fallbackName,
      currentUrl: email.raw?.currentUrl || null,
      filter: config.invoiceSubjectFilter,
      pdf_magic_verified: true
    }
  };

  logs.push(`Downloaded verified PDF locally: ${targetPath}`);
  return record;
}

async function clickAndWaitForDownload(page, clickFn, timeout = 9000) {
  const downloadPromise = page.waitForEvent('download', { timeout }).catch(() => null);
  await clickFn();
  return downloadPromise;
}

function extractPdfFileNames(text = '') {
  const matches = String(text).match(/[A-Z0-9][^\n\r\t<>:"|?*]{0,180}\.pdf/gi) || [];
  const seen = new Set();
  return matches
    .map(name => safeFileName(name.replace(/^[\s\uE000-\uF8FF]+|[\s\uE000-\uF8FF]+$/g, '').trim()))
    .filter(name => {
      const key = name.toLowerCase();
      if (!key.endsWith('.pdf') || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getOpenedMessageScope(page) {
  // Outlook has many PDF-ish texts in the left message list. The attachment we need lives
  // in the opened message/read pane, so always prefer role=main before falling back to page.
  return page.locator('[role="main"]').last();
}

async function findPdfAttachmentCandidates(page, logs) {
  const scope = getOpenedMessageScope(page);
  const scopeText = await safeText(scope, '');
  let names = extractPdfFileNames(scopeText);

  if (names.length) {
    logs.push(`PDF names detected inside opened message pane: ${names.join(', ')}`);
    return names.map((fileName, index) => ({ fileName, index, source: 'message-pane' }));
  }

  // Fallback: inspect clickable elements inside the message pane only.
  const clickable = scope.locator('button, a, [role="button"], [role="link"], [title], [aria-label], [download]');
  const elementCandidates = await clickable.evaluateAll(elements => elements
    .map((element, index) => {
      const text = [
        element.textContent || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('download') || '',
        element.getAttribute('href') || ''
      ].join(' ').replace(/\s+/g, ' ').trim();
      return { index, text };
    })
    .filter(item => /\.pdf\b/i.test(item.text))
  ).catch(() => []);

  const seen = new Set();
  const candidates = [];
  for (const item of elementCandidates) {
    const foundNames = extractPdfFileNames(item.text);
    for (const fileName of foundNames) {
      const key = fileName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ fileName, index: item.index, text: item.text, source: 'message-clickable' });
    }
  }

  if (candidates.length) {
    logs.push(`PDF candidates detected from opened message clickables: ${candidates.map(c => c.fileName).join(', ')}`);
    return candidates;
  }

  // Last fallback for odd Outlook layouts. This can include left-list noise, so use only if nothing else worked.
  const pageText = await safeText(page.locator('body').first(), '');
  names = extractPdfFileNames(pageText).slice(0, 5);
  if (names.length) {
    logs.push(`Fallback PDF names detected from whole page: ${names.join(', ')}`);
  }
  return names.map((fileName, index) => ({ fileName, index, source: 'page-fallback' }));
}

async function clickDownloadMenuItem(page, logs) {
  const selectors = [
    '[role="menuitem"]:has-text("Download")',
    '[role="menuitem"]:has-text("Descargar")',
    'button:has-text("Download")',
    'button:has-text("Descargar")',
    '[role="button"]:has-text("Download")',
    '[role="button"]:has-text("Descargar")',
    'text=/^Download$/i',
    'text=/^Descargar$/i'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);

      const label = await item.evaluate(element => [
        element.textContent || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
      ].join(' ').replace(/\s+/g, ' ').trim()).catch(() => '');

      if (isBulkAttachmentDownloadAction(label)) {
        logs.push(`Skipped Outlook bulk attachment action: ${label}`);
        continue;
      }

      try {
        const download = await clickAndWaitForDownload(
          page,
          () => item.click({ timeout: 2500 }),
          10000
        );

        if (download) return download;
      } catch (error) {
        logs.push(`Menu download click failed for ${selector} index ${index}: ${error.message}`);
      }
    }
  }

  return null;
}

async function tryVisibleDownloadButton(page, logs) {
  const locator = page.locator(downloadActionSelectors.join(', '));
  const options = await locator.evaluateAll(elements => elements.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const text = [
      element.textContent || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || ''
    ].join(' ').replace(/\s+/g, ' ').trim();
    const disabled = element.disabled === true || element.getAttribute('aria-disabled') === 'true';
    return {
      index,
      text,
      visible: rect.width > 0 && rect.height > 0,
      disabled
    };
  }).filter(item => item.visible && !item.disabled && /(download|descargar)/i.test(item.text))).catch(() => []);

  for (const option of options) {
    if (isBulkAttachmentDownloadAction(option.text)) {
      logs.push(`Skipped Outlook bulk attachment action: ${option.text}`);
      continue;
    }

    const button = locator.nth(option.index);
    try {
      logs.push(`Trying visible download action: ${option.text}`);
      const download = await clickAndWaitForDownload(page, () => button.click({ timeout: 2500 }), 10000);
      if (download) return download;
    } catch (error) {
      logs.push(`Visible download action failed: ${error.message}`);
    }
  }
  return null;
}


async function findVisiblePdfAttachmentCards(page, logs) {
  const cards = await page.evaluate(() => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) !== 0;
    };

    const viewportWidth = window.innerWidth || 1440;
    const viewportHeight = window.innerHeight || 950;
    const minReadingPaneX = Math.max(500, viewportWidth * 0.32);
    const filenameRegex = /[A-Z0-9][^\n\r\t<>:"|?*]{0,180}?\.pdf/gi;
    const elements = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"], [aria-label], [title], div, span'));
    const raw = [];

    for (const element of elements) {
      if (!isVisible(element)) continue;
      const rect = element.getBoundingClientRect();

      // Ignore Outlook's left message list, app rail, toolbar, browser chrome, and very low invisible/recycled DOM.
      if (rect.left < minReadingPaneX || rect.top < 190 || rect.top > viewportHeight - 20) continue;

      const text = normalize([
        element.textContent,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('download'),
        element.getAttribute('href')
      ].filter(Boolean).join(' '));

      if (!/\.pdf\b/i.test(text)) continue;
      const fileName = (text.match(filenameRegex) || [])[0];
      if (!fileName) continue;

      let card = element;
      let current = element;
      for (let i = 0; i < 10 && current; i += 1) {
        const candidateRect = current.getBoundingClientRect();
        const candidateText = normalize(current.textContent || '');
        const looksLikeAttachmentCard =
          candidateRect.left >= minReadingPaneX &&
          candidateRect.width >= 120 && candidateRect.width <= 520 &&
          candidateRect.height >= 28 && candidateRect.height <= 130 &&
          /\.pdf\b/i.test(candidateText);

        if (looksLikeAttachmentCard) card = current;
        current = current.parentElement;
      }

      const cardRect = card.getBoundingClientRect();
      raw.push({
        fileName: normalize(fileName),
        text,
        box: {
          x: cardRect.left,
          y: cardRect.top,
          width: cardRect.width,
          height: cardRect.height
        }
      });
    }

    const bestByName = new Map();
    for (const item of raw.filter(item => item.box.width > 0 && item.box.height > 0)) {
      const key = item.fileName.toLowerCase();
      const area = item.box.width * item.box.height;
      const existing = bestByName.get(key);
      const existingArea = existing ? existing.box.width * existing.box.height : 0;
      // Outlook often exposes both the full attachment card and an inner filename span.
      // Keep only the largest visible card per filename to avoid double downloads.
      if (!existing || area > existingArea) bestByName.set(key, item);
    }

    return Array.from(bestByName.values())
      .sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x))
      .slice(0, 10);
  }).catch(error => {
    logs.push(`Could not inspect visible attachment cards: ${error.message}`);
    return [];
  });

  if (cards.length) {
    logs.push(`Visible PDF attachment card(s) in reading pane: ${cards.map(card => `${card.fileName} @ ${Math.round(card.box.x)},${Math.round(card.box.y)},${Math.round(card.box.width)}x${Math.round(card.box.height)}`).join(' | ')}`);
  }

  return cards;
}

async function downloadPdfAttachmentFromCardBox(page, email, card, logs) {
  const fileName = safeFileName(card.fileName || 'attachment.pdf');
  const box = card.box;
  if (!box || !box.width || !box.height) return null;

  const clickPoints = [
    // Outlook attachment card dropdown/chevron is usually on the right side.
    { x: box.x + box.width - 14, y: box.y + box.height / 2, label: 'right edge dropdown' },
    { x: box.x + box.width - 34, y: box.y + box.height / 2, label: 'right inner dropdown' },
    { x: box.x + box.width / 2, y: box.y + box.height / 2, label: 'card center' }
  ];

  for (const point of clickPoints) {
    try {
      logs.push(`Clicking ${point.label} for visible attachment ${fileName} at ${Math.round(point.x)},${Math.round(point.y)}`);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(900);

      let download = await clickDownloadMenuItem(page, logs);
      if (download) return saveDownload(download, email, fileName, logs);

      // Some Outlook builds download directly from the card or open a preview toolbar.
      download = await tryVisibleDownloadButton(page, logs);
      if (download) return saveDownload(download, email, fileName, logs);

      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(400);
    } catch (error) {
      logs.push(`Visible attachment card click failed for ${fileName}: ${error.message}`);
    }
  }

  try {
    logs.push(`Trying right-click context menu for visible attachment ${fileName}`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.waitForTimeout(900);
    const download = await clickDownloadMenuItem(page, logs);
    if (download) return saveDownload(download, email, fileName, logs);
  } catch (error) {
    logs.push(`Visible attachment right-click failed for ${fileName}: ${error.message}`);
  } finally {
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(400).catch(() => null);
  }

  return null;
}

async function getAttachmentCardBox(fileTextLocator) {
  const textHandle = await fileTextLocator.elementHandle();
  if (!textHandle) return null;

  const cardHandle = await textHandle.evaluateHandle(element => {
    let current = element;
    let best = element;

    for (let i = 0; i < 8 && current; i += 1) {
      const rect = current.getBoundingClientRect();
      const looksLikeAttachmentCard = rect.width >= 150 && rect.width <= 900 && rect.height >= 25 && rect.height <= 160;
      if (looksLikeAttachmentCard) best = current;
      current = current.parentElement;
    }

    return best;
  });

  const cardElement = cardHandle.asElement();
  if (!cardElement) return null;
  return cardElement.boundingBox();
}

async function locatorForAttachmentFileName(page, fileName) {
  const scope = getOpenedMessageScope(page);
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactish = scope.getByText(new RegExp(escaped, 'i')).first();
  if ((await exactish.count().catch(() => 0)) > 0) return exactish;

  const shortName = fileName.replace(/\s+/g, ' ').trim();
  const fallback = page.getByText(new RegExp(shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
  if ((await fallback.count().catch(() => 0)) > 0) return fallback;
  return null;
}

async function tryOpenPreviewThenDownloadByName(page, fileName, logs) {
  const target = await locatorForAttachmentFileName(page, fileName);
  if (!target) {
    logs.push(`Could not find visible attachment text for ${fileName}`);
    return null;
  }

  try {
    logs.push(`Clicking attachment text to open/download: ${fileName}`);
    let download = await clickAndWaitForDownload(page, () => target.click({ timeout: 3500 }), 9000);
    if (download) return download;

    await page.waitForTimeout(2200);
    download = await tryVisibleDownloadButton(page, logs);
    if (download) return download;

    download = await clickDownloadMenuItem(page, logs);
    if (download) return download;
  } catch (error) {
    logs.push(`Attachment text strategy failed for ${fileName}: ${error.message}`);
  } finally {
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(500).catch(() => null);
  }

  return null;
}

async function tryAttachmentDropdownByName(page, fileName, logs) {
  const target = await locatorForAttachmentFileName(page, fileName);
  if (!target) return null;

  try {
    const box = await getAttachmentCardBox(target);
    if (!box) {
      logs.push(`Could not get attachment card box for ${fileName}`);
      return null;
    }

    // Outlook's attachment card has a chevron/more-actions area on the right side.
    const clickX = box.x + box.width - 18;
    const clickY = box.y + Math.min(Math.max(box.height / 2, 16), box.height - 8);
    logs.push(`Clicking attachment dropdown area for ${fileName} at ${Math.round(clickX)},${Math.round(clickY)}`);

    await page.mouse.click(clickX, clickY);
    await page.waitForTimeout(900);

    let download = await clickDownloadMenuItem(page, logs);
    if (download) return download;

    // If the chevron did not open, try right click on the card center.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.waitForTimeout(900);
    download = await clickDownloadMenuItem(page, logs);
    if (download) return download;
  } catch (error) {
    logs.push(`Attachment dropdown strategy failed for ${fileName}: ${error.message}`);
  } finally {
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(500).catch(() => null);
  }

  return null;
}

async function downloadPdfAttachmentByName(page, email, fileName, logs) {
  let download = await tryAttachmentDropdownByName(page, fileName, logs);
  if (!download) download = await tryOpenPreviewThenDownloadByName(page, fileName, logs);

  if (!download) {
    logs.push(`Could not download attachment: ${fileName}`);
    await screenshot(page, `download-failed-${safeFileName(fileName).replace(/\.pdf$/i, '')}-${Date.now()}.png`, logs);
    return null;
  }

  return saveDownload(download, email, fileName, logs);
}

// A2000_V4_6_8_1_EXPAND_COLLAPSED_ATTACHMENT_GROUP
// A2000_V4_6_8_2_BULK_ZIP_ATTACHMENT_RECOVERY
// A2000_V4_7_0_ALL_MESSAGE_GROUPS_ALL_PDFS
// A2000_V4_7_0_ALL_MESSAGE_GROUPS_ALL_PDFS
async function downloadMatchingPdfAttachments(
  page,
  email,
  logs,
  {
    skipFileNames = []
  } = {}
) {
  if (!subjectMatchesInvoiceFilter(email.subject)) return [];

  const records = [];
  const existingNames = new Set(
    mergePdfAttachmentNames(skipFileNames).map(normalizedAttachmentName)
  );
  const savedHashes = new Set();
  const expectedNames = new Set(
    mergePdfAttachmentNames(email.attachments || []).map(value => safeFileName(value))
  );
  const expectedOccurrences = new Set();
  const recoveredOccurrences = new Set();
  const bulkActionKeys = new Set();
  let messageGroupCount = 0;

  const execute = async (command, args, binary = false, maxBuffer = 128 * 1024 * 1024) => {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve, reject) => {
      execFile(command, args, {
        encoding: binary ? null : 'utf8',
        maxBuffer
      }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  };

  const savePdfBuffer = async (buffer, fileName, meta = {}) => {
    if (!isPdfMagic(buffer)) {
      logs.push(`PDF_REJECTED|FILE=${fileName}|REASON=pdf_magic_missing`);
      return null;
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const safeName = safeFileName(fileName);
    const normalizedName = normalizedAttachmentName(safeName);

    expectedNames.add(safeName);

    if (existingNames.has(normalizedName)) {
      logs.push(`PDF_ALREADY_LINKED_TO_EMAIL=${safeName}`);
      return null;
    }

    if (savedHashes.has(sha256)) {
      logs.push(`PDF_DUPLICATE_CONTENT_SKIPPED|FILE=${safeName}|SHA256=${sha256}`);
      return null;
    }

    savedHashes.add(sha256);

    const dayFolder = new Date().toISOString().slice(0, 10);
    const folder = path.join(invoiceDownloadsPath, dayFolder);
    await fs.mkdir(folder, { recursive: true });
    const targetPath = path.join(
      folder,
      `${Date.now()}-${sha256.slice(0, 10)}-${safeName}`
    );
    await fs.writeFile(targetPath, buffer);

    const record = {
      externalKey: documentExternalKey(email, `${sha256}|${safeName}`),
      emailExternalKey: email.externalKey,
      subject: email.subject,
      senderName: email.senderName,
      senderEmail: email.senderEmail,
      fileName: safeName,
      localPath: targetPath,
      downloadedAt: new Date().toISOString(),
      raw: {
        currentUrl: email.raw?.currentUrl || null,
        filter: config.invoiceSubjectFilter,
        pdf_magic_verified: true,
        sha256,
        recovery_mode: meta.recovery_mode || 'outlook_attachment',
        message_group: meta.message_group ?? null,
        archive_name: meta.archive_name || null,
        archive_entry: meta.archive_entry || null,
        attachment_occurrence_key: meta.occurrence_key || null
      }
    };

    records.push(record);
    logs.push(
      `OUTLOOK_PDF_SAVED=${safeName}|SHA256=${sha256}`
      + `|GROUP=${meta.message_group ?? 'unknown'}`
      + `|MODE=${record.raw.recovery_mode}`
    );
    return record;
  };

  const scrollConversation = async position => {
    const data = await page.evaluate(target => {
      const viewportWidth = window.innerWidth || 1440;
      const minX = Math.max(440, viewportWidth * 0.27);
      const candidates = Array.from(document.querySelectorAll('main, section, div, [role="main"]'))
        .map(element => {
          const rect = element.getBoundingClientRect();
          const max = Math.max(0, element.scrollHeight - element.clientHeight);
          return { element, rect, max };
        })
        .filter(item => (
          item.rect.width > 260
          && item.rect.height > 180
          && item.rect.left >= minX
          && item.max > 80
        ))
        .sort((left, right) => right.max - left.max)
        .slice(0, 10);

      for (const item of candidates) {
        item.element.scrollTop = Math.round(item.max * target);
      }

      const documentMax = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
      window.scrollTo(0, Math.round(documentMax * target));

      return {
        candidate_count: candidates.length,
        max_scroll: candidates[0]?.max || documentMax,
        tops: candidates.map(item => item.element.scrollTop)
      };
    }, position).catch(() => ({ candidate_count: 0, max_scroll: 0, tops: [] }));

    await page.waitForTimeout(900);
    logs.push(
      `OUTLOOK_CONVERSATION_SCROLL|POSITION=${position}`
      + `|CONTAINERS=${data.candidate_count}`
      + `|MAX=${data.max_scroll}`
    );
  };

  const expandMessageAndAttachmentGroups = async () => {
    let total = 0;

    for (let pass = 0; pass < 4; pass += 1) {
      const candidates = page.locator([
        'button[aria-label*="attachment" i]',
        'button[aria-label*="adjunto" i]',
        'button[aria-label*="expand" i]',
        'button[aria-label*="mostrar" i]',
        'button[title*="attachment" i]',
        'button[title*="adjunto" i]',
        '[role="button"]:has-text("Show")',
        '[role="button"]:has-text("Expand")',
        '[role="button"]:has-text("Mostrar")',
        '[role="button"]:has-text("Adjunto")'
      ].join(', '));
      const count = Math.min(await candidates.count().catch(() => 0), 120);
      let clicked = false;

      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        const meta = await candidate.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const label = [
            element.textContent || '',
            element.getAttribute('aria-label') || '',
            element.getAttribute('title') || ''
          ].join(' ').replace(/\s+/g, ' ').trim();
          return {
            label,
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            expanded: element.getAttribute('data-a2000-expanded') === '1'
          };
        }).catch(() => null);

        if (!meta || meta.expanded) continue;
        if (meta.x < Math.max(440, 0.27 * 1440)) continue;
        if (meta.y < 100 || meta.y > 940 || meta.width < 1 || meta.height < 1) continue;

        const matches = (
          isAttachmentExpanderLabel(meta.label)
          || /show message|expand message|expand conversation|mostrar mensaje|expandir mensaje/i.test(meta.label)
        );
        if (!matches) continue;

        try {
          await candidate.evaluate(element => element.setAttribute('data-a2000-expanded', '1'));
          await candidate.click({ timeout: 2200, force: true });
          await page.waitForTimeout(850);
          logs.push(`OUTLOOK_MESSAGE_OR_ATTACHMENT_GROUP_EXPANDED=${meta.label}`);
          total += 1;
          clicked = true;
          break;
        } catch (error) {
          logs.push(`OUTLOOK_GROUP_EXPAND_ERROR=${meta.label}|MESSAGE=${error.message}`);
        }
      }

      if (!clicked) break;
    }

    return total;
  };

  const inventoryVisiblePdfNames = async () => {
    const candidates = await findPdfAttachmentCandidates(page, logs);
    const cards = await findVisiblePdfAttachmentCards(page, logs);
    for (const item of [...candidates, ...cards]) {
      if (item?.fileName) expectedNames.add(safeFileName(item.fileName));
    }
  };

  const recoverVisibleDownloadAll = async () => {
    const actions = page.locator([
      'button:has-text("Download all")',
      'a:has-text("Download all")',
      '[role="button"]:has-text("Download all")',
      '[role="link"]:has-text("Download all")',
      '[role="menuitem"]:has-text("Download all")',
      'button:has-text("Descargar todo")',
      'a:has-text("Descargar todo")',
      '[role="button"]:has-text("Descargar todo")',
      '[role="link"]:has-text("Descargar todo")',
      '[aria-label*="Download all" i]',
      '[title*="Download all" i]',
      '[aria-label*="Descargar todo" i]',
      '[title*="Descargar todo" i]'
    ].join(', '));
    const count = Math.min(await actions.count().catch(() => 0), 24);

    for (let index = 0; index < count; index += 1) {
      const action = actions.nth(index);
      const meta = await action.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const label = [
          element.textContent || '',
          element.getAttribute('aria-label') || '',
          element.getAttribute('title') || ''
        ].join(' ').replace(/\s+/g, ' ').trim();

        let current = element;
        let groupText = '';
        for (let depth = 0; depth < 12 && current; depth += 1) {
          const text = (current.innerText || current.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (/attachments?|adjuntos?/i.test(text) && text.length < 6000) {
            groupText = text;
          }
          current = current.parentElement;
        }

        return {
          label,
          groupText: groupText.slice(0, 1200),
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        };
      }).catch(() => null);

      if (!meta || !isBulkAttachmentDownloadAction(meta.label)) continue;
      if (meta.x < Math.max(440, 0.27 * 1440)) continue;
      if (meta.y < 100 || meta.y > 940 || meta.width < 1 || meta.height < 1) continue;

      const actionKey = crypto
        .createHash('sha256')
        .update(`${meta.label}|${meta.groupText}`)
        .digest('hex')
        .slice(0, 20);

      if (bulkActionKeys.has(actionKey)) continue;
      bulkActionKeys.add(actionKey);
      messageGroupCount += 1;
      const messageGroup = messageGroupCount;

      let tempDir = null;
      try {
        await action.scrollIntoViewIfNeeded({ timeout: 1200 }).catch(() => null);
        const download = await clickAndWaitForDownload(
          page,
          () => action.click({ timeout: 3500, force: true }),
          18000
        );

        if (!download) {
          logs.push(`OUTLOOK_DOWNLOAD_ALL_NO_EVENT=${meta.label}|GROUP=${messageGroup}`);
          continue;
        }

        tempDir = await fs.mkdtemp(path.join(downloadsPath, 'outlook-all-'));
        const suggested = download.suggestedFilename() || `attachments-${Date.now()}.zip`;
        const archivePath = path.join(tempDir, `${Date.now()}-outlook-download.bin`);
        await download.saveAs(archivePath);
        const archiveBuffer = await fs.readFile(archivePath);

        if (!isZipMagic(archiveBuffer)) {
          const occurrenceKey = `${actionKey}|single|${suggested}`;
          expectedOccurrences.add(occurrenceKey);

          if (isPdfMagic(archiveBuffer)) {
            recoveredOccurrences.add(occurrenceKey);
            await savePdfBuffer(archiveBuffer, suggested, {
              recovery_mode: 'download_all_single_pdf',
              message_group: messageGroup,
              occurrence_key: occurrenceKey
            });
          } else {
            logs.push(`OUTLOOK_DOWNLOAD_ALL_REJECTED=${suggested}|REASON=not_zip_or_pdf`);
          }
          continue;
        }

        const listScript = [
          'import json, sys, zipfile',
          'with zipfile.ZipFile(sys.argv[1], "r") as archive:',
          '    print(json.dumps(archive.namelist()))'
        ].join('\n');
        const listing = await execute('python3', ['-c', listScript, archivePath]);
        const names = JSON.parse(String(listing.stdout || '[]'));
        const entries = pdfArchiveEntries(names);

        logs.push(
          `OUTLOOK_DOWNLOAD_ALL_ARCHIVE=${suggested}|GROUP=${messageGroup}`
          + `|PDF_COUNT=${entries.length}`
          + `|FILES=${entries.map(item => item.fileName).join(' | ')}`
        );

        const exactReader = [
          'import sys, zipfile',
          'archive_path, member_name = sys.argv[1], sys.argv[2]',
          'with zipfile.ZipFile(archive_path, "r") as archive:',
          '    sys.stdout.buffer.write(archive.read(member_name))'
        ].join('\n');

        for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
          const entry = entries[entryIndex];
          const occurrenceKey = `${actionKey}|${entryIndex}|${entry.entry}`;
          expectedOccurrences.add(occurrenceKey);
          expectedNames.add(safeFileName(entry.fileName));

          try {
            const extracted = await execute(
              'python3',
              ['-c', exactReader, archivePath, entry.entry],
              true
            );
            const buffer = Buffer.isBuffer(extracted.stdout)
              ? extracted.stdout
              : Buffer.from(extracted.stdout || []);

            if (!isPdfMagic(buffer)) {
              logs.push(
                `OUTLOOK_ZIP_MEMBER_ERROR|GROUP=${messageGroup}`
                + `|ENTRY=${entry.entry}|MESSAGE=pdf_magic_missing`
              );
              continue;
            }

            recoveredOccurrences.add(occurrenceKey);
            await savePdfBuffer(buffer, entry.fileName, {
              recovery_mode: 'download_all_zip_exact_member',
              message_group: messageGroup,
              archive_name: suggested,
              archive_entry: entry.entry,
              occurrence_key: occurrenceKey
            });
          } catch (entryError) {
            logs.push(
              `OUTLOOK_ZIP_MEMBER_ERROR|GROUP=${messageGroup}`
              + `|ENTRY=${entry.entry}`
              + `|NAME=${entryError.name || 'Error'}`
              + `|MESSAGE=${entryError.message}`
            );
          }
        }
      } catch (error) {
        logs.push(
          `OUTLOOK_DOWNLOAD_ALL_ERROR|GROUP=${messageGroup}`
          + `|NAME=${error.name || 'Error'}|MESSAGE=${error.message}`
        );
      } finally {
        if (tempDir) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null);
        }
        await page.keyboard.press('Escape').catch(() => null);
      }
    }
  };

  const positions = [0, 0.5, 1];

  for (const position of positions) {
    await scrollConversation(position);
    await expandMessageAndAttachmentGroups();
    await inventoryVisiblePdfNames();
    await recoverVisibleDownloadAll();
  }

  await scrollConversation(0);
  await expandMessageAndAttachmentGroups();
  await inventoryVisiblePdfNames();

  for (const expectedName of [...expectedNames]) {
    const normalizedName = normalizedAttachmentName(expectedName);
    if (existingNames.has(normalizedName)) continue;
    if (records.some(record => normalizedAttachmentName(record.fileName) === normalizedName)) continue;

    const saved = await downloadPdfAttachmentByName(page, email, expectedName, logs);
    if (saved) {
      records.push(saved);
      logs.push(`OUTLOOK_DIRECT_PDF_RECOVERED=${expectedName}`);
    }
  }

  const nameCoverage = completeAttachmentCoverage({
    expected: [...expectedNames],
    existing: [...existingNames],
    downloaded: records.map(record => record.fileName)
  });
  const occurrenceCoverage = attachmentOccurrenceCoverage({
    expected: [...expectedOccurrences],
    recovered: [...recoveredOccurrences]
  });
  const complete = nameCoverage.complete && occurrenceCoverage.complete;
  const occurrenceCoverageUnknown = (
    expectedNames.size > 0
    && Number(occurrenceCoverage.expected_count || 0) === 0
  );

  if (occurrenceCoverageUnknown) {
    logs.push(
      `OUTLOOK_ATTACHMENT_OCCURRENCE_COVERAGE_UNKNOWN`
      + `|EMAIL=${email.subject}`
      + `|UNIQUE_NAMES=${expectedNames.size}`
      + `|ACTION=name_coverage_used_without_blocking`
    );
  }

  email.attachments = [...expectedNames];
  email.raw = {
    ...(email.raw || {}),
    attachment_occurrence_coverage: {
      ...occurrenceCoverage,
      message_group_count: messageGroupCount,
      coverage_unknown: occurrenceCoverageUnknown
    },
    attachment_download_complete: complete
  };

  logs.push(
    `OUTLOOK_ALL_PDFS_RESULT|EMAIL=${email.subject}`
    + `|MESSAGE_GROUPS=${messageGroupCount}`
    + `|ATTACHMENTS_EXPECTED=${occurrenceCoverage.expected_count}`
    + `|ATTACHMENTS_RECOVERED=${occurrenceCoverage.recovered_count}`
    + `|UNIQUE_NAMES_EXPECTED=${nameCoverage.expected_count}`
    + `|UNIQUE_NAMES_AVAILABLE=${nameCoverage.available_count}`
    + `|UNIQUE_DOCUMENTS_NEW=${records.length}`
    + `|COMPLETE=${complete}`
    + `|MISSING_OCCURRENCES=${occurrenceCoverage.missing.length}`
    + `|MISSING_NAMES=${nameCoverage.missing.join(' | ') || '(none)'}`
  );

  return records;
}

async function readMessage(page, row, rowText, logs = []) {
  await row.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => null);

  // Click the center of the specific message-list row. Outlook sometimes keeps
  // stale reading-pane content if the click lands on nested icons/previews.
  const rowBox = await row.boundingBox().catch(() => null);
  if (rowBox) {
    await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  } else {
    await row.click({ timeout: 5000 }).catch(() => null);
  }

  // Wait until the opened reading pane looks connected to the selected row.
  // This prevents downloading attachments from the previously opened email.
  const expectedNeedles = [];
  if (subjectMatchesInvoiceFilter(rowText)) expectedNeedles.push(config.invoiceSubjectFilter || 'factura american');
  for (const name of extractAttachmentNames(rowText)) expectedNeedles.push(name);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(500);
    const mainText = await safeText(page.locator('[role="main"]').last(), '');
    const normalizedMain = normalizeForMatch(mainText);
    const ready = expectedNeedles.length === 0 || expectedNeedles.some(needle => normalizedMain.includes(normalizeForMatch(needle)));
    if (ready) break;
    if (attempt === 7) logs.push('Reading pane did not clearly match selected row before parsing. Continuing cautiously.');
  }

  const rawSubject =
    (await safeText(page.locator('[role="main"] [aria-level="1"]').first(), '')) ||
    (await safeText(page.locator('[role="heading"]').first(), '')) ||
    rowText.split('\n').find(Boolean) ||
    '';

  const bodyText = await readBestBodyText(page, rowText);

  // RPA_POST_LIVE_OUTLOOK_METADATA_V1
  const messageMetadata = inferOutlookMessageMetadata({
    rawSubject,
    rowText,
    bodyText,
    subjectFilter: config.invoiceSubjectFilter
  });

  const allText = `${rawSubject}\n${rowText}\n${bodyText}`;
  const senderEmailMatch = allText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const senderEmail = senderEmailMatch?.[0]?.toLowerCase() || null;
  const senderName = messageMetadata.senderName;
  const subject = messageMetadata.subject;
  const poNumber = extractPoNumber(allText);
  const ptNumber = extractPtNumber(allText);
  const attachments = extractAttachmentNames(allText);
  const hasAttachments = attachments.length > 0 || /attachment|attached|attachments|adjunto|adjuntos/i.test(allText);

  const email = {
    subject,
    senderName,
    senderEmail,
    receivedAt: guessReceivedAt(allText),
    snippet: rowText.slice(0, 900),
    bodyText: bodyText.slice(0, 16000),
    poNumber,
    ptNumber,
    hasAttachments,
    attachments,
    raw: {
      rowText,
      currentUrl: page.url(),
      rawSubject,
      scannedMode: config.outlookScanMode,
      message_metadata: {
        subject_source: messageMetadata.subjectSource,
        sender_source: messageMetadata.senderSource,
        configured_subject_line:
          messageMetadata.configuredSubjectLine,
        rejected_raw_subject:
          messageMetadata.rejectedRawSubject
      }
    }
  };

  email.analysis = analyzeEmail(email);
  email.messageType = email.analysis.messageType;
  email.customerName = email.analysis.customerName;
  email.operatorName = email.analysis.operatorName;
  email.externalKey = stableKey(email);
  return email;
}

// A2000_V4_6_8_2_MATCHED_EMAIL_OBSERVABILITY
// A2000_V4_7_0_UNREAD_QUEUE_DRAIN
// A2000_V4_7_0_UNREAD_QUEUE_DRAIN
async function collectVisibleEmails(page, maxEmails, logs) {
  const emails = [];
  const documents = [];
  const processedRows = new Set();
  const processedEmails = new Set();
  const query = String(page.__a2000CurrentSearchQuery || config.outlookSearchQuery || '').trim();
  let processedCount = 0;
  let idlePasses = 0;
  let scrollPasses = 0;

  const scrollMessageList = async () => {
    const selectors = [
      '[data-automationid="MessageList"]',
      '[aria-label*="Message list" i]',
      '[aria-label*="Lista de mensajes" i]',
      '[role="listbox"]'
    ];

    for (const selector of selectors) {
      const list = page.locator(selector).first();
      if (!(await list.count().catch(() => 0))) continue;

      const moved = await list.evaluate(element => {
        const before = Number(element.scrollTop || 0);
        const step = Math.max(Number(element.clientHeight || 0) * 0.82, 450);
        element.scrollTop = Math.min(
          before + step,
          Math.max(0, Number(element.scrollHeight || 0) - Number(element.clientHeight || 0))
        );
        return {
          before,
          after: Number(element.scrollTop || 0),
          height: Number(element.scrollHeight || 0),
          viewport: Number(element.clientHeight || 0)
        };
      }).catch(() => null);

      if (moved) {
        logs.push(
          `OUTLOOK_RESULT_SCROLL|BEFORE=${moved.before}|AFTER=${moved.after}`
          + `|HEIGHT=${moved.height}|VIEWPORT=${moved.viewport}`
        );
        await page.waitForTimeout(900);
        return moved.after > moved.before;
      }
    }

    return false;
  };

  const resetMessageListToTop = async () => {
    for (const selector of [
      '[data-automationid="MessageList"]',
      '[aria-label*="Message list" i]',
      '[aria-label*="Lista de mensajes" i]',
      '[role="listbox"]'
    ]) {
      const list = page.locator(selector).first();
      if (!(await list.count().catch(() => 0))) continue;
      await list.evaluate(element => { element.scrollTop = 0; }).catch(() => null);
      await page.waitForTimeout(700);
      return;
    }
  };

  await resetMessageListToTop();

  while (processedCount < maxEmails && idlePasses < 6) {
    const rows = await getRows(page, logs);
    if (!rows) break;

    const count = Math.min(await rows.count().catch(() => 0), 250);
    let candidate = null;

    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const rowText = await safeText(row);
      if (isProbablySystemRow(rowText)) continue;

      const rowMeta = await getRowMeta(row);
      const combined = `${rowText} ${rowMeta.combined || ''}`;
      const fingerprint = stableRowFingerprint({
        text: rowText,
        combined,
        index
      });

      const subjectMatch = subjectMatchesInvoiceFilter(rowText);
      const inboxFallback = /__INBOX_DOM_UNREAD_FALLBACK__/i.test(query);

      if (inboxFallback && index < 60) {
        logs.push(
          `OUTLOOK_INBOX_ROW_DIAGNOSTIC|INDEX=${index}`
          + `|SUBJECT_MATCH=${subjectMatch}`
          + `|IS_UNREAD=${rowMeta.isUnread}`
          + `|IS_READ=${rowMeta.isRead}`
          + `|READ_SOURCE=${rowMeta.readStateSource || 'unknown'}`
          + `|TEXT=${rowText.replace(/\s+/g, ' ').slice(0, 220)}`
        );
      }

      if (!subjectMatch) continue;
      if (config.invoiceReceivedOnly && isSentFolderRow(combined)) continue;

      const unreadDecision = rowUnreadDecision(rowMeta, query);
      logs.push(
        `OUTLOOK_ROW_CANDIDATE|INDEX=${index}`
        + `|UNREAD_ACCEPT=${unreadDecision.accept}`
        + `|UNREAD_SOURCE=${unreadDecision.source}`
        + `|READ_STATE_SOURCE=${rowMeta.readStateSource || 'unknown'}`
        + `|FINGERPRINT=${fingerprint.slice(0, 120)}`
      );

      if (config.invoiceRequireUnread && !unreadDecision.accept) continue;
      if (processedRows.has(fingerprint)) continue;

      candidate = {
        row,
        rowText,
        rowMeta,
        fingerprint,
        index
      };
      break;
    }

    if (!candidate) {
      const moved = await scrollMessageList();
      scrollPasses += 1;
      idlePasses += moved ? 1 : 2;
      logs.push(`OUTLOOK_UNREAD_QUEUE_IDLE|PASS=${idlePasses}|SCROLL_PASS=${scrollPasses}`);
      continue;
    }

    idlePasses = 0;
    processedRows.add(candidate.fingerprint);

    try {
      const email = await readMessage(page, candidate.row, candidate.rowText, logs);      if (
        !subjectMatchesInvoiceFilter(email.subject)
        && subjectMatchesInvoiceFilter(candidate.rowText)
      ) {
        const correctedMetadata = inferOutlookMessageMetadata({
          rawSubject: email.raw?.rawSubject || '',
          rowText: candidate.rowText,
          bodyText: email.bodyText,
          subjectFilter: config.invoiceSubjectFilter
        });

        const previousSubject = email.subject;
        email.subject = correctedMetadata.subject;
        email.senderName =
          correctedMetadata.senderName || email.senderName;

        email.raw = {
          ...(email.raw || {}),
          message_metadata: {
            ...(email.raw?.message_metadata || {}),
            corrected_after_row_validation: true,
            previous_subject: previousSubject,
            subject_source:
              correctedMetadata.subjectSource,
            configured_subject_line:
              correctedMetadata.configuredSubjectLine
          }
        };

        email.analysis = analyzeEmail(email);
        email.messageType = email.analysis.messageType;
        email.customerName = email.analysis.customerName;
        email.operatorName = email.analysis.operatorName;
        email.externalKey = stableKey(email);

        logs.push(
          `OUTLOOK_EMAIL_METADATA_CORRECTED`
          + `|FROM=${previousSubject}`
          + `|TO=${email.subject}`
          + `|SENDER=${email.senderName || ''}`
        );
      }

      const emailKey = email.externalKey
        || `${email.subject}|${email.senderEmail}|${email.receivedAt}|${candidate.fingerprint}`;

      if (processedEmails.has(emailKey)) {
        logs.push(`OUTLOOK_EMAIL_DUPLICATE_IN_RUN=${emailKey}`);
        continue;
      }
      processedEmails.add(emailKey);

      const existingFileNames = await downloadedDocumentFileNamesForEmail(email.externalKey);
      logs.push(
        `OUTLOOK_ATTACHMENT_RECOVERY_START|SUBJECT=${email.subject}`
        + `|VISIBLE_NAMES=${(email.attachments || []).join(' | ') || '(none)'}`
        + `|EXISTING=${existingFileNames.length}`
      );

      const recoveryStartedAt = Date.now();
      const downloadedDocuments = await downloadMatchingPdfAttachments(
        page,
        email,
        logs,
        { skipFileNames: existingFileNames }
      );

      logs.push(
        `OUTLOOK_ATTACHMENT_RECOVERY_END|SUBJECT=${email.subject}`
        + `|NEW_PDFS=${downloadedDocuments.length}`
        + `|DURATION_MS=${Date.now() - recoveryStartedAt}`
      );

      email.downloadedDocuments = downloadedDocuments.map(document => ({
        externalKey: document.externalKey,
        fileName: document.fileName,
        localPath: document.localPath
      }));

      const expectedNames = mergePdfAttachmentNames(
        email.attachments || [],
        downloadedDocuments.map(document => document.fileName)
      );
      const nameCoverage = completeAttachmentCoverage({
        expected: expectedNames,
        existing: existingFileNames,
        downloaded: downloadedDocuments.map(document => document.fileName)
      });
      const occurrenceCoverage = email.raw?.attachment_occurrence_coverage || {
        expected_count: 0,
        recovered_count: 0,
        missing: [],
        complete: true,
        message_group_count: 0
      };
      const attachmentEvidence = Boolean(
        email.hasAttachments
        || expectedNames.length > 0
        || Number(occurrenceCoverage.expected_count || 0) > 0
      );
      const availablePdfCount = existingFileNames.length + downloadedDocuments.length;
      const unresolvedAttachmentClaim = attachmentEvidence && availablePdfCount === 0;
      const complete = (
        nameCoverage.complete
        && occurrenceCoverage.complete !== false
        && !unresolvedAttachmentClaim
      );

      if (unresolvedAttachmentClaim) {
        logs.push(
          `OUTLOOK_ATTACHMENT_GUARD_BLOCKED_MARK_READ=${email.subject}`
          + '|REASON=attachment_evidence_but_no_pdf_available'
        );
      }

      email.raw = {
        ...(email.raw || {}),
        unread_queue: {
          query,
          row_index: candidate.index,
          row_fingerprint: candidate.fingerprint,
          unread_source: rowUnreadDecision(candidate.rowMeta, query).source
        },
        attachment_coverage: {
          ...nameCoverage,
          complete,
          occurrence_coverage: occurrenceCoverage
        }
      };

      emails.push(email);
      documents.push(...downloadedDocuments);
      processedCount += 1;

      if (complete) {
        const markedRead = await markCurrentMessageAsRead(page, logs, candidate.row);

        const refreshedRowText = await safeText(candidate.row, candidate.rowText);
        const refreshedRowMeta = await getRowMeta(candidate.row);
        const refreshedFingerprint = stableRowFingerprint({
          text: refreshedRowText,
          combined: `${refreshedRowText} ${refreshedRowMeta.combined || ''}`,
          index: candidate.index
        });
        processedRows.add(refreshedFingerprint);

        if (markedRead) {
          logs.push(
            `OUTLOOK_EMAIL_COMPLETED_AND_MARKED_READ=${email.subject}`
            + `|MESSAGE_GROUPS=${occurrenceCoverage.message_group_count || 0}`
            + `|ATTACHMENTS=${occurrenceCoverage.expected_count || nameCoverage.expected_count}`
          );
        } else {
          logs.push(
            `OUTLOOK_EMAIL_PROCESSED_BUT_MARK_READ_FAILED=${email.subject}`
            + `|ATTACHMENTS=${occurrenceCoverage.expected_count || nameCoverage.expected_count}`
          );
        }

        await page.waitForTimeout(1400);
        await resetMessageListToTop();
      } else {
        logs.push(
          `OUTLOOK_EMAIL_LEFT_UNREAD=${email.subject}`
          + `|MESSAGE_GROUPS=${occurrenceCoverage.message_group_count || 0}`
          + `|ATTACHMENTS_EXPECTED=${occurrenceCoverage.expected_count || nameCoverage.expected_count}`
          + `|ATTACHMENTS_AVAILABLE=${occurrenceCoverage.recovered_count || nameCoverage.available_count}`
          + `|MISSING_NAMES=${nameCoverage.missing.join(' | ') || '(none)'}`
          + `|MISSING_OCCURRENCES=${occurrenceCoverage.missing?.length || 0}`
        );
        await scrollMessageList();
      }
    } catch (error) {
      logs.push(
        `OUTLOOK_UNREAD_ROW_ERROR|INDEX=${candidate.index}`
        + `|NAME=${error.name || 'Error'}|MESSAGE=${error.message}`
      );
      await scrollMessageList();
    }
  }

  logs.push(
    `OUTLOOK_UNREAD_QUEUE_COMPLETE|EMAILS=${emails.length}`
    + `|PDFS=${documents.length}|MAX=${maxEmails}`
  );

  return { emails, documents };
}

export async function scanOutlook({
  maxEmails = config.outlookMaxEmails,
  searchQuery = config.outlookSearchQuery,
  forceInbox = false
} = {}) {
  await ensureDirs();

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: config.outlookHeadless,
    viewport: { width: 1440, height: 950 },
    acceptDownloads: true,
    downloadsPath,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });

  const page = browser.pages()[0] || await browser.newPage();
  const logs = [];

  try {
    page.__a2000CurrentSearchQuery = forceInbox
      ? '__INBOX_DOM_UNREAD_FALLBACK__'
      : String(searchQuery || '');

    await openOutlookPage(page, logs);

    const readiness = await waitForOutlookReady(page, logs);
    if (!readiness.ready) {
      await screenshot(page, 'outlook-scan-login-required.png', logs);
      return {
        emails: [],
        documents: [],
        logs: [
          ...logs,
          'Outlook is not ready. The Playwright profile is probably not logged in.',
          'Run npm --prefix api run login from a visible browser/VNC session.'
        ]
      };
    }

    let result = { emails: [], documents: [] };

    if (forceInbox) {
      logs.push(
        'OUTLOOK_INBOX_DOM_FALLBACK=START'
        + `|SUBJECT_FILTER=${config.invoiceSubjectFilter}`
      );
      await clearSearchIfPossible(page, logs);
      await page.waitForTimeout(1400);
      result = await collectVisibleEmails(page, maxEmails, logs);
      logs.push(
        `OUTLOOK_INBOX_DOM_FALLBACK=END`
        + `|EMAILS=${result.emails?.length || 0}`
        + `|PDFS=${result.documents?.length || 0}`
      );
    } else {
      const scanMode = String(config.outlookScanMode || 'search').toLowerCase();

      if (scanMode === 'search' && String(searchQuery || '').trim()) {
        logs.push(
          `OUTLOOK_SEARCH_MODE=START|QUERY=${searchQuery}`
          + `|SUBJECT_FILTER=${config.invoiceSubjectFilter}`
        );
        await searchMessages(page, readiness.searchBox, searchQuery, logs);
        result = await collectVisibleEmails(page, maxEmails, logs);
      } else {
        logs.push(
          `OUTLOOK_INBOX_MODE=START`
          + `|SUBJECT_FILTER=${config.invoiceSubjectFilter}`
        );
        await clearSearchIfPossible(page, logs);
        result = await collectVisibleEmails(page, maxEmails, logs);
      }
    }

    if (!result.emails.length) {
      await screenshot(page, forceInbox
        ? 'outlook-inbox-fallback-no-target-emails.png'
        : 'outlook-search-no-target-emails.png', logs);

      return {
        emails: [],
        documents: [],
        logs: [
          ...logs,
          'No matching unread invoice emails were accepted in this pass.'
        ]
      };
    }

    logs.push(`Parsed ${result.emails.length} matching unread emails.`);
    logs.push(`Downloaded ${result.documents.length} unique PDF documents locally.`);

    return {
      emails: result.emails,
      documents: result.documents,
      logs
    };
  } catch (error) {
    await screenshot(page, 'outlook-scan-error.png', logs);
    throw error;
  } finally {
    await browser.close();
  }
}
