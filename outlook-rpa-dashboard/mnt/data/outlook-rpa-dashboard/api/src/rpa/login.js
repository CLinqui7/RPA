import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = path.resolve(__dirname, '../../.auth/outlook-profile');

const browser = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 950 },
  args: ['--disable-dev-shm-usage']
});
const page = browser.pages()[0] || await browser.newPage();
await page.goto('https://outlook.office.com/mail/', { waitUntil: 'domcontentloaded' });
console.log('Inicia sesión en Outlook. Cuando veas el inbox cargado, vuelve a la terminal y presiona Ctrl+C.');
await new Promise(() => {});
