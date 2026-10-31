import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { startExpanse } from '../server/src/expanse/server.js';
import { VisitorAuth } from '../server/src/expanse/visitor-auth.js';
import { addressFromPrivateKey, signForTests } from '../server/src/wallet.js';
import { identityDigest, readState, SNAPSHOT } from '../server/src/expanse/persist.js';

const origin = 'https://world.example', preview = 'https://preview.example', uri = origin + '/';
// Disposable, randomly generated test signers only. No wallet or RPC connection.
const key = randomBytes(32).toString('hex'), address = addressFromPrivateKey(key);
const otherKey = randomBytes(32).toString('hex'), otherAddress = addressFromPrivateKey(otherKey);
async function app(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expanse-auth-'));
  let time = Date.now();
  const settings = { dataDir: dir, seed: 909, initialCount: 3, tickMs: 1_000_000, port: 0,
    auth: { uri, allowedOrigins: [preview], now: () => time, ...options } };
  let svc = startExpanse(settings); await once(svc.server, 'listening');
  let base = `http://127.0.0.1:${svc.server.address().port}`;
  const request = async (route, body, token, from = origin, extra = {}) => {
    const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(from === null ? {} : { Origin: from }), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  const nonce = async (addr = address, chainId = 1, from = origin) => request('/api/auth/nonce', { address: addr, chainId }, undefined, from);
  const proof = (c, signKey = key) => ({ nonce: c.nonce, address: c.address, chainId: c.chainId, message: c.message, signature: signForTests(c.message, signKey) });
  const login = async (addr = address, signKey = key) => { const c = (await nonce(addr)).body; return request('/api/auth/verify', proof(c, signKey)); };
  t.after(async () => { await svc.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, request, nonce, proof, login, get svc() { return svc; }, get base() { return base; }, advance(ms) { time += ms; }, async restart() { await svc.stop(); svc = startExpanse(settings); await once(svc.server, 'listening'); base = `http://127.0.0.1:${svc.server.address().port}`; } };
}

test('real HTTP challenge/signature/login/session/logout; private profile survives restart, world unchanged', async (t) => {
  const a = await app(t);
  const before = a.svc.world.toState(), digest = identityDigest(before);
  const config = await a.request('/api/auth/config'); assert.equal(config.body.enabled, true);
  const c = await a.nonce(); assert.equal(c.status, 200); assert.match(c.body.message, /Chain ID: 1/); assert.equal(c.body.domain, 'world.example'); assert.equal(c.body.uri, uri);
  assert.match(c.body.message, /sends no transaction/); assert.match(c.body.nonce, /^[0-9a-f]{64}$/);
  const v = await a.request('/api/auth/verify', a.proof(c.body)); assert.equal(v.status, 200); const token = v.body.token;
  assert.equal(v.body.role, 'visitor'); assert.equal(v.body.profile.visitCount, 1);
  assert.equal(v.headers.get('cache-control'), 'no-store'); assert.equal(v.headers.get('set-cookie'), null);
  const current = await a.request('/api/auth/session', undefined, token); assert.equal(current.status, 200); assert.equal(current.body.challengeHash, undefined); assert.equal(current.body.token, undefined);
  assert.equal((await a.request('/api/auth/session', undefined, token, preview)).status, 403);
  assert.equal((await a.request('/api/auth/session', undefined, token, null, { 'X-Stratoks-Origin': origin })).status, 200);
  assert.equal((await a.request('/api/auth/session', undefined, token, null)).status, 403);
  assert.equal((await a.request('/api/auth/logout', {}, token, preview)).status, 403);
  assert.equal((await a.request('/api/auth/logout', {}, token)).status, 200);
  assert.equal((await a.request('/api/auth/session', undefined, token)).status, 401);
  assert.equal((await a.request('/api/auth/logout', {}, token)).status, 200);
  const again = await a.login(); assert.equal(again.body.profile.visitCount, 2);
  assert.equal(identityDigest(a.svc.world.toState()), digest);
  assert.deepEqual(a.svc.world.toState(), before);
  for (const route of ['/api/expanse/info', '/api/expanse/frame', '/api/expanse/discoveries', '/healthz']) {
    const r = await a.request(route, undefined, undefined, null); assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes(address)); assert.ok(!JSON.stringify(r.body).includes(again.body.token));
  }
  await a.restart();
  assert.equal(identityDigest(a.svc.world.toState()), digest);
  assert.equal(identityDigest(readState(path.join(a.dir, SNAPSHOT))), digest);
  assert.equal((await a.request('/api/auth/session', undefined, again.body.token)).status, 401);
  assert.equal((await a.login()).body.profile.visitCount, 3);
  const store = path.join(a.dir, 'private-visitors/profiles-v1.json');
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(store, 'utf8').includes(again.body.token));
});

