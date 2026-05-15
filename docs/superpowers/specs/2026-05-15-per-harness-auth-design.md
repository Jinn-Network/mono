# Per-harness auth: remove the daemon-level Claude gate

**Bead:** `jinn-mono-vh74.2` (P1, parent epic `jinn-mono-vh74`)
**GitHub:** https://github.com/Jinn-Network/mono/issues/236
**Date:** 2026-05-15
**Run-mode:** REFACTOR — auth check moves out of daemon-level preflight into per-harness shape.

## Problem

The daemon currently treats Claude auth as a global pre-running-mode hard gate. At `main.ts:1398`:

```typescript
const claudeAuthRequired = configRequiresClaudeAuth(config);
if (claudeAuthRequired) {
  // ... claude auth status subprocess; exit with exitCode=11 if not authed
}
```

`configRequiresClaudeAuth` (in `preflight/claude-required.ts`) reads `config.harnesses.disabled` — a static allow-list — NOT `joinedSolverNets[<cid>].harness` (the actual harnesses any joined SolverNet uses). The gate exits the daemon on missing Claude auth regardless of whether any joined SolverNet uses Claude.

**Concretely wrong because:**

1. Claude is one harness among several (the daemon ships ~17 impls today: claude-code-learner, codex-code-learner, swe-rebench-v2-evaluator (Docker, no Claude), prediction-v0/v1-baseline, portfolio-v0-evaluator, hermes-agent in `hermes/*` branches, etc.).
2. The only daemon-side surface that strictly requires Claude is the embedded agent-WS bridge (xterm.js panel in the dashboard) — and it's attached unconditionally.
3. Codex-only operators are blocked. Docker-evaluator-only operators are blocked. Both by a gate that doesn't apply to their harness.

The fix is architectural: per-harness readiness checks, composed from `joinedSolverNets[<cid>].harness`, surfaced to the SPA, gating claim loops — never gating the daemon process itself.

## Existing patterns to build on

The codebase already has two pieces of this puzzle:

1. **`Harness.isReady()`** (`client/src/harnesses/types.ts:247`) — returns `ReadyStatus { ready, reason?, nextStep?: { description, cli?, url? } }`. Exactly the shape per-harness readiness needs. Many harness impls don't implement it yet; this design requires they do.

2. **Hermes branch precheck pattern** (`hermes/6-real-binary-fixes`, 53 commits ahead of main — not yet merged). Establishes:
   - Backend: `GET /api/hermes/doctor` (`client/src/api/hermes-doctor-endpoint.ts`) — spawns `hermes doctor` subprocess, returns `{ installed, exitCode, stdout, stderr }`.
   - Frontend: `HermesPrecheckPanel.tsx` — polls the endpoint, shows three operator-facing states (`not-installed` → curl-pipe-bash install command + retry; `config-issue` → stderr diagnostic + `hermes setup` instructions; `ok` → calls `onSuccess()`).
   - Wiring: `JoinFlow.tsx` shows `<HermesPrecheckPanel>` before allowing save when operator picks Hermes.

   This is exactly the per-harness pattern we need. This design assumes the Hermes branch lands in main before implementation begins and generalizes its shape across all harnesses (rename → `HarnessPrecheckPanel`, lift endpoint → `/v1/harnesses/<name>/readiness`, add composed `/v1/harnesses/readiness` for SPA polling).

## Scope

**In scope** (per Captain decision 2026-05-15 — "Medium" scope):

- Remove the daemon-level Claude auth gate (`configRequiresClaudeAuth` + the `main.ts` exit branch).
- Add daemon-side `HarnessReadinessRegistry` composing per-joined-harness `isReady()`.
- Add claim-loop readiness gating per joined SolverNet.
- Reshape SPA Onboarding takeover: 4 phases → 3 (drop Phase 1 "Sign in to Claude").
- Move per-harness setup into the `/operator` join flow per the vh74 epic's framing.
- Generalize the Hermes precheck pattern to all harnesses (panel + endpoint shape).
- Retrofit existing Claude auth flow (`/v1/auth/claude`, `/v1/auth/claude/spawn`) as one specific implementation of the generic pattern.

**Out of scope:**

- Embedded agent-WS bridge UX (the `/operator` chat panel) — currently always-on regardless of joined harnesses. For Codex-only operators it shows an unauthenticated state. Re-home to a separate `vh74` child.
- Codex auth flow polish — Codex is supported as a harness today via `claude-code-learner/adapters/codex-code.ts`; if the per-harness pattern surfaces Codex-specific shortfalls, file as a follow-up.
- Sign-out / re-auth UX inside the SPA.
- Performance / observability metrics for the readiness ticks.
- Harness auth for harnesses where this design surfaces but the impl already works (most prediction-v0/v1-* — they have no external auth concern; their `isReady()` returns `{ ready: true }`).

