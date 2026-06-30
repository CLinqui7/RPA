import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { hasDownloadedDocumentsForEmail } from '../documentRepository.js';
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
  const filter = normalizeForMatch(config.invoiceSubjectFilter || 'factura american');
  if (!filter) return true;

  const normalizedSubject = normalizeForMatch(subject);
  const alternatives = filter.split('|').map(part => part.trim()).filter(Boolean);
  return alternatives.some(part => normalizedSubject.includes(part));
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
  return row.evaluate(element => {
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    const attrs = [
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('class') || '',
      element.getAttribute('data-isread') || '',
      element.getAttribute('data-is-read') || '',
      element.getAttribute('data-testid') || ''
    ].join(' ');
    const combined = `${text} ${attrs}`.replace(/\s+/g, ' ').trim();
    const unreadNode = element.querySelector('[aria-label*="Unread" i], [title*="Unread" i], [aria-label*="No leído" i], [title*="No leído" i], [aria-label*="Sin leer" i], [title*="Sin leer" i]');
    const readNode = element.querySelector('[aria-label*="Read" i], [title*="Read" i], [aria-label*="Leído" i], [title*="Leído" i]');
    return {
      text,
      combined,
      isUnread: Boolean(unreadNode) || /\bunread\b|no leído|sin leer|isread:false|data-isread=false/i.test(combined),
      isRead: Boolean(readNode) || /\bread\b|leído|isread:true|data-isread=true/i.test(combined)
    };
  }).catch(() => ({ text: '', combined: '', isUnread: false, isRead: false }));
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
  const markAsReadSelectors = [
    '[role="menuitem"]:has-text("Mark as read")',
    '[role="menuitem"]:has-text("Mark read")',
    '[role="menuitem"]:has-text("Read")',
    '[role="menuitem"]:has-text("Marcar como leído")',
    '[role="menuitem"]:has-text("Marcar como leido")',
    '[role="menuitem"]:has-text("Leído")',
    '[role="menuitem"]:has-text("Leido")',
    'button:has-text("Mark as read")',
    'button:has-text("Marcar como leído")',
    'button:has-text("Marcar como leido")'
  ];

  for (const selector of markAsReadSelectors) {
    const clicked = await clickFirstVisibleEnabled(page.locator(selector), logs, `mark-as-read menu item ${selector}`, 1200);
    if (clicked) return true;
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
  if (!config.invoiceMarkAsRead) return;

  // Give Outlook a moment; sometimes it marks an opened message as read automatically,
  // but not instantly. This also helps the selected-row state settle.
  await page.waitForTimeout(900).catch(() => null);

  const before = await rowStillLooksUnread(row);
  if (before === false) {
    logs.push('Message already appears read. Mark-as-read step skipped.');
    return;
  }

  // Strategy 1: focus the selected row/reading pane and use keyboard shortcuts.
  // Ctrl+Q works in Outlook desktop and in some OWA builds. Plain Q/Shift+I work in
  // other Outlook Web shortcut modes. We try them, then verify when possible.
  try {
    if (row) {
      await row.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => null);
      const box = await row.boundingBox().catch(() => null);
      if (box) await page.mouse.click(box.x + Math.min(35, box.width / 2), box.y + box.height / 2);
    } else {
      await page.locator('[role="main"]').last().click({ timeout: 1500 }).catch(() => null);
    }

    for (const shortcut of ['Control+Q', 'Shift+I', 'q']) {
      await page.keyboard.press(shortcut).catch(() => null);
      await page.waitForTimeout(900);
      const afterShortcut = await rowStillLooksUnread(row);
      logs.push(`Sent Outlook mark-as-read shortcut: ${shortcut}`);
      if (afterShortcut === false) {
        logs.push(`Message verified as read after shortcut: ${shortcut}`);
        return;
      }
      if (afterShortcut === null && shortcut === 'Control+Q') {
        // Keep trying other strategies if we cannot verify.
        continue;
      }
    }
  } catch (error) {
    logs.push(`Could not use keyboard mark-as-read strategy: ${error.message}`);
  }

  // Strategy 2: click the visible toolbar command. In your current Outlook UI it appears
  // as "Read / Unread". Since this function is called only for processed unread invoices,
  // clicking it should mark the selected message as read.
  const directToolbarSelectors = [
    'button[aria-label*="Read / Unread" i]',
    'button[title*="Read / Unread" i]',
    'button:has-text("Read / Unread")',
    '[role="button"]:has-text("Read / Unread")',
    'button[aria-label*="Mark as read" i]',
    'button[title*="Mark as read" i]',
    'button[aria-label*="Marcar como leído" i]',
    'button[title*="Marcar como leído" i]',
    'button[aria-label*="Marcar como leido" i]',
    'button[title*="Marcar como leido" i]'
  ];

  for (const selector of directToolbarSelectors) {
    const clicked = await clickFirstVisibleEnabled(page.locator(selector), logs, `mark-as-read toolbar ${selector}`, 1500);
    if (!clicked) continue;
    await page.waitForTimeout(900);
    const afterToolbar = await rowStillLooksUnread(row);
    if (afterToolbar === false || afterToolbar === null) {
      logs.push(`Mark-as-read toolbar strategy completed: ${selector}`);
      return;
    }
  }

  // Strategy 3: open the message-row context menu and select Mark as read.
  if (row) {
    try {
      const box = await row.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
        await page.waitForTimeout(800);
        if (await tryMarkAsReadFromVisibleMenu(page, logs)) {
          await page.waitForTimeout(800);
          const afterContext = await rowStillLooksUnread(row);
          if (afterContext === false || afterContext === null) {
            logs.push('Mark-as-read context-menu strategy completed.');
            return;
          }
        }
      }
    } catch (error) {
      logs.push(`Could not use row context menu mark-as-read strategy: ${error.message}`);
    } finally {
      await page.keyboard.press('Escape').catch(() => null);
    }
  }

  // Strategy 4: open top "More actions" and look for Mark as read.
  const moreSelectors = [
    'button[aria-label*="More actions" i]',
    'button[title*="More actions" i]',
    'button[aria-label*="Más acciones" i]',
    'button[title*="Más acciones" i]',
    'button[aria-label*="Mas acciones" i]',
    'button[title*="Mas acciones" i]',
    'button:has-text("...")'
  ];

  for (const selector of moreSelectors) {
    try {
      const opened = await clickFirstVisibleEnabled(page.locator(selector), logs, `more-actions ${selector}`, 1200);
      if (!opened) continue;
      await page.waitForTimeout(700);
      if (await tryMarkAsReadFromVisibleMenu(page, logs)) {
        logs.push('Mark-as-read more-actions strategy completed.');
        return;
      }
    } catch (error) {
      logs.push(`Could not use more-actions mark-as-read strategy: ${error.message}`);
    } finally {
      await page.keyboard.press('Escape').catch(() => null);
    }
  }

  logs.push('Could not explicitly mark message as read. It will still be skipped later if it already exists in Supabase.');
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
  const fileName = safeFileName(suggestedName || fallbackName || `outlook-${Date.now()}.pdf`);
  const dayFolder = new Date().toISOString().slice(0, 10);
  const folder = path.join(invoiceDownloadsPath, dayFolder);
  await fs.mkdir(folder, { recursive: true });

  const targetPath = path.join(folder, `${Date.now()}-${fileName}`);
  await download.saveAs(targetPath);

  const record = {
    externalKey: documentExternalKey(email, fileName, targetPath),
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
      filter: config.invoiceSubjectFilter
    }
  };

  logs.push(`Downloaded PDF locally: ${targetPath}`);
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
    const item = page.locator(selector).first();
    if ((await item.count().catch(() => 0)) === 0) continue;
    try {
      const download = await clickAndWaitForDownload(page, () => item.click({ timeout: 2500 }), 10000);
      if (download) return download;
    } catch (error) {
      logs.push(`Menu download click failed for ${selector}: ${error.message}`);
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

async function downloadMatchingPdfAttachments(page, email, logs) {
  if (!subjectMatchesInvoiceFilter(email.subject)) {
    logs.push(`Skipped non-matching subject: ${email.subject || '(no subject)'}`);
    return [];
  }

  logs.push(`Subject matched invoice filter '${config.invoiceSubjectFilter}': ${email.subject}`);
  const downloadedDocuments = [];

  // Keep reading pane near the top of the opened message so visible-card detection
  // prefers the actual target email attachment, not attachments from conversation history.
  try {
    await page.mouse.wheel(0, -2400);
    await page.waitForTimeout(500);
  } catch {}
  const downloadedKeys = new Set();

  // First use the live visual attachment cards in the reading pane. This avoids stale PDF
  // filenames from Outlook's left list or expanded message history.
  const visibleCards = await findVisiblePdfAttachmentCards(page, logs);
  for (const card of visibleCards) {
    const fileName = safeFileName(card.fileName);
    const key = fileName.toLowerCase();
    if (downloadedKeys.has(key)) continue;

    logs.push(`Trying visible attachment card download: ${fileName}`);
    const saved = await downloadPdfAttachmentFromCardBox(page, email, card, logs);
    if (!saved) continue;

    downloadedDocuments.push(saved);
    downloadedKeys.add(key);
  }

  if (downloadedDocuments.length) return downloadedDocuments;

  const candidates = await findPdfAttachmentCandidates(page, logs);

  if (!candidates.length) {
    logs.push('No PDF attachment names found in the opened message. Saving debug screenshot.');
    await screenshot(page, `no-pdf-attachments-${Date.now()}.png`, logs);
    return downloadedDocuments;
  }

  logs.push(`Found ${candidates.length} PDF attachment name(s): ${candidates.map(c => c.fileName).join(', ')}`);

  for (const candidate of candidates) {
    const fileName = safeFileName(candidate.fileName);
    const key = fileName.toLowerCase();
    if (downloadedKeys.has(key)) continue;

    logs.push(`Trying to download PDF attachment by filename: ${fileName}`);
    const saved = await downloadPdfAttachmentByName(page, email, fileName, logs);
    if (!saved) continue;

    downloadedDocuments.push(saved);
    downloadedKeys.add(key);
  }

  return downloadedDocuments;
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

  const allText = `${rawSubject}\n${rowText}\n${bodyText}`;
  const senderEmailMatch = allText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const senderEmail = senderEmailMatch?.[0]?.toLowerCase() || null;
  const senderName = rowText.split('\n').map(line => line.trim()).find(line => line.length > 2 && !line.includes('@') && !/^po enviado|^caution|^inbox/i.test(line)) || null;
  const subject = cleanSubject({ subject: rawSubject, rowText, bodyText });
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
    raw: { rowText, currentUrl: page.url(), rawSubject, scannedMode: config.outlookScanMode }
  };

  email.analysis = analyzeEmail(email);
  email.messageType = email.analysis.messageType;
  email.customerName = email.analysis.customerName;
  email.operatorName = email.analysis.operatorName;
  email.externalKey = stableKey(email);
  return email;
}

