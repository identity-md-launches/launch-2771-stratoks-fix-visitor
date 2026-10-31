# Expanse visitor authentication API v1

This contract belongs to `server/src/expanse/server.js`, not the legacy service. World routes remain GET/HEAD only; auth gives no gameplay, reset, payment or developer privileges. All verified accounts have `role: "visitor"`. Connecting a provider, sending an address, or restoring browser storage never authenticates anyone. Only server-verified EIP-191 signatures do.

## Transport and origin scope

Owner-run HTTPS service, usually behind the existing same-origin reverse proxy. `AUTH_URI` is the canonical public URI identifying that service; the challenge's domain is its URL host (including port), never an incoming Host/forwarded header. Set explicit `AUTH_ALLOWED_ORIGINS` for exact IMD HTTPS preview origins. No suffix matching, wildcard, arbitrary loopback exception, cookie, credentialed CORS, or reflection of unknown origins. Local HTTP is allowed **only** with the separate `AUTH_LOCAL_DEMO=true` flag and loopback hostnames.

Use `credentials: "omit"`, `cache: "no-store"`, and `redirect: "error"` in browser fetches. Set `X-Stratoks-Origin: location.origin` on every auth request, including same-origin GET (browsers often omit native Origin on those requests). Native `Origin`, when present, must exactly match that header. An origin must be in the configured allowlist. Non-browser clients can spoof these headers; headers are scope/CSRF controls, never identity proof. Signer recovery is identity proof.

The 64-character lowercase hex bearer returned by verification is a credential. Keep it in page memory only. Send it solely as `Authorization: Bearer <token>` to the configured auth service. Do not put tokens, signatures or nonces in URLs, public frames, console/proxy/body logs, analytics, localStorage, sessionStorage, exported saves or application-wide public state. No cookies are used or accepted as authentication, eliminating ambient-cookie CSRF; cross-origin script reads and custom-header requests require the exact allowlist. Owner scripts holding a token must also send its bound origin. Service-side session records contain only a SHA-256 token digest, plus scope and expiry; responses never return that digest.

All auth responses use `Cache-Control: no-store`; JSON responses also use `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. Disable body/Authorization logging in the owner's proxy/APM. HTTPS and protection against script injection in the hosting application remain required because page JavaScript can access an in-memory token.

## Routes

Reserved prefix: `/api/auth`. No query strings are accepted, even on config. Unknown auth routes return 404. JSON request objects must have **exactly** the specified keys, with no role/admin/client flags. POST requires `Content-Type: application/json` (optional `charset=utf-8`), no content encoding, and a JSON object. All timestamps are integer Unix epoch milliseconds; addresses are normalized lowercase 20-byte `0x` hex.

| Method/path | Request | Successful response (200) |
| --- | --- | --- |
| GET `/api/auth/config` | No body; public capability discovery | Enabled configuration described below, or `{version:1,enabled:false}` when not configured/unavailable |
| POST `/api/auth/nonce` | `{address, chainId}`; `chainId` is a JSON integer | Challenge described below |
| POST `/api/auth/verify` | `{nonce,address,chainId,message,signature}` | `{version:1,token,address,chainId,origin,world,uri,role:"visitor",expiresAt,profile}` |
| GET `/api/auth/session` | Bearer + origin; no body | Same session fields and current private profile, **without token** |
| POST `/api/auth/logout` | Bearer + origin, body `{}` | `{version:1,loggedOut:true}`; idempotently revokes that token, including if already expired/revoked |
| POST `/api/auth/logout` | Body `{nonce,cancellationSecret}`, origin, bearer optional | Same result; cancels a pending challenge or revokes a session already minted from it. Secret is random, separate from the signed/public nonce, and required to revoke by challenge. |

`config` when enabled: `{version:1,enabled:true,uri,domain,world,chains,nonceTtlMs,sessionTtlMs,transport:"memory-bearer",sessionsSurviveRestart:false}`. It is public metadata, never an authentication result. URI/domain/world/chains must be validated before signing. `world` binds a durable random service identity to a hash of the snapshot identity, additionally scoped to the configured URI. A separate deployment must have its own data directory/URI; do not copy private service identity into another installation.

`nonce` response adds `cancellationSecret`, another independent 32 random bytes encoded as lowercase hex; it is never included in the signed message. Keep it in memory and submit it only for pending/late challenge cancellation. The public nonce alone cannot revoke an established session. Nonce response otherwise contains `{version:1,address,domain,origin,uri,world,chainId,nonce,issuedAt,expiresAt,message}`. Every issuance is fresh.

```text
<domain> wants you to sign in to STRATOKS with your Ethereum account:
<normalized address>

Verify a private visitor account. This signature is free, sends no transaction, and grants no permissions over funds. It does not create resident memories.

URI: <canonical service URI>
Version: 1
Chain ID: <supported integer chain ID>
Nonce: <64 lowercase hex characters>
Issued At: <ISO 8601 timestamp>
Expiration Time: <ISO 8601 timestamp>
Origin: <exact permitted frontend origin>
World: <opaque world scope>
```

This is a custom versioned EIP-191 personal-sign message, not a claim of strict EIP-4361 parser compatibility. Sign the UTF-8 bytes of **the exact returned message** using `personal_sign`; no RPC chain reads, transfers, approvals, chain changes or transactions are involved. The chain is a signed authentication scope: frontend must check `eth_chainId` before signing and again before verify. The server checks it against both challenge and explicit configured supported chains. This server supports recoverable 65-byte EOA signatures only; no ERC-1271/smart-contract wallet verification.

## Verification and lifecycle

Verification consumes an existing nonce before checking the signature, even on wrong signer/address/message/chain or a different allowed origin. Invalid-origin HTTP requests are rejected before touching a nonce. Malformed objects rejected before verification do not consume it. The service compares the exact stored message and every supplied scope field and recovers the signer on the server. An expired/missing/used nonce cannot mint a session; use a fresh challenge after any failed verification. Session creation fails closed if the profile cannot be durably recorded or a capacity is reached.

Profiles are private `{address,firstVerifiedAt,lastVerifiedAt,visitCount}`. A visit means successful cryptographic verification, not connection, HTTP refresh, unique person, resident recognition or social memory. Lost responses can still count a verified visit. They are independent of world time. Updates use a same-directory exclusive temporary file, mode 0600, file fsync, atomic rename and directory fsync, in a mode 0700 private directory. No sessions/signatures/nonces are persisted. Sessions and pending challenges end on process restart. Profile history and service scope survive restart. No resident/entity/world schema is extended.

Client integration must clear auth immediately on `accountsChanged`, `chainChanged`, provider disconnect, backend/world changes and expiry. Send secret-protected cancellation (or token logout for completed sessions); discard all responses from earlier attempts/worlds. On timeout, decline or locked provider, release the busy UI and offer retry. A timed-out wallet prompt may remain open in the wallet; any later signature belongs to the cancelled nonce.

Explicit logout must receive `{version:1,loggedOut:true}` before displaying "Signed out on the server." Concurrent logout/retry calls share one in-flight revocation. If offline, clear local authentication immediately, retain pending revocation only in memory, and report that server logout needs retry. After tab close, offline revocation cannot be guaranteed; the old credential expires within its fixed TTL or on backend restart. Only session-check 401 with `invalid_session` / `session_expired_or_revoked`, or 403 with `session_scope_mismatch`, authoritatively invalidates a credential. An unrelated proxy 401/403 is not an invalid-session response. Network errors, timeout, 429, 5xx and malformed replies retain the credential and show unavailable/unverified; they never claim a fresh verification. The locally known fixed expiry still ends the session.

Reload/navigation forgets this tab’s in-memory credential and pending cancellation/revocation material; it does **not** confirm server logout. Sign out and wait for the server acknowledgment before reloading to end that server session. Otherwise it remains active until its fixed expiry (default one hour from verification) or server restart. The default per-address cap is three active sessions, including credentials abandoned by reload. A fourth valid signature can return `429 session_store_full`; it does not replace an older session. Sign out in another tab that still holds its credential, or wait for existing sessions to expire. If all credentials were forgotten, the HUD cannot revoke those sessions. `Retry-After` is a request cooldown, not a promise that session capacity will be available then. Keep the session cap and memory-only credential policy.

Automatic retry begins around one second with 0.75–1.25 jitter and exponential backoff, capped at 30 seconds including jitter. `Retry-After` accepts seconds or an HTTP date and is a minimum delay, with nonnegative jitter; long values are limited to a safe JavaScript timer range. Polling, focus, online and manual retry cannot bypass that server cooldown. A manual retry may bypass ordinary backoff. Success and invalidation cancel the old timer, and a refresh from an obsolete generation cannot clear or block a newer refresh. Configuration availability alone never re-verifies an existing session.

## Bounds, errors and OPTIONS

Default bounds: 120s nonce lifetime, 1h fixed session lifetime, 1000 pending nonces, 2000 sessions, 3 sessions/address, 500 sessions/origin, 10,000 private profiles, and 90-day inactivity retention. Expired inactive profiles are evicted atomically when capacity requires it; active records are retained, and admission is refused if all slots remain active. This retention is disclosed to owners; identity is not Sybil-proof. Auth concurrency is capped at 128 requests; POST bodies are limited to 8192 bytes and 5s. Startup refuses private stores over 8 MiB or invalid schemas/records and disables login while preserving anonymous viewing.

Per 60s fixed window: challenge/verify are limited to 60 requests per peer and 600 globally, with at most 1000 rate buckets; challenge creation additionally allows 10 starts per peer/window. Session polling uses the global ceiling but not the shared sign-in peer bucket. Forwarded headers are trusted only when the socket peer exactly matches `AUTH_TRUSTED_PROXIES`; Caddy must overwrite `X-Forwarded-For` with `{remote_host}` and the backend must remain private. Otherwise socket peer is used. See owner setup for routing.

Errors are JSON `{version:1,error:<code>}`. Representative statuses:

| Status | Codes/meaning |
| --- | --- |
| 400 | `invalid_body`, `invalid_json`, `invalid_address`, `unsupported_chain`, `invalid_nonce`, `auth_query_forbidden`, `unexpected_body` |
| 401 | `unknown_or_used_nonce`, `nonce_expired`, `address_mismatch`, `origin_mismatch`, `chain_mismatch`, `message_mismatch`, `invalid_signature`, `wrong_signer`, `invalid_session`, `session_expired_or_revoked` |
| 403 | `origin_required`, `origin_not_allowed`, `origin_mismatch`, `session_scope_mismatch`, `preflight_not_allowed` |
| 404/405 | Unknown route / method not allowed (Allow header) |
| 408/413/415 | `body_timeout` / `body_too_large` / `json_required` |
| 429 | `rate_limited`, `signup_rate_limited`, `rate_store_full`, `nonce_store_full`, `session_store_full`, `profile_store_full`; bounded `Retry-After` in seconds |
| 503 | `auth_unavailable`, `auth_busy`, `profile_store_unavailable` |

GC may remove an expired nonce first, yielding `unknown_or_used_nonce` instead of `nonce_expired`; both require a new challenge. Unknown internal errors return generic `auth_unavailable`, without paths, stack traces or credentials. A profile filesystem failure returns 503 and issues no token.

OPTIONS is allowed only on the five known auth routes with an allowed origin, the specific route method, and only `Authorization`, `Content-Type`, `X-Stratoks-Origin` requested headers. Returns 204. No `Access-Control-Allow-Credentials`; no wildcard allowlist. World OPTIONS and every non-GET/HEAD world method still return 405.

## Current HUD client contract

The wire contract remains v1. `web/src/expanse/VisitorWallet.tsx` uses `VisitorAuthClient` from `shared/visitor-auth-client.js`; its TypeScript API is declared in `shared/visitor-auth-client.d.ts`. It uses only `eth_requestAccounts`, `eth_accounts`, `eth_chainId` and `personal_sign`. The selected backend's base plus `/` is the expected canonical URI, even behind a prefixed reverse proxy. The HUD requires a compatible config before enabling sign-in and accepts nonce lifetimes up to 120 seconds. It never derives identity from the saved world URL or a supplied address.

In an isolated static preview, `baseUrl` and `uri` are explicitly null. The controller can connect/disconnect an injected provider, but every auth request fails locally before fetch and no sign-in action is rendered. There is no default hosting-origin auth endpoint or fabricated session.

The HUD configures a separate 60-second wallet-signature reading deadline; backend/connection operations remain bounded at 10 seconds. Other controller integrations can set `signatureTimeoutMs` explicitly; if omitted it follows `timeoutMs`. The server nonce expiry remains authoritative.

The controller validates exact challenge bytes and scope before prompting and re-reads wallet account/network before signing, before submitting verification and after the verification reply. The structured world scope is a bounded safe service identity plus `:` and a 64-character lowercase SHA-256 digest; it is not a UUID validation of the underlying world ID. Canonical URI/domain/origin checks reject control characters, including C1 controls and Unicode line separators. The exact issued message is reconstructed with `shared/visitor-challenge.js` and compared before `personal_sign`.

Every invalidation increments a generation; delayed responses cannot publish authentication into a later attempt or world. Each attempt captures its own nonce and unpredictable cancellation secret, including when its response arrives after a newer attempt. Pending/late cancellation always submits both fields; a public nonce alone is never a revocation credential. A changed capability world scope invalidates the previous session; session responses must match the existing session's scope and expiry and contain a valid profile. The HUD checks retained sessions every 30 seconds and on focus/online/visibility/dialog open, subject to deduplication and backoff. The polling interval is an observation cadence, not an expiry extension. Initial EIP-1193 account/chain announcements during connection are supported without treating them as authentication.

`AuthSnapshot.state === "checking"` means a session request is pending. A retained `session` in `"unavailable"` is unconfirmed, not proof of current authentication. The HUD reserves **Verified visitor** and **Verified on chain…** for `"verified"` after a validated session/verify response. It shows one explanation and one live region in the active account surface. Only the private controller retains bearer/cancellation credentials; the React snapshot strips the bearer. Static preview has a null backend and never requests a challenge or signature.

`onChange` exposes a private session (including token) to an integrator; the actual HUD removes the token before putting any session display data into React state. Do not export controller snapshots. Failed revocations remain queued in page memory, including retired world controllers with in-flight operations, and explicit logout displays success only for a server-confirmed result. Offline tab-close revocation is limited as described above. No session restores from browser storage.

With no local credential/pending revocation, client `logout()` reports **No active visitor session in this tab**, rather than claiming to have received a server acknowledgment. Only successful pending revocation requests produce **Signed out on the server**.
