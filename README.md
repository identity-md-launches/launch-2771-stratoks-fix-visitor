# STRATOKS · A world taking root

A full-screen isometric observer for the persistent 280×280 Expanse. Golden, leaf-crowned Stratoks explore, gather, fish, carry finite inventories, use shared stores, construct/repair biome-specific shelters, rest, form families, age and die in the existing learning engine. The original settlement coordinate system, owner world identity and saved-data migration tools are retained. This contribution integrates the preceding agency engine (schema 5), living-world art and supplementary terrain/activity art; it does not deploy or reset the live VPS.

The review **opens a real isolated browser demo**. It upgrades a copy of the existing seed-2 tick-12,000 checkpoint and runs 600 ordinary engine ticks before export. It resumes with 166 residents, 73 standing shelters, five crops, and retained goals/signaling evidence. The exact original checkpoint remains alongside it for rollback; no jobs, supplies, residents or scene events are injected. The owner capture remains **Recorded preview**. Owner/live mode reports only the server's actual fields: an older live backend does not acquire new mechanisms from a frontend update.

The eight-finding resolution table, actual test results, raw evidence, screenshots, phone recording and six-domain review are in [current validation](artifacts/agency-interface/VALIDATION.md). [Integration](docs/agency/INTEGRATION.md) explains terrain geometry, animation gates and the compact runtime art. No production access or deployment occurred.

The current HUD offers **Connect wallet**, explicit message sign-in and server-confirmed sign-out through the Expanse visitor API. Connection alone never authenticates you. Temporary session-check failures now retain the credential while showing **Session unconfirmed**, retry automatically, and keep sign-out available. Accounts are optional, private visitor records; they give no simulation controls, resident recognition or social memories. The [session recovery validation](artifacts/visitor-recovery/VALIDATION.md) contains this revision's results, screenshots, finding-to-fix matrix and limits. [API v1](docs/auth/API-v1.md) and [owner setup/rollback](docs/auth/SETUP.md) describe the real backend and exact origin configuration.

Reload forgets this tab’s credential; the server session can remain active until expiry (default one hour) or server restart. **Sign out** and wait for acknowledgment before reloading to end it. At the active-session limit, sign out in another signed-in tab or wait for existing sessions to expire. A one-minute retry does not free those slots. The [reload-copy revision](artifacts/visitor-recovery/revision/VALIDATION.md) reproduces both reports and records the corrected HUD/docs, unchanged server policy, and current results: **248 backend tests, 51 frontend tests, 35 HUD browser scenarios, typecheck/build and 16/16 design checks passed**. Browser wallets were simulated with real disposable signatures; Safari and actual wallets/devices remain unverified.

For an isolated local demonstration of the **actual built HUD** plus real server verification:

```sh
# Build first with the existing commands below, then from the repository root:
node deploy/auth-demo/hud.mjs
```

Open `http://127.0.0.1:8791/preview/` in an injected EVM wallet browser. This server creates and deletes its own disposable world; it never mounts production data. Choose a wallet, connect, then explicitly sign the free message. No gas, approvals, transactions or funds are involved. Only simulated providers have been tested; actual MetaMask/Rabby extensions and mobile devices remain untested. The verifier accepts EOA signatures, not smart contract accounts. Static hosting alone installs no backend and cannot authenticate visitors.

Current recovery checks: **247 Node tests (including 29 auth-controller cases), 51 frontend tests (34 existing + 17 Expanse), 33 actual-HUD Chromium scenarios, five inspector viewports and the 16/16 design probe passed**, along with production build and typecheck. Eight new controller regressions and four rendered regressions were first observed failing on the inherited delivery. The static preview connects wallets without requesting a signature or contacting an auth backend. Wallet signing allows 60 seconds, independently of the 10-second network deadlines. WebKit could not start because host libraries are missing; real extensions/devices and ARM image startup remain unverified. See [raw evidence and limitations](artifacts/visitor-recovery/VALIDATION.md). Previous visitor results remain historical at `artifacts/visitor-auth/`.

## Install, preview and rebuild

Use Node 22.12+ (this task used Node 24.21.0). The existing frontend manifest, lockfile and Vite configuration are preserved.

```sh
cd web
npm ci
npm run typecheck
npm test
npm run build
cd ..
node web/scripts/preview.mjs 4173
```

Open `http://127.0.0.1:4173/preview/`. Stop the server with Ctrl+C. The production export is **`dist/index.html` and its complete local assets**. Vite uses `base: './'`; assets, workers, checkpoint and metadata work at a static gateway subpath. Use HTTP rather than `file://`, because the demo uses module workers and runtime asset requests. No credentials or backend are bundled into the export. The site is submitted for IMD's static preview publication; no publishing or deployment command was run here.

Dependencies can instead stay entirely outside the repository:

```sh
node web/scripts/task.mjs install
node web/scripts/task.mjs typecheck
node web/scripts/task.mjs test
node web/scripts/task.mjs build
```

Run those commands sequentially: the helper copies source into a shared temporary build tree. `node web/scripts/task.mjs path` prints that tree for external browser tools. Package caches, dependencies and unnecessary archives are excluded at every nesting level. The submission includes source, the existing lockfile, reusable atlases, model sheet, demo checkpoint, export, installation instructions and actual evidence. No submodule is created, and `.git/` remains untouched.

## Explore and inspect

Drag or use arrow keys to pan. Scroll, pinch, use +/−, or use the zoom controls. Select a Stratok on the map, or use **Find residents** and search by name/ID. **Follow resident** tracks its confirmed position; manual pan stops following. Escape closes the resident sheet and returns focus to the map.

Click empty terrain, or focus the map and press Enter, to inspect its actual coordinates, resources, construction progress, shelter integrity and observer-visible stores. Tile evidence is a safe-area-aware native dialog; Close or Escape returns focus to the map. **Explore settlements** lists real structures by biome; choosing one moves your camera. The atlas supports pointer and arrow navigation, and closes after choosing a location. Observer travel never moves residents. Water crossings remain subject to the engine's original movement rules.

Goals shows persistent needs/curiosity/social priorities, suspension/resumption and learned strategies. Signals shows limited learned local signaling, perceived/sent history, response evidence, co-occurrence, confidence and individual trust. Resident store memory is explicitly stale until revisited. Plans retains predictions, uncertainty, candidates and measured outcomes. Perception is the resident's last decision observation, not current global truth. Learning retains its actual model/episode/mb-v1 evidence. JSON downloads contain the actual inspector. World records expose bounded discovery/social history and real population, births, deaths, stores, sites and fish totals. No speech, thoughts, invented events, payment UI or fake IMD control is added. Visitor account data never enters public frames or inspector downloads. The archived `#settlement` route stays unavailable with `legacyAvailable:false`.

## Mode and owner installation

The shipped runtime file, `web/public/expanse-config.json` (copied to `dist/`), is:

```json
{"httpUrl":"https://stratoks.2-29-11-211.sslip.io","legacyAvailable":false,"startMode":"live"}
```

The existing configuration is preserved. On the owner's matching origin, `startMode:live` still selects that live service. On another static preview origin it opens the isolated browser demo; it never silently contacts production. For an owner same-origin installation, serve `dist/` beside the existing Expanse API (world reads remain read-only) and retain that runtime file, or use an empty `httpUrl` to select the page origin. Keep `legacyAvailable:false`. The source offers **Choose world** for an owner HTTPS endpoint, `?server=<URL-encoded HTTPS base>`, `?demo=1` and `?recorded=1`. An explicitly remembered source choice takes precedence. Local HTTP is accepted only from a local HTTP preview. A static export cannot change a different server's CORS policy. Failed connections retain a labeled recorded capture or last confirmed frame and provide reconnect. Sign-in additionally needs the configured backend's `/api/auth/config` capability and exact API v1 scope checks; it never uses the legacy developer-role transport.

The owner-run backend has zero runtime dependencies:

```sh
node server/src/expanse/server.js
```

Use an explicit data directory for a new local installation. For an existing owner world, first stop its process cleanly and copy its complete data directory to a separate review location. On that **copy**, run:

```sh
node server/bin/expanse-upgrade.js /absolute/path/to/copied-world
node server/bin/expanse-upgrade.js /absolute/path/to/copied-world --write
```

The first command is a dry run. The second preserves original pre-migration bytes before applying the versioned migrations through schema 5; do not point either command at the only copy of a world. See [owner installation and rollback](deploy/INSTALL-LIVING.md) for concrete backup, startup, API and rollback steps, including environment settings. The frontend integrates the preceding schema-5 engine, with additive observer-only relief, heat and activity fields. Schema 4→5 adds bounded agency defaults; see `docs/agency/ENGINE.md`. Existing IDs, brains, learned weights, family/relationship records, memories, discoveries and modified terrain are never replaced by the demo checkpoint.

## Art, physics and provenance

[Art integration](docs/art/INTEGRATION.md) describes the 36 character and 32 environmental sprites, transparent gutters, common foot anchors, supplied input hashes, animation gates, mirroring and licenses. The model sheet is at `web/public/art/model.webp` and is linked from Help. The runtime uses the API's actual per-tile biomes, connected water neighbours, material-progress sites and resource/store contents. It does not stamp resource-bearing decorative islands or bridges into walkable tiles.

