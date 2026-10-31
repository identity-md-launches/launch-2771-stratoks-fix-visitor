import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { VisitorAuthClient, discoverWallets, validateChallenge } from '../shared/visitor-auth-client.js';
import { startExpanse } from '../server/src/expanse/server.js';
import { addressFromPrivateKey, signForTests } from '../server/src/wallet.js';
const origin = 'https://world.example', uri = origin + '/';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
class SimulatedWallet extends EventEmitter {
  constructor() { super(); this.key = randomBytes(32).toString('hex'); this.address = addressFromPrivateKey(this.key); this.chain = '0x1'; this.methods = []; this.sign = null; }
  async request({ method, params }) {
    this.methods.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [this.address];
    if (method === 'eth_chainId') return this.chain;
    if (method === 'personal_sign') {
      const message = Buffer.from(params[0].slice(2), 'hex').toString('utf8');
      return this.sign ? this.sign(message) : signForTests(message, this.key);
    }
    throw new Error('Unexpected RPC: ' + method);
  }
}
async function app(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visitor-client-'));
  const settings = { dataDir: dir, seed: 101, initialCount: 2, port: 0, tickMs: 1_000_000, auth: { uri } };
  let svc = startExpanse(settings); await once(svc.server, 'listening');
  const client = new VisitorAuthClient({ baseUrl: `http://127.0.0.1:${svc.server.address().port}`, uri, origin, timeoutMs: 500, ...overrides });
  const wallet = new SimulatedWallet(); await client.loadConfig(); await client.connect(wallet);
  t.after(async () => { client.destroy(); await client.retryRevocations().catch(() => {}); await svc.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { client, wallet, get svc() { return svc; }, async restart() { await svc.stop(); svc = startExpanse(settings); await once(svc.server, 'listening'); client.baseUrl = `http://127.0.0.1:${svc.server.address().port}`; } };
}

test('client uses actual HTTP crypto verification and server logout; connecting alone never authenticates', async (t) => {
  const a = await app(t), { client, wallet } = a;
  assert.equal(client.state, 'connected'); assert.equal(client.session, null);
  await Promise.all([client.signIn(), client.signIn(), client.signIn()]);
  assert.equal(client.state, 'verified'); assert.equal(wallet.methods.filter((m) => m === 'personal_sign').length, 1);
  const token = client.session.token;
  assert.ok(wallet.methods.every((m) => ['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'personal_sign'].includes(m)));
  await client.logout(); assert.equal(client.session, null); assert.equal(client.state, 'connected');
  assert.throws(() => a.svc.auth.session(token, origin), /session_expired_or_revoked/);
  await client.signIn(); assert.equal(client.state, 'verified'); await a.restart(); await client.refreshSession(); assert.equal(client.state, 'expired'); assert.equal(client.session, null);
  await client.signIn(); assert.equal(client.state, 'verified'); assert.equal(client.session.profile.visitCount, 3);
});

test('transient session-check errors retain credentials, deduplicate checks and recover without false verification', async (t) => {
  const { client } = await app(t, { timeoutMs: 5000 }); await client.signIn(); assert.ok(client.session, client.error);
  const session = client.session, native = client.fetch; let calls = 0;
  client.fetch = async (...args) => {
    if (args[0].endsWith('/session')) { calls++; await delay(25); return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '2' } }); }
    return native(...args);
  };
  await Promise.all([client.refreshSession(), client.refreshSession(), client.refreshSession()]);
  assert.equal(calls, 1); assert.equal(client.session.token, session.token); assert.equal(client.state, 'unavailable');
  client.fetch = native;
  await client.refreshSession(); assert.equal(calls, 1, 'focus cannot bypass Retry-After');
  for (let i = 0; client.state !== 'verified' && i < 40; i++) await delay(100);
  assert.equal(client.session.token, session.token); assert.equal(client.state, 'verified');
});

test('account switch mid-signature cannot authenticate old or new account; retry recovers', async (t) => {
  const { client, wallet, svc } = await app(t);
  const gate = deferred(), entered = deferred(); wallet.sign = async (message) => { entered.resolve(); await gate.promise; return signForTests(message, wallet.key); };
  const attempt = client.signIn(); await entered.promise;
  wallet.address = addressFromPrivateKey(randomBytes(32).toString('hex')); wallet.emit('accountsChanged', [wallet.address]);
  assert.equal(client.session, null); assert.equal(client.busy, false); gate.resolve(); await attempt; await client.retryRevocations();
  assert.equal(svc.auth.sessions.size, 0); assert.equal(client.session, null);
  wallet.key = randomBytes(32).toString('hex'); wallet.address = addressFromPrivateKey(wallet.key); wallet.sign = null; wallet.emit('accountsChanged', [wallet.address]);
  await client.signIn(); assert.equal(client.state, 'verified'); assert.equal(client.session.address, wallet.address);
});

test('network changes and provider disconnect immediately clear/revoke an existing session', async (t) => {
  const { client, wallet, svc } = await app(t); await client.signIn(); const token = client.session.token;
  wallet.chain = '0x2105'; wallet.emit('chainChanged', wallet.chain); assert.equal(client.session, null);
  await client.retryRevocations(); assert.throws(() => svc.auth.session(token, origin), /session_expired_or_revoked/);
  await client.signIn(); assert.match(client.error, /Unsupported network/); assert.equal(client.busy, false);
  wallet.chain = '0x1'; wallet.emit('chainChanged', wallet.chain); await client.signIn(); assert.equal(client.state, 'verified');
  wallet.emit('disconnect'); assert.equal(client.session, null); assert.equal(client.address, null); await client.retryRevocations(); assert.equal(svc.auth.sessions.size, 0);
});

test('chain switch mid-signature and silent account changes both reject; no transaction RPC', async (t) => {
  const { client, wallet, svc } = await app(t);
  wallet.sign = async (message) => { wallet.chain = '0x2105'; wallet.emit('chainChanged', wallet.chain); return signForTests(message, wallet.key); };
  await client.signIn(); await client.retryRevocations(); assert.equal(client.session, null); assert.equal(svc.auth.sessions.size, 0);
  wallet.chain = '0x1'; wallet.emit('chainChanged', wallet.chain);
  wallet.sign = async (message) => { wallet.address = addressFromPrivateKey(randomBytes(32).toString('hex')); return signForTests(message, wallet.key); };
  await client.signIn(); assert.equal(client.session, null); assert.match(client.error, /account or network changed/); assert.equal(svc.auth.sessions.size, 0);
});

test('late verification response after account switch is cancelled on server', async (t) => {
  const { client, wallet, svc } = await app(t); const native = client.fetch;
  const entered = deferred(), gate = deferred();
  client.fetch = async (...args) => {
    const response = await native(...args);
    if (args[0].endsWith('/verify')) { await response.clone().json(); entered.resolve(); await gate.promise; }
    return response;
  };
  const attempt = client.signIn(); await entered.promise; assert.equal(svc.auth.sessions.size, 1);
  wallet.emit('accountsChanged', []); assert.equal(client.session, null); await client.retryRevocations();
  gate.resolve(); await attempt; assert.equal(client.session, null); assert.equal(svc.auth.sessions.size, 0);
});

test('declined signature, locked wallet and provider timeout leave buttons recoverable', async (t) => {
  const { client, wallet } = await app(t); client.timeoutMs = 80;
  wallet.sign = async () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); };
  await client.signIn(); assert.match(client.error, /Signature declined/); assert.equal(client.busy, false);
  wallet.sign = () => new Promise(() => {});
  await client.signIn(); assert.match(client.error, /timed out/); assert.equal(client.busy, false);
  client.timeoutMs = 500; wallet.sign = null; await client.signIn(); assert.equal(client.state, 'verified');
  await client.logout(); await client.connect({ request: async () => [] }); assert.equal(client.state, 'disconnected'); assert.equal(client.busy, false); assert.match(client.error, /locked/);
  await client.connect(wallet); assert.equal(client.state, 'connected');
});

