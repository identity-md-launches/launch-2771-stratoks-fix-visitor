# Visitor authentication delivery findings

| Reported defect | Change | Regression evidence |
| --- | --- | --- |
| Refresh errors destroyed credentials | Temporary `unavailable` state, deduplicated refresh, bounded exponential retry with jitter; only explicit invalid-session responses end a session. The HUD now labels retained credentials unconfirmed. | `tests/expanse-auth-client.test.js`: “transient session-check errors retain credentials…” and `recovery:` cases; rendered evidence below. |
| Shared proxy IP exhausted by polling | Exact trusted socket peers may supply sanitized forwarded client IP; only nonce/verify consume per-peer bucket, with global ceiling retained. | `tests/expanse-auth.test.js`: “forwarded client addresses…” and “per-peer/global rates…”. |
| Durable profile/session capacity lockout | 90-day inactive profile retention and atomic eviction on admission; total/per-address/per-origin active-session bounds; per-peer signup cap. | Bounded profile/expiry case and existing atomic restart/profile persistence HTTP test. |
| Public nonce could revoke minted session | Separate random cancellation secret, hashed server side and required for pending or completed challenge cancellation; origin remains bound. | “cancel pending or completed challenge…” including wrong-origin and wrong-secret attempts; delayed verify race in client suite. |
| Copied-world identity assumed UUID | World remains an opaque structured service scope; client rejects controls and malformed fields, checks exact reconstructed issued message before wallet prompt. | Exact challenge validation and copied populated-world HTTP signature tests. |
| Docker umask and proxy routing | `COPY --chown=node --chmod=0755`, import test after switching to `node`; Caddy routes auth/world/health on 8788, serves static tree, overwrites forwarding header. | Dockerfile source review. ARM image runtime could not be exercised because Docker daemon socket access is denied (see SETUP). |

## Scope and outstanding evidence

The earlier server-scoped delivery left frontend integration and ARM execution outstanding. The current HUD follow-up now provides [the finding-to-fix matrix and browser evidence](../../artifacts/visitor-recovery/VALIDATION.md): recovery/cancellation integration, one auth live region, one unavailable explanation, 320/390px checks, real HTTP crypto, and a rebuilt static preview. An additional test creates 50 genuinely verified disposable signers through an explicitly trusted loopback proxy boundary, polls at virtual 30-second intervals, and signs in another visitor concurrently. It does not run Caddy itself.

All browser wallet providers are simulated EIP-1193/EIP-6963; actual extensions/devices remain untested. WebKit could not launch because host libraries are missing. Full Docker/ARM build/start remains unverified and is not claimed by the frontend checks. No production access/deployment occurred. Static preview client modules remain synchronized with `shared/`.
