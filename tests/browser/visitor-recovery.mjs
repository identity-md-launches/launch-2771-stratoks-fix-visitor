// Production HUD, real isolated HTTP verifier, disposable EIP-191 signer.
// Providers below are simulated; this does not test an installed extension/device.
// Usage: PLAYWRIGHT_BROWSERS_PATH=... node tests/browser/visitor-recovery.mjs PLAYWRIGHT_MODULE OUTPUT_DIR [BASELINE_DIST] [CHECK_PATTERN]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startHudDemo } from '../../deploy/auth-demo/hud.mjs';
import { addressFromPrivateKey, signForTests } from '../../server/src/wallet.js';

const { chromium, webkit } = await import(pathToFileURL(process.argv[2]).href);
const out = path.resolve(process.argv[3] ?? 'artifacts/visitor-recovery/browser');
const baseline = process.argv[4] && path.resolve(process.argv[4]);
const checkPattern = new RegExp(process.argv[5] ?? '.*');
fs.mkdirSync(out, { recursive: true });
const report = { mode: baseline ? 'inherited export' : 'updated export', providers: 'Simulated EIP-6963 and legacy EIP-1193; real randomly generated EOA signatures and real HTTP verification. No extensions/devices.', checks: [], errors: [], measurements: [], webkit: 'not attempted' };
// One peer runs many independent sign-in scenarios within a minute. Keep the
// shipped per-address bound; increase only the harness's sign-in request quota.
const service = await startHudDemo({ port: 0, tickMs: 500, auth: { perIpRequests: 600, perPeerSignups: 600, globalRequests: 2000 } });
const browser = await chromium.launch({ headless: true });
const key = randomBytes(32).toString('hex'), address = addressFromPrivateKey(key);
const deferred = () => { let resolve; return { promise: new Promise((r) => { resolve = r; }), resolve: (...args) => resolve(...args) }; };
const status = (p) => p.locator('.exp-visitor-status strong');
const signin = (p) => p.getByRole('button', { name: 'Sign in with message' });
const isVerified = (p) => status(p).filter({ hasText: 'Verified visitor' }).waitFor({ timeout: 8000 });
const shot = (p, name) => p.screenshot({ path: path.join(out, name + '.jpg'), type: 'jpeg', quality: 55 });
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); } assert.fail('Expected backend state did not arrive'); }

