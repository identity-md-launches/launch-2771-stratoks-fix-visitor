# Validation and remaining integration work

This file records the earlier backend delivery. **Current HUD recovery results are in [visitor-recovery/VALIDATION.md](../../artifacts/visitor-recovery/VALIDATION.md)**, including before/after regressions, the rebuilt export and remaining ARM/browser limits. Counts below are historical, not the current release totals.

No production connection/deployment, RPC call, owner wallet, asset operation, chain transaction or contract deployment was performed. All verification tests use disposable test signers. No runtime dependency was installed; the backend and delivered preview/client modules run on built-in Node/browser APIs. Tests need no network.

| Check | Result | Evidence |
| --- | --- | --- |
| Existing complete backend suite, including new HTTP/controller auth tests available at that run | **224 passed**, 0 failed | [`all-backend.tap`](../../tests/results/auth/all-backend.tap) |
| Final focused auth suite, including two additional late-nonce/static-byte checks | **20 passed**, 0 failed | [`focused.tap`](../../tests/results/auth/focused.tap) |
| Independent ethers-generated EIP-191 recovery vectors | Passed within complete backend suite | Existing `wallet-crosscheck.test.js`, raw complete-suite log |
| Existing client tests | **34 passed**, 0 failed | [`existing-client-tests.log`](../../tests/results/auth/existing-client-tests.log) |
| Existing client TypeScript check | Exit 0, no diagnostics | [`existing-client-typecheck.log`](../../tests/results/auth/existing-client-typecheck.log), [`checks.json`](../../tests/results/auth/checks.json) |
| Existing client production Vite build | Exit 0, with warnings below | [`existing-client-build.log`](../../tests/results/auth/existing-client-build.log) |
| Actual browser + actual Expanse HTTP service, simulated injected desktop/mobile providers | **8 scenarios passed**, zero page errors | [`browser.json`](../../tests/results/auth/browser.json), [`browser.log`](../../tests/results/auth/browser.log) |
| Copied populated schema-4 snapshot migration + restart with verified profile | Passed, identical `identityDigest`, population/tick preserved | Focused test and complete-suite logs |
| Docker-copy module import closure under Node | Passed locally | [`module-smoke.log`](../../tests/results/auth/module-smoke.log) |
| Docker image build/start, ARM execution | **Not run: Docker runtime unavailable** | Owner-run [`check-auth-image.sh`](../../deploy/expanse/check-auth-image.sh) is supplied, not a passing result |
| Actual MetaMask/Rabby extensions, physical mobile devices/hardware wallets | **Not tested** | Simulated providers do not establish device compatibility |

## Reproduce component tests

From repository root with Node >=22, offline:

```sh
node --test tests/expanse-auth.test.js tests/expanse-auth-client.test.js
node --test --test-concurrency=2 tests/*.test.js
```

The focused tests exercise actual HTTP routing/body parsing/CORS/origin protection and the actual cryptographic verifier; they do not stub verification to accept any supplied address. Coverage includes wrong signer/address/origin/chain/message, malformed signatures/JSON/objects, message tampering before wallet prompt, unsupported chains, nonce single-use/expiry, fixed session expiry, origin mismatch, logout/replay, cancellation before/after verify, late nonce and late verify responses, account switches mid-signature, silent provider changes, chain switches, provider disconnect, locked/rejected/timed-out wallet/retry, backend timeout/offline revocation/restart, damaged/private-store write failure, all store capacities, rate-key/global/per-peer bounds, body size/deadline, exact restricted preflights and unchanged anonymous reads/write rejection.

Copied-world test copies `tests/fixtures/expanse-v4/` into a disposable directory, verifies identity/population before/after login and restart, checks the existing migration archive exists, and preserves private visit count separately. The earlier full test suite includes legacy migration, brains, memories, histories, plans, trust, families and terrain restart checks too. Authentication never calls `step()`, reset, migration or any resident mutation. A separate test proves login/logout leaves the entire in-memory world state exactly equal when no timer tick occurs.

