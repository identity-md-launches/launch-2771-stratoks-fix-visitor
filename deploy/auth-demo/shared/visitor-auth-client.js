// Framework-independent visitor auth controller for the current HUD's integration.
// No localStorage, cookies, transaction RPC, chain switching or wallet-specific SDK.
import { challengeMessage } from './visitor-challenge.js';
const validAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const addressOf = (accounts) => Array.isArray(accounts) && validAddress(accounts[0]) ? accounts[0].toLowerCase() : null;
const chainOf = (s) => typeof s === 'string' && /^0x[0-9a-f]+$/i.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
// The service issues <durable service identity>:<SHA-256 of world identity>.
// A world identity is not necessarily a UUID (for example world-20260101-0).
const validWorldScope = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[0-9a-f]{64}$/.test(v);
const safeField = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);
function serviceURL(value, originOnly = false) {
  if (!safeField(value, 512)) throw new Error('Malformed sign-in service scope.');
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || (originOnly ? u.origin !== value : u.href !== value) ||
    (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('Malformed sign-in service scope.');
  return u;
}
const validProfile = (p, address) => p?.address === address && Number.isSafeInteger(p.visitCount) && p.visitCount >= 1 &&
  Number.isSafeInteger(p.firstVerifiedAt) && Number.isSafeInteger(p.lastVerifiedAt) && p.firstVerifiedAt >= 0 && p.lastVerifiedAt >= p.firstVerifiedAt;

export function discoverWallets(target = window, legacy = target.ethereum) {
  const wallets = [], listeners = new Set();
  const add = (provider, name, id) => {
    if (!provider || typeof provider.request !== 'function' || wallets.some((w) => w.provider === provider)) return;
    // Treat names as text; never render provider-controlled HTML or icons.
    wallets.push({ provider, name: String(name || 'Injected wallet').slice(0, 80), id: String(id || wallets.length) });
    for (const listener of listeners) listener([...wallets]);
  };
  const announce = (e) => { const d = e.detail; if (d?.info) add(d.provider, d.info.name, d.info.uuid); };
  target.addEventListener('eip6963:announceProvider', announce);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  for (const p of (Array.isArray(legacy?.providers) ? legacy.providers : legacy ? [legacy] : [])) add(p, p.isRabby ? 'Rabby (legacy)' : p.isMetaMask ? 'MetaMask (legacy)' : 'Injected wallet (legacy)', null);
  return { get wallets() { return [...wallets]; }, subscribe(fn) { listeners.add(fn); fn([...wallets]); return () => listeners.delete(fn); }, destroy() { target.removeEventListener('eip6963:announceProvider', announce); listeners.clear(); } };
}

export function validateChallenge(c, cfg, { address, chainId, origin, uri, now = Date.now() }) {
  const service = serviceURL(uri); serviceURL(origin, true);
  if (!c || c.version !== 1 || c.address !== address || c.chainId !== chainId || !cfg.chains.includes(chainId) || c.origin !== origin || c.uri !== uri || c.domain !== service.host || c.world !== cfg.world || !validWorldScope(c.world) || !safeField(c.domain, 253) || !safeField(c.origin, 512) || !safeField(c.uri, 512) || !/^[0-9a-f]{64}$/.test(c.cancellationSecret ?? '') || !/^[0-9a-f]{64}$/.test(c.nonce) || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.issuedAt > now + 30_000 || c.issuedAt < now - cfg.nonceTtlMs || c.expiresAt <= now || c.expiresAt - c.issuedAt !== cfg.nonceTtlMs || c.message !== challengeMessage(c)) throw new Error('Mismatched sign-in challenge. No signature requested.');
}

export class VisitorAuthClient {
  constructor({ baseUrl, uri, origin, fetchImpl = fetch, timeoutMs = 10_000, signatureTimeoutMs, onChange = () => {} }) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null; this.uri = uri; this.origin = origin;
    this.fetch = (...args) => fetchImpl(...args); this.timeoutMs = timeoutMs; this.onChange = onChange;
    this.signatureTimeoutMs = signatureTimeoutMs;
    this.generation = 0; this.state = 'disconnected'; this.error = ''; this.provider = null;
    this.address = null; this.chainId = null; this.session = null; this.config = null; this.pendingNonce = null;
    this.busy = false; this.cleanup = () => {}; this.expiryTimer = null; this.revocations = new Set();
    this.challenge = null; this.cancellationSecret = null; this.refreshing = null; this.retryTimer = null; this.retryAttempt = 0;
    this.retryAt = 0; this.retryAfterUntil = 0;
    this.pendingRequests = 0; this.activeAttempts = 0;
  }
  emit(state = this.state, error = '') { this.state = state; this.error = error; this.onChange({ state, error, address: this.address, chainId: this.chainId, session: this.session, busy: this.busy, retryAt: this.retryAt, retryAfterUntil: this.retryAfterUntil }); }
  async deadline(promise, timeoutMs = this.timeoutMs) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request timed out. You can retry.')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async request(route, body, token) {
    if (!this.baseUrl) throw new Error('This isolated preview has no authentication backend. Choose a world server to sign in.');
    this.pendingRequests++;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const r = await this.fetch(`${this.baseUrl}/api/auth/${route}`, { method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { 'X-Stratoks-Origin': this.origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(data.error ?? `Backend returned ${r.status}`);
        e.status = r.status; e.code = data.error;
        const retryAfter = r.headers?.get?.('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const dateMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(dateMs) && dateMs > 0) e.retryAfterMs = Math.min(2_147_000_000, dateMs);
        }
        throw e;
      }
      return data;
    } catch (e) { if (e.name === 'AbortError') throw new Error('Backend timed out. You can retry.'); throw e; }
    finally { clearTimeout(timer); this.pendingRequests--; }
  }
  revoke(body, token) {
    // Track failures so UI never falsely claims server logout while offline.
    let job = [...this.revocations].find((j) => body.nonce ? j.body.nonce === body.nonce && j.body.cancellationSecret === body.cancellationSecret : !j.body.nonce && j.token === token);
    if (!job) { job = { body, token, promise: null }; this.revocations.add(job); }
    return this.runRevocation(job);
  }
  runRevocation(job) {
    if (!job.promise) job.promise = this.request('logout', job.body, job.token).then((result) => {
      if (result.version !== 1 || result.loggedOut !== true) throw new Error('Server sign-out was not acknowledged.');
      this.revocations.delete(job);
    }).finally(() => { job.promise = null; });
    return job.promise;
  }
  async retryRevocations() {
    for (const job of [...this.revocations]) await this.runRevocation(job);
  }
  clearRetry() {
    clearTimeout(this.retryTimer); this.retryTimer = null; this.retryAt = 0; this.retryAfterUntil = 0; this.retryAttempt = 0;
  }
  scheduleRetry(error = {}) {
    clearTimeout(this.retryTimer);
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.retryAttempt++, 5));
    const jittered = Math.min(30_000, backoff * (0.75 + Math.random() * 0.5));
    if (error.retryAfterMs) this.retryAfterUntil = Date.now() + error.retryAfterMs;
    const delay = Math.max(jittered, this.retryAfterUntil - Date.now() + (error.retryAfterMs ? Math.random() * Math.min(5000, error.retryAfterMs * 0.2) : 0));
    this.retryAt = Date.now() + Math.ceil(delay);
    const generation = this.generation;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (generation === this.generation) void this.refreshSession(); }, Math.ceil(delay));
  }
  invalidate(reason = '', state = this.address ? 'connected' : 'disconnected') {
    ++this.generation; this.busy = false;
    clearTimeout(this.expiryTimer); this.expiryTimer = null; this.refreshing = null;
    const old = this.session, nonce = this.pendingNonce, cancellationSecret = this.cancellationSecret;
    this.session = null; this.pendingNonce = null; this.challenge = null;
    this.cancellationSecret = null; this.clearRetry();
    const generation = this.generation;
    if (old || nonce) this.revoke(nonce ? { nonce, cancellationSecret } : {}, old?.token).catch(() => {
      if (generation === this.generation) this.emit(this.state, 'Authentication cleared locally. Server revocation pending; reconnect and retry logout. Sessions also expire or end on server restart.');
    });
    this.emit(state, reason);
  }
  async loadConfig() {
    const generation = this.generation;
    try {
      const c = await this.request('config');
      if (c.enabled !== true || c.version !== 1 || c.uri !== this.uri || c.domain !== serviceURL(this.uri).host || !safeField(c.domain, 253) || !validWorldScope(c.world) || !Array.isArray(c.chains) || !c.chains.length || c.chains.length > 16 || c.chains.some((n) => !Number.isSafeInteger(n) || n <= 0) || !Number.isSafeInteger(c.nonceTtlMs) || c.nonceTtlMs < 1 || c.nonceTtlMs > 120_000 || !Number.isSafeInteger(c.sessionTtlMs) || c.sessionTtlMs < 1 || c.sessionTtlMs > 100_000_000 || c.sessionsSurviveRestart !== false || c.transport !== 'memory-bearer') throw new Error('This backend does not offer compatible visitor sign-in.');
      if (generation === this.generation) {
        if (this.config && this.config.world !== c.world) this.invalidate('The world service changed. Sign in again.');
        this.config = c;
        const recovering = this.state === 'unavailable' && !this.session;
        this.emit(recovering ? (this.address ? 'connected' : 'disconnected') : this.state, recovering ? '' : this.error);
      } return c;
    } catch (e) {
      if (generation === this.generation) {
        if (this.session) {
          this.scheduleRetry(e);
          this.emit('unavailable', 'Session status temporarily unavailable. Your credential is retained; retrying.');
        } else { this.config = null; this.emit('unavailable', e.message); }
      } throw e;
    }
  }
  async connect(provider) {
    if (this.busy) return;
    this.invalidate(); this.cleanup(); this.provider = provider; this.address = null; this.chainId = null;
    if (!provider?.request) { this.emit('unavailable', 'Use an injected EVM wallet extension or its mobile browser.'); return; }
    // Many wallets announce the initial account while eth_requestAccounts is still resolving.
    // There is no session at this point; re-read the selected account before completing connection.
    let connecting = true;
    const changedAccounts = (a) => { this.address = addressOf(a); if (!connecting) this.invalidate('Wallet account changed. Sign in again.'); };
    const changedChain = (c) => { this.chainId = chainOf(c); if (!connecting) this.invalidate('Network changed. Sign in again on a supported network.'); };
    const disconnected = () => { this.address = null; this.invalidate('Wallet disconnected. Unlock or reconnect your wallet.', 'disconnected'); };
    for (const [name, fn] of [['accountsChanged', changedAccounts], ['chainChanged', changedChain], ['disconnect', disconnected]]) provider.on?.(name, fn);
    this.cleanup = () => { for (const [name, fn] of [['accountsChanged', changedAccounts], ['chainChanged', changedChain], ['disconnect', disconnected]]) provider.removeListener?.(name, fn); };
    const generation = this.generation; this.busy = true; this.activeAttempts++; this.emit();
    try {
      await this.deadline(Promise.resolve().then(() => provider.request({ method: 'eth_requestAccounts' })));
      const [accounts, chain] = await this.deadline(Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]));
      if (generation !== this.generation) return;
      this.address = addressOf(accounts); this.chainId = chainOf(chain);
      if (!this.address || !this.chainId) throw new Error('Wallet is locked or has no available account. Unlock it and retry.');
      this.emit('connected');
    } catch (e) { if (generation === this.generation) this.emit('disconnected', e.code === 4001 ? 'Connection declined. You can retry.' : e.message); }
    finally { this.activeAttempts--; connecting = false; if (generation === this.generation) { this.busy = false; this.emit(this.state, this.error); } }
  }
  async signIn() {
    if (this.busy || this.session || !this.address || !this.provider) return;
    const generation = this.generation, address = this.address, chainId = this.chainId, provider = this.provider;
    const current = () => generation === this.generation;
    this.busy = true; this.activeAttempts++; this.emit('signing');
    // Cancellation material belongs to this attempt, never to a newer generation.
    let nonce, cancellationSecret;
    try {
      await this.retryRevocations();
      if (!current()) return;
      const config = await this.loadConfig();
      if (!current()) return;
      if (!config.chains.includes(chainId)) throw new Error(`Unsupported network. Select chain ${config.chains.join(' or ')} in your wallet, then retry.`);
      const c = await this.request('nonce', { address, chainId }); nonce = c.nonce;
      cancellationSecret = c.cancellationSecret;
      if (!current()) { await this.revoke({ nonce, cancellationSecret: c.cancellationSecret }); return; }
      this.cancellationSecret = cancellationSecret;
      this.pendingNonce = nonce;
      validateChallenge(c, config, { address, chainId, origin: this.origin, uri: this.uri });
      this.challenge = c; this.emit('signing');
      // Recheck provider state before opening the signature prompt, and again before verify.
      const checkWallet = async () => {
        const [a, ch] = await this.deadline(Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]));
        if (!current() || addressOf(a) !== address || chainOf(ch) !== chainId) throw new Error('Wallet account or network changed. Sign in again.');
      };
      await checkWallet();
      const signature = await this.deadline(Promise.resolve().then(() => provider.request({ method: 'personal_sign', params: ['0x' + [...new TextEncoder().encode(c.message)].map((v) => v.toString(16).padStart(2, '0')).join(''), address] })), this.signatureTimeoutMs ?? this.timeoutMs);
      await checkWallet();
      const result = await this.request('verify', { nonce, address, chainId, message: c.message, signature });
      if (!current()) { await this.revoke({ nonce, cancellationSecret }); return; }
      // Verification itself can be delayed. Recheck silent wallet changes after its response too.
      await checkWallet();
      if (result.version !== 1 || result.address !== address || result.chainId !== chainId || result.world !== config.world || result.origin !== this.origin || result.uri !== this.uri || !/^[0-9a-f]{64}$/.test(result.token) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + config.sessionTtlMs + 30_000 || result.role !== 'visitor' || !validProfile(result.profile, address)) throw new Error('Mismatched session response.');
      this.session = result; this.pendingNonce = null; this.challenge = null; this.cancellationSecret = null; this.clearRetry();
      this.expiryTimer = setTimeout(() => this.invalidate('Session expired. Sign in again.', 'expired'), Math.max(0, result.expiresAt - Date.now()));
      this.emit('verified');
    } catch (e) {
      if (nonce) await this.revoke({ nonce, cancellationSecret }).catch(() => {});
      if (current()) { this.pendingNonce = null; this.session = null; this.challenge = null; this.cancellationSecret = null; this.emit(this.config ? 'connected' : 'unavailable', e.code === 4001 ? 'Signature declined. You can retry.' : e.message); }
    } finally { this.activeAttempts--; if (current()) { this.busy = false; this.emit(this.state, this.error); } }
  }
  async refreshSession({ retryNow = false } = {}) {
    if (!this.session || this.refreshing) return this.refreshing?.promise;
    if (Date.now() < this.retryAfterUntil || (!retryNow && Date.now() < this.retryAt)) return;
    const generation = this.generation;
    const previous = this.session;
    clearTimeout(this.retryTimer); this.retryTimer = null; this.retryAt = 0;
    const job = {};
    this.refreshing = job;
    this.emit('checking');
    job.promise = (async () => {
      try {
        const s = await this.request('session', undefined, previous.token);
        if (generation !== this.generation) return;
        for (const k of ['version', 'address', 'chainId', 'origin', 'world', 'uri', 'role', 'expiresAt']) if (s[k] !== previous[k]) throw new Error('Mismatched session response');
        if (!validProfile(s.profile, previous.address)) throw new Error('Mismatched session profile');
        this.session = { ...previous, profile: s.profile }; this.clearRetry(); this.emit('verified');
      } catch (e) {
        if (generation !== this.generation) return;
        if ((e.status === 401 && ['invalid_session', 'session_expired_or_revoked'].includes(e.code)) || (e.status === 403 && e.code === 'session_scope_mismatch')) {
          this.invalidate('Session was rejected by the server. Sign in again.', 'expired'); return;
        }
        this.scheduleRetry(e);
        this.emit('unavailable', 'Session status temporarily unavailable. Your credential is retained; retrying.');
      } finally { if (this.refreshing === job) this.refreshing = null; }
    })();
    return job.promise;
  }
  async logout() {
    this.invalidate();
    if (!this.revocations.size) {
      this.emit(this.address ? 'connected' : 'disconnected', 'No active visitor session in this tab.');
      return;
    }
    const generation = this.generation;
    this.busy = true; this.emit(this.state, 'Confirming sign-out with the server…');
    try { await this.retryRevocations(); if (generation === this.generation) this.emit(this.address ? 'connected' : 'disconnected', 'Signed out on the server.'); }
    catch { if (generation === this.generation) this.emit(this.state, 'Cleared locally; server logout is pending while offline. Retry logout when the backend returns.'); }
    finally { if (generation === this.generation) { this.busy = false; this.emit(this.state, this.error); } }
  }
  disconnect() { this.cleanup(); this.address = null; this.provider = null; this.invalidate(); }
  destroy() { this.disconnect(); clearTimeout(this.expiryTimer); }
}
