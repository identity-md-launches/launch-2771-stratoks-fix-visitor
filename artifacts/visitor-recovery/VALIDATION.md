# Visitor session recovery in the current HUD

Complete for the bounded frontend assignment, subject to the explicit coverage limits below. This is worker-run evidence, not independent certification or permission to deploy. No production service, owner wallet, production data or external RPC was accessed. The delivery is the updated source and complete `dist/` static export; the publisher assigns the hosted preview after submission.

## Scope and provenance

The brief pins `4671102884260ac798821bd32bfad7f462aacf7f`. The supplied working tree already includes accepted backend work at `e07ad89`; that inherited commit is the before baseline. This follow-up integrates its session recovery/cancellation into `VisitorWallet`, repairs remaining shared-controller races, and preserves the Expanse rendering, wallet selection, inspector, camera, mobile controls and walletless demo. No simulation implementation, schema, terrain, resident state, live configuration, dependency manifest, lockfile or build configuration was changed. No Git metadata was written; the submission commit is assigned after handoff. `release.json` identifies the baseline and hashes the delivered source/export.

The existing moss/gold HUD and local typography remain authoritative. No wallet SDK or Smart Wallet flow was added: the server verifies EOA signatures only. The pinned wallet guide was read; adding an unsupported connector would misrepresent compatibility. Provider discovery remains EIP-6963 with explicit choice and a legacy fallback. The phone guidance still points to the wallet's own injected browser.

## Actual results

| Check | Observed result | Raw evidence |
| --- | --- | --- |
| Inherited auth-controller suite | 19 passed before changes | `inherited-client.tap` |
| Eight new controller regressions on inherited source | 0 passed / 8 failed, expected | `before-client.tap` |
| Four new rendered regressions on inherited `dist/` | 0 passed / 4 failed, expected | `before-browser.txt`, `before-browser/results.json` |
| Complete Node backend/controller/simulation suite | 247 passed / 0 failed | `backend.tap` |
| Focused final shared-controller suite | 29 passed / 0 failed | `after-client.tap` (also included in the complete suite) |
| Existing frontend unit suite | 34 passed / 0 failed | `frontend.tap` |
| Expanse frontend unit suite | 17 passed / 0 failed (51 frontend cases total) | `expanse-frontend.tap` |
| TypeScript | Exit 0 | `typecheck.txt` |
| Production Vite build | Exit 0; complete relative-URL export | `build.txt`, `dist/index.html` |
| Existing actual-HUD Chromium runner | 19 scenarios passed, zero page errors | `existing-hud-browser.txt`, `existing-browser/browser.json` |
| New actual-HUD recovery runner | 14 scenarios passed, zero page/unexpected HTTP errors | `browser.txt`, `browser/results.json` |
| Existing standalone API-demo consumer | 9 scenarios passed, including its new checking/unconfirmed labels | `standalone.txt`, `standalone/browser.json` |
| Inspector scroll/focus regression | 5/5 viewports passed | `inspector.txt`, `inspector/inspector-scroll.json` |
| Pinned taste@1 probe, final export | 16/16 checks passed | `taste.json`, `taste-stdout.json` |
| Structural/size/asset audit | Relative local assets present; no forbidden changes or dependency/cache additions; within 8 MiB | `release.json` |

The initial browser runs exposed harness errors: the inherited runner exhausted the newly introduced per-peer signup quota, and incorrect Playwright route cleanup left interceptions active. The runner now raises **only its isolated sign-in scenario quotas** and waits for held replies to be delivered before removing their handlers. The actual 50-signer HTTP test uses shipped abuse defaults and explicitly trusted loopback forwarding. Browser checks do not assert that a raised harness quota proves production capacity. One copy consolidation initially hid the unsupported-chain hint; its existing browser assertion caught it, and the final UI again names the supported chain.

## Finding-to-fix matrix

All "before" references below mean inherited commit `e07ad89`, following the brief's pinned base. "Delivered" means the source in this submission, with file hashes in `release.json`; no unpublished commit ID is invented.

