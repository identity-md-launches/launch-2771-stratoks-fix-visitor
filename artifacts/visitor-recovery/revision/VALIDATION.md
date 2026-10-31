# Reload and session-cap copy revision

This revision corrects authentication claims and recovery instructions in the existing HUD. The complete updated static export is `dist/`; publication is assigned after submission. No production access or deployment occurred. These results are worker observations, not independent certification.

Baseline: supplied accepted tree at `5a187d95046a4b1f974c1123e8a989ce5197c9d4`, following the brief’s original base `4671102884260ac798821bd32bfad7f462aacf7f`. The revision commit is assigned at submission. `release.json` identifies delivered files by SHA-256. Existing source, lockfile, build configuration, simulation, auth controller, server admission policy, wallet discovery, runtime configuration and required assets are preserved.

## Reports, reproduction and decision

| Finding | Measured before | Change / decision | Source and test reference |
| --- | --- | --- | --- |
| `ed185c560feac44afba3cdc5250c4d0c1a753f42b573a98c0d3d8a454192cd82` | A real reload leaves a live server session. Its forgotten credential still returns HTTP 200. Three reload/sign-in cycles occupy three slots; a fourth real signature returns `429 session_store_full`. | Reproduction confirmed. False claims corrected. **Disputed:** requiring guaranteed unload revocation or session replacement in this frontend revision. The fixed-expiry, memory-only policy is retained and explicitly disclosed. The companion report requests this disclosure while preserving the bound. Automatic reload cleanup remains unimplemented. | `web/src/expanse/VisitorWallet.tsx:15`, `:116`, `:179`; `tests/browser/visitor-recovery.mjs:94`, `:120`; raw `before-browser/results.json`, `browser/results.json`. |
| `80c4b7af7108b0037ae4f687edc1cce3adfcc64c4457849c65e5602e3d68b44e` | Verified reason/privacy falsely say reload ends the session. Full account slots produce “Wait a minute and retry” despite one-hour expiry. | **Fixed:** both disclosure locations distinguish the tab credential from the server session. A dedicated `session_store_full` message gives the requested recovery. API/setup/README/DESIGN describe the same behavior. Setup no longer claims per-address admission evicts an older session. | Same HUD/test references; `docs/auth/API-v1.md:60`, `docs/auth/SETUP.md:40`, `:98`. Screenshots: `before-browser/reload-disclosure-390.jpg`, `before-browser/session-cap-390.jpg`, `browser/reload-disclosure-390.jpg`, `browser/session-cap-390.jpg`. |

The tests capture tokens only in private test memory and never write them or signer keys to evidence. They use actual document reloads and actual cryptographic verification. Both new regressions first failed on the unchanged inherited export, specifically on its false text; after the copy correction both pass. The cap test also advances only the disposable backend clock to collect expired sessions, restores issuance to browser time, then completes another real sign-in and acknowledged logout. No one-hour wall-clock wait was performed. The browser harness increases only abuse-request quotas for its many scenarios; the per-address cap of three and one-hour session TTL stay at shipped defaults. Shipped proxy/polling defaults are separately exercised by the existing HTTP suite.

## Actual checks

| Check | Result | Raw evidence |
| --- | --- | --- |
| Two new regressions against inherited export | 0 passed / 2 failed, expected text assertions | `before-browser.txt`, `before-browser/results.json` |
| Full backend/controller/crypto/simulation suite | 248 passed / 0 failed, exit 0 | `backend.tap` |
| Existing frontend unit suite | 34 passed / 0 failed, exit 0 | `frontend.tap` |
| Expanse frontend unit suite | 17 passed / 0 failed, exit 0 | `expanse-frontend.tap` |
| TypeScript | Exit 0 | `typecheck.txt` |
| Production Vite build | Exit 0; relative asset URLs and complete assets | `build.txt`, `release.json` |
| Current-HUD recovery browser runner | 16 passed / 0 failed, no page/unexpected HTTP errors | `browser.txt`, `browser/results.json` |
| Existing current-HUD auth runner | 19 scenarios passed, no page errors | `existing-hud-browser.txt`, `existing-browser.json` |
| Pinned taste@1 | 16/16 checks passed at 320/390/1440 | `taste-stdout.json`, `taste.json` |
| Browser-tool static-preview inspection | 390x844, Connect dialog/Escape/focus return; width = scrollWidth = 390; local font loaded; 13 successful local requests, zero console messages | `manual-browser.json`; production export also exercised by the automated runners |

The full backend run includes real HTTP wrong-signer/origin/nonce/cancellation tests, 50 distinct verified signers behind a trusted proxy polling at 0/30/60 virtual seconds plus a concurrent sign-in, expiry/capacity/restart tests, copied populated-world migration/auth/restart, and exact demo restart behavior retaining brains, goals, trust, families and terrain. These are disposable repository worlds, not owner production data. Auth/controller source was not modified in this revision.

The browser runners cover EIP-6963 provider choice and legacy fallback, connect versus sign-in, login/logout acknowledgment, retained credentials through 429/503/offline/timeout, no false fresh verification, no logout caused by temporary polling failure, cancellation after verification, account/network/provider/world races, unavailable retry, a single auth live region, anonymous/static viewing, camera, inspector, keyboard Escape/focus return, and 320/390/768/1440 widths. The current static demo stays labeled; no signature or auth request is made in static mode. See scenario names and measurements in the JSON reports.

