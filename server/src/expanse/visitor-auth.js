// Expanse visitor authentication v1. Deliberately independent of legacy Auth/developer roles.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isAddress, recoverAddress } from '../wallet.js';
import { challengeMessage } from '../../../shared/visitor-challenge.js';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const defaults = {
  nonceTtlMs: 120_000, sessionTtlMs: 3_600_000, maxNonces: 1000, maxSessions: 2000,
  maxProfiles: 10_000, maxRateKeys: 1000, rateWindowMs: 60_000, perIpRequests: 60,
  globalRequests: 600, bodyLimit: 8192, bodyTimeoutMs: 5000,
  maxConcurrentRequests: 128,
  profileRetentionMs: 90 * 24 * 60 * 60 * 1000, maxSessionsPerAddress: 3, maxSessionsPerOrigin: 500,
  perPeerSignups: 10,
};
const ROUTES = new Map([
  ['/api/auth/config', 'GET'], ['/api/auth/nonce', 'POST'], ['/api/auth/verify', 'POST'],
  ['/api/auth/session', 'GET'], ['/api/auth/logout', 'POST'],
]);
function originURL(value, local) {
  const u = new URL(value);
  if (u.origin !== value || (u.protocol !== 'https:' && !(local && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('auth origins require exact HTTPS origins (or explicit local demo HTTP)');
  return u;
}
function exactObject(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length !== keys.length || !keys.every((k) => Object.hasOwn(o, k))) throw fail(400, 'invalid_body');
}

export class VisitorAuth {
  constructor({ dataDir, uri, allowedOrigins = [], chains = [1], localDemo = false, worldId = null, trustedProxies = [], now = Date.now, ...limits }) {
    this.cfg = { ...defaults, ...limits };
    for (const [k, v] of Object.entries(this.cfg)) if (!Number.isSafeInteger(v) || v < 1 || v > 1_000_000_000_000) throw new Error(`invalid auth limit: ${k}`);
    const u = new URL(uri);
    originURL(u.origin, localDemo);
    if (u.username || u.password || u.search || u.hash || u.href !== uri || uri.length > 512) throw new Error('AUTH_URI must be a canonical absolute service URI without credentials/query/fragment');
    this.uri = uri; this.domain = u.host;
    this.origins = new Set([u.origin, ...allowedOrigins]);
    for (const o of this.origins) originURL(o, localDemo);
    if (this.origins.size > 32) throw new Error('too many auth origins');
    if (!Array.isArray(chains) || !chains.length || chains.length > 16 || chains.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error('invalid supported auth chains');
    this.chains = [...new Set(chains)]; this.now = now;
    this.trustedProxies = new Set(trustedProxies);
    this.nonces = new Map(); this.sessions = new Map(); this.rates = new Map();
    this.activeRequests = 0;
    this.global = { start: now(), count: 0 };
    const dir = path.join(dataDir, 'private-visitors');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'profiles-v1.json');
    this.profiles = new Map();
    this.serviceId = crypto.randomUUID();
    if (fs.existsSync(this.file)) {
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw new Error('private profile store too large');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || typeof saved.serviceId !== 'string' || !/^[0-9a-f-]{36}$/.test(saved.serviceId) || !Array.isArray(saved.profiles) || saved.profiles.length > this.cfg.maxProfiles) throw new Error('invalid private profile store');
      this.serviceId = saved.serviceId;
      for (const p of saved.profiles) {
        exactObject(p, ['address', 'firstVerifiedAt', 'lastVerifiedAt', 'visitCount']);
        if (!isAddress(p.address) || p.address !== p.address.toLowerCase() || !Number.isSafeInteger(p.firstVerifiedAt) || p.firstVerifiedAt < 0 || !Number.isSafeInteger(p.lastVerifiedAt) || p.lastVerifiedAt < p.firstVerifiedAt || !Number.isSafeInteger(p.visitCount) || p.visitCount < 1 || this.profiles.has(p.address)) throw new Error('invalid private profile');
        this.profiles.set(p.address, p);
      }
    } else this.persist(this.profiles);
    // A distinct durable service identity, URI and snapshot identity prevent cross-world use.
    this.world = `${this.serviceId}:${hash(JSON.stringify(worldId ?? 'expanse'))}`;
  }
  persist(profiles) {
    const tmp = `${this.file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, serviceId: this.serviceId, profiles: [...profiles.values()] }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, this.file);
      const dir = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  gc() {
    const now = this.now();
    for (const store of [this.nonces, this.sessions]) for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
    for (const [k, v] of this.rates) if (v.start + this.cfg.rateWindowMs <= now) this.rates.delete(k);
  }
  clientAddress(req) {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!this.trustedProxies.has(peer)) return peer;
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string' || forwarded.length > 512) return peer;
    const first = forwarded.split(',')[0].trim();
    return first && !/[\s%]/.test(first) ? first : peer;
  }
  rate(ip, peerLimited = true) {
    this.gc(); const now = this.now();
    if (this.global.start + this.cfg.rateWindowMs <= now) this.global = { start: now, count: 0 };
    if (++this.global.count > this.cfg.globalRequests) throw fail(429, 'rate_limited');
    if (!peerLimited) return;
    let r = this.rates.get(ip);
    if (!r) {
      if (this.rates.size >= this.cfg.maxRateKeys) throw fail(429, 'rate_store_full');
      this.rates.set(ip, r = { start: now, count: 0 });
    }
    if (++r.count > this.cfg.perIpRequests) throw fail(429, 'rate_limited');
  }
  signupRate(ip) {
    const now = this.now(), key = `signup:${ip}`;
    let r = this.rates.get(key);
    if (!r) { if (this.rates.size >= this.cfg.maxRateKeys) throw fail(429, 'rate_store_full'); this.rates.set(key, r = { start: now, count: 0 }); }
    if (++r.count > this.cfg.perPeerSignups) throw fail(429, 'signup_rate_limited');
  }
  config() {
    return { version: 1, enabled: true, uri: this.uri, domain: this.domain, world: this.world, chains: this.chains,
      nonceTtlMs: this.cfg.nonceTtlMs, sessionTtlMs: this.cfg.sessionTtlMs, transport: 'memory-bearer', sessionsSurviveRestart: false };
  }
  issue({ address, chainId }, origin) {
    if (!this.origins.has(origin)) throw fail(403, 'origin_not_allowed');
    if (typeof address !== 'string' || !isAddress(address)) throw fail(400, 'invalid_address');
    if (!this.chains.includes(chainId)) throw fail(400, 'unsupported_chain');
    this.gc();
    if (this.nonces.size >= this.cfg.maxNonces) throw fail(429, 'nonce_store_full');
    const issuedAt = this.now(), expiresAt = issuedAt + this.cfg.nonceTtlMs;
    const nonce = crypto.randomBytes(32).toString('hex');
    const cancellationSecret = crypto.randomBytes(32).toString('hex');
    const c = { version: 1, address: address.toLowerCase(), domain: this.domain, origin, uri: this.uri, world: this.world,
      chainId, nonce, issuedAt, expiresAt };
    c.message = challengeMessage(c);
    this.nonces.set(nonce, { ...c, cancellationHash: hash(cancellationSecret) });
    return { ...c, cancellationSecret };
  }
  verify({ nonce, address, chainId, message, signature }, origin) {
    if (!this.origins.has(origin)) throw fail(403, 'origin_not_allowed');
    if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) throw fail(400, 'invalid_nonce');
    const c = this.nonces.get(nonce);
    if (!c) throw fail(401, 'unknown_or_used_nonce');
    this.nonces.delete(nonce); // consume before every verification attempt, including failures
    if (c.expiresAt <= this.now()) throw fail(401, 'nonce_expired');
    if (typeof address !== 'string' || c.address !== address.toLowerCase()) throw fail(401, 'address_mismatch');
    if (c.origin !== origin) throw fail(401, 'origin_mismatch');
    if (c.chainId !== chainId) throw fail(401, 'chain_mismatch');
    if (c.message !== message) throw fail(401, 'message_mismatch');
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw fail(401, 'invalid_signature');
    let signer;
    try { signer = recoverAddress(c.message, signature); } catch { throw fail(401, 'invalid_signature'); }
    if (signer !== c.address) throw fail(401, 'wrong_signer');
    this.gc();
    const addressSessions = [...this.sessions.values()].filter((s) => s.address === c.address).length;
    const originSessions = [...this.sessions.values()].filter((s) => s.origin === origin).length;
    if (this.sessions.size >= this.cfg.maxSessions || addressSessions >= this.cfg.maxSessionsPerAddress || originSessions >= this.cfg.maxSessionsPerOrigin) throw fail(429, 'session_store_full');
    const previous = this.profiles.get(c.address);
    const now = this.now();
    const next = new Map(this.profiles);
    const activeAddresses = new Set([...this.sessions.values()].map((s) => s.address));
    for (const [a, p] of next) if (!activeAddresses.has(a) && p.lastVerifiedAt + this.cfg.profileRetentionMs <= now) next.delete(a);
    if (!next.has(c.address) && next.size >= this.cfg.maxProfiles) {
      const [oldest, profile] = [...next].sort((a,b) => a[1].lastVerifiedAt - b[1].lastVerifiedAt)[0] ?? [];
      if (oldest && !activeAddresses.has(oldest) && profile.lastVerifiedAt + this.cfg.profileRetentionMs <= now) next.delete(oldest);
    }
    if (!next.has(c.address) && next.size >= this.cfg.maxProfiles) throw fail(429, 'profile_store_full');
    const retained = next.get(c.address);
    const profile = { address: c.address, firstVerifiedAt: retained?.firstVerifiedAt ?? now,
      lastVerifiedAt: Math.max(now, retained?.lastVerifiedAt ?? now), visitCount: (retained?.visitCount ?? 0) + 1 };
    if (!Number.isSafeInteger(profile.visitCount)) throw fail(503, 'profile_store_unavailable');
    next.set(c.address, profile);
    try { this.persist(next); } catch { throw fail(503, 'profile_store_unavailable'); }
    this.profiles = next;
    const token = crypto.randomBytes(32).toString('hex');
    const session = { address: c.address, chainId, origin, world: this.world, uri: this.uri, role: 'visitor', expiresAt: now + this.cfg.sessionTtlMs };
    this.sessions.set(hash(token), { ...session, challengeHash: hash(nonce), cancellationHash: c.cancellationHash });
    return { version: 1, token, ...session, profile: { ...profile } };
  }
  session(token, origin) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw fail(401, 'invalid_session');
    const s = this.sessions.get(hash(token));
    if (!s || s.expiresAt <= this.now()) { this.sessions.delete(hash(token)); throw fail(401, 'session_expired_or_revoked'); }
    if (s.origin !== origin || s.world !== this.world || s.uri !== this.uri) throw fail(403, 'session_scope_mismatch');
    const { challengeHash, ...publicSession } = s;
    return { version: 1, ...publicSession, profile: { ...this.profiles.get(s.address) } };
  }
  cancel(nonce, secret, origin) {
    if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) throw fail(400, 'invalid_nonce');
    const c = this.nonces.get(nonce);
    if (c && c.origin !== origin) throw fail(403, 'origin_mismatch');
    const matching = [...this.sessions].filter(([, s]) => s.challengeHash === hash(nonce));
    const expected = c?.cancellationHash ?? matching[0]?.[1].cancellationHash;
    if (expected && (!/^[0-9a-f]{64}$/.test(secret ?? '') || expected !== hash(secret))) throw fail(403, 'invalid_cancellation_secret');
    if (matching.some(([, s]) => s.origin !== origin)) throw fail(403, 'session_scope_mismatch');
    this.nonces.delete(nonce);
    for (const [key, s] of this.sessions) if (s.challengeHash === hash(nonce)) {
      if (s.origin !== origin) throw fail(403, 'session_scope_mismatch');
      if (s.cancellationHash === expected) this.sessions.delete(key);
    }
    return { version: 1, loggedOut: true };
  }
  logout(token, origin) {
    // Idempotent for expired/revoked tokens, but never allow another origin to revoke a live session.
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw fail(401, 'invalid_session');
    const s = this.sessions.get(hash(token));
    if (s && s.origin !== origin) throw fail(403, 'session_scope_mismatch');
    this.sessions.delete(hash(token));
    return { version: 1, loggedOut: true };
  }
}


function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}
function readBody(req, cfg) {
  return new Promise((resolve, reject) => {
    let size = 0, done = false; const chunks = [];
    const finish = (err, value) => {
      if (done) return; done = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', error); req.removeListener('aborted', aborted);
      if (err) { req.resume(); reject(err); } else resolve(value);
    };
    const data = (chunk) => { size += chunk.length; if (size > cfg.bodyLimit) finish(fail(413, 'body_too_large')); else chunks.push(chunk); };
    const end = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(fail(400, 'invalid_json')); } };
    const error = () => finish(fail(400, 'request_failed'));
    const aborted = () => finish(fail(400, 'request_aborted'));
    const timer = setTimeout(() => finish(fail(408, 'body_timeout')), cfg.bodyTimeoutMs);
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
  });
}

// Returns false only for routes outside the reserved auth namespace.
export async function handleVisitorAuth(req, res, auth) {
  let u;
  try { u = new URL(req.url, 'http://internal'); } catch { json(res, 400, { error: 'invalid_url' }); return true; }
  if (u.pathname !== '/api/auth' && !u.pathname.startsWith('/api/auth/')) return false;
  if (auth && auth.activeRequests >= auth.cfg.maxConcurrentRequests) {
    res.setHeader('retry-after', '1'); json(res, 503, { version: 1, error: 'auth_busy' }); req.resume(); return true;
  }
  if (auth) auth.activeRequests++;
  try {
    const method = ROUTES.get(u.pathname);
    if (!method) throw fail(404, 'not_found');
    if (u.search) throw fail(400, 'auth_query_forbidden');
    if (!auth) {
      if (u.pathname === '/api/auth/config' && req.method === 'GET') json(res, 200, { version: 1, enabled: false });
      else throw fail(503, 'auth_unavailable');
      return true;
    }
    const protectedRoute = ['/api/auth/nonce', '/api/auth/verify'].includes(u.pathname);
    auth.rate(auth.clientAddress(req), protectedRoute); // login abuse has per-peer limits; every route retains a global ceiling
    const rawOrigin = req.headers.origin, claimed = req.headers['x-stratoks-origin'];
    const origin = rawOrigin ?? claimed;
    if (rawOrigin && claimed && rawOrigin !== claimed) throw fail(403, 'origin_mismatch');
    if (origin && !auth.origins.has(origin)) throw fail(403, 'origin_not_allowed');
    if (rawOrigin && auth.origins.has(rawOrigin)) {
      res.setHeader('access-control-allow-origin', rawOrigin);
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!origin) throw fail(403, 'origin_required');
      const headers = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== method || headers.some((h) => !['authorization', 'content-type', 'x-stratoks-origin'].includes(h))) throw fail(403, 'preflight_not_allowed');
      res.writeHead(204, { 'access-control-allow-methods': method, 'access-control-allow-headers': 'Authorization, Content-Type, X-Stratoks-Origin', 'cache-control': 'no-store' }); res.end(); return true;
    }
    if (req.method !== method) { res.setHeader('allow', `${method}, OPTIONS`); throw fail(405, 'method_not_allowed'); }
    if (u.pathname === '/api/auth/config') { json(res, 200, auth.config()); return true; }
    if (!origin) throw fail(403, 'origin_required');
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    if (method === 'GET') {
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) throw fail(400, 'unexpected_body');
      json(res, 200, auth.session(token, origin)); return true;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) throw fail(415, 'json_required');
    if (Number(req.headers['content-length']) > auth.cfg.bodyLimit) throw fail(413, 'body_too_large');
    const body = await readBody(req, auth.cfg);
    let result;
    if (u.pathname === '/api/auth/nonce') { auth.signupRate(auth.clientAddress(req)); exactObject(body, ['address', 'chainId']); result = auth.issue(body, origin); }
    else if (u.pathname === '/api/auth/verify') { exactObject(body, ['nonce', 'address', 'chainId', 'message', 'signature']); result = auth.verify(body, origin); }
    else if (body && Object.hasOwn(body, 'nonce')) { exactObject(body, ['nonce', 'cancellationSecret']); result = auth.cancel(body.nonce, body.cancellationSecret, origin); }
    else { exactObject(body, []); result = auth.logout(token, origin); }
    json(res, 200, result);
  } catch (e) {
    if ([408, 413].includes(e.status)) res.setHeader('connection', 'close');
    if (e.status === 429) res.setHeader('retry-after', String(Math.ceil((auth?.cfg.rateWindowMs ?? 60000) / 1000)));
    if (!res.destroyed && !res.headersSent) json(res, e.status ?? 503, { version: 1, error: e.code ?? 'auth_unavailable' });
    req.resume();
  } finally {
    if (auth) auth.activeRequests--;
  }
  return true;
}
