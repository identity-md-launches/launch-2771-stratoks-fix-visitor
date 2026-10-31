// Optional browser acceptance runner: node tests/browser/expanse-auth.mjs /path/to/playwright/index.mjs /path/to/chromium
// Browser tooling is external test infrastructure, not a backend/runtime dependency.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { startDemo } from '../../deploy/auth-demo/server.mjs';
import { addressFromPrivateKey, signForTests } from '../../server/src/wallet.js';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.launch({ executablePath: process.argv[3] === '-' ? undefined : process.argv[3], headless: true, args: ['--no-sandbox'] });
const demo = await startDemo({ port: 0, tickMs: 200 });
const results = []; const errors = [];
const shotDir = process.argv[4] ? pathToFileURL(process.argv[4].replace(/\/?$/, '/')) : new URL('../../docs/auth/screenshots/', import.meta.url);
fs.mkdirSync(shotDir, { recursive: true });
const key = randomBytes(32).toString('hex'), address = addressFromPrivateKey(key);
let signMode = 'normal', heldResolve, enteredResolve;
const sign = async (hex) => {
  const message = Buffer.from(hex.slice(2), 'hex').toString('utf8');
  if (signMode === 'reject') throw new Error('SIMULATED_SIGNATURE_REJECTION');
  if (signMode === 'hold') { enteredResolve?.(); await new Promise((r) => { heldResolve = r; }); }
  return signForTests(message, key);
};
async function check(name, fn) { const start = Date.now(); await fn(); results.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
async function simulatedPage({ mobile = false, wallets = 2 } = {}) {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1200, height: 1000 } });
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('simulatedSign', sign);
  await page.addInitScript(({ address, count }) => {
    window.testWallets = [];
    for (let i = 0; i < count; i++) {
      const events = new Map();
      const p = { account: address, chain: '0x1', methods: [],
        on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
        removeListener(name, fn) { events.get(name)?.delete(fn); },
        emit(name, value) { for (const fn of events.get(name) ?? []) fn(value); },
        async request({ method, params }) {
          this.methods.push(method);
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return this.account ? [this.account] : [];
          if (method === 'eth_chainId') return this.chain;
          if (method === 'personal_sign') { try { return await window.simulatedSign(params[0]); } catch (e) { if (e.message.includes('SIMULATED_SIGNATURE_REJECTION')) e.code = 4001; throw e; } }
          throw new Error('Forbidden test RPC: ' + method);
        } };
      window.testWallets.push(p);
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'simulated-' + i, name: i ? 'Rabby · simulated' : 'MetaMask · simulated', rdns: 'test.simulated' }, provider: p } }));
      window.addEventListener('eip6963:requestProvider', announce);
    }
  }, { address, count: wallets });
  await page.goto(demo.origin); await page.waitForFunction(() => document.getElementById('world').textContent.includes('anonymous viewing'));
  return { context, page };
}
try {
  const { page, context } = await simulatedPage();
  await check('multiple EIP-6963 wallets require visitor choice; anonymous world is visible', async () => {
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    assert.equal(await page.locator('#wallets button').count(), 2);
    assert.equal(await page.evaluate(() => window.testWallets.every((p) => !p.methods.length)), true);
    assert.equal(await page.locator('#sign').isDisabled(), true);
    await page.screenshot({ path: new URL('desktop-wallet-choice.png', shotDir).pathname });
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected · not authenticated');
    assert.equal(await page.evaluate(() => window.testWallets[0].methods.length), 0);
  });
  await check('real server verification and private profile; screenshot', async () => {
    await page.locator('#sign').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Verified visitor');
    assert.match(await page.locator('#account').textContent(), /verified visits: 1/);
    assert.equal(await page.evaluate(() => window.testWallets[1].methods.every((m) => ['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'personal_sign'].includes(m))), true);
    await page.screenshot({ path: new URL('desktop-verified.png', shotDir).pathname });
    assert.equal(demo.backend.auth.sessions.size, 1);
  });
  await check('standalone consumer keeps transient session checks unconfirmed and recovers', async () => {
    await page.route('**/api/auth/session', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"maintenance"}' }));
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Session unconfirmed');
    assert.match(await page.locator('#account').textContent(), /last confirmed visits/);
    assert.doesNotMatch(await page.locator('#reason').textContent(), /Already verified/);
    assert.equal(demo.backend.auth.sessions.size, 1);
    await page.unroute('**/api/auth/session');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Verified visitor');
  });
  await check('server-verified logout and rejected signature retry', async () => {
    await page.locator('#logout').click(); await page.waitForFunction(() => document.getElementById('error').textContent.includes('Signed out on the server'));
    assert.equal(demo.backend.auth.sessions.size, 0);
    signMode = 'reject'; await page.locator('#sign').click(); await page.waitForFunction(() => document.getElementById('error').textContent.includes('Signature declined'));
    assert.equal(await page.locator('#sign').isDisabled(), false);
    signMode = 'normal'; await page.locator('#sign').click(); await page.waitForFunction(() => document.getElementById('status').textContent === 'Verified visitor');
  });
  await check('network change clears verified UI and revokes old credential', async () => {
    await page.evaluate(() => { const p = window.testWallets[1]; p.chain = '0x2105'; p.emit('chainChanged', p.chain); });
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected · not authenticated');
    await page.waitForTimeout(100); assert.equal(demo.backend.auth.sessions.size, 0);
    assert.match(await page.locator('#reason').textContent(), /chain 1/);
    await page.locator('#sign').click(); await page.waitForFunction(() => document.getElementById('error').textContent.includes('Unsupported network'));
    await page.evaluate(() => { const p = window.testWallets[1]; p.chain = '0x1'; p.emit('chainChanged', p.chain); });
  });
  await check('account switch while signature is pending never authenticates late response', async () => {
    signMode = 'hold'; const entered = new Promise((r) => { enteredResolve = r; });
    await page.locator('#sign').click(); await entered;
    await page.evaluate(() => { const p = window.testWallets[1]; p.account = null; p.emit('accountsChanged', []); });
    heldResolve(); signMode = 'normal';
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Disconnected');
    await page.waitForTimeout(150); assert.equal(demo.backend.auth.sessions.size, 0);
    assert.equal(await page.locator('#sign').isDisabled(), true);
  });
  await context.close();
  const mobile = await simulatedPage({ mobile: true, wallets: 0 });
  await check('mobile without injected wallet explains requirements; screenshot; walletless ticks continue', async () => {
    await mobile.page.locator('#connect').click();
    assert.match(await mobile.page.locator('#requirements').textContent(), /injected mobile wallet browser/);
    assert.equal(await mobile.page.locator('#sign').isDisabled(), true);
    const before = demo.backend.world.tick; await mobile.page.waitForTimeout(250); assert.ok(demo.backend.world.tick > before);
    await mobile.page.screenshot({ path: new URL('mobile-no-wallet.png', shotDir).pathname, fullPage: true });
    assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  });
  await mobile.context.close();
  const injectedMobile = await simulatedPage({ mobile: true, wallets: 1 });
  await check('simulated injected mobile provider can verify and logout', async () => {
    await injectedMobile.page.locator('#connect').click(); await injectedMobile.page.locator('#sign').click();
    await injectedMobile.page.waitForFunction(() => document.getElementById('status').textContent === 'Verified visitor');
    await injectedMobile.page.screenshot({ path: new URL('mobile-verified.png', shotDir).pathname, fullPage: true });
    await injectedMobile.page.locator('#logout').click(); await injectedMobile.page.waitForFunction(() => document.getElementById('error').textContent.includes('Signed out on the server'));
    assert.equal(demo.backend.auth.sessions.size, 0);
  });
  await injectedMobile.context.close();
  await check('static preview never contacts a world or offers sign-in without an installed backend', async () => {
    const files = new Map([['/', 'index.html'], ['/demo.js', 'demo.js'], ['/shared/visitor-auth-client.js', 'shared/visitor-auth-client.js'], ['/shared/visitor-challenge.js', 'shared/visitor-challenge.js']]);
    const staticServer = http.createServer((req, res) => {
      const file = files.get(req.url); if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(fs.readFileSync(new URL('../../deploy/auth-demo/' + file, import.meta.url)));
    });
    staticServer.listen(0, '127.0.0.1'); await once(staticServer, 'listening');
    const page = await browser.newPage(); const requests = [];
    page.on('request', (req) => requests.push(new URL(req.url()).pathname));
    try {
      await page.goto(`http://127.0.0.1:${staticServer.address().port}`);
      await page.waitForFunction(() => document.getElementById('world').textContent.includes('Static preview'));
      await page.locator('#connect').click(); assert.equal(await page.locator('#sign').isDisabled(), true);
      assert.ok(!requests.some((p) => p.startsWith('/api/')));
      await page.screenshot({ path: new URL('static-preview.png', shotDir).pathname, fullPage: true });
    } finally { await page.close(); await new Promise((r) => staticServer.close(r)); }
  });
  assert.deepEqual(errors, []);
  fs.writeFileSync(process.argv[4] ? new URL('browser.json', shotDir) : new URL('../results/auth/browser.json', import.meta.url), JSON.stringify({ browser: 'Chromium headless', wallets: 'simulated EIP-1193/EIP-6963 providers, disposable signer; NOT actual extensions/devices', tests: results, pageErrors: errors }, null, 2) + '\n');
} finally { await browser.close(); await demo.stop(); }