test('HTTP rejects wrong signer/address/chain/message/origin, replay and expiry', async (t) => {
  const a = await app(t, { nonceTtlMs: 1000, sessionTtlMs: 2000, perPeerSignups: 100 });
  for (const [change, expected, from] of [
    [(p) => ({ ...p, signature: signForTests(p.message, otherKey) }), 'wrong_signer'],
    [(p) => ({ ...p, address: otherAddress }), 'address_mismatch'],
    [(p) => ({ ...p, chainId: 8453 }), 'chain_mismatch'],
    [(p) => ({ ...p, message: p.message.replace('URI:', 'URL:') }), 'message_mismatch'],
    [(p) => ({ ...p, message: p.message.replace('world.example', 'evil.example') }), 'message_mismatch'],
    [(p) => ({ ...p, signature: '0x1234' }), 'invalid_signature'],
    [(p) => p, 'origin_mismatch', preview],
  ]) {
    const c = (await a.nonce()).body;
    const r = await a.request('/api/auth/verify', change(a.proof(c)), undefined, from ?? origin);
    assert.equal(r.status, 401); assert.equal(r.body.error, expected);
    assert.equal((await a.request('/api/auth/verify', a.proof(c))).body.error, 'unknown_or_used_nonce');
  }
  assert.equal((await a.nonce(address, 4663)).status, 400);
  assert.equal((await a.nonce('not-an-address')).status, 400);
  assert.equal((await a.nonce(address, 1, 'https://evil.example')).status, 403);
  const c = (await a.nonce()).body; a.advance(1000);
  assert.equal((await a.request('/api/auth/verify', a.proof(c))).status, 401);
  const session = await a.login(); assert.equal(session.status, 200); a.advance(2000);
  assert.equal((await a.request('/api/auth/session', undefined, session.body.token)).status, 401);
});

test('cancel pending or completed challenge safely revokes late authentication', async (t) => {
  const a = await app(t);
  let c = (await a.nonce()).body;
  assert.equal((await a.request('/api/auth/logout', { nonce: c.nonce, cancellationSecret: c.cancellationSecret }, undefined, preview)).status, 403);
  assert.equal((await a.request('/api/auth/logout', { nonce: c.nonce, cancellationSecret: '0'.repeat(64) })).status, 403);
  assert.equal((await a.request('/api/auth/logout', { nonce: c.nonce, cancellationSecret: c.cancellationSecret })).status, 200);
  assert.equal((await a.request('/api/auth/verify', a.proof(c))).status, 401);
  c = (await a.nonce()).body;
  const s = await a.request('/api/auth/verify', a.proof(c)); assert.equal(s.status, 200);
  assert.equal((await a.request('/api/auth/logout', { nonce: c.nonce, cancellationSecret: c.cancellationSecret })).status, 200);
  assert.equal((await a.request('/api/auth/session', undefined, s.body.token)).status, 401);
  assert.equal((await a.request('/api/auth/logout', { nonce: c.nonce, cancellationSecret: c.cancellationSecret })).status, 200);
});

