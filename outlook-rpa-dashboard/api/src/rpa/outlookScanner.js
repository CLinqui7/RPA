import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { analyzeEmail, cleanSubject, extractPoNumber, extractPtNumber, stableKey } from '../parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '../..');
const userDataDir = path.resolve(apiRoot, '.auth/outlook-profile');
const downloadsPath = path.resolve(apiRoot, 'downloads');
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

async function ensureDirs() {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(downloadsPath, { recursive: true });
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
  const matches = String(text).match(/[^\n\r\t<>:\"|?*]{2,120}\.(?:pdf|xlsx?|csv|docx?)/gi) || [];
  return [...new Set(matches.map(name => name.replace(/^[\s\uE000-\uF8FF]+|[\s\uE000-\uF8FF]+$/g, '').trim()).filter(Boolean))];
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

async function readMessage(page, row, rowText) {
  await row.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => null);
  await row.click({ timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(1400);

  const rawSubject =
    (await safeText(page.locator('[role="main"] [aria-level="1"]').first(), '')) ||
    (await safeText(page.locator('[role="heading"]').first(), '')) ||
    rowText.split('\n').find(Boolean) ||
    '';

  const bodyText = await readBestBodyText(page, rowText);

  // IMPORTANT: the parser receives subject + row preview + full body.
  // This allows detection of urgent/action phrases inside the email body,
  // even when the subject is only “po enviado” or does not contain PO/urgent words.
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
  if (!rows) return [];

  const count = Math.min(await rows.count(), maxEmails);
  const emails = [];
  const seen = new Set();

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const rowText = await safeText(row);

    if (isProbablySystemRow(rowText)) continue;

    try {
      const email = await readMessage(page, row, rowText);
      const key = email.externalKey || `${email.subject}|${email.senderEmail}|${email.snippet}`;
      if (!seen.has(key) && (email.subject || email.bodyText || email.snippet)) {
        seen.add(key);
        emails.push(email);
      }
    } catch (error) {
      logs.push(`Could not read row ${i + 1}: ${error.message}`);
    }
  }
  return emails;
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
        logs: [
          ...logs,
          'Outlook is not ready. The Playwright profile is probably not logged in.',
          'Run npm --prefix api run login from an environment with a visible browser/VNC, then try /run-scan again.'
        ]
      };
    }

    const scanMode = String(config.outlookScanMode || 'inbox').toLowerCase();
    let emails = [];

    if (scanMode === 'search') {
      logs.push('Scan mode: search. Outlook search will be used first.');
      await searchMessages(page, readiness.searchBox, searchQuery, logs);
      emails = await collectVisibleEmails(page, maxEmails, logs);
    } else {
      logs.push('Scan mode: inbox. Reading recent visible inbox rows and then analyzing full email bodies.');
      logs.push('Subject is used only for dashboard grouping/classification. Urgent/assignment detection uses subject + preview + body.');
      await clearSearchIfPossible(page, logs);
      emails = await collectVisibleEmails(page, maxEmails, logs);
    }

    if (!emails.length) {
      await screenshot(page, 'outlook-scan-no-rows.png', logs);
      return { emails: [], logs: [...logs, 'No readable emails found in visible rows.'] };
    }

    logs.push(`Parsed ${emails.length} emails.`);
    return { emails, logs };
  } catch (error) {
    await screenshot(page, 'outlook-scan-error.png', logs);
    throw error;
  } finally {
    await browser.close();
  }
}