[Living rules](server/docs/LIVING.md) document the designed recipes, tool wear, fish stock limits/regrowth, storage, construction, exposure and survival rules. [Frontend contract](docs/living/FRONTEND.md) explains the demo history, engine integration and state-to-animation mapping. [DESIGN.md](DESIGN.md) documents the final implemented interface system.

The rejected rabbit media, old share cards and compiled archived observer have been removed, including historical screenshot binaries. Their old numerical JSON/TAP measurements remain historical data, not evidence for this revision. Current media and worker observations are in `artifacts/agency-interface/`; [MEDIA.md](MEDIA.md) identifies them. Earlier `artifacts/living-interface/` results are historical. Existing original art sources under `docs/living/source/` remain intact.

## Validation

Actual local results (revision 2, 2026-10-30): production build and TypeScript check passed; **206 server tests (including the 2 demo migration/replay tests) + 34 client tests passed**. Opening a resident from a scrolled roster now starts the inspector at its identity block (`node web/scripts/check-inspector-scroll.mjs`, 5 viewports). The demo checkpoint was regenerated with the current engine using `tools/living/upgrade-demo.mjs`; details and the finding table are in `artifacts/agency-interface/VALIDATION.md`. Chromium interactions passed at desktop, tablet, 320/390-wide phones and 667/844-wide landscape phones. The pinned design probe passed **16/16**. These are worker observations, separate from independent structural acceptance.

```sh
node --test --test-concurrency=2 tests/*.test.js
cd web && npm test && npm run typecheck && npm run build
cd ..
# Install browser binaries outside the submission, using the existing lockfile:
PLAYWRIGHT_BROWSERS_PATH=/tmp/stratoks-browsers web/node_modules/.bin/playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/stratoks-browsers node web/scripts/agency-check.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/stratoks-browsers node web/scripts/agency-performance.mjs
node web/scripts/check-inspector-scroll.mjs   # uses the dependencies staged by web/scripts/task.mjs
IMD_PLAYWRIGHT="$PWD/web/node_modules/playwright/index.mjs" PLAYWRIGHT_BROWSERS_PATH=/tmp/stratoks-browsers node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste --offline
node tests/experiments/agency-ablation.mjs 3000 3,5,9 test/scratch/ablation.json
node tests/load/living-bench.mjs 100 600
node tests/load/living-bench.mjs 250 600
```

The pinned `.imd/reads/` probe is an assignment input and is removed after submission; its raw final result is retained in the validation artifacts. The delivered interaction/performance scripts remain reproducible. They start and close their own loopback preview, exercise the actual `dist/` at `/preview/`, and never request the owner VPS. Playwright WebKit was attempted but failed because host shared libraries are missing; Safari behavior remains unverified.

To reproduce the upgraded demo, run `node tools/living/upgrade-demo.mjs`, then rebuild. `tests/agency-demo.test.js` verifies its exact gzip hash from the original + 600 ticks and exact restarted continuation. The original `checkpoint.json.gz` must never be replaced with a newly generated world. The old `demo-checkpoint.mjs` fresh-founder recipe describes historical schema-4 work and is not the upgrade recipe.

A short actual phone recording is delivered at `artifacts/agency-interface/phone-tour.webm`. To make a fresh raw capture, run `PLAYWRIGHT_BROWSERS_PATH=/tmp/stratoks-browsers node web/scripts/agency-record.mjs`. It writes under `test/scratch/`. The delivered clip was encoded at 8 fps/90 kbit VP9 (no audio); the recorded simulation and interactions are real, without forced agent actions. High-resolution screenshots accompany the compact recording.

## Remaining limits

The parent engine's cooking and provisioning-help chains pass functional tests but did not emerge in the new 14-run natural ablation. Communication showed no demonstrated benefit; its confidence is evidence quantity, not semantic correctness. These are explicitly **unresolved emergence/research limits**, not features made successful by this presentation update. The existing planner and mb-v1 remain in charge; there are no scripted professions or global director.

Sprites retain the original golden leaf-crowned species. Unsupported wheat, cookware, vessels and composite two-actor art are not used. Work-tool art requires a supported held tool; bare-handed construction still follows engine rules. Direction coverage is limited; backward travel uses rear idle art, and some source matte fringe remains visible when enlarged.

Rendering keeps a 30 Hz cap, a DPR≤2 viewport surface and at most 384 small terrain rasters. Newly exposed terrain/camera changes can spike; timings are reported, not averaged away. Per-resident histories are bounded, while natural population growth can increase total CPU/RSS. Local x64 and emulated Chromium results do not establish ARM VPS, physical-phone, WebKit, native screen-reader or native 200% zoom performance/accessibility. No paid inference, payments, production access or public-world writes occurred.