test('signature reading timeout is independently bounded and cancelled without shortening backend requests', async (t) => {
  const { client, wallet, svc } = await app(t, { signatureTimeoutMs: 60 });
  wallet.sign = () => new Promise(() => {});
  await client.signIn(); assert.equal(client.busy, false); assert.match(client.error, /timed out/);
  assert.equal(client.timeoutMs, 500); assert.equal(svc.auth.nonces.size, 0); assert.equal(svc.auth.sessions.size, 0);
  wallet.sign = null; await client.signIn(); assert.equal(client.state, 'verified');
});

test('backend timeout/offline logout, unavailable capability and retry', async (t) => {
  const { client, wallet, svc } = await app(t); await client.signIn(); const token = client.session.token;
  const realFetch = client.fetch; client.timeoutMs = 40;
  client.fetch = (_, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  await client.logout(); assert.equal(client.session, null); assert.match(client.error, /pending while offline/); assert.ok(client.revocations.size > 0); assert.ok(svc.auth.session(token, origin));
  client.fetch = realFetch; client.timeoutMs = 500; await client.logout(); assert.match(client.error, /Signed out on the server/); assert.throws(() => svc.auth.session(token, origin));
  client.fetch = async () => new Response(JSON.stringify({ enabled: false, version: 1 }));
  await assert.rejects(client.loadConfig()); assert.equal(client.state, 'unavailable');
  const previousSignCount = wallet.methods.filter((m) => m === 'personal_sign').length;
  await client.signIn(); assert.equal(wallet.methods.filter((m) => m === 'personal_sign').length, previousSignCount);
  client.fetch = realFetch; await client.loadConfig(); await client.signIn(); assert.equal(client.state, 'verified');
});

test('exact challenge validation rejects altered server fields before prompting wallet', async (t) => {
  const { client, wallet } = await app(t);
  const c = await client.request('nonce', { address: wallet.address, chainId: 1 });
  for (const edit of [{ address: '0x' + 'a'.repeat(40) }, { chainId: 8453 }, { domain: 'evil.example' }, { origin: 'https://evil.example' }, { uri: 'https://evil.example/' }, { world: 'other' }, { expiresAt: Date.now() - 1 }, { nonce: 'garbage' }, { issuedAt: Date.now() + 60_000 }, { message: c.message + '\nGrant approval' }]) assert.throws(() => validateChallenge({ ...c, ...edit }, client.config, { address: wallet.address, chainId: 1, origin, uri }));
  const native = client.fetch; client.fetch = async (...args) => {
    const r = await native(...args); if (!args[0].endsWith('/nonce')) return r;
    const body = await r.json(); body.message += '\nPay 1 ETH'; return new Response(JSON.stringify(body));
  };
  await client.signIn(); assert.equal(client.session, null); assert.ok(!wallet.methods.includes('personal_sign')); assert.match(client.error, /Mismatched sign-in challenge/);
});

test('missing wallets, EIP-6963 discovery, multiple provider choice, fallback and cleanup', async () => {
  const target = new EventTarget(); const none = discoverWallets(target); assert.equal(none.wallets.length, 0); none.destroy();
  const p1 = new SimulatedWallet(), p2 = new SimulatedWallet();
  target.addEventListener('eip6963:requestProvider', () => {
    for (const [i, p] of [p1, p2].entries()) target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'wallet-' + i, name: ['MetaMask simulated', 'Rabby simulated'][i] }, provider: p } }));
  });
  const discovery = discoverWallets(target, { providers: [p1, p2] }); assert.equal(discovery.wallets.length, 2); assert.equal(p1.methods.length, 0); assert.equal(p2.methods.length, 0);
  const client = new VisitorAuthClient({ baseUrl: 'https://world.example', uri, origin });
  await client.connect(discovery.wallets[1].provider); assert.equal(client.address, p2.address); assert.equal(p1.methods.length, 0); client.destroy(); discovery.destroy();
  const fallback = discoverWallets(new EventTarget(), p1); assert.equal(fallback.wallets.length, 1); fallback.destroy();
  await client.connect(null); assert.equal(client.state, 'unavailable'); assert.match(client.error, /injected EVM/);
});

