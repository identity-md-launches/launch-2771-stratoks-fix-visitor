// Actual built HUD + actual Expanse HTTP handlers. Wallets are simulated, signatures are real.
// Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/imd-tools/ms-playwright node tests/browser/expanse-hud-auth.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startHudDemo } from '../../deploy/auth-demo/hud.mjs';
import { addressFromPrivateKey, signForTests } from '../../server/src/wallet.js';
const { chromium, webkit } = await import(pathToFileURL(process.argv[2] ?? '/opt/imd-tools/playwright-mcp/node_modules/playwright/index.mjs').href);
const out = process.argv[3] ? pathToFileURL(process.argv[3].replace(/\/?$/, '/')) : new URL('../../artifacts/visitor-auth/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
const results = { wallets: 'Simulated EIP-6963/EIP-1193 providers; real disposable EIP-191 signer and real HTTP backend. No actual extensions/devices.', checks: [], errors: [], widths: [], contrast: [], webkit: 'not run' };
const demo = await startHudDemo({ port: 0, tickMs: 250, auth: { perIpRequests: 600, perPeerSignups: 600, globalRequests: 2000 } });
const browser = await chromium.launch({ headless: true });
const key = randomBytes(32).toString('hex'), address = addressFromPrivateKey(key);
let signMode = 'normal', entered, release;
function deferred() { let resolve; return { promise: new Promise((r) => { resolve = r; }), resolve: (...a) => resolve(...a) }; }
async function until(fn) { for (let i = 0; i < 120; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail('Expected state did not arrive'); }
async function check(name, fn) { const start = Date.now(); await fn(); results.checks.push({ name, passed: true, ms: Date.now() - start }); console.log('PASS ' + name); }
async function shot(page, file) { await page.screenshot({ path: new URL(file + '.jpg', out).pathname, type: 'jpeg', quality: 57 }); }
async function pageWithWallets({ width = 1440, height = 900, count = 2, legacy = false, staticPreview = false, service = demo, offlineAuth = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', ...(width <= 390 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', (e) => results.errors.push(e.message));
  await context.route('**/*', (route) => new URL(route.request().url()).origin === service.origin ? route.continue() : route.abort());
  if (offlineAuth) await page.route('**/api/auth/config', (route) => route.abort());
  if (staticPreview) await page.route('**/expanse-config.json', (route) => route.fulfill({ contentType: 'application/json', body: fs.readFileSync(new URL('../../web/public/expanse-config.json', import.meta.url), 'utf8') }));
  await page.exposeFunction('testSignMessage', async (hex) => {
    if (signMode === 'reject') throw new Error('SIMULATED_DECLINE');
    if (signMode === 'hold') { entered.resolve(); await release.promise; }
    return signForTests(Buffer.from(hex.slice(2), 'hex').toString('utf8'), key);
  });
  await page.addInitScript(({ address, count, legacy }) => {
    window.testWallets = [];
    for (let i = 0; i < count; i++) {
      const events = new Map();
      const provider = { account: address, chain: '0x1', methods: [], mode: '', isRabby: i === 1,
        on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
        removeListener(name, fn) { events.get(name)?.delete(fn); },
        emit(name, value) { for (const fn of events.get(name) ?? []) fn(value); },
        async request({ method, params }) {
          this.methods.push(method);
          if (method === 'eth_requestAccounts') {
            if (this.mode === 'timeout') return new Promise(() => {});
            if (this.mode === 'locked') return [];
            this.emit('accountsChanged', this.account ? [this.account] : []);
            return this.account ? [this.account] : [];
          }
          if (method === 'eth_accounts') return this.mode === 'locked' || !this.account ? [] : [this.account];
          if (method === 'eth_chainId') return this.chain;
          if (method === 'personal_sign') {
            try { return await window.testSignMessage(params[0]); }
            catch (e) { if (e.message.includes('SIMULATED_DECLINE')) e.code = 4001; throw e; }
          }
          throw new Error('Unexpected RPC method: ' + method);
        },
      };
      window.testWallets.push(provider);
      if (!legacy) window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'test-wallet-' + i, name: i ? 'Rabby · simulated' : 'MetaMask · simulated' }, provider },
      })));
    }
    if (legacy && window.testWallets[0]) window.ethereum = window.testWallets[0];
  }, { address, count, legacy });
  await page.goto(service.origin + '/preview/');
  await page.waitForFunction(() => document.querySelector('.exp-app')?.dataset.connection === 'connected', null, { timeout: 30_000 });
  await page.locator('.exp-art-loading').waitFor({ state: 'detached', timeout: 30_000 });
  return { context, page };
}
const status = (page) => page.locator('.exp-visitor-status strong');
const connect = (page) => page.getByRole('button', { name: 'Connect wallet', exact: true });
const sign = (page) => page.getByRole('button', { name: 'Sign in with message' });
const close = (page) => page.getByRole('button', { name: 'Close dialog', exact: true }).click();
async function verify(page) { await sign(page).click(); await status(page).filter({ hasText: 'Verified visitor' }).waitFor(); }
try {
  const { page, context } = await pageWithWallets();
  await check('desktop HUD contains world, preserved inspector and accessible wallet selection', async () => {
    await page.getByRole('button', { name: 'Find residents', exact: true }).first().click();
    await page.locator('.exp-resident').first().click();
    const selected = await page.locator('.exp-creature-head h2').innerText();
    await connect(page).click();
    await page.locator('.exp-visitor-wallet').first().waitFor();
    assert.equal(await page.locator('.exp-visitor-wallet').count(), 2);
    assert.equal(await page.evaluate(() => window.testWallets.every((p) => p.methods.length === 0)), true);
    assert.equal(await sign(page).isDisabled(), true);
    await shot(page, 'desktop-wallet-choice');
    results.contrast = await page.locator('.exp-visitor').evaluate((root) => {
      const luminance = (color) => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      };
      return ['.exp-visitor-status', '.exp-muted', '.exp-visitor-reason', '.exp-visitor-details summary'].map((selector) => {
        const el = root.querySelector(selector), color = getComputedStyle(el).color;
        let bg = el;
        while (bg.parentElement && getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement;
        const background = getComputedStyle(bg).backgroundColor;
        const a = luminance(color), b = luminance(background);
        return { selector, color, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    assert.ok(results.contrast.every((p) => p.ratio >= 4.5));
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    await status(page).filter({ hasText: 'Connected · not signed in' }).waitFor();
    assert.equal(demo.backend.auth.sessions.size, 0);
    assert.equal(await page.evaluate(() => window.testWallets[0].methods.length), 0);
    await verify(page); assert.equal(demo.backend.auth.sessions.size, 1);
    await close(page); assert.equal(await page.locator('.exp-creature-head h2').innerText(), selected);
    await page.getByRole('button', { name: /^Verified wallet/ }).click();
    await shot(page, 'desktop-verified');
  });
  await check('server-confirmed logout, rejected signature and repeated-click retry', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText('Signed out on the server.', { exact: true }).waitFor();
    assert.equal(demo.backend.auth.sessions.size, 0);
    signMode = 'reject'; await sign(page).click(); await page.getByText('Signature declined. You can retry.', { exact: true }).waitFor();
    assert.equal(await sign(page).isEnabled(), true);
    signMode = 'normal';
    const before = await page.evaluate(() => window.testWallets[1].methods.filter((m) => m === 'personal_sign').length);
    await sign(page).evaluate((el) => { el.click(); el.click(); el.click(); });
    await status(page).filter({ hasText: 'Verified visitor' }).waitFor();
    assert.equal(await page.evaluate(() => window.testWallets[1].methods.filter((m) => m === 'personal_sign').length), before + 1);
  });
  await check('chain changes clear verification immediately, revoke and explain disabled sign-in', async () => {
    await page.evaluate(() => { const p = window.testWallets[1]; p.chain = '0x2105'; p.emit('chainChanged', p.chain); });
    await status(page).filter({ hasText: 'Connected · not signed in' }).waitFor();
    assert.equal(await sign(page).isDisabled(), true);
    assert.match(await page.locator('#visitor-reason').innerText(), /Select chain 1/);
    await until(() => demo.backend.auth.sessions.size === 0);
    await page.evaluate(() => { const p = window.testWallets[1]; p.chain = '0x1'; p.emit('chainChanged', p.chain); });
    await verify(page);
  });
  await check('offline logout is never reported as server success and can be retried', async () => {
    await page.route('**/api/auth/logout', (r) => r.abort());
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText(/server logout is pending while offline/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
    assert.equal(demo.backend.auth.sessions.size, 1);
    await page.unroute('**/api/auth/logout');
    await page.getByRole('button', { name: 'Retry server sign-out' }).click();
    await page.getByText('Signed out on the server.', { exact: true }).waitFor();
    assert.equal(demo.backend.auth.sessions.size, 0);
  });
  await check('restart expires verified UI while anonymous world and private visits survive', async () => {
    await verify(page); const visits = demo.backend.auth.profiles.get(address).visitCount;
    await demo.restart();
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await status(page).filter({ hasText: 'Session expired' }).waitFor();
    assert.equal(demo.backend.auth.profiles.get(address).visitCount, visits);
    await verify(page); assert.equal(demo.backend.auth.profiles.get(address).visitCount, visits + 1);
  });
  await check('account switch during signing discards a late signature and allows reconnection', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText('Signed out on the server.', { exact: true }).waitFor();
    signMode = 'hold'; entered = deferred(); release = deferred();
    await sign(page).click(); await entered.promise;
    await page.evaluate(() => { const p = window.testWallets[1]; p.account = null; p.emit('accountsChanged', []); });
    await status(page).filter({ hasText: 'Disconnected' }).waitFor();
    release.resolve(); signMode = 'normal'; await until(() => demo.backend.auth.nonces.size === 0);
    assert.equal(demo.backend.auth.sessions.size, 0);
    await page.evaluate((address) => { window.testWallets[1].account = address; }, address);
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    await verify(page);
  });
  await check('provider disconnect clears existing verification and server session', async () => {
    await page.evaluate(() => window.testWallets[1].emit('disconnect'));
    await status(page).filter({ hasText: 'Disconnected' }).waitFor();
    await until(() => demo.backend.auth.sessions.size === 0);
  });
  await check('late HTTP verification response after account switch is discarded and revoked', async () => {
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    const responseHeld = deferred(), allowResponse = deferred(), responseDelivered = deferred();
    await page.route('**/api/auth/verify', async (route) => {
      const response = await route.fetch(); responseHeld.resolve(); await allowResponse.promise;
      await route.fulfill({ response }); responseDelivered.resolve();
    });
    await sign(page).click(); await responseHeld.promise;
    assert.equal(demo.backend.auth.sessions.size, 1);
    await page.evaluate(() => window.testWallets[1].emit('accountsChanged', []));
    await status(page).filter({ hasText: 'Disconnected' }).waitFor();
    await until(() => demo.backend.auth.sessions.size === 0);
    allowResponse.resolve(); await responseDelivered.promise; await page.unroute('**/api/auth/verify');
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    await verify(page); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText('Signed out on the server.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
    await status(page).filter({ hasText: 'Disconnected' }).waitFor();
  });
  await check('connection timeout and locked wallet return to an enabled retry', async () => {
    await page.evaluate(() => { window.testWallets[1].mode = 'timeout'; });
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    await page.getByText('Request timed out. You can retry.', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).isEnabled(), true);
    await page.evaluate(() => { window.testWallets[1].mode = 'locked'; });
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    await page.getByText(/Wallet is locked or has no available account/).waitFor();
    await page.evaluate(() => { window.testWallets[1].mode = ''; });
    await page.getByRole('button', { name: 'Rabby · simulated', exact: true }).click();
    await verify(page);
  });
  await check('world switch while signing cannot authenticate the new browser world', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText('Signed out on the server.', { exact: true }).waitFor();
    signMode = 'hold'; entered = deferred(); release = deferred(); await sign(page).click(); await entered.promise;
    await close(page);
    await page.getByRole('button', { name: 'The Expanse Choose world' }).click();
    await page.getByRole('button', { name: /Explore isolated demo/ }).click();
    release.resolve(); signMode = 'normal';
    await page.waitForFunction(() => document.querySelector('.exp-app')?.dataset.display === 'demo');
    await connect(page).click(); assert.match(await status(page).innerText(), /Sign-in unavailable/);
    assert.equal(await sign(page).count(), 0); await until(() => demo.backend.auth.sessions.size === 0);
    await close(page);
  });
  await context.close();

  for (const width of [320, 390, 768, 1440]) {
    const mobile = await pageWithWallets({ width, count: width === 320 ? 0 : 1, height: width <= 390 ? 844 : 900 });
    await check(`${width}px HUD and wallet dialog fit; absent/mobile injected and keyboard paths`, async () => {
      assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await shot(mobile.page, `hud-${width}`);
      await connect(mobile.page).focus(); await mobile.page.keyboard.press('Enter');
      if (width === 320) {
        assert.match(await mobile.page.locator('.exp-visitor-wallets').innerText(), /No wallet found/);
        assert.equal(await sign(mobile.page).isDisabled(), true);
        await shot(mobile.page, 'mobile-no-wallet');
      } else {
        await mobile.page.locator('.exp-visitor-wallet').first().click(); await verify(mobile.page);
        if (width === 390) await shot(mobile.page, 'mobile-verified');
        await mobile.page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await mobile.page.getByText('Signed out on the server.', { exact: true }).waitFor();
      }
      assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mobile.page.keyboard.press('Escape');
      assert.equal(await mobile.page.locator('dialog[open]').count(), 0);
      assert.equal(await mobile.page.locator('.exp-wallet-control').evaluate((el) => document.activeElement === el), true);
      results.widths.push(width);
    });
    await mobile.context.close();
  }
  const narrow = await pageWithWallets({ width: 320, count: 1 });
  await check('320px connected, signing and verified header labels stay within their control zones', async () => {
    const fit = async () => {
      const boxes = await narrow.page.locator('.exp-header').evaluate((header) =>
        [...header.querySelectorAll('.exp-logo, button')].filter((el) => el.getClientRects().length).map((el) => {
          const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }));
      assert.ok(boxes.every((r) => r.left >= 0 && r.right <= 320));
      assert.ok(boxes.every((a, i) => boxes.slice(i + 1).every((b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)));
    };
    await connect(narrow.page).click(); await narrow.page.locator('.exp-visitor-wallet').first().click(); await fit();
    signMode = 'hold'; entered = deferred(); release = deferred();
    await sign(narrow.page).click(); await entered.promise; await fit();
    release.resolve(); signMode = 'normal'; await status(narrow.page).filter({ hasText: 'Verified visitor' }).waitFor(); await fit();
    await narrow.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await narrow.page.getByText('Signed out on the server.', { exact: true }).waitFor();
  }); await narrow.context.close();
  const fallback = await pageWithWallets({ count: 1, legacy: true });
  await check('legacy browser provider fallback signs in through real server', async () => {
    await connect(fallback.page).click(); await fallback.page.locator('.exp-visitor-wallet').first().click();
    await verify(fallback.page); await fallback.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await fallback.page.getByText('Signed out on the server.', { exact: true }).waitFor();
  }); await fallback.context.close();
  const preview = await pageWithWallets({ width: 390, staticPreview: true });
  await check('static export defaults to a genuine browser demo without contacting a live backend', async () => {
    const paths = [];
    preview.page.on('request', (r) => paths.push(new URL(r.url()).pathname));
    assert.equal(await preview.page.locator('.exp-app').getAttribute('data-source'), 'demo');
    await connect(preview.page).click(); assert.match(await status(preview.page).innerText(), /unavailable/);
    assert.equal(await sign(preview.page).count(), 0);
    assert.ok(!paths.some((p) => p.startsWith('/api/')));
    await shot(preview.page, 'static-preview');
    await preview.page.locator('.exp-visitor-wallet').first().click();
    await status(preview.page).filter({ hasText: 'Connected · not signed in' }).waitFor();
    assert.equal(await sign(preview.page).count(), 0);
    assert.ok(!paths.some((p) => p.startsWith('/api/')));
    await shot(preview.page, 'static-connected');
  }); await preview.context.close();
  const disabledService = await startHudDemo({ port: 0, authEnabled: false });
  try {
    const disabled = await pageWithWallets({ service: disabledService, width: 390 });
    await check('auth-disabled backend preserves anonymous viewing and never offers an enabled sign-in', async () => {
      await connect(disabled.page).click();
      await status(disabled.page).filter({ hasText: 'Sign-in unavailable' }).waitFor();
      assert.equal(await sign(disabled.page).isDisabled(), true);
      assert.equal(disabledService.backend.auth, null);
      assert.match(await disabled.page.locator('#visitor-reason').innerText(), /has not enabled compatible visitor sign-in/);
    }); await disabled.context.close();
  } finally { await disabledService.stop(); }
  const offline = await pageWithWallets({ offlineAuth: true, count: 1 });
  await check('offline capability check keeps browsing usable and availability retry reaches the real API', async () => {
    await connect(offline.page).click();
    await status(offline.page).filter({ hasText: 'Sign-in unavailable' }).waitFor();
    assert.equal(await sign(offline.page).isDisabled(), true);
    await offline.page.unroute('**/api/auth/config');
    await offline.page.getByRole('button', { name: 'Check sign-in availability' }).click();
    await status(offline.page).filter({ hasText: 'Disconnected' }).waitFor();
    await offline.page.locator('.exp-visitor-wallet').first().click(); await verify(offline.page);
    await offline.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await offline.page.getByText('Signed out on the server.', { exact: true }).waitFor();
  }); await offline.context.close();
  let safari;
  try { safari = await webkit.launch({ headless: true }); }
  catch { results.webkit = 'Unavailable: WebKit could not be launched; Safari/device behavior unverified.'; }
  if (safari) {
    const p = await safari.newPage({ viewport: { width: 390, height: 844 } });
    await p.goto(demo.origin + '/preview/'); await connect(p).click(); await status(p).waitFor();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.keyboard.press('Escape'); await safari.close();
    results.webkit = 'Launch, real HUD render, wallet dialog and Escape passed. No real device/extension.';
  }
  assert.deepEqual(results.errors, []);
  results.completed = true;
} catch (e) {
  results.failure = { message: e.message, stack: e.stack };
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await shot(page, 'failure').catch(() => {});
  }
  throw e;
} finally {
  fs.writeFileSync(new URL('browser.json', out), JSON.stringify(results, null, 2) + '\n');
  await browser.close(); await demo.stop();
}