test('malformed input, bounded bodies, exact CORS and method isolation', async (t) => {
  const a = await app(t);
  for (const body of [null, [], {}, { address, chainId: 1, role: 'developer' }, { address: { toString: 'oops' }, chainId: 1 }]) assert.equal((await a.request('/api/auth/nonce', body)).status, 400);
  const raw = async (route, options) => fetch(a.base + route, { ...options, headers: { Origin: origin, ...options.headers } });
  assert.equal((await raw('/api/auth/nonce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await raw('/api/auth/nonce', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await a.request('/api/auth/nonce', { address: 'a'.repeat(9000), chainId: 1 })).status, 413);
  assert.equal((await a.request('/api/auth/session?token=secret')).status, 400);
  assert.equal((await a.request('/api/auth/nonce')).status, 405);
  assert.equal((await a.request('/api/auth/not-real')).status, 404);
  assert.equal((await a.request('/api/auth/nonce', { address, chainId: 1 }, undefined, origin, { 'x-stratoks-origin': preview })).status, 403);
  const pre = await raw('/api/auth/verify', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization, x-stratoks-origin' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), origin); assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  assert.equal((await raw('/api/auth/verify', { method: 'OPTIONS', headers: { 'access-control-request-method': 'DELETE' } })).status, 403);
  assert.equal((await raw('/api/auth/verify', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-admin' } })).status, 403);
  const evil = await fetch(a.base + '/api/auth/config', { headers: { Origin: 'https://world.example.evil' } }); assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  for (const route of ['/api/expanse/info', '/api/reset', '/api/payments', '/healthz']) for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await raw(route, { method })).status, 405);
  assert.equal((await a.request('/api/expanse/info')).status, 200);
});

test('bounded nonce/session/profile stores and expiry garbage collection', async (t) => {
  const a = await app(t, { maxNonces: 1, maxSessions: 1, maxProfiles: 1, nonceTtlMs: 500, sessionTtlMs: 1000, profileRetentionMs: 500, perPeerRequests: 100, perPeerSignups: 100 });
  const c = (await a.nonce()).body; assert.equal((await a.nonce()).body.error, 'nonce_store_full');
  const s = await a.request('/api/auth/verify', a.proof(c)); assert.equal(s.status, 200);
  assert.equal((await a.login()).body.error, 'session_store_full');
  assert.equal((await a.request('/api/auth/logout', {}, s.body.token)).status, 200);
  assert.equal((await a.login(otherAddress, otherKey)).body.error, 'profile_store_full');
  a.advance(500); const other = await a.login(otherAddress, otherKey); assert.equal(other.status, 200); assert.equal(a.svc.auth.profiles.has(address), false);
  await a.request('/api/auth/logout', {}, other.body.token);
  assert.equal((await a.login()).body.error, 'profile_store_full'); a.advance(500); assert.equal((await a.login()).status, 200);
  a.advance(1000); a.svc.auth.gc(); assert.equal(a.svc.auth.sessions.size, 0);
  assert.equal((await a.nonce()).status, 200); a.advance(500); a.svc.auth.gc(); assert.equal(a.svc.auth.nonces.size, 0);
});

test('forwarded client addresses are accepted only from explicitly trusted peers', async (t) => {
  const a = await app(t, { trustedProxies: ['127.0.0.1'] });
  const auth = a.svc.auth;
  const req = (peer, header) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': header } });
  assert.equal(auth.clientAddress(req('127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(auth.clientAddress(req('198.51.100.8', '198.51.100.7')), '198.51.100.8');
  assert.equal(auth.clientAddress(req('127.0.0.1', 'bad value')), '127.0.0.1');
});

test('50 authenticated polling sessions do not consume sign-in peer quota', async (t) => {
  const a = await app(t, { perIpRequests: 2, perPeerSignups: 2 });
  const auth = a.svc.auth;
  const tokens = Array.from({ length: 50 }, () => randomBytes(32).toString('hex'));
  tokens.forEach((token, i) => auth.sessions.set(createHash('sha256').update(token).digest('hex'), {
    address: `0x${String(i + 1).padStart(40, '0')}`, chainId: 1, origin, world: auth.world, uri, role: 'visitor', expiresAt: Date.now() + 60_000,
  }));
  for (const token of tokens) assert.equal((await a.request('/api/auth/session', undefined, token)).status, 200);
  const challenge = (await a.nonce()).body;
  assert.equal((await a.request('/api/auth/verify', a.proof(challenge))).status, 200);
});

test('50 real verified signers behind a trusted proxy poll at 30 seconds while another visitor signs in', async (t) => {
  const a = await app(t, { trustedProxies: ['127.0.0.1'] });
  const visitors = [];
  const login = async (index) => {
    const signer = randomBytes(32).toString('hex'), addr = addressFromPrivateKey(signer);
    const forwarded = { 'x-forwarded-for': `198.51.100.${index}` };
    const challenge = await a.request('/api/auth/nonce', { address: addr, chainId: 1 }, undefined, origin, forwarded);
    assert.equal(challenge.status, 200);
    const verified = await a.request('/api/auth/verify', a.proof(challenge.body, signer), undefined, origin, forwarded);
    assert.equal(verified.status, 200); assert.equal(verified.body.address, addr);
    return { token: verified.body.token, forwarded };
  };
  for (let i = 1; i <= 50; i++) visitors.push(await login(i));
  const poll = () => Promise.all(visitors.map(async ({ token, forwarded }) => {
    const response = await a.request('/api/auth/session', undefined, token, origin, forwarded);
    assert.equal(response.status, 200); assert.equal(response.body.role, 'visitor');
  }));
  await poll(); a.advance(30_000);
  const [, newVisitor] = await Promise.all([poll(), login(51)]);
  a.advance(30_000); await poll();
  assert.equal((await a.request('/api/auth/session', undefined, newVisitor.token, origin, newVisitor.forwarded)).status, 200);
  assert.equal(a.svc.auth.sessions.size, 51);
});

test('per-peer/global rates and bounded rate-key map reject without affecting world', async (t) => {
  const a = await app(t, { perIpRequests: 2, rateWindowMs: 1000 });
  assert.equal((await a.request('/api/auth/config')).status, 200); assert.equal((await a.request('/api/auth/config')).status, 200);
  assert.equal((await a.request('/api/auth/config')).status, 200);
  await a.nonce(); await a.nonce();
  const limited = await a.nonce(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal((await a.request('/api/expanse/info')).status, 200);
  a.advance(1000); assert.equal((await a.request('/api/auth/config')).status, 200);
  const auth = a.svc.auth; auth.rates.clear(); auth.cfg.maxRateKeys = 1;
  auth.rate('a'); auth.rate('b'); assert.equal(auth.rates.size, 1);
  a.advance(1000); auth.rate('b'); assert.equal(auth.rates.size, 1);
  auth.cfg.globalRequests = 1; assert.throws(() => auth.rate('b'), /rate_limited/);
});

test('body deadline returns 408; profile write failure and corrupt restart keep anonymous viewing alive', async (t) => {
  const a = await app(t, { bodyTimeoutMs: 40 });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(a.base + '/api/auth/nonce', { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode); req.destroy(); }); });
    req.on('error', reject); req.write('{');
  }); assert.equal(status, 408);
  const persist = a.svc.auth.persist; a.svc.auth.persist = () => { throw new Error('simulated disk failure'); };
  assert.equal((await a.login()).body.error, 'profile_store_unavailable'); assert.equal(a.svc.auth.sessions.size, 0); assert.equal(a.svc.auth.profiles.size, 0);
  a.svc.auth.persist = persist;
  assert.equal((await a.request('/api/expanse/info')).status, 200);
  fs.writeFileSync(path.join(a.dir, 'private-visitors/profiles-v1.json'), 'broken');
  await a.restart(); assert.equal(a.svc.authUnavailable, true);
  assert.equal((await a.request('/api/auth/config')).body.enabled, false);
  assert.equal((await a.nonce()).status, 503); assert.equal((await a.request('/api/expanse/info')).status, 200);
});

test('invalid configuration cannot enable authentication', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cfg-'));
  try {
    for (const settings of [{ uri: 'http://world.example/' }, { uri, allowedOrigins: ['*'] }, { uri, allowedOrigins: ['https://preview.example/'] }, { uri, chains: [0] }, { uri: uri + '?secret=1' }, { uri, maxSessions: Infinity }]) assert.throws(() => new VisitorAuth({ dataDir: dir, ...settings }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('auth on a copied schema-4 populated world preserves identity through migration and restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visitor-copied-world-'));
  const fixture = new URL('./fixtures/expanse-v4/', import.meta.url);
  fs.cpSync(fixture, dir, { recursive: true });
  const original = readState(path.join(dir, SNAPSHOT)); const digest = identityDigest(original);
  const settings = { dataDir: dir, seed: 999, initialCount: 1, tickMs: 1_000_000, port: 0, auth: { uri } };
  let svc = startExpanse(settings); await once(svc.server, 'listening');
  t.after(async () => { await svc.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(identityDigest(svc.world.toState()), digest); assert.equal(svc.world.creatures.length, original.creatures.length);
  let base = `http://127.0.0.1:${svc.server.address().port}`;
  const post = (route, body) => fetch(base + '/api/auth/' + route, { method: 'POST', headers: { Origin: origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const c = await (await post('nonce', { address, chainId: 1 })).json();
  const v = await post('verify', { nonce: c.nonce, address, chainId: 1, message: c.message, signature: signForTests(c.message, key) }); assert.equal(v.status, 200);
  assert.equal(identityDigest(svc.world.toState()), digest);
  const backupRoot = path.join(dir, 'pre-migration');
  assert.ok(fs.existsSync(backupRoot));
  await svc.stop(); svc = startExpanse(settings); await once(svc.server, 'listening'); base = `http://127.0.0.1:${svc.server.address().port}`;
  assert.equal(identityDigest(svc.world.toState()), digest); assert.equal(svc.auth.profiles.get(address).visitCount, 1);
  const frame = await (await fetch(base + '/api/expanse/frame')).json(); assert.equal(frame.tick, original.tick); assert.equal(frame.residents.length, original.creatures.length);
});

test('review regressions: peer cannot exhaust global ceiling; capacity recovery; CORS Retry-After; rate-key eviction', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-'));
  let now = 1e12;
  const mk = (o) => new VisitorAuth({ dataDir: fs.mkdtempSync(path.join(dir, 'd')), uri: 'https://world.example/', now: () => now, perPeerSignups: 1000, ...o });
  const O = 'https://world.example';
  const signer = () => { const k = randomBytes(32).toString('hex'); return [addressFromPrivateKey(k), k]; };
  const login = (au, [ad, k]) => { const c = au.issue({ address: ad, chainId: 1 }, O); return au.verify({ nonce: c.nonce, address: ad, chainId: 1, message: c.message, signature: signForTests(c.message, k) }, O); };
  // 1: one peer cannot burn the global ceiling
  let au = mk({ globalRequests: 600, perIpPollRequests: 240 });
  for (let i = 0; i < 600; i++) try { au.rate('1.1.1.1', false); } catch {}
  au.rate('2.2.2.2', true);
  // 2: profile capacity recovery
  au = mk({ maxProfiles: 3 });
  for (let i = 0; i < 3; i++) { const s = signer(); const r = login(au, s); au.logout(r.token, O); }
  assert.throws(() => login(au, signer()), /profile_store_full/);
  now += 7 * 86400_000; login(au, signer());
  // 3: session cap fairness
  au = mk({ maxSessionsPerOrigin: 6 });
  const a1 = signer(), a2 = signer(); for (let i = 0; i < 3; i++) { login(au, a1); login(au, a2); }
  assert.ok(login(au, signer()).token);
  // 5: rate-key store never locks out new peers
  au = mk({ maxRateKeys: 4 });
  for (let i = 0; i < 10; i++) au.signupRate(`2001:db8::${i}`.replace('::', `:${i}::`) );
  au.rate('198.51.100.7', true);
  // 4: CORS + Retry-After on early 429
  const web = 'https://preview.example';
  au = mk({ allowedOrigins: [web], globalRequests: 1 });
  const srv = http.createServer((q, r) => { import('../server/src/expanse/visitor-auth.js').then((m) => m.handleVisitorAuth(q, r, au)); });
  srv.listen(0); await once(srv, 'listening'); t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/api/auth/config`;
  await fetch(url, { headers: { Origin: web } });
  const res = await fetch(url, { headers: { Origin: web } });
  assert.equal(res.status, 429); assert.equal(res.headers.get('access-control-allow-origin'), web);
  assert.equal(res.headers.get('access-control-expose-headers'), 'Retry-After'); assert.equal(res.headers.get('retry-after'), '60');
  const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
});