test('late nonce after disconnect is cancelled; connection timeout/rejection can be retried', async (t) => {
  const { client, wallet, svc } = await app(t);
  const native = client.fetch, entered = deferred(), gate = deferred();
  client.fetch = async (...args) => {
    const response = await native(...args);
    if (args[0].endsWith('/nonce')) { await response.clone().json(); entered.resolve(); await gate.promise; }
    return response;
  };
  const attempt = client.signIn(); await entered.promise; client.disconnect(); gate.resolve(); await attempt;
  assert.equal(client.session, null); assert.equal(svc.auth.nonces.size, 0); assert.equal(svc.auth.sessions.size, 0);
  client.fetch = native; client.timeoutMs = 50;
  await client.connect({ request: () => new Promise(() => {}) }); assert.equal(client.busy, false); assert.match(client.error, /timed out/);
  await client.connect({ request: async () => { throw Object.assign(new Error('declined'), { code: 4001 }); } }); assert.equal(client.busy, false); assert.match(client.error, /Connection declined/);
  client.timeoutMs = 500; await client.connect(wallet); await client.signIn(); assert.equal(client.state, 'verified');
});

test('initial wallet announcements during connect are accepted without creating authentication', async (t) => {
  const { client, wallet } = await app(t);
  const request = wallet.request.bind(wallet);
  wallet.request = async (args) => {
    if (args.method === 'eth_requestAccounts') {
      wallet.emit('accountsChanged', [wallet.address]);
      wallet.emit('chainChanged', wallet.chain);
    }
    return request(args);
  };
  await client.connect(wallet);
  assert.equal(client.state, 'connected'); assert.equal(client.chainId, 1);
  assert.equal(client.session, null); assert.equal(client.busy, false);
  await client.signIn(); assert.equal(client.state, 'verified');
});