**Coupling:**

- **Depends on `hermes/6-real-binary-fixes` landing in main first.** The generic pattern this design defines is a direct generalization of the Hermes-specific pattern. Landing this work before Hermes merges would require either redesigning the Hermes pattern from scratch (wasteful) or rebasing 53 commits across the chain (risky).
- **Couples with `jinn-mono-h74p`** (in-process safe-binding retry, PR #237). h74p removes the accidental safety net (daemon-exit → restart → bootstrap-resume → retry succeeds) that masks first-attempt setAgentWallet reverts. This design removes the *other* reason the daemon exits. The combined effect: post-vh74.2 the daemon stays up; post-h74p binding succeeds in-process on retry. Order: h74p lands first; this lands after Hermes.

## Architecture

### Invariants

- **The daemon's process lifetime is independent of harness auth state.** No `process.exit()` paths driven by harness readiness.
- **`joinedSolverNets[<cid>].harness` is the source of truth** for which harness needs to be ready for which SolverNet.
- **Per-harness `isReady()` is the canonical readiness API.** Harnesses encapsulate their own readiness check; the daemon composes results.
- **Empty `joinedSolverNets` = zero readiness checks.** A fresh operator who hasn't joined anything has nothing to authenticate. Onboarding doesn't surface harness cards.
- **The dashboard always reflects current readiness; never claims "ready" when daemon would skip claims.**
- **Existing operators with prior Claude OAuth see zero behavior change.** The gate just no longer fires; their readiness composes as ready.

### Runtime behavior

When a harness isn't ready:

- **Daemon keeps running.** Setup-mode API + dashboard reachable. Balance-topup / discovery / cross-chain claim / other harness-independent loops keep ticking.
- **Claim loops check `isReady()` per joined harness and skip claims** for SolverNets whose harness isn't ready.
- **SPA Onboarding** shows per-harness setup cards driven by the same `isReady()` results, surfaced in the `/operator` joined-list rather than the bootstrap takeover.
- **Operator can fix harness auth any time** without restarting the daemon. Next 4s readiness tick picks up the change; next claim tick proceeds.

## Components

### Deleted

- `client/src/preflight/claude-required.ts` — the whole file (`configRequiresClaudeAuth` + `CLAUDE_AUTH_REQUIRED_HARNESSES` constant).
- The `claudeAuthRequired` branch in `client/src/main.ts:1398-1399` and its exit envelope.
- `client/src/dashboard/spa/src/regions/ClaudeAuthCard.tsx` (functionality absorbed by generalized `HarnessPrecheckPanel`).

### New

- `client/src/harnesses/readiness-registry.ts` — `HarnessReadinessRegistry`. Composes `isReady()` per harness listed in `joinedSolverNets[<cid>].harness`. Provides:
  - Background refresh tick (4s default, matching current claude-auth poll cadence).
  - Snapshot getter for the API endpoint.
  - `isReadyForClaim(manifestCid): ReadyStatus` for claim loops (cached snapshot lookup; ≤4s stale).
- `client/src/api/harness-readiness-endpoint.ts` — registers:
  - `GET /v1/harnesses/readiness` — composed view across all joined harnesses (for SPA polling).
  - `GET /v1/harnesses/<name>/readiness` — single-harness probe (for JoinFlow's pre-save check).
- `client/src/dashboard/spa/src/regions/HarnessPrecheckPanel.tsx` — generalized rename of `HermesPrecheckPanel`. Props: `{ harnessName, onSuccess, onCancel }`. Polls `/v1/harnesses/<harnessName>/readiness`. State machine driven by `ReadyStatus.nextStep`:
  - `nextStep.cli` present → render install/CLI affordance (e.g., curl-pipe-bash for Hermes).
  - `nextStep.url` present → render action button that triggers the URL (e.g., POST to `/v1/auth/claude/spawn` for Claude OAuth in xterm).
  - `ready: true` → collapse panel, call `onSuccess()`.

### Modified

- `client/src/main.ts` — delete the `claudeAuthRequired` branch; wire `HarnessReadinessRegistry` init after config load; pass registry into claim-loop construction.
- `client/src/api/setup-endpoints.ts` — keep `/v1/auth/claude` + `/v1/auth/claude/spawn` (they become the Claude-specific implementation; `HarnessPrecheckPanel` for harness=claude-code-learner uses them). Register new harness-readiness endpoint via `addHarnessReadinessRoutes()`.
- `client/src/api/hermes-doctor-endpoint.ts` (introduced on Hermes branch) — once Hermes lands, rename/migrate to register `/v1/harnesses/hermes/readiness` instead of `/api/hermes/doctor`. Response shape adapts to `ReadyStatus`.
- `client/src/api/server.ts` — replace the existing `addHermesDoctorRoutes()` call with `addHarnessReadinessRoutes()`.
- `client/src/dashboard/spa/src/regions/Onboarding.tsx` — drop Phase 1 ("Sign in to Claude") and the `useQuery(['claude-auth'])` block. Renumber `PHASE_TITLES`:
  ```typescript
  // BEFORE                              // AFTER
  1: 'Sign in to Claude',                1: 'Provisioning your wallet',
  2: 'Provisioning your wallet',         2: 'Fund your wallet',
  3: 'Fund your wallet',                 3: 'Joining Jinn',
  4: 'Joining Jinn',
  ```
  Update `PHASE_FOR_STEP` mappings (subtract 1 from each phase number). Update Phase type to `1 | 2 | 3`.
- `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx` — generalize the existing per-Hermes precheck wiring. Render `<HarnessPrecheckPanel harness={selectedHarness} />` for any non-trivial harness selection (driven by a `harnessRequiresPrecheck(name): boolean` helper or, better, by always rendering it and letting the panel collapse when `ready: true`). Both solver harness AND evaluator harness (derived from manifest) must report ok before Save is enabled.
- `client/src/dashboard/spa/src/pages/operator-catalog/HermesPrecheckPanel.tsx` — rename → `HarnessPrecheckPanel.tsx`. Generalize props as described above. Existing Hermes-specific states (`not-installed`, `config-issue`, `ok`) map to the generic `nextStep.cli` / `ok` shape.
- `client/src/daemon/daemon.ts` (and any per-claim-loop file) — claim attempt sites add a `readinessRegistry.isReadyForClaim(manifestCid)` check; skip claim if false; log once per status-change (NOT per tick).
- Per-harness `isReady()` impls — strengthen / introduce for harnesses that participate:
  - `claude-code-learner/index.ts` — `isReady()` runs the existing `claude auth status` subprocess (lift logic from `preflight/claude-auth.ts`) and returns `ReadyStatus`. The probe code stays in `preflight/claude-auth.ts` as a reusable helper; just the call-site moves.
  - `hermes-agent/index.ts` (lands with Hermes branch) — `isReady()` runs `hermes doctor` (lift from `hermes-doctor-endpoint.ts`).
  - Other current Claude-requiring harnesses (`claude-mcp-prediction`, `claude-mcp-prediction-apy`, `claude-mcp-hyperliquid`, `legacy-claude`) — same Claude probe.
  - Evaluator harnesses needing Docker (`swe-rebench-v2-evaluator`) — `isReady()` probes `docker info`.
  - Pure-compute harnesses (prediction-v0/v1-baseline) — keep returning `{ ready: true }` (default if `isReady()` omitted).

### Kept untouched

- The embedded agent-WS bridge (`client/src/agent/agent-ws.ts`) — still attached unconditionally. Re-home its conditional-attachment to a separate `vh74` child.
- `/v1/setup/claude/install` — still useful for first-time-Claude operators; `HarnessPrecheckPanel` for harness=claude-code-learner can trigger it via `nextStep.url` when claude binary is missing.

## Data flow

```
boot:
  config.joinedSolverNets
    → for each entry: resolve harness impl from registry
    → call harness.isReady({ solverType, role })
    → cache snapshot in HarnessReadinessRegistry
    → start background refresh tick (4s, matching current claude-auth poll cadence)

per-claim loop tick:
  for each joined SolverNet:
    status = readinessRegistry.isReadyForClaim(manifestCid)   // cached snapshot lookup
    if !status.ready: skip (log once per status-change, not per tick)
    else: proceed with claim

SPA polling (every 4s):
  SPA → GET /v1/harnesses/readiness
    → returns { harnesses: [{ harnessName, manifestCids: [...], ready, reason?, nextStep? }] }
    → SPA renders HarnessPrecheckPanel for each entry where ready=false in /operator joined-list

auth completion:
  SPA → POST /v1/auth/<harness>/spawn (or harness-specific equivalent via nextStep.url)
    → daemon spawns the existing xterm.js OAuth subprocess
    → operator completes OAuth in embedded terminal
    → on next 4s refresh tick: isReady() returns ready=true
    → SPA card disappears; claim loops start claiming on next tick

auth expiry mid-runtime:
  next 4s refresh tick: isReady() returns ready=false
    → claim loops skip this harness's SolverNets (no exit)
    → SPA repaints HarnessPrecheckPanel
    → operator re-authenticates same flow as initial

join flow:
  operator → POST /v1/operator/join/:cid (existing)
    → daemon writes joinedSolverNets[<cid>] to config
    → restart-required banner shown (existing UX, unchanged)
    → on restart: HarnessReadinessRegistry includes new entry
    → if harness not ready: card surfaces in joined-list; auth flow above
```

**Caching invariant:** SPA endpoint and claim-loop getter read the same cached snapshot. Background tick is the single writer. Avoids per-claim subprocess spawn (`claude auth status` is measurable cost over a busy claim loop). Cache max-age is the tick interval (4s).

## UX changes

### Onboarding (`Onboarding.tsx`)

4 phases → 3:

```
BEFORE                          AFTER
─────────────────               ─────────────────
01 · Sign in to Claude          01 · Provisioning your wallet
02 · Provisioning wallet        02 · Fund your wallet
03 · Fund your wallet           03 · Joining Jinn
04 · Joining Jinn
```

`Onboarding.tsx` drops the `useQuery(['claude-auth'])` block and the entire Phase 1 rendering. The `ClaudeAuthCard` component goes away.

### JoinFlow (`JoinFlow.tsx`)

```
operator picks SolverNet "SWE-rebench v2" → JoinFlow opens
  → operator selects roles (solver / evaluator / both)
  → harness picker shows (Claude Code / Hermes Agent / etc. for solver role)
  → on harness selection: render <HarnessPrecheckPanel harness={selected} />
  → panel polls /v1/harnesses/<name>/readiness; renders state-specific UI driven by ReadyStatus.nextStep
  → operator can't save until ALL selected-role harnesses report ok
    (solver harness + evaluator harness derived from manifest's
     contract.evaluationFunction.implementation)
```

### Joined-list rendering on `/operator`

Adds a "needs setup" indicator:

```
SWE-rebench v2 (Jinn)  [joined: solver + evaluator]
  Solver harness: Claude Code  ⚠ Sign in required
                                ↳ [Sign in] button (re-opens HarnessPrecheckPanel inline)
```

The `/v1/harnesses/readiness` composed endpoint feeds this. When the SPA polls it (every 4s) and any joined harness is `ready: false`, the joined-list row shows the warning chip + action.

### Daemon log surfaces

Daemon logs a one-line "harness X not ready; skipping claims for SolverNet Y" message per status change (NOT per tick) so operators tailing logs see the gate clearly.

## Error handling

| Failure | Behavior |
|---|---|
| `Harness.isReady()` throws or hangs | Background tick wraps in try/catch + timeout. Result cached as `{ ready: false, reason: 'isReady threw: <msg>' \| 'timed out' }`. Claim loops treat as not-ready. |
| `/v1/harnesses/readiness` GET errors | Endpoint serves cached snapshot with `lastRefreshedAt` timestamp; never throws to SPA. SPA renders snapshot even if stale. |
| Per-harness subprocess fails (`claude auth status` exits non-zero) | Existing `preflight/claude-auth.js` shape preserved inside `claude-code-learner`'s `isReady()` impl; non-zero exit → `ready: false` with `reason: stderr ?? 'auth status exited <code>'`. |
| Operator joins SolverNet with unknown harness name | Zod schema in config rejects unknown names at join time (already in place via `HarnessNameSchema`). Daemon never sees the bad value. |
| Joined config references harness the daemon doesn't ship | `HarnessReadinessRegistry` returns `{ ready: false, reason: 'harness <name> not registered in this daemon build', nextStep: { description: 'Upgrade daemon or change SolverNet harness selection' } }`. SPA renders standard card. |
| `isReady()` returns ready=true but `harness.run()` throws auth error at claim time | Cache TTL is 4s — bounded staleness. Claim throws → existing claim-failure paths. Next tick re-probes; readiness flips false; next loop iteration skips. |
| Auth flow crashes mid-OAuth (xterm dies, operator closes browser) | Existing `/v1/auth/claude/spawn` behavior unchanged. `HarnessPrecheckPanel` next poll sees `ready: false` and re-renders sign-in affordance. |
| Migration boot: daemon upgrades, old config in place | Daemon no longer exits. (a) Claude-OAuth-ed operator → readiness ready=true → zero visible change. (b) No joined SolverNets → empty readiness, loops idle (unchanged). (c) Pre-existing inconsistency (Claude-using SolverNet joined but unauthenticated, impossible today) → SPA surfaces card on next visit, no behavior break. |
| Auth state expires mid-runtime (Claude token refresh fails) | Next 4s tick re-probes; readiness flips false; next claim tick skips; SPA card reappears. Operator re-auths via same flow. No daemon restart needed. |

**Performance note**: subprocess spawn frequency. Current `Onboarding.tsx` already polls `/v1/auth/claude` every 4s; that triggers `claude auth status` server-side. The new registry tick at the same 4s cadence preserves this; multi-harness operators see one spawn per joined-distinct-harness per tick. Negligible at typical scale (1-3 harnesses).

## Testing strategy

**New unit tests:**
- `HarnessReadinessRegistry` — compose / cache / refresh / handle isReady() exceptions / unknown harness / empty joinedSolverNets.
- Per-harness `Harness.isReady()` impls — claude-code-learner returns the right shape on each `claude auth status` outcome; hermes-agent's `isReady` wraps the existing doctor logic; others as needed.

**New integration tests:**
- Daemon doesn't exit on missing Claude auth — mock `claude auth status` to return `loggedIn: false`; assert daemon reaches running mode (no `exitCode=11`); assert `/v1/harnesses/readiness` reports claude-code-learner as not ready.
- Claim loop gates on readiness — mock registry to return false → assert no claim tx; mock true → assert claim proceeds.
- `/v1/harnesses/readiness` composed endpoint — returns expected shape for joined-harness fixture set.
- `/v1/harnesses/<name>/readiness` per-harness endpoint — returns single-harness snapshot.

**New SPA tests:**
- `HarnessPrecheckPanel.test.tsx` — generalized version covers Hermes + Claude state machines (replaces `HermesPrecheckPanel.test.tsx`).
- `JoinFlow.test.tsx` — Save button disabled until all selected-role harnesses report ok; per-harness panel renders correctly for solver + evaluator harness pair.
- `Onboarding.test.tsx` — renders 3 phases; asserts no "Sign in to Claude" card present; existing phase-progression tests stay green.

**Updated existing tests:**
- `preflight/claude-required.test.ts` — deleted (file goes away with `configRequiresClaudeAuth`).
- `bootstrap.test.ts` — Phase 1 transition no longer requires Claude auth; bootstrap completes regardless of harness readiness. Existing `agent_registered step retries setAgentWallet on transient failure (jinn-mono-h74p)` and adjacent tests should remain green.
- `setup-endpoints.test.ts` — `/v1/auth/claude` and `/v1/auth/claude/spawn` tests preserved; new tests for `/v1/harnesses/readiness` and `/v1/harnesses/<name>/readiness`.

**Manual verification gate** (release-blocking, doc-only — not automated):
- Clean-HOME walkthrough on a machine WITHOUT prior Claude OAuth — verify the install path the original `jinn-mono-uy6v.4` walkthrough couldn't reach due to the daemon exit gate. Confirms the architectural fix lands operator-visible behavior.

## Migration / rollout

- No data migration required.
- Single-version cutover: the new daemon does both jobs (composes readiness + skips claims when not ready). No feature flag needed because the new behavior is strictly safer than the old (daemon never exits where it would have; previous-passing operators continue to pass).
- Coordination with Hermes branch: this design assumes Hermes lands in main first. Once merged, the Hermes-specific endpoint (`/api/hermes/doctor`) is replaced by the generic `/v1/harnesses/hermes/readiness`, and `HermesPrecheckPanel` is renamed/generalized to `HarnessPrecheckPanel`. The Hermes-pioneered shape stays; just gets a different name and a sibling Claude impl.

## Open implementation questions

These don't gate the design; they surface during the implementation plan:

- Should `HarnessReadinessRegistry`'s 4s tick interval be configurable via `FleetBootstrapperOptions` (or the equivalent for the registry's owner)? Tests need fast paths; defer to plan.
- Should the daemon emit metrics (counters / gauges) for readiness state changes? Probably useful for ops; defer to plan if release-relevant, otherwise file as a follow-up.
- Does the `HarnessPrecheckPanel` need a "skip" affordance for operators who genuinely want to join without setting up the harness yet (e.g., to claim later)? Probably yes for evaluator-only joins where solver-harness setup is optional. Decide in plan.