| Finding / impact | Delivered fix and source | Regression and before/after evidence |
| --- | --- | --- |
| High: a failed capability refresh destroyed an established credential | `shared/visitor-auth-client.js:124`: retain session and previous compatible capabilities, enter unconfirmed state, schedule a session check. Config success alone cannot verify. | `tests/expanse-auth-client.test.js:271`; failed before, passed after. |
| High: arbitrary proxy 401 expired a valid session; 403 scope invalidation was missed | `shared/visitor-auth-client.js:208`: only explicit API invalid-session codes clear auth; generic 401/403, 429/5xx, offline, timeout and malformed replies remain unconfirmed. | `tests/expanse-auth-client.test.js:283`; failed before, passed after. Existing restart/expiry tests remain passing. |
| High: stale refresh/timer work blocked or reset later attempts | `shared/visitor-auth-client.js:99`, `:208`: one refresh job per generation, identity-checked cleanup, cancel retry on success/invalidation. Auto/focus/poll share cooldown. | `tests/expanse-auth-client.test.js:300`, `:330`; both failed before, passed after. `:392` adds virtual-clock bounded retry/recovery/logout coverage. |
| Medium: Retry-After values above 60 seconds were truncated and could be bypassed | `shared/visitor-auth-client.js:71`, `:102`: seconds/date minimum delay, nonnegative jitter, capped normal backoff, manual override only outside server cooldown. | `tests/expanse-auth-client.test.js:315`; failed before, passed after. Browser 429 and explicit-logout cases pass. |
| High: an obsolete nonce reply overwrote the next attempt's cancellation secret | `shared/visitor-auth-client.js:167`: capture nonce/secret inside each attempt; stale replies cannot mutate the current secret. | `tests/expanse-auth-client.test.js:352`; failed before, passed after. Existing account/chain/signature races still pass. |
| High: late verify cancellation queued an invalid nonce-only logout and blocked retry | `shared/visitor-auth-client.js:167`: every challenge cancellation sends its own nonce and secret, including late verification. | `tests/expanse-auth-client.test.js:373`; failed before, passed after. Browser "cancel after verification was minted" fails on inherited export, passes after; subsequent real login succeeds. |
| Medium: duplicate logout requests and unvalidated success could falsely acknowledge sign-out | `shared/visitor-auth-client.js:83`: deduplicate by cancellation material or token, share the in-flight request, require versioned logged-out acknowledgement. | `tests/expanse-auth-client.test.js:382`; failed before, passed after. Existing offline logout/retry and delayed acknowledgement cases pass. |
| High: HUD called a retained, unconfirmed credential "Verified on chain" | `web/src/expanse/VisitorWallet.tsx:112`: checking/unconfirmed labels, last-confirmed profile wording, retry action and persistent sign-out. | `tests/browser/visitor-recovery.mjs`: 429/503/offline/real 10-second timeout retain the server session, issue no logout, show no fresh Verified claim, recover without a second signature. Four inherited-export checks include this 429 defect. |
| Medium: three auth live regions and two unavailable explanations | `web/src/expanse/VisitorWallet.tsx:135`: exactly one region in the active account surface; status and one reason grouped by `.exp-visitor-feedback` (`visitor-wallet.css:6`). The background announcer is absent while modal content is active. | First two recovery browser checks: inherited export has 3 regions / 2 explanations; delivered export has 1 / 1. Keyboard modal focus/Escape checks pass. No screen-reader speech claim. |
| Medium: UUID assumption and insufficient field-safety checks | `shared/visitor-auth-client.js:7`, `:36`: bounded structured service scope plus digest, canonical service URI/origin, C0/C1 and Unicode newline rejection; exact message reconstruction before prompt. | `tests/expanse-auth-client.test.js:421` supplements existing tampering cases. Real HTTP copied-world/restart test remains passing. This supplemental case was added after the fixes; no failing-before claim. |
| Inherited proxy fix needed genuine capacity evidence | Backend implementation retained from `e07ad89`; `tests/expanse-auth.test.js:166` adds 50 real, distinct disposable signers, trusted-loopback forwarded addresses, 0/30/60-second virtual polling and concurrent 51st login. | All requests pass under shipped abuse defaults; 51 sessions remain active. Earlier seeded-session unit test is not presented as cryptographic proof. Caddy itself was not run. |