test('isolated preview can connect a wallet but cannot request a challenge or fake authentication', async () => {
  const wallet = new SimulatedWallet(); let requests = 0;
  const client = new VisitorAuthClient({ baseUrl: null, uri: null, origin, fetchImpl: async () => { requests++; throw new Error('unexpected network'); } });
  await client.connect(wallet); assert.equal(client.state, 'connected'); assert.equal(client.session, null);
  await client.signIn(); assert.equal(client.session, null); assert.equal(client.state, 'unavailable');
  assert.match(client.error, /no authentication backend/); assert.equal(requests, 0);
  assert.ok(!wallet.methods.includes('personal_sign'));
  await client.logout(); assert.equal(client.error, 'No active visitor session in this tab.'); assert.equal(requests, 0);
  client.destroy();
});

test('silent account switch while verify is in flight rejects and revokes its returned session', async (t) => {
  const { client, wallet, svc } = await app(t);
  const native = client.fetch, entered = deferred(), gate = deferred();
  client.fetch = async (...args) => {
    const response = await native(...args);
    if (args[0].endsWith('/verify')) { entered.resolve(); await gate.promise; }
    return response;
  };
  const attempt = client.signIn(); await entered.promise;
  assert.equal(svc.auth.sessions.size, 1);
  wallet.address = addressFromPrivateKey(randomBytes(32).toString('hex')); // intentionally no event
  gate.resolve(); await attempt;
  assert.equal(client.session, null); assert.equal(svc.auth.sessions.size, 0);
  assert.match(client.error, /account or network changed/);
});

test('capability world changes invalidate and malformed current-session replies become unverified', async (t) => {
  const { client, svc } = await app(t); await client.signIn(); const old = client.session.token;
  svc.auth.world = svc.auth.world.replace(/[0-9a-f]{64}$/, 'a'.repeat(64));
  await client.loadConfig(); await client.retryRevocations();
  assert.equal(client.session, null); assert.match(client.error, /world service changed/);
  assert.throws(() => svc.auth.session(old, origin));
  await client.signIn(); assert.equal(client.state, 'verified');
  const native = client.fetch;
  client.fetch = async (...args) => {
    const response = await native(...args);
    if (!args[0].endsWith('/session')) return response;
    const body = await response.json(); body.chainId = 8453;
    return new Response(JSON.stringify(body));
  };
  const retained = client.session.token;
  await client.refreshSession();
  assert.equal(client.state, 'unavailable'); assert.equal(client.session.token, retained);
});

test('late logout acknowledgement cannot overwrite a newer verified account state', async (t) => {
  const { client, wallet } = await app(t); await client.signIn();
  const native = client.fetch, entered = deferred(), gate = deferred();
  let hold = true;
  client.fetch = async (...args) => {
    const response = await native(...args);
    if (hold && args[0].endsWith('/logout')) { entered.resolve(); await gate.promise; }
    return response;
  };
  const logout = client.logout(); await entered.promise;
  wallet.emit('accountsChanged', [wallet.address]);
  hold = false; const signing = client.signIn();
  gate.resolve(); await signing; assert.equal(client.state, 'verified');
  await logout;
  assert.equal(client.state, 'verified'); assert.ok(client.session);
});