Commands run from the repository root:

```sh
node web/scripts/task.mjs install
node web/scripts/task.mjs build
node web/scripts/task.mjs typecheck
node web/scripts/task.mjs test
node --test --test-concurrency=2 tests/*.test.js
# Expanse tests via the externally staged tsx binary:
"$FRONTEND_STAGE/node_modules/.bin/tsx" --test "$FRONTEND_STAGE"/src/expanse/*.test.ts
# PLAYWRIGHT_MODULE was a temporary adapter to the installed Playwright module.
node tests/browser/visitor-recovery.mjs "$PLAYWRIGHT_MODULE" artifacts/visitor-recovery/revision/before-browser test/scratch/reload-baseline/dist '^reload'
node tests/browser/visitor-recovery.mjs "$PLAYWRIGHT_MODULE" artifacts/visitor-recovery/revision/browser
node tests/browser/expanse-hud-auth.mjs "$PLAYWRIGHT_MODULE" test/scratch/revision-existing-browser
IMD_PLAYWRIGHT="$PLAYWRIGHT_MODULE" node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste --offline
```

The temporary adapter imports the dependency installed by `task.mjs`, exports its browser types, and overrides only Chromium’s `launch` to pass `executablePath` for the downloaded full Chrome binary. The optional headless-shell download hit disk quota (`write`, errno -122); full Chromium was already complete and all Chromium checks ran with it. Browser binaries, dependencies and adapter are outside the submitted source/export. On a normal Playwright installation pass its `index.mjs` directly. WebKit downloaded to external storage but could not launch: required host GTK/GStreamer and other shared libraries are absent. Its failure is recorded in the browser reports; Safari is not counted as passing. The build’s existing `node:fs` externalization notice is retained in the raw log; build and all local resource checks passed.

## Better Interface review

Visual idea preserved: a painted living world with moss controls and one gold primary action. This is a copy revision, with no layout or style redesign. The pinned workflow, all six domains, wallet reference and document-web-design guidance were read. Existing design attribution/licenses remain intact.

| Domain | Coverage and correction | Limits |
| --- | --- | --- |
| Accessibility | Checked dialog semantics, named controls, keyboard open/Escape/focus return, single auth live region and status text. Existing 320px verified-state checks pass. | No screen-reader speech test, physical device or native 200% zoom certification. |
| Layout | Checked anonymous scene and wallet surfaces at 320/390/768/1440. Long corrected copy wraps in the existing independently scrolling dialog; Sign out remains accessible. No horizontal overflow. Screenshot inspection confirms product and Connect on first screen at 390. | No new RTL/localization test. |
| Writing | Two confirmed medium findings at `VisitorWallet.tsx:15`, `:116`, `:179`: false session-ending claim and false one-minute recovery. Fixed and rechecked against actual server behavior. One unavailable explanation remains. | Automatic unload logout/session replacement is not provided. |
| Typography | Existing local Manrope body/data and Georgia dialog title, existing sizes/weights and wrapping preserved. Font loads; probe type checks pass. Full addresses remain selectable and wrap. | No new font/platform fallback coverage. |
| Colors | Existing tokens preserved. Browser-measured modal pairs: gold 7.53:1, secondary 7.31:1, primary/reason 11.01:1 against `#28362d` (`existing-browser.json`). | Probe skips 18 text boxes over canvas/images/gradients; no universal contrast claim. |
| UI | Existing loading/error/connected/verified/unconfirmed/expired/cancel/retry/logout states exercised by browser suites; current world, camera/inspector/mobile controls retained. Native privacy disclosure tested open. Motion probe passes with reduced motion. | No motion slow-play inspection, actual extensions or mobile wallet devices. |

The preserved design system and revised session-copy rules are documented in root `DESIGN.md` after the final source change. The probe also reports 12 compact controls under its comfortable 44px size; all pass the measured 24px/spacing baseline. No additional actionable first-screen/layout finding was observed in this copy revision.

## Remaining limitations and delivery

- Reload/navigation still forgets the tab credential without guaranteed server revocation. Abandoned sessions count until fixed expiry (default one hour) or server restart; if no tab retains a credential, the HUD cannot sign them out. No unload handler or replacement policy is claimed. This is the disputed part of the first advisory, not a failed reproduction.
- Providers are simulated EIP-6963/EIP-1193 objects with real randomly generated EOA signatures. Actual wallet extensions, phones and smart contract wallets are untested/unsupported as already disclosed. No transactions or chain RPC are involved.
- WebKit/Safari, physical devices, screen-reader speech and native zoom remain unverified. Caddy, Docker/ARM startup and production were not run in this frontend-only revision; earlier backend/deployment evidence is not upgraded to new coverage.
- The static preview has no auth backend. The owner-run isolated HUD server supplies the real HTTP backend for sign-in tests. No live URL or production rollout is claimed; installation/preview/build instructions remain in README, and owner backup/rollback instructions remain in `docs/auth/SETUP.md`.
- Evidence remains under the existing `artifacts/visitor-recovery/**` 2 MiB budget; the final bundle audit in `release.json` checks the 8 MiB submission bound, protected paths, export asset completeness and unchanged world/controller files. No ignore file, dependency manifest, lockfile, build configuration, submodule or Git metadata was changed.
