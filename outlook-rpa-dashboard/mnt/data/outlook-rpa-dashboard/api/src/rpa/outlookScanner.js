import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { classifyEmail, extractPoNumber, stableKey } from '../parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = path.resolve(__dirname, '../../.auth/outlook-profile');

async function safeText(locator, fallback = '') {
  try {
    return (await locator.innerText({ timeout: 2500 })).trim();
  } catch {
    return fallback;
  }
}

async function firstVisible(page, candidates) {
  for (const c of candidates) {
    const loc = page.locator(c).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 2500 });
      return loc;
    } catch {}
  }
  return null;
}

export async function scanOutlook({ maxEmails = config.outlookMaxEmails, searchQuery = config.outlookSearchQuery } = {}) {
  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: config.outlookHeadless,
    viewport: { width: 1440, height: 950 },
    acceptDownloads: true,
    downloadsPath: path.resolve(__dirname, '../../downloads'),
  args: ['--disable-dev-shm-usage', '--no-sandbox']
  });

  const page = browser.pages()[0] || await browser.newPage();
  const logs = [];

  try {
    logs.push('Opening Outlook Web');
    await page.goto('https://outlook.office.com/mail/', { waitUntil: 'domcontentloaded', timeout: 90000 });

    // Si no hay sesión, deja tiempo para login manual.
    const searchBox = await firstVisible(page, [
      'input[aria-label="Search"]',
      'input[placeholder="Search"]',
      'input[aria-label*="Buscar"]',
      'input[placeholder*="Buscar"]',
      '[role="searchbox"] input',
      '[aria-label="Search"]'
    ]);

    if (!searchBox) {
      logs.push('Search box not visible. Login may be required. Waiting 90 seconds.');
      await page.waitForTimeout(90000);
    }

    const finalSearch = await firstVisible(page, [
      'input[aria-label="Search"]',
      'input[placeholder="Search"]',
      'input[aria-label*="Buscar"]',
      'input[placeholder*="Buscar"]',
      '[role="searchbox"] input',
      '[aria-label="Search"]'
    ]);

    if (finalSearch) {
      logs.push(`Searching: ${searchQuery}`);
      await finalSearch.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.type(searchQuery);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
    } else {
      logs.push('Could not find search box. Scanning visible inbox list only.');
    }

    const rowSelectors = [
      '[role="option"]',
      '[data-automationid="MessageListItem"]',
      '[aria-label*="Message list"] [role="listitem"]',
      '[role="listbox"] [role="option"]'
    ];

    let rows = null;
    for (const selector of rowSelectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) {
        rows = page.locator(selector);
        logs.push(`Found ${count} candidate rows with selector ${selector}`);
        break;
      }
    }

    if (!rows) return { emails: [], logs: [...logs, 'No rows found'] };

    const count = Math.min(await rows.count(), maxEmails);
    const emails = [];

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const rowText = await safeText(row);
      if (!rowText || rowText.length < 6) continue;

      await row.click({ timeout: 5000 }).catch(() => null);
      await page.waitForTimeout(1200);

      const subject = await safeText(page.locator('[role="main"] [aria-level="1"]').first(), '')
        || await safeText(page.locator('[role="heading"]').first(), '')
        || rowText.split('\n').find(Boolean) || '';

      const bodyText = await safeText(page.locator('[role="main"]').first(), '')
        || await safeText(page.locator('[aria-label*="Message body"]').first(), '')
        || rowText;

      const senderText = rowText.split('\n').find(line => /@|^[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ ]+/.test(line)) || '';
      const senderEmailMatch = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || senderText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      const senderEmail = senderEmailMatch?.[0] || null;
      const poNumber = extractPoNumber(`${subject}\n${rowText}\n${bodyText}`);
      const messageType = classifyEmail({ subject, body: bodyText, snippet: rowText });
      const hasAttachments = /attachment|attached|\.pdf|\.xlsx|\.xls|adjunto/i.test(rowText + bodyText);

      const email = {
        subject,
        senderName: senderEmail ? null : senderText,
        senderEmail,
        receivedAt: null,
        snippet: rowText.slice(0, 500),
        bodyText: bodyText.slice(0, 5000),
        poNumber,
        messageType,
        hasAttachments,
        raw: { rowText }
      };
      email.externalKey = stableKey(email);
      emails.push(email);
    }

    return { emails, logs };
  } finally {
    await browser.close();
  }
}