test('expiry timer clears verification and revokes server credential without changing the world', async (t) => {
  const { client, svc } = await app(t); svc.auth.cfg.sessionTtlMs = 80;
  const before = svc.world.toState();
  await client.signIn(); assert.equal(client.state, 'verified');
  await delay(100); await client.retryRevocations();
  assert.equal(client.state, 'expired'); assert.equal(client.session, null);
  assert.equal(svc.auth.sessions.size, 0); assert.deepEqual(svc.world.toState(), before);
});

test('delivered static preview modules match the authoritative shared client bytes', () => {
  for (const name of ['visitor-auth-client.js', 'visitor-challenge.js']) assert.equal(fs.readFileSync(new URL('../shared/' + name, import.meta.url), 'utf8'), fs.readFileSync(new URL('../deploy/auth-demo/shared/' + name, import.meta.url), 'utf8'));
});

test('recovery: transient config checks retain an existing credential without claiming verification', async (t) => {
  const { client, svc } = await app(t); await client.signIn(); const token = client.session.token;
  const native = client.fetch;
  client.fetch = async (...args) => args[0].endsWith('/config') ? new Response('{"error":"maintenance"}', { status: 503 }) : native(...args);
  await assert.rejects(client.loadConfig());
  assert.equal(client.session?.token, token); assert.equal(client.state, 'unavailable');
  assert.equal(client.revocations.size, 0); assert.ok(svc.auth.session(token, origin));
  client.fetch = native; await client.loadConfig();
  assert.equal(client.state, 'unavailable', 'capabilities are not a session verification');
  await client.refreshSession({ retryNow: true }); assert.equal(client.state, 'verified');
});

test('recovery: only explicit invalid-session replies expire a session; generic proxy errors do not', async (t) => {
  const { client } = await app(t); await client.signIn(); const token = client.session.token;
  const native = client.fetch;
  for (const [status, error] of [[429, 'rate_limited'], [500, 'internal'], [503, 'maintenance'], [401, 'proxy_login'], [403, 'origin_not_allowed']]) {
    client.fetch = async (...args) => args[0].endsWith('/session') ? new Response(JSON.stringify({ error }), { status }) : native(...args);
    await client.refreshSession({ retryNow: true });
    assert.equal(client.session?.token, token, `${status} ${error}`);
    assert.equal(client.state, 'unavailable'); assert.equal(client.revocations.size, 0);
  }
  for (const name of ['TypeError', 'AbortError']) {
    client.fetch = async (...args) => { if (args[0].endsWith('/session')) throw Object.assign(new Error('offline'), { name }); return native(...args); };
    await client.refreshSession({ retryNow: true }); assert.equal(client.session?.token, token); assert.equal(client.state, 'unavailable');
  }
  client.fetch = async (...args) => args[0].endsWith('/session') ? new Response('{"error":"session_scope_mismatch"}', { status: 403 }) : native(...args);
  await client.refreshSession({ retryNow: true }); assert.equal(client.session, null); assert.equal(client.state, 'expired');
});

test('recovery: manual success cancels old backoff and refreshes are deduplicated', async (t) => {
  const { client } = await app(t); await client.signIn(); const native = client.fetch;
  let calls = 0, fail = true;
  client.fetch = async (...args) => { if (args[0].endsWith('/session')) { calls++; if (fail) return new Response('{"error":"maintenance"}', { status: 503 }); } return native(...args); };
  await client.refreshSession(); assert.ok(client.retryTimer);
  fail = false; await client.refreshSession({ retryNow: true });
  assert.equal(client.state, 'verified'); assert.equal(client.retryTimer, null); assert.equal(client.retryAttempt, 0);
  const gate = deferred(), entered = deferred();
  client.fetch = async (...args) => { if (args[0].endsWith('/session')) { calls++; entered.resolve(); await gate.promise; } return native(...args); };
  const first = client.refreshSession(); await entered.promise;
  assert.equal(client.state, 'checking');
  const second = client.refreshSession(); gate.resolve(); await Promise.all([first, second]);
  assert.equal(calls, 3); assert.equal(client.state, 'verified');
});

test('recovery: Retry-After is a lower bound, including dates and delays longer than a minute', async (t) => {
  const { client } = await app(t); await client.signIn(); const native = client.fetch;
  for (const header of ['120', new Date(Date.now() + 120_000).toUTCString()]) {
    let calls = 0;
    client.fetch = async (...args) => { if (args[0].endsWith('/session')) { calls++; return new Response('{"error":"rate_limited"}', { status: 429, headers: { 'retry-after': header } }); } return native(...args); };
    // Start a fresh retry window for each independently exercised header.
    client.retryAfterUntil = 0; client.retryAt = 0;
    const before = Date.now(); await client.refreshSession({ retryNow: true });
    assert.ok(client.retryAt >= before + 118_000, `${header}: ${client.retryAt - before}ms`);
    await Promise.all([client.refreshSession(), client.refreshSession({ retryNow: true })]);
    assert.equal(calls, 1, 'focus, polling and manual retries honor server cooldown');
    assert.equal(client.state, 'unavailable');
  }
});

test('recovery: a stale refresh cannot block or reset a newer session refresh', async (t) => {
  const { client, wallet } = await app(t); await client.signIn(); const native = client.fetch;
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()]; let calls = 0;
  client.fetch = async (...args) => {
    const response = await native(...args);
    if (args[0].endsWith('/session')) { const i = calls++; entered[i]?.resolve(); await gates[i]?.promise; }
    return response;
  };
  const old = client.refreshSession(); await entered[0].promise;
  wallet.emit('accountsChanged', [wallet.address]); await client.signIn(); const token = client.session.token;
  const fresh = client.refreshSession();
  // Give the HTTP request a bounded opportunity to enter; always release both gates on failure.
  try {
    await Promise.race([entered[1].promise, delay(500)]);
    assert.equal(calls, 2, 'new generation must have its own refresh');
    gates[0].resolve(); await old;
    const duplicate = client.refreshSession();
    gates[1].resolve(); await Promise.all([fresh, duplicate]);
    assert.equal(calls, 2); assert.equal(client.session.token, token); assert.equal(client.state, 'verified');
  } finally { for (const gate of gates) gate.resolve(); await Promise.all([old, fresh]); }
});

test('recovery: late nonce cannot overwrite the cancellation secret of a newer signing attempt', async (t) => {
  const { client, wallet, svc } = await app(t); const native = client.fetch;
  const oldNonce = deferred(), releaseNonce = deferred(), newSignature = deferred(), releaseSignature = deferred(); let nonceCalls = 0;
  client.fetch = async (...args) => {
    const response = await native(...args);
    if (args[0].endsWith('/nonce') && nonceCalls++ === 0) { oldNonce.resolve(); await releaseNonce.promise; }
    return response;
  };
  const old = client.signIn(); await oldNonce.promise; client.invalidate('Cancelled');
  wallet.sign = async (message) => { newSignature.resolve(); await releaseSignature.promise; return signForTests(message, wallet.key); };
  const fresh = client.signIn(); await newSignature.promise; const secret = client.cancellationSecret;
  try {
    releaseNonce.resolve(); await old;
    assert.equal(client.cancellationSecret, secret);
    client.invalidate('Cancelled'); await client.retryRevocations();
    assert.equal(svc.auth.nonces.size, 0);
    releaseSignature.resolve(); await fresh; await client.retryRevocations();
    assert.equal(client.session, null); assert.equal(svc.auth.sessions.size, 0); assert.equal(client.revocations.size, 0);
  } finally { releaseNonce.resolve(); releaseSignature.resolve(); await Promise.all([old, fresh]); }
});

test('recovery: cancelling a delayed verify queues no malformed nonce-only revocations', async (t) => {
  const { client, svc } = await app(t); const native = client.fetch, entered = deferred(), release = deferred();
  client.fetch = async (...args) => { const response = await native(...args); if (args[0].endsWith('/verify')) { entered.resolve(); await release.promise; } return response; };
  const attempt = client.signIn(); await entered.promise; assert.equal(svc.auth.sessions.size, 1);
  client.invalidate('Cancelled'); await client.retryRevocations(); release.resolve(); await attempt;
  assert.equal(svc.auth.sessions.size, 0); assert.equal(client.revocations.size, 0);
  await client.signIn(); assert.equal(client.state, 'verified', client.error);
});

