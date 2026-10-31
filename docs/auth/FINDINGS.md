# Visitor authentication delivery findings

| Reported defect | Change | Regression evidence |
| --- | --- | --- |
| Refresh errors destroyed credentials | Temporary `unavailable` state, deduplicated refresh, bounded exponential retry with jitter; only 401/403 ends a session. | `tests/expanse-auth-client.test.js`: “transient session-check errors retain credentials…” and restart/session rejection case. |
| Shared proxy IP exhausted by polling | Exact trusted socket peers may supply sanitized forwarded client IP; only nonce/verify consume per-peer bucket, with global ceiling retained. | `tests/expanse-auth.test.js`: “forwarded client addresses…” and “per-peer/global rates…”. |
| Durable profile/session capacity lockout | 90-day inactive profile retention and atomic eviction on admission; total/per-address/per-origin active-session bounds; per-peer signup cap. | Bounded profile/expiry case and existing atomic restart/profile persistence HTTP test. |
| Public nonce could revoke minted session | Separate random cancellation secret, hashed server side and required for pending or completed challenge cancellation; origin remains bound. | “cancel pending or completed challenge…” including wrong-origin and wrong-secret attempts; delayed verify race in client suite. |
| Copied-world identity assumed UUID | World remains an opaque structured service scope; client rejects controls and malformed fields, checks exact reconstructed issued message before wallet prompt. | Exact challenge validation and copied populated-world HTTP signature tests. |
| Docker umask and proxy routing | `COPY --chown=node --chmod=0755`, import test after switching to `node`; Caddy routes auth/world/health on 8788, serves static tree, overwrites forwarding header. | Dockerfile source review. ARM image runtime could not be exercised because Docker daemon socket access is denied (see SETUP). |

## Scope and outstanding evidence

Focused backend/client HTTP crypto suites are the component evidence. Browser tests use simulated EIP-1193 providers; no actual extension/device claim is made. Full ARM build/start, browser viewport/browser login checks, and frontend UI copy/status changes are outside this assigned `server/shared/deploy/docs/tests` file scope or unavailable in this runtime. No production access or deployment occurred. Static preview client module is synchronized at `deploy/auth-demo/shared/visitor-auth-client.js`.
