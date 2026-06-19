import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = path.resolve(__dirname, '../../.auth/outlook-profile');

const browser = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  viewport: { width: 1440, height: 950 },
  args: ['--disable-dev-shm-usage', '--no-sandbox']
});

const page = browser.pages()[0] || await browser.newPage();

await page.goto('https://outlook.office.com/mail/', { waitUntil: 'domcontentloaded' });

console.log('Login headless iniciado.');
console.log('Si Outlook pide MFA o login interactivo, Codespace no podrá hacerlo visible sin VNC.');
console.log('Siguiente paso recomendado: usar el RPA desde una sesión ya abierta o hacer el flujo attended.');
console.log('URL actual:', page.url());

await page.screenshot({ path: 'outlook-login-debug.png', fullPage: true });

await browser.close();