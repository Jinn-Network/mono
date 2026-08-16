---
name: testing-jinn-app
description: Use when smoke-testing or writing regression coverage for the jinn operator dashboard SPA — touching routing, layout, bootstrap/status data flow, or operator-visible surfaces, or reproducing a paper cut a user reported in the running-mode dashboard. Covers both manual chrome-devtools MCP walks against a live daemon and Playwright E2E tests with mocked daemon API.
---

# Testing the Jinn App

The jinn app is the operator dashboard SPA at `operator/src/dashboard/spa/`, served by the jinn daemon's HTTP API. Two complementary recipes drive it end-to-end — both share the same daemon-spawn pattern; they differ in whether the API is real or mocked.

1. **Manual smoke** via `chrome-devtools` MCP against a live daemon — for spotting UX/layout paper cuts during development.
2. **Automated E2E** via Playwright with route-mocked daemon API — for regression coverage in `operator/test/dashboard/`.

**Canonical domain model.** What these tests must cover is defined by [`operator/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md) — the operator app's canonical spec. It models the app as 14 components (§2.1 Daemon through §2.14 Generator panel), each described along four axes: **Static**, **Streams**, **Actions**, and **State messages**. The [Spec coverage map](#spec-coverage-map) below maps each component to the recipe or test that covers it.

## When to use

- After SPA changes that touch routing, layout, bootstrap/status data flow, or shared shell components
- Before opening a PR that changes operator-visible surfaces
- Reproducing a reported paper cut (follow the user's path)
- Adding regression coverage for a new operator workflow

## Daemon spawn (shared by both recipes)

All commands assume cwd = `jinn-mono/client`.

1. Build: `yarn build` — produces `dist/bin/jinn.js` and the SPA bundle in `dist/dashboard/`. **Re-run after every SPA source edit** — the daemon serves the bundled SPA from disk.
2. Spawn: `node dist/bin/jinn.js run --no-ui`. **Against the operator's real `~/.jinn`, that's the whole command** — the daemon auto-reads `~/.jinn-client/keystore-password` (written at first bootstrap) when `JINN_PASSWORD` is unset. Do NOT ask the operator for a password.

   > **CAVEAT — Restart-button / respawn tests must NOT use `--no-ui`.**
   > `--no-ui` sets `JINN_NO_UI=1`, which puts the daemon into headless/supervised mode. In that mode, `requestDaemonRestart` (see `operator/src/restart-daemon.ts`) skips the in-process respawn and calls `process.exit(0)` instead — it expects an external supervisor (systemd, Docker, etc.) to bring the daemon back. If you are testing the operator **Restart** button or any restart-respawn behaviour (issue #289), launch the daemon **without** `--no-ui`; otherwise the restart kills the daemon with no respawn and the test cannot pass.

   Env vars only matter when you're deviating from the default setup:
   - `HOME=<tmpdir>` — only set for a *fresh, clean-state* spawn (e.g. E2E test). Omit to attach to the bootstrapped fleet at `~/.jinn` (Base Sepolia master `0xE64bAf0073a71b0Cb2C0558bB16f24b45E1FB5CF`, agent #5474, safe `0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC`).
   - `JINN_PASSWORD=<password>` — only set when HOME is a fresh tmpdir (no `~/.jinn-client/keystore-password` to auto-read), or to override the on-disk password.
   - `JINN_API_PORT=<port>` — defaults to 7331; override only if 7331 is taken.
   - `BASE_RPC_URL=<rpc>` — only set for fresh-bootstrap setup-mode spawns; existing fleets read it from stored config.
   - `JINN_NETWORK=testnet`, `JINN_DISABLE_TESTNET_FAUCET=1` — only for E2E tests.
3. Capture the handshake URL from stdout/stderr — regex `UI handshake URL:\s+(\S+)`. The token in the URL is one-time per spawn; capture fresh after each restart.
4. Wait for `/v1/bootstrap` to return 200 or 401 before navigating — otherwise the SPA crashes on null data. Poll loop with 250ms backoff is sufficient (see `spa-config.e2e.test.ts`).

## Manual smoke (chrome-devtools MCP)

**Tool prerequisite:** requires `chrome_devtools__navigate_page` (and `__take_screenshot`). Verify with `ToolSearch query="chrome devtools navigate"` first — if the schemas don't surface, this MCP isn't loaded in the session and you cannot do a manual walk. Fall back to the Playwright E2E path below; it covers the same routes/assertions without a browser tool.

1. Run `Bash` with `run_in_background: true` to start the daemon; read background output to capture handshake URL.
2. `chrome_devtools__navigate_page` to the handshake URL.
3. Walk surfaces and screenshot each:
   - **Overview** (`/overview`) — two-column grid (`data-testid="overview-page-grid"`): a main column holding **ActivityCard** and a right rail holding **NodeHealthCard** then **WalletCard**. (An **EvictionBanner**, `data-testid="overview-eviction-banner"`, prepends the main column only when a service is evicted.) Per-card assertion hints:
     - **ActivityCard** (`data-testid="activity-card"`, region `aria-label="Activity"`, title `Activity`) — three sub-columns: Joined (`data-testid="activity-joined"`, `Joined` heading; empty copy `No SolverNets joined.`; `Join more SolverNets` CTA), Tasks (`data-testid="activity-tasks"`; a `Run / Task / State / Started` table with state Badges; empty copy `No task runs recorded yet.`), and Settings (`data-testid="activity-settings"`; `Roles` / `Harness` / `Model` / `Plugins` rows; `Edit` link).
     - **NodeHealthCard** (`data-testid="node-health-card"`, `Node health` heading) — a Daemon row (`Running` / `Stopped` with a `Restart` button — `Stop` is currently commented out) and an RPC row (`Healthy` / `Unreachable` with a `Manage RPC` button).
     - **WalletCard** (`data-testid="wallet-card"`, region `aria-label="Wallet"`, eyebrow `Wallet`) — four hairline-separated sections: Gas (`<n> ETH · <n>d runway`, `Top up from faucet (free)` button), Rewards (`Testnet JINN earned` in `tJINN`, `Lifetime claimed`), Identity (`Service` / `Agent` / `Master` / `Safe`), Password (`Change password` button).
   - **Configuration** (`/configuration`) — Network / Security sections; deep-link via hash (`#network`, `#security`). SolverNet selection no longer lives here — it moved to the Operator join flow (see below).
   - **Launcher** (`/launcher`) — owned-SolverNets list rendered from `solvernets.listLaunched`; primary `Create SolverNet` CTA; empty-state copy ("No SolverNets created yet…") when no records exist; each row links to `/launcher/launched/:solverNetId`.
   - **Launcher · Create** (`/launcher/create`) — 5-step Create wizard (Define → Review Contract → Configure Generator → Configure Pricing → Review and Launch). Step is local state, route stays `/launcher/create`. Drafts persist server-side via `solvernets.createDraft / updateDraft`; the Launch action drives the forward-only state machine (`pinning → recording → broadcasting → confirming → spawning → launched`) — see `spec/2026-05-05-solvernet-creation-and-launch.md` §10.
   - **Launcher · Launched** (`/launcher/launched/:solverNetId`) — post-launch dashboard for an owned record. Status badge (launched / paused / retired), generator status, posted-tasks list, spend / runway, Pause/Resume controls, generator-config form (cadence / allowlist / blocklist hot-apply via `solvernets.updateGeneratorConfig`), Danger Zone retire with typed-name confirmation.
   - **Operator · Join** (`/operator/join/:cid`) — operator participation flow keyed by `manifestCid`. Resolves the manifest from registry, surfaces `openRoles`, runs readiness checks (credentials, harness compatibility), writes a `joinedSolverNets[<manifestCid>]` config entry (restart-required — the daemon does not hot-reload SolverNet config).
   - **Top tab nav** — click links, verify URL updates and active-tab indicator follows
4. Stop daemon: `kill $(lsof -ti :PORT)` or send SIGTERM via the background shell handle.

### Things to watch for (regressions caught this way)

- **Layout overflow**: page should not scroll past viewport. AppShell is viewport-locked (`height: 100vh; overflow: hidden`); xterm scrollback in the agent rail will blow document height past 800,000 px if the lock is missing.
- **Empty controls when stored config is partial-shape**: per-field `??` merge is the rule — whole-object fallback (`stored ?? defaults`) leaks `undefined` fields through. Applies wherever stored config is merged into a typed shape (operator `joinedSolverNets[<cid>]`, generator-config form, etc.).
- **Restart banner persistence**: after saving any config that returns `restartRequired: true` (e.g. `operator.join`), the banner must remain visible across tab navigation.
- **Stale daemon on port**: if spawn fails, `lsof -i :PORT` to find the holder, `kill -9` it, retry.
- **Active tab indicator drift**: sky underline should track URL changes — broken when `useLocation` is forgotten.
- **Launch state-machine recovery**: a daemon restarted mid-launch must resume from the last completed phase. After interrupting the launch, restart the daemon and confirm the SPA shows the in-flight `launchProgress` record advancing through `pinning → recording → broadcasting → confirming → spawning → launched` rather than rolling back to draft. The on-disk record is the recovery checkpoint (per §10 of the spec); each phase is idempotent.
- **Registry catalog rendering**: `/operator/join/...` and the launched-list pull from the global subgraph-backed registry. Verify both states: empty (`No launched SolverNets available.` copy when the subgraph returns zero `solvernet-manifest:*` events) and populated (each summary shows name, launcher agentId, status badge, openRoles, prices). A `refresh=1` query param forces a re-pull.
- **Lifecycle transitions**: pause/resume should round-trip without page reload — the launched dashboard polls `solvernets.get` and re-renders the status badge. Retire is destructive: typed-name confirmation must match the SolverNet name exactly before the `[Retire]` button enables; once retired, the dashboard shifts to a read-only terminal state with no resume affordance.
- **Manifest-cid attribution**: claim eligibility is filtered by entries in `joinedSolverNets[<manifestCid>]`. A daemon with no joined SolverNets must not claim *any* tasks — including tasks whose `solverNetManifestCid` matches a SolverNet the operator has not joined. Verify by posting tasks under launcher A's manifest while the operator has joined only launcher B's manifest; the engine-watcher should ignore them.
- **Generator hot-apply (vs. predecessor P0 bug)**: editing cadence / allowlist / blocklist on the launched dashboard must take effect within one generator tick. The PATCH writes both the on-disk record *and* an in-memory mirror inside the running generator's closure — restart should not be required. (This was `jinn-mono-p1t4.2` in the predecessor Launcher mode and is regression-tested in the launcher e2e.)

## Automated E2E (Playwright)

Live template: `operator/test/dashboard/spa-config.e2e.test.ts`. The pattern:

1. `test.beforeAll` — spawn daemon (same recipe), poll `/v1/bootstrap` until reachable.
2. `mockDaemonApi(page)` — `page.route(...)` intercepts every endpoint the page touches. The current set, drawn from `operator/src/dashboard/spa/src/api/client.ts` (`api.solvernets.*` and `api.operator.*`):
   - `/v1/bootstrap` → running-mode payload (`mode: 'running'`, fleet, chain, joinedSolverNets)
   - `/v1/status` → status snapshot
   - `/auth/handshake**` → suppress redirect, return `{"ok":true}`
   - **Drafts (Launcher · Create)** — `solvernets.listDrafts`, `getDraft`, `createDraft`, `updateDraft`, `deleteDraft` against `/v1/solvernets/drafts[/:id]`
   - **Launch + lifecycle** — `solvernets.launch` against `/v1/solvernets/drafts/:id/launch`; `solvernets.transitionLifecycle` against `/v1/solvernets/launched/:solverNetId/lifecycle` (PATCH `{ target: 'launched' | 'paused' | 'retired' }`); `solvernets.updateGeneratorConfig` against `/v1/solvernets/launched/:solverNetId/generator-config` (PATCH partial)
   - **Owned launched records (Launcher pages)** — `solvernets.get`, `solvernets.listLaunched` against `/v1/solvernets/launched[/:solverNetId]`
   - **Global registry (Operator · Join)** — `solvernets.listRegistry`, `solvernets.getManifest` against `/v1/solvernets/registry[/:cid]`
   - **Operator participation** — `operator.join`, `operator.leave` against `/v1/operator/join/:manifestCid` (POST writes `joinedSolverNets[<cid>]` with `restartRequired: true`; DELETE removes it)
   - The predecessor `fetchLauncherStatus`, `fetchLauncherTasks`, and `patchLauncherSolverNet` methods have been removed; do not mock the legacy `/v1/launcher/*` paths.
3. `page.goto(handshakeUrl ?? "http://127.0.0.1:PORT/")`.
4. Drive: `getByRole('link', { name: /configuration/i }).click()`, `getByRole('button', { name: /save changes/i }).click()`, etc. Prefer accessible-role queries over CSS selectors.
5. Assert: `expect(page).toHaveURL(...)`, `expect(page.getByText(/configuration saved/i)).toBeVisible()`.
6. `test.afterAll` — SIGTERM, fall back to SIGKILL after 500ms.

Run a single E2E file: `yarn build && playwright test --config=playwright.config.ts test/dashboard/spa-config.e2e.test.ts` (model after the `e2e:spa` script in `operator/package.json`).

## Multi-operator scenarios

The single-op recipes above (manual smoke, automated E2E) cover testing one operator in isolation. Multi-operator scenarios — where two daemons interact via the chain and via the operator app — require additional infrastructure that this section documents. Reference docs in `references/` cover each pattern in detail.

Spawn pattern: two (or more) daemons run concurrently against distinct HOMEs (substrate-derived workspaces from Plan A's `substrate-copy`, or fresh tmp HOMEs for clean-state E2Es). Each daemon gets a distinct `JINN_API_PORT`. Helpers in `operator/test/helpers/multi-op-daemon.ts` wrap the spawn + teardown lifecycle.

Three method-pattern reference docs cover the mechanics:

- [`references/multi-op-spawn.md`](references/multi-op-spawn.md) — bash + TypeScript spawn recipes; port management; teardown.
- [`references/multi-op-chrome-devtools.md`](references/multi-op-chrome-devtools.md) — multi-page chrome-devtools driving for cross-op manual smoke.
- [`references/multi-op-playwright.md`](references/multi-op-playwright.md) — Playwright template for two-daemon automated tests.

Scenario reference docs. The first three describe gated scenarios (consumed by
the release pipeline); the last is a **manual** runbook (deliberately not gated):

- [`references/scenario-spa-route-smoke.md`](references/scenario-spa-route-smoke.md) — T1.4: load every SPA route against a mocked daemon, assert clean.
- [`references/scenario-cross-op-donation.md`](references/scenario-cross-op-donation.md) — T2.1: op-a produces corpus artifact, op-b consumes via x402.
- [`references/scenario-producer-evaluator.md`](references/scenario-producer-evaluator.md) — T2.2: op-a solves task on Anvil-fork, op-b evaluates.
- [`references/scenario-multi-op-spa-flow.md`](references/scenario-multi-op-spa-flow.md) — **Paired (two-operator) SPA flow — manual runbook.** op-a launches a SolverNet, op-b discovers + joins. Driving two real daemons against real testnet is inherently flaky, so this is a **human-run spot check, not an automated/gating test** (#1014 — a flaky non-gating browser test re-creates the un-gateable T2.3 shape #960 deleted). The *deterministic* create→launch→join coverage that DOES gate lives in `operator/test/dashboard/{solvernet-flow,join}.e2e.test.ts` (`yarn e2e:app-flow`, hermetic gate).

### Things to watch for (multi-op specific)

In addition to the single-op concerns listed earlier:

- **Cross-operator visibility lag** — op-b sees op-a's actions only after the indexer has caught up (~2 indexer-poll-intervals). Wait, don't assume instant.
- **Identity collisions** — spawning two daemons with the same HOME means both fight for the same agentId/Safe/nonce. Always verify *both* apiPort AND source HOME directory are distinct before spawning.
- **Workspace bleed** — substrate-derived workspaces under `~/jinn-dev/workspaces/` are auto-pruned at 7 days by `substrate-reap`. Don't leave a workspace assumed to be there between test runs; either own its lifecycle or use a fresh one each test.
- **Substrate staleness** — if `substrate-verify` reports drift, all multi-op scenarios using substrate workspaces will fail in non-obvious ways. Run verify before any multi-op session.
- **RPC saturation under concurrent load** — substrate ops currently share one Tenderly key (per spec §2). If both daemons hammer the RPC simultaneously, expect HTTP 429. Tracked as `jinn-mono-lrey`; for now, add jittered delays in scenarios where both daemons are RPC-active.

## Quick reference

| Goal | Approach |
|------|----------|
| Spot a UX/layout bug | Manual + chrome-devtools, take screenshots |
| Reproduce a reported issue | Manual + chrome-devtools, follow user's exact path |
| Add regression coverage | Playwright E2E with `page.route` mocks |
| Verify hash deep-links | Navigate to `/configuration#network` etc. |
| Test against real chain state | Reuse a bootstrapped HOME, no mocks |
| Test pure SPA wiring | Fresh HOME + mock all `/v1/*` endpoints |
| Spot a cross-op visibility bug | Multi-op chrome-devtools — drive two pages, [`references/multi-op-chrome-devtools.md`](references/multi-op-chrome-devtools.md) |
| Add cross-op regression coverage | Multi-op Playwright — [`references/multi-op-playwright.md`](references/multi-op-playwright.md) |
| Test SPA route surface (T1.4) | [`references/scenario-spa-route-smoke.md`](references/scenario-spa-route-smoke.md) |
| Test cross-op donation (T2.1) | [`references/scenario-cross-op-donation.md`](references/scenario-cross-op-donation.md) |
| Test producer/evaluator on Anvil-fork (T2.2) | [`references/scenario-producer-evaluator.md`](references/scenario-producer-evaluator.md) |
| Eyeball the paired two-operator SPA flow (manual) | [`references/scenario-multi-op-spa-flow.md`](references/scenario-multi-op-spa-flow.md) |
| Gate create→launch→join deterministically | `yarn e2e:app-flow` (`solvernet-flow` + `join` e2e, hermetic gate) |

## Spec coverage map

The recipes above are surface/route-keyed; this table pivots back to the spec's component model (§2.1–§2.14) so each component can be checked off against the SPA surface that renders it and the recipe or test that covers it. Unit-test paths are relative to `operator/src/dashboard/spa/src/`; e2e paths are under `operator/test/dashboard/`.

| Spec component (§) | SPA surface(s) | Covered by |
|---|---|---|
| 2.1 Daemon | `pages/overview/NodeHealthCard.tsx` (Daemon + RPC rows); daemon event stream `pages/Events.tsx` + `components/EventStreamList.tsx` | Manual smoke → Overview · NodeHealthCard; `pages/overview/NodeHealthCard.test.tsx`, `pages/Events.test.tsx`. **NOTE:** Actions axis — Restart-respawn (#289) is manual-only per the `--no-ui` CAVEAT above; no gated e2e. |
| 2.2 Identity | `pages/overview/IdentityCard.tsx` (Service / Agent / Master / Safe) | `pages/overview/IdentityCard.test.tsx`; manual smoke → Overview · WalletCard Identity section. |
| 2.3 Funds | `pages/overview/WalletCard.tsx` (Gas / runway / faucet) | `pages/overview/WalletCard.test.tsx`, `pages/Overview.balances.test.tsx`; e2e `runway-display.e2e.test.ts` (#288), `funding-sequence.e2e.test.ts`. |
| 2.4 Network Memberships | `pages/operator/MembershipsTab.tsx`; `pages/configuration/JoinedNetCard.tsx`; operator join `pages/operator-catalog/JoinFlow.tsx` | `pages/operator/MembershipsTab.test.tsx`, `pages/configuration/JoinedNetCard.test.tsx`; e2e `join.e2e.test.ts` (`yarn e2e:app-flow`). Manifest-cid attribution per "Things to watch for". |
| 2.5 SolverNet Registry | `pages/operator-catalog/RegistryCatalog.tsx`; `pages/operator/RegistryTab.tsx` | `pages/operator-catalog/RegistryCatalog.test.tsx`, `pages/operator/RegistryTab.test.tsx`; manual smoke → Operator · Join (Registry catalog rendering watch-for). |
| 2.6 Tasks (in-flight) | `pages/overview/ActivityCard.tsx` (Tasks sub-column); launched `pages/launcher-launched/TasksPanel.tsx` | `pages/overview/ActivityCard.test.tsx`, `pages/launcher-launched/TasksPanel.test.tsx`; manual smoke → Overview · ActivityCard Tasks table. |
| 2.7 Rewards | `pages/overview/WalletCard.tsx` (Rewards section: pending OLAS / lifetime claimed); `pages/leaderboard/Leaderboard.tsx` | `pages/overview/WalletCard.test.tsx`, `pages/leaderboard/Leaderboard.test.tsx`. |
| 2.8 Bootstrap | `regions/Onboarding.tsx` + `regions/onboarding/{SolverNetStep,HarnessSelectStep,…}.tsx` (takeover) | e2e `onboarding-flow.e2e.test.ts`, `funding-sequence.e2e.test.ts`; unit `regions/Onboarding.test.tsx`, `regions/onboarding/SolverNetStep.test.tsx`. Older setup-mode e2e `spa.e2e.test.ts`. |
| 2.9 Harness Selection | onboarding rendering `regions/onboarding/HarnessSelectStep.tsx` (+ `TierDots.tsx` for three-tier availability) | `regions/onboarding/HarnessSelectStep.test.tsx`, `regions/onboarding/TierDots.test.tsx`; e2e `onboarding-flow.e2e.test.ts`, `HarnessSection.e2e.test.ts`. **NOTE:** the post-onboarding Settings home is the #983 split follow-up — no standalone Settings harness surface yet. |
| 2.10 Notifications | `notifications/components/NotificationsList.tsx`, rendered in `shell/AppShell.tsx` | `notifications/components/NotificationsList.test.tsx`, `notifications/useNotifications.test.tsx`, `notifications/derive.test.ts`, `notifications/taxonomy.test.ts`; e2e `claim-failed-notification.e2e.test.ts` (#442). Restart-banner persistence in "Things to watch for". |
| 2.11 Settings | `pages/operator/NetworkTab.tsx` (RPC + task-post panel), `pages/operator/SecurityTab.tsx`; deep-link `/configuration#network` / `#security` | `pages/operator/NetworkTab.test.tsx`, `pages/operator/SecurityTab.test.tsx`; e2e `spa-config.e2e.test.ts`, `task-post-counts.e2e.test.ts` (#918). **NOTE:** §2.9 Harness-Selection home not yet hosted here (#983 split). |
| 2.12 Updates | no dedicated page; `update_available` kind in `notifications/taxonomy.ts` rendered via NotificationsList | Partial: `notifications/taxonomy.test.ts` covers the `update_available` kind. **NOTE:** Actions axis — current-version / check-now / apply-update — no first-class Updates surface shipped yet; deferred. |
| 2.13 Optional components | Launcher `pages/Launcher.tsx`; Artifact Serving `pages/operator/OperatorDataMarket.tsx`; Peers — Configuration peer list | Launcher: e2e `solvernet-flow.e2e.test.ts`, `task-post-counts.e2e.test.ts`; `pages/Launcher.test.tsx`. Artifact: `pages/operator/OperatorDataMarket.test.tsx`. **NOTE:** mode-gated / partial — Peers has no dedicated e2e; opt-in surfaces render only when the mode is active. |
| 2.14 Generator panel (#570) | `pages/launcher-launched/GeneratorPanel.tsx` | `pages/launcher-launched/GeneratorPanel.test.tsx`; e2e `solvernet-flow.e2e.test.ts` (generator hot-apply watch-for). |

Cells with a coverage gap carry a **NOTE** naming the closing issue or marking the surface deferred / mode-gated.

## Common mistakes

- **Forgetting to rebuild**: `dist/bin/jinn.js` and `dist/dashboard/` don't update on source edits — re-run `yarn build` after each SPA change.
- **Reusing a stale handshake URL**: token is one-time per daemon spawn.
- **Mocking too little**: if a polled endpoint isn't intercepted, the SPA renders empty state — mock everything the page touches, including `/auth/handshake`.
- **Killing the daemon too early**: useQuery polls every 1.5s; the daemon must stay alive for the duration of the walk.
- **Skipping the bootstrap-readiness wait**: navigating before `/v1/bootstrap` returns a real status leads to non-deterministic crashes.

## References

- Canonical spec: `spec/2026-05-05-solvernet-creation-and-launch.md` (v0.2) — creation + launch flow, manifest shape, generator ownership, operator join, registry interface
- E2E template: `operator/test/dashboard/spa-config.e2e.test.ts`
- Launcher e2e (real-daemon happy path): `operator/test/dashboard/solvernet-flow.e2e.test.ts`
- Older single-page e2e (setup mode): `operator/test/dashboard/spa.e2e.test.ts`
- Routing tests: `operator/src/dashboard/spa/src/App.routing.test.tsx`
- AppShell viewport-lock: `operator/src/dashboard/spa/src/shell/AppShell.tsx`
- Launcher SPA pages: `operator/src/dashboard/spa/src/pages/Launcher.tsx`, `LauncherCreate.tsx`, `LauncherLaunched.tsx`, and the operator catalog at `operator/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx`
- SDK surface: `operator/src/dashboard/spa/src/api/client.ts` (`api.solvernets.*`, `api.operator.*`)
- Playwright config: `operator/playwright.config.ts`