test('recovery: logout requests share one in-flight revocation and require acknowledgement', async (t) => {
  const { client } = await app(t); await client.signIn(); const native = client.fetch;
  const entered = deferred(), release = deferred(); let calls = 0;
  client.fetch = async (...args) => { if (args[0].endsWith('/logout')) { calls++; entered.resolve(); await release.promise; return new Response('{}'); } return native(...args); };
  const logout = client.logout(); await entered.promise; release.resolve(); await logout;
  assert.equal(calls, 1); assert.equal(client.session, null); assert.equal(client.revocations.size, 1);
  assert.match(client.error, /pending/);
  client.fetch = native; await client.logout(); assert.equal(client.revocations.size, 0); assert.match(client.error, /Signed out on the server/);
});

test('recovery: automatic retries grow with bounded jitter, recover, and stop on logout (virtual clock)', async (t) => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const client = new VisitorAuthClient({ baseUrl: origin, uri, origin });
  t.after(() => client.destroy());
  const token = randomBytes(32).toString('hex'), address = addressFromPrivateKey(randomBytes(32).toString('hex'));
  const session = { version: 1, token, address, chainId: 1, origin, uri, world: 'world-20260101-0:' + randomBytes(32).toString('hex'), role: 'visitor', expiresAt: now + 3_600_000,
    profile: { address, visitCount: 1, firstVerifiedAt: now, lastVerifiedAt: now } };
  client.session = session; client.address = address;
  let calls = 0, failed = true;
  client.request = async (route) => {
    if (route === 'logout') return { version: 1, loggedOut: true };
    calls++; if (failed) throw Object.assign(new Error('maintenance'), { status: 503 });
    return session;
  };
  await client.refreshSession();
  for (let i = 0; i < 8; i++) {
    const wait = client.retryAt - Date.now(), backoff = Math.min(30_000, 1000 * 2 ** Math.min(i, 5));
    assert.ok(wait >= backoff * .75 && wait <= Math.min(30_000, Math.ceil(backoff * 1.25)));
    assert.equal(client.session.token, token); assert.equal(client.state, 'unavailable');
    t.mock.timers.tick(wait); await new Promise(setImmediate);
  }
  assert.equal(calls, 9);
  failed = false; t.mock.timers.tick(client.retryAt - Date.now()); await new Promise(setImmediate);
  assert.equal(client.state, 'verified'); assert.equal(client.retryTimer, null); assert.equal(calls, 10);
  failed = true; await client.refreshSession(); await client.logout();
  const afterLogout = calls; t.mock.timers.tick(120_000); await new Promise(setImmediate);
  assert.equal(calls, afterLogout); assert.equal(client.session, null);
});

test('recovery: structured scope and control characters are checked before any wallet signature', async (t) => {
  const { client, wallet, svc } = await app(t); const native = client.fetch;
  // The service scope is structured, while the underlying existing world ID may be non-UUID.
  const structured = 'world-20260101-0:' + randomBytes(32).toString('hex');
  svc.auth.world = structured; await client.loadConfig(); await client.signIn();
  assert.equal(client.state, 'verified'); assert.equal(client.session.world, structured); await client.logout();
  const signatures = wallet.methods.filter((m) => m === 'personal_sign').length;
  for (const [field, value] of [['world', structured + '\nPermissions: all'], ['domain', 'world.example\r\n'], ['origin', origin + '\u0085'], ['uri', uri + '\u2028']]) {
    client.fetch = async (...args) => {
      const response = await native(...args);
      if (!args[0].endsWith('/nonce')) return response;
      return new Response(JSON.stringify({ ...await response.json(), [field]: value }));
    };
    await client.signIn(); assert.equal(client.session, null); assert.match(client.error, /Mismatched/);
  }
  assert.equal(wallet.methods.filter((m) => m === 'personal_sign').length, signatures);
  client.fetch = native; await client.signIn(); assert.equal(client.state, 'verified');
});