The complete suite also checks exact full world equality across auth with ticks stopped, a copied populated schema-4 world's identity/population through migration/save/restart, and the existing demo's exact restart/brains/goals/trust/families/terrain checks. Those are disposable repository fixtures, not a copy of the owner's current production world. No simulation behavior changes are proposed here.

The standalone API demo also consumes the shared controller. Its `demo.js:7` render map now understands `checking`, uses last-confirmed visit wording for retained credentials, and does not call an unconfirmed session "Already verified". Its separate browser runner checks recovery; this is compatibility coverage, not a replacement for the current-HUD tests. Absolute checkout/tool staging paths in text logs are normalized to avoid embedding workspace identifiers; test diagnostics, counts and outcomes are unchanged.

## Better Interface review: six domains

The visual idea remains a painted living world with compact moss controls and one gold primary action. The reviewed surfaces are the first screen, wallet chooser, connected/unverified, signing, checking, unconfirmed/retry, verified, expired, unavailable, offline revocation and modal disclosures. Reviewed source is the existing HUD plus the small auth integration changes. No broader redesign was needed.

| Domain | Coverage, findings and recheck | Limits |
| --- | --- | --- |
| Accessibility | Checked native buttons/dialog, accessible labels, one active polite status region, disabled reasons, keyboard open/Escape/focus return, header target geometry. Fixed duplicate regions at `VisitorWallet.tsx:135`. Rendered status count and existing keyboard checks pass. | No NVDA/VoiceOver/JAWS or physical assistive technology session; a DOM/Playwright observation does not establish spoken output. Forced-colors and browser-native zoom untested. |
| Layout | Checked 320×568, 390×844, 768×844 and 1440×844 auth/world; existing HUD checks also use 1440×900. Inspector checks cover 667×375 and 844×390 landscape. Scene, Find residents and Connect appear in the first 390px screen. No measured horizontal overflow; full wrapping addresses, scrollable dialog and preserved selection. | Viewports emulate phones; physical safe areas, native 200% zoom and RTL mirror untested. No locale variants added. |
| Writing | Checked all auth actions/states. Fixed misleading fresh-verification copy at `VisitorWallet.tsx:112`, repeated unavailable paragraphs and a briefly obscured unsupported-chain hint. Retention is disclosed; connect and sign-in remain separate. | Actual-wallet wording/error behavior may differ from simulated providers. |
| Typography | Existing local Manrope and Georgia; existing 12/14/16/20/24/32px scale reused, no new sizes/families/weights. Full address wraps; profile numerals remain tabular. Browser font readiness recorded. | Canvas typography and all possible provider names not exhaustively measured. |
| Colors | Existing tokens retained. Actual modal pairs against `#28362d`: gold `#e8c36e` **7.53:1**, secondary `#bdc8b6` **7.31:1**, primary `#f5efd9` **11.01:1**. Raw computed pairs in `existing-browser/browser.json`. | Probe leaves 18 first-screen text boxes over image/canvas/gradient backgrounds unmeasured. These ratios apply only to the identified opaque modal pairs. No new theme. |
| UI | Existing icons, surfaces, provider rows, native disclosure and primary button reused. New feedback spacing is 12px within the existing 16px account grid; no new animation. Verified/unconfirmed/checking/retry states have text cues. Reduced-motion probe passes. | No animation-panel slow-motion inspection or real touch hardware. The existing compact HUD has 12 controls below the preferred 44px comfort size; the probe finds all 17 controls satisfy the 24px-or-spacing baseline. |

Source values and component contracts are recorded in root `DESIGN.md`. Attribution and licenses remain at `docs/design/better-interface-LICENSE.txt`. The probe's 16 passes cover the first screen, not every dialog or full accessibility compliance; targeted browser checks supply the auth-state coverage.

## Reproduce

Use the unchanged frontend manifest/lockfile. These commands stage dependencies/caches outside the repository and must run sequentially:

```sh
node web/scripts/task.mjs install
node web/scripts/task.mjs typecheck
node web/scripts/task.mjs test
node web/scripts/task.mjs build
node --test --test-concurrency=2 tests/*.test.js
node --test tests/expanse-auth-client.test.js
# The existing npm test glob excludes nested Expanse tests; run them too:
visitor_frontend_stage="$(node web/scripts/task.mjs path)"
(cd "$visitor_frontend_stage" && node node_modules/tsx/dist/cli.mjs --test src/expanse/*.test.ts)
```

Browser commands (replace the temporary browser directory as needed):

```sh
visitor_frontend_stage="$(node web/scripts/task.mjs path)"
export PLAYWRIGHT_BROWSERS_PATH=/tmp/stratoks-visitor-browsers
node "$visitor_frontend_stage/node_modules/playwright/cli.js" install chromium webkit
node tests/browser/expanse-hud-auth.mjs "$visitor_frontend_stage/node_modules/playwright/index.mjs" "$PWD/artifacts/visitor-recovery/existing-browser"
node tests/browser/visitor-recovery.mjs "$visitor_frontend_stage/node_modules/playwright/index.mjs" artifacts/visitor-recovery/browser
node tests/browser/expanse-auth.mjs "$visitor_frontend_stage/node_modules/playwright/index.mjs" - "$PWD/artifacts/visitor-recovery/standalone"
node web/scripts/check-inspector-scroll.mjs artifacts/visitor-recovery/inspector
IMD_PLAYWRIGHT="$visitor_frontend_stage/node_modules/playwright/index.mjs" node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste --offline
```

The pinned probe is an input and is removed after submission; `taste.json` retains its actual output. The browser scripts start/stop their own local preview and disposable backend within one foreground run, serve `dist/` at `/preview/`, and use no owner credentials. The browser before run used `git archive e07ad89 dist` extracted outside the repository, then the recovery runner's optional baseline-directory argument and pattern `one auth|unavailable backend|429 refresh|cancel after`; its nonzero exit is expected. Eight newly added `recovery:` controller cases were run before modifying shared source. Long backoff/polling checks advance virtual clocks instead of waiting in real time.

## Unresolved and unperformed

- **Docker/ARM build and native/emulated startup remain unverified.** Existing owner deployment, private volume, Caddy 8788 routing, backup and rollback guidance is in `docs/auth/SETUP.md`; this frontend follow-up does not certify that broader deployment requirement. Do not infer it from a test pass or task status.
- **WebKit/Safari execution is unavailable:** actual launch attempts report missing host shared libraries. The supplied browser MCP also could not initialize because `/opt/google/chrome/chrome` was absent. Browser evidence here is local Playwright Chromium, not that unavailable tool. Narrow/mobile viewports are emulated.
- **No actual extensions, physical phones, hardware wallets or screen-reader sessions.** Providers explicitly identify themselves as simulated. EOA login only; ERC-1271/Coinbase Smart Wallet/WalletConnect are unsupported and are not advertised as working.
- **No production cutover, deployed Caddy smoke test or current owner-world rehearsal.** Copied-world and restart evidence uses the committed fixtures. Existing owner configuration is preserved. The static preview requires an owner backend and exact origin/URI configuration for real authentication; otherwise it stays a labeled isolated demo.
- Backend retention/admission implementation is inherited. Its existing small-limit/expiry/restart tests and the new 50-signer polling test ran; this frontend follow-up does not establish a comprehensive repeated-signer/per-origin saturation or large disposable-profile admission campaign.
- Offline revocation cannot be guaranteed after tab close. It remains in memory for retry, with fixed expiry/restart as fallback. Visitor retention is bounded, not Sybil-proof; world/resident memory is independent.
- Vite reports the existing `node:fs` externalization from `server/src/config.js`; build/typecheck and rendered checks pass. No dependency or build-configuration changes were made to suppress it. Canvas/image contrast, physical safe areas, forced colors, RTL and native zoom remain unverified as detailed above.

The static export, source, lockfile and setup documentation are included. No package archive, dependency tree, cache, submodule, source map or private backend state is added. Historical evidence under other artifact directories is not relabeled as this run's evidence.