The final shared client change additionally prevents a second sign-in while already verified; focused tests cover repeated simultaneous sign-in calls and server logout/retry. The full simulation suite was not repeated after that isolated frontend guard and the two additional test cases; its raw run includes 224 tests, while the final focused run has 20 tests.

## Browser and existing client tooling

Browser runner (requires separately supplied Playwright and Chromium test infrastructure):

```sh
node tests/browser/expanse-auth.mjs /path/to/playwright/index.mjs /path/to/chromium
```

It starts a temporary isolated world and injects explicitly labelled **simulated** MetaMask/Rabby-compatible EIP-1193 providers discovered via EIP-6963. Signing is backed by a disposable randomly generated signer and the real HTTP verifier; no private key is placed in the demo source or any fixture. It tests multiple wallet choice, explicit sign-in, server-verified logout, signature rejection/retry, chain changes, account switch mid-signature, absent mobile provider guidance, simulated injected mobile flow, and static-hosting inactivity. It captures desktop/mobile screenshots, asserts no forbidden transaction RPC calls and zero page errors, and cleans up the disposable backend. The static-preview check makes no `/api/` requests at all.

Existing frontend checks ran against an isolated copy of unchanged `web/`, using already available external test tooling rather than modifying/installing repository dependencies: TypeScript 5.9.3, Vite 8.3.5 and Playwright 1.64.1/Chromium headless. The existing TypeScript tests were transpiled using TypeScript 5.9.3 through a scratch-only Node loader that resolves extensionless TS imports and JSON modules (equivalent needed import support to the repository's `tsx` test command). This was **not** a canonical `npm ci && npm test` run: no new frontend package installation or lockfile change was made. Frontend build output stayed in scratch storage, outside the deliverable; the delivered static preview is the dependency-free `deploy/auth-demo/` page, not a rebuilt current HUD.

Vite reported the existing CSS reference to `@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2` could not resolve in that available toolchain and remains a runtime URL; it also reported Node `fs` externalization from the existing imported config. Build exited 0. The font resolution needs confirmation with the owner's locked, complete frontend installation; no font or web source was changed here. The build log normalizes repository paths to `<repo>`; TAP/browser logs are unmodified successful outputs. Typecheck log is empty because it succeeded without diagnostics.

## Remaining work and limits

- **Current Expanse HUD integration is outstanding.** `web/` is outside this bounded assignment's editable scope. The backend is implemented in the actual service, and the shared controller plus isolated browser reference are delivered. The current HUD is unchanged and does not gain a connect button from this component alone. Do not claim a completed live frontend rollout.
- Owner must configure canonical HTTPS URI, exact preview origin allowlist, permitted chains, private data permissions, existing reverse proxy routing, and operational backup/retention. Auth stays disabled when unset. Same-origin live client settings are not rewritten.
- ARM Docker image startup has not been proven on this machine. Run the delivered check on suitable Docker/ARM infrastructure before rollout. The original `shared/` COPY fix remains present, and build-time import checks now include auth.
- Real extensions/devices are untested. Smart-contract wallets, WalletConnect, gas/transaction actions, payments, admin/reset and creature/social recognition are intentionally outside this visitor-only API.
- In-memory bearer credentials cannot be reliably revoked by a tab that closes while offline. UI must distinguish local clearance from server-confirmed logout; fixed TTL and process restart bound credential lifetime. In-flight cancellation with nonce and context generation protects against late authentication responses.
- The peer rate limiter deliberately ignores forwarding headers; visitors behind a proxy share its 60/min allowance. Tune audited ingress/programmatic limits for expected traffic. Atomic profile writes are synchronous and bounded; high login traffic needs performance assessment before raising limits. No multi-process shared session/store support is claimed; use one writer per world/data directory.

Screenshots: [desktop wallet selection](screenshots/desktop-wallet-choice.png), [verified desktop](screenshots/desktop-verified.png), [mobile without wallet](screenshots/mobile-no-wallet.png), [simulated verified mobile](screenshots/mobile-verified.png), [static preview without backend](screenshots/static-preview.png). These show the isolated demo/reference, not an altered live HUD.
