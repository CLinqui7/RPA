import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, '../..');
const userDataDir = path.resolve(apiRoot, '.auth/outlook-profile');
const debugPath = path.resolve(apiRoot, 'debug');

await fs.mkdir(userDataDir, { recursive: true });
await fs.mkdir(debugPath, { recursive: true });

const forcedHeadless = config.outlookLoginHeadless || !process.env.DISPLAY;

console.log('Opening Outlook login helper...');
console.log(`Profile folder: ${userDataDir}`);
console.log(`Headless login mode: ${forcedHeadless}`);

if (forcedHeadless) {
  console.log('No visible browser is available in this environment.');
  console.log('This can open Outlook and save a screenshot, but it cannot complete an interactive login or MFA.');
  console.log('Use a Codespaces VNC session or run this same project on an authorized VM/PC with a visible browser.');
}

const browser = await chromium.launchPersistentContext(userDataDir, {
  headless: forcedHeadless,
  viewport: { width: 1440, height: 950 },
  args: ['--disable-dev-shm-usage', '--no-sandbox']
});

const page = browser.pages()[0] || await browser.newPage();
await page.goto(config.outlookUrl, { waitUntil: 'domcontentloaded', timeout: config.outlookLoadTimeoutMs });
await page.waitForTimeout(3000);

console.log(`Current URL: ${page.url()}`);
await page.screenshot({ path: path.join(debugPath, 'outlook-login-debug.png'), fullPage: true });
console.log(`Screenshot saved: ${path.join(debugPath, 'outlook-login-debug.png')}`);

if (!forcedHeadless) {
  console.log('Log in to Outlook in the browser window. Do the MFA if Microsoft asks.');
  console.log(`I will keep the browser open for ${Math.round(config.outlookLoginWaitMs / 1000)} seconds so the session can be saved.`);
  await page.waitForTimeout(config.outlookLoginWaitMs);
  await page.screenshot({ path: path.join(debugPath, 'outlook-login-after-wait.png'), fullPage: true }).catch(() => null);
} else {
  await page.waitForTimeout(2000);
}

await browser.close();
console.log('Login helper finished.');
