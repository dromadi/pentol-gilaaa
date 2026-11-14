// Jalankan semua uji: node tests/run.js   (butuh Playwright + Chromium; lihat tests/README.md)
import { createRequire } from 'node:module';
import { run } from './harness.js';
import { startServer } from './server.js';
import { unitTests } from './unit.test.js';
import { adminTests } from './admin.test.js';
import { catalogTests } from './catalog.test.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

let failed = 0;
unitTests();
failed += await run('Uji unit');

const server = await startServer();
const browser = await chromium.launch();
try {
  adminTests(browser, devices, server.url);
  failed += await run('Uji admin (browser, data tiruan)');
  catalogTests(browser, devices, server.url);
  failed += await run('Uji katalog pembeli (browser, data tiruan)');
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `\n${failed} uji gagal.` : '\nSemua uji lolos.');
process.exit(failed ? 1 : 0);