async function fixture({ width = 390, height = 844, offlineConfig = false, staticPreview = false, legacy = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', ...(width <= 390 ? { isMobile: true, hasTouch: true } : {}) });
  const p = await context.newPage(), signing = { mode: 'normal', entered: deferred(), release: deferred(), calls: 0 }, network = [];
  p.on('pageerror', (e) => report.errors.push(e.message));
  p.on('request', (r) => network.push(new URL(r.url()).pathname));
  p.on('response', (r) => { const url = new URL(r.url()); if (r.status() >= 400 && !url.pathname.startsWith('/api/auth/')) report.errors.push(`HTTP ${r.status()} ${url.pathname}`); });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === service.origin ? route.continue() : route.abort());
  if (baseline) await context.route('**/preview/**', async (route) => {
    const relative = new URL(route.request().url()).pathname.slice('/preview/'.length) || 'index.html';
    if (relative === 'expanse-config.json') return route.fallback();
    const file = path.resolve(baseline, relative);
    if (!file.startsWith(baseline + path.sep)) return route.abort();
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    await route.fulfill({ path: file, contentType: mime[path.extname(file)] });
  });
  if (offlineConfig) await p.route('**/api/auth/config', (route) => route.abort());
  if (staticPreview) await p.route('**/expanse-config.json', (route) => route.fulfill({ contentType: 'application/json', path: new URL('../../web/public/expanse-config.json', import.meta.url).pathname }));
  await p.exposeFunction('disposableSign', async (hex) => {
    signing.calls++;
    if (signing.mode === 'hold') { signing.entered.resolve(); await signing.release.promise; }
    return signForTests(Buffer.from(hex.slice(2), 'hex').toString('utf8'), key);
  });
  await p.addInitScript(({ address, legacy }) => {
    window.simulatedWallets = [];
    for (let i = 0; i < 2; i++) {
      const events = new Map();
      const provider = {
        account: address, chain: '0x1', methods: [],
        on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
        removeListener(name, fn) { events.get(name)?.delete(fn); },
        emit(name, value) { for (const fn of events.get(name) ?? []) fn(value); },
        async request({ method, params }) {
          this.methods.push(method);
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return this.account ? [this.account] : [];
          if (method === 'eth_chainId') return this.chain;
          if (method === 'personal_sign') return window.disposableSign(params[0]);
          throw new Error('Unexpected wallet RPC: ' + method);
        },
      };
      window.simulatedWallets.push(provider);
      if (!legacy) addEventListener('eip6963:requestProvider', () => dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'disposable-provider-' + i, name: i ? 'Rabby · simulated' : 'MetaMask · simulated' }, provider },
      })));
    }
    if (legacy) window.ethereum = window.simulatedWallets[0];
  }, { address, legacy });
  await p.goto(service.origin + '/preview/');
  await p.waitForFunction(() => document.querySelector('.exp-app')?.dataset.connection === 'connected');
  await p.locator('.exp-art-loading').waitFor({ state: 'detached' });
  return { p, context, signing, network, async open() { await p.locator('.exp-wallet-control').click(); },
    async login() { await this.open(); await p.locator('.exp-visitor-wallet').first().click(); await signin(p).click(); await isVerified(p); },
    async close() { signing.release.resolve(); await context.close(); service.backend.auth.sessions.clear(); service.backend.auth.nonces.clear(); },
  };
}
async function check(name, run, options) {
  if (!checkPattern.test(name)) return;
  const started = Date.now(), f = await fixture(options);
  try { await run(f); report.checks.push({ name, passed: true, ms: Date.now() - started }); console.log('PASS ' + name); }
  catch (e) { report.checks.push({ name, passed: false, error: e.message, ms: Date.now() - started }); console.log('FAIL ' + name + ': ' + e.message); }
  finally { await f.close(); }
}
try {
  // Reload is a real document navigation: it does not run React effect cleanup.
  // Capture disposable credentials only inside this test; never write them to evidence.
  await check('reload disclosure distinguishes forgotten credentials from live server sessions', async (f) => {
    const { p } = f;
    const verified = p.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/verify' && r.status() === 200);
    await f.login();
    const { token } = await (await verified).json();
    const reason = await p.locator('#visitor-reason').innerText();
    await p.getByText('Privacy and wallet support', { exact: true }).click();
    const privacy = await p.locator('.exp-visitor-details').innerText();
    await shot(p, 'reload-disclosure-390');
    await p.reload();
    await p.waitForFunction(() => document.querySelector('.exp-app')?.dataset.connection === 'connected');
    await f.open();
    assert.equal(service.backend.auth.sessions.size, 1);
    const reply = await fetch(service.origin + '/api/auth/session', { headers: { origin: service.origin, authorization: 'Bearer ' + token } });
    assert.equal(reply.status, 200, 'forgotten credential still authenticates on the server');
    assert.equal(await p.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
    assert.doesNotMatch(await status(p).innerText(), /Verified visitor/);
    report.measurements.push({ scenario: 'reload', survivingSessions: service.backend.auth.sessions.size, oldCredentialHTTP: reply.status, reason, privacy });
    for (const text of [reason, privacy]) {
      assert.match(text, /Reload forgets this tab’s credential/);
      assert.match(text, /Sign out before reloading/);
      assert.match(text, /until expiry or server restart/);
      assert.doesNotMatch(text, /end(?:s)? on expiry, reload/);
    }
  });

  await check('reload at the per-address session cap gives truthful recovery and expiry frees capacity', async (f) => {
    const { p } = f, tokens = [];
    const limit = service.backend.auth.cfg.maxSessionsPerAddress;
    assert.equal(limit, 3); assert.equal(service.backend.auth.cfg.sessionTtlMs, 3_600_000);
    for (let i = 0; i < limit; i++) {
      const verified = p.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/verify' && r.status() === 200);
      await f.login(); tokens.push((await (await verified).json()).token);
      await p.reload();
      await p.waitForFunction(() => document.querySelector('.exp-app')?.dataset.connection === 'connected');
      assert.equal(service.backend.auth.sessions.size, i + 1);
    }
    for (const token of tokens) assert.equal((await fetch(service.origin + '/api/auth/session', { headers: { origin: service.origin, authorization: 'Bearer ' + token } })).status, 200);
    await f.open(); await p.locator('.exp-visitor-wallet').first().click();
    const rejected = p.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/verify');
    await signin(p).click();
    const response = await rejected;
    assert.equal(response.status(), 429); assert.equal((await response.json()).error, 'session_store_full');
    await p.waitForFunction(() => !document.querySelector('.exp-visitor button.primary')?.disabled);
    const reason = await p.locator('#visitor-reason').innerText();
    await shot(p, 'session-cap-390');
    assert.equal(service.backend.auth.sessions.size, limit);
    assert.equal(await p.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
    assert.doesNotMatch(await status(p).innerText(), /Verified visitor|Session expired/);
    report.measurements.push({ scenario: 'per-address cap after reload', limit, sessionTTL: service.backend.auth.cfg.sessionTtlMs, verifyHTTP: response.status(), sessions: service.backend.auth.sessions.size, reason });
    // Exercise expiry recovery without a real one-hour wait. Only the disposable
    // service clock advances; the production TTL and admission policy stay intact.
    const now = service.backend.auth.now;
    try {
      const afterExpiry = Math.max(...[...service.backend.auth.sessions.values()].map((s) => s.expiresAt)) + 1;
      service.backend.auth.now = () => afterExpiry;
      service.backend.auth.gc(); assert.equal(service.backend.auth.sessions.size, 0);
      // Return issuance to browser time so future-dated challenges are not rejected.
      service.backend.auth.now = now;
      await signin(p).click(); await isVerified(p); assert.equal(service.backend.auth.sessions.size, 1);
      await p.getByRole('button', { name: 'Sign out', exact: true }).click();
      await p.getByText('Signed out on the server.', { exact: true }).waitFor();
      assert.equal(service.backend.auth.sessions.size, 0);
    } finally { service.backend.auth.now = now; }
    assert.equal(reason, 'This account or origin has reached its active-session limit. Sign out in another signed-in tab, or wait for existing sessions to expire.');
  });

  await check('one auth live region in the open dialog, including errors', async ({ p, open }) => {
    await open(); await status(p).filter({ hasText: 'Sign-in unavailable' }).waitFor();
    assert.equal(await p.locator('.exp-visitor [role="status"], .exp-wallet-control + [role="status"]').count(), 1);
    await p.getByRole('button', { name: 'Check sign-in availability' }).click();
    assert.equal(await p.locator('.exp-visitor [role="status"], .exp-wallet-control + [role="status"]').count(), 1);
  }, { offlineConfig: true });
  await check('unavailable backend has one explanation and an actionable retry', async ({ p, open }) => {
    await open(); await status(p).filter({ hasText: 'Sign-in unavailable' }).waitFor();
    const paragraphs = await p.locator('.exp-visitor p').allTextContents();
    assert.equal(paragraphs.filter((s) => /unavailable|offline|cannot be reached|does not offer/i.test(s)).length, 1);
    await p.unroute('**/api/auth/config'); await p.getByRole('button', { name: 'Check sign-in availability' }).click();
    await status(p).filter({ hasText: 'Disconnected' }).waitFor();
    await p.locator('.exp-visitor-wallet').nth(1).click(); await signin(p).click(); await isVerified(p);
  }, { offlineConfig: true });

  for (const failure of ['429', '503', 'offline', 'timeout']) await check(`${failure} refresh retains a real session without false verification and recovers`, async (f) => {
    const { p, signing } = f; await f.login(); const signatures = signing.calls, pending = deferred();
    let calls = 0, logouts = 0;
    p.on('request', (r) => { if (new URL(r.url()).pathname === '/api/auth/logout') logouts++; });
    await p.route('**/api/auth/session', async (route) => {
      calls++;
      if (failure === 'offline') return route.abort();
      if (failure === 'timeout') { await pending.promise; return route.abort().catch(() => {}); }
      return route.fulfill({ status: Number(failure), contentType: 'application/json', headers: { 'retry-after': '2' }, body: '{"error":"temporarily_unavailable"}' });
    });
    try {
      await p.evaluate(() => dispatchEvent(new Event('focus')));
      await status(p).filter({ hasText: 'Session unconfirmed' }).waitFor({ timeout: 15_000 });
      assert.doesNotMatch(await p.locator('#visitor-reason').innerText(), /Verified on chain/);
      assert.match(await p.locator('#visitor-reason').innerText(), /retry automatically/);
      assert.equal(await signin(p).count(), 0); assert.equal(await p.getByRole('button', { name: 'Sign out', exact: true }).count(), 1);
      assert.equal(service.backend.auth.sessions.size, 1); assert.equal(logouts, 0);
      await p.evaluate(() => { dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
      assert.equal(calls, 1, 'focus and online do not bypass cooldown');
      if (failure === '503') await shot(p, 'mobile-unconfirmed');
      pending.resolve(); await p.unroute('**/api/auth/session');
      if (failure === 'offline') await p.getByRole('button', { name: 'Retry session check' }).click();
      await isVerified(p); assert.equal(signing.calls, signatures); assert.equal(service.backend.auth.sessions.size, 1);
      await p.getByRole('button', { name: 'Sign out', exact: true }).click(); await p.getByText('Signed out on the server.', { exact: true }).waitFor();
      assert.equal(service.backend.auth.sessions.size, 0);
    } finally { pending.resolve(); }
  });

  await check('cancel after verification was minted rejects its late response and allows another sign-in', async (f) => {
    const { p } = f; await f.open(); await p.locator('.exp-visitor-wallet').first().click();
    const entered = deferred(), release = deferred(), delivered = deferred();
    await p.route('**/api/auth/verify', async (route) => { const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response }); delivered.resolve(); });
    try {
      await signin(p).click(); await entered.promise; assert.equal(service.backend.auth.sessions.size, 1);
      await p.getByRole('button', { name: 'Cancel attempt' }).click();
      await status(p).filter({ hasText: 'Connected · not signed in' }).waitFor();
      await until(() => service.backend.auth.sessions.size === 0);
      release.resolve(); await delivered.promise; await p.unroute('**/api/auth/verify');
      await signin(p).click(); await isVerified(p); assert.equal(service.backend.auth.sessions.size, 1);
    } finally { release.resolve(); }
  });

  await check('account and network switches during an unconfirmed refresh never resurrect the old credential', async (f) => {
    const { p } = f; await f.login();
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
      const entered = deferred(), release = deferred(), delivered = deferred();
      await p.route('**/api/auth/session', async (route) => { const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response }); delivered.resolve(); });
      try {
        await p.evaluate(() => dispatchEvent(new Event('focus'))); await entered.promise;
        await status(p).filter({ hasText: 'Checking session' }).waitFor();
        await p.evaluate((event) => {
          const w = window.simulatedWallets[0];
          if (event === 'chainChanged') { w.chain = '0x2105'; w.emit(event, w.chain); }
          else { w.account = null; w.emit(event, []); }
        }, event);
        await until(() => service.backend.auth.sessions.size === 0);
        release.resolve(); await delivered.promise; await p.unroute('**/api/auth/session');
        assert.doesNotMatch(await status(p).innerText(), /Verified visitor/);
        await p.evaluate((address) => {
          const w = window.simulatedWallets[0]; w.account = address; w.chain = '0x1';
          w.emit('accountsChanged', [address]); w.emit('chainChanged', '0x1');
        }, address);
        if (await p.locator('.exp-visitor-wallet').count()) await p.locator('.exp-visitor-wallet').first().click();
        await signin(p).click(); await isVerified(p);
      } finally { release.resolve(); }
    }
  });

  await check('explicit logout remains available during Retry-After and ends server authentication', async (f) => {
    const { p } = f; await f.login();
    await p.route('**/api/auth/session', (route) => route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '120' }, body: '{"error":"rate_limited"}' }));
    await p.evaluate(() => dispatchEvent(new Event('focus')));
    await status(p).filter({ hasText: 'Session unconfirmed' }).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Retry scheduled' }).isDisabled(), true);
    await p.getByRole('button', { name: 'Sign out', exact: true }).click();
    await p.getByText('Signed out on the server.', { exact: true }).waitFor(); assert.equal(service.backend.auth.sessions.size, 0);
  });

  for (const width of [320, 390, 768, 1440]) await check(`${width}px anonymous world, camera, inspector, wallet selection and keyboard layout`, async (f) => {
    const { p } = f;
    await shot(p, 'hud-' + width);
    const measurements = await p.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      mainAction: (() => { const r = document.querySelector('.exp-wallet-control').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; })(),
      title: document.title, fontLoaded: document.fonts.check('14px "Manrope Variable"'),
    }));
    assert.ok(measurements.scrollWidth <= width); assert.ok(measurements.mainAction.bottom < 844); assert.ok(measurements.mainAction.right <= width);
    report.measurements.push(measurements);
    const map = p.locator('.exp-canvas');
    const camera = p.getByRole('button', { name: 'Zoom in', exact: true });
    await camera.click(); await p.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await p.getByRole('button', { name: 'Find residents', exact: true }).first().click(); await p.locator('.exp-resident').first().click();
    const resident = await p.locator('.exp-creature-head h2').innerText();
    await p.locator('.exp-wallet-control').focus(); await p.keyboard.press('Enter');
    await p.locator('.exp-visitor-wallet').first().waitFor();
    assert.equal(await p.locator('.exp-visitor-wallet').count(), 2);
    await p.locator('.exp-visitor-wallet').nth(1).click(); await signin(p).click(); await isVerified(p);
    if (width <= 390) await shot(p, 'verified-' + width);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.keyboard.press('Escape'); assert.equal(await p.locator('dialog[open]').count(), 0);
    assert.equal(await p.locator('.exp-wallet-control').evaluate((el) => el === document.activeElement), true);
    assert.equal(await p.locator('.exp-creature-head h2').innerText(), resident);
    assert.ok(await map.count());
  }, { width, height: width === 320 ? 568 : 844 });

  await check('static demo permits wallet connection but makes no authentication requests', async (f) => {
    const { p, signing, network } = f;
    assert.equal(await p.locator('.exp-app').getAttribute('data-source'), 'demo');
    await f.open(); await p.locator('.exp-visitor-wallet').first().click();
    await status(p).filter({ hasText: 'Connected · not signed in' }).waitFor();
    assert.equal(await signin(p).count(), 0); assert.equal(signing.calls, 0); assert.equal(network.filter((s) => s.startsWith('/api/auth/')).length, 0);
    await shot(p, 'static-connected');
  }, { staticPreview: true });

  try {
    const safari = await webkit.launch({ headless: true });
    try { const p = await safari.newPage({ viewport: { width: 390, height: 844 } }); await p.goto(service.origin + '/preview/'); await p.locator('.exp-wallet-control').click(); await status(p).waitFor(); await p.keyboard.press('Escape'); report.webkit = '390px render/dialog/Escape passed. No physical device or real extension.'; }
    finally { await safari.close(); }
  } catch (e) { report.webkit = 'Not run: ' + e.message.split('\n').slice(0, 5).join(' '); }
  assert.deepEqual(report.errors, []);
} finally {
  await browser.close(); await service.stop();
  report.passed = report.checks.filter((c) => c.passed).length;
  report.failed = report.checks.filter((c) => !c.passed).length;
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
if (report.failed) process.exitCode = 1;