async function collectVisibleEmails(page, maxEmails, logs) {
  const rows = await getRows(page, logs);
  if (!rows) return { emails: [], documents: [] };

  const count = Math.min(await rows.count(), maxEmails);
  const emails = [];
  const documents = [];
  const seen = new Set();

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const rowText = await safeText(row);
    const rowMeta = await getRowMeta(row);
    const rowCombinedText = `${rowText} ${rowMeta.combined || ''}`;

    if (isProbablySystemRow(rowText)) continue;

    try {
      if (config.invoiceReceivedOnly && isSentFolderRow(rowCombinedText)) {
        const rowPreview = rowText.replace(/\s+/g, ' ').trim().slice(0, 140);
        logs.push(`Ignoring row because it appears to be Sent/Enviados, not Inbox/received: ${rowPreview}`);
        continue;
      }

      const rowLooksTarget = subjectMatchesInvoiceFilter(rowText);

      // Critical guard: pre-filter by the message-list row before opening it.
      // Outlook keeps hidden/stale emails in the DOM, and the previous version
      // could click a non-target row while the reading pane still showed an old
      // matching subject. That caused the bot to download a PDF from the wrong thread.
      if (config.invoiceDownloadOnlyMatching && !rowLooksTarget) {
        const rowPreview = rowText.replace(/\s+/g, ' ').trim().slice(0, 120);
        logs.push(`Ignoring visible row because it does not contain '${config.invoiceSubjectFilter}': ${rowPreview}`);
        continue;
      }

      if (config.invoiceRequireUnread && rowMeta.isRead && !rowMeta.isUnread) {
        const rowPreview = rowText.replace(/\s+/g, ' ').trim().slice(0, 140);
        logs.push(`Ignoring row because it appears already read. Use unread target emails only: ${rowPreview}`);
        continue;
      }

      const email = await readMessage(page, row, rowText, logs);
      const key = email.externalKey || `${email.subject}|${email.senderEmail}|${email.snippet}`;
      const matchesTarget = subjectMatchesInvoiceFilter(email.subject) || rowLooksTarget;

      if (rowLooksTarget && !subjectMatchesInvoiceFilter(email.subject)) {
        logs.push(`Opened row matched '${config.invoiceSubjectFilter}' but parsed subject looked different: '${email.subject}'. Keeping row-based subject for download.`);
        email.subject = config.invoiceSubjectFilter || email.subject;
      }

      if (config.invoiceDownloadOnlyMatching && !matchesTarget) {
        logs.push(`Ignoring email because subject does not match '${config.invoiceSubjectFilter}': ${email.subject}`);
        continue;
      }

      if (config.invoiceReceivedOnly && isSentFolderRow(`${email.raw?.rowText || ''} ${email.bodyText || ''}`)) {
        logs.push(`Ignoring email because it appears to come from Sent/Enviados instead of Inbox/received: ${email.subject}`);
        continue;
      }

      if (config.invoiceSkipAlreadyDownloaded && await hasDownloadedDocumentsForEmail(email.externalKey)) {
        logs.push(`Skipping email because this invoice email was already downloaded before: ${email.subject}`);
        await markCurrentMessageAsRead(page, logs, row);
        continue;
      }

      if (!seen.has(key) && (email.subject || email.bodyText || email.snippet)) {
        seen.add(key);
        const downloadedDocuments = await downloadMatchingPdfAttachments(page, email, logs);
        email.downloadedDocuments = downloadedDocuments.map(doc => ({
          externalKey: doc.externalKey,
          fileName: doc.fileName,
          localPath: doc.localPath
        }));
        documents.push(...downloadedDocuments);
        if (downloadedDocuments.length > 0) {
          await markCurrentMessageAsRead(page, logs, row);
        }
        emails.push(email);
      }
    } catch (error) {
      logs.push(`Could not read row ${i + 1}: ${error.message}`);
    }
  }

  return { emails, documents };
}

export async function scanOutlook({ maxEmails = config.outlookMaxEmails, searchQuery = config.outlookSearchQuery } = {}) {
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
          'Run npm --prefix api run login from an environment with a visible browser/VNC, then try /run-scan again.'
        ]
      };
    }

    const scanMode = String(config.outlookScanMode || 'inbox').toLowerCase();
    let result = { emails: [], documents: [] };

    if (scanMode === 'search') {
      logs.push('Scan mode: search. Outlook search will be used first.');
      logs.push(`Received-only guard: ${config.invoiceReceivedOnly ? 'on' : 'off'}; unread guard: ${config.invoiceRequireUnread ? 'on' : 'off'}; skip already-downloaded: ${config.invoiceSkipAlreadyDownloaded ? 'on' : 'off'}`);
      await searchMessages(page, readiness.searchBox, searchQuery, logs);
      result = await collectVisibleEmails(page, maxEmails, logs);
    } else {
      logs.push('Scan mode: inbox. Reading recent visible inbox rows and then analyzing full email bodies.');
      logs.push(`Only received/unread subjects matching '${config.invoiceSubjectFilter}' will be downloaded as invoice PDFs.`);
      logs.push(`Received-only guard: ${config.invoiceReceivedOnly ? 'on' : 'off'}; unread guard: ${config.invoiceRequireUnread ? 'on' : 'off'}; skip already-downloaded: ${config.invoiceSkipAlreadyDownloaded ? 'on' : 'off'}`);
      await clearSearchIfPossible(page, logs);
      result = await collectVisibleEmails(page, maxEmails, logs);
    }

    if (!result.emails.length) {
      await screenshot(page, 'outlook-scan-no-target-emails.png', logs);
      return { emails: [], documents: [], logs: [...logs, 'No matching invoice emails found in visible rows.'] };
    }

    logs.push(`Parsed ${result.emails.length} matching emails.`);
    logs.push(`Downloaded ${result.documents.length} PDF documents locally.`);
    return { emails: result.emails, documents: result.documents, logs };
  } catch (error) {
    await screenshot(page, 'outlook-scan-error.png', logs);
    throw error;
  } finally {
    await browser.close();
  }
}
