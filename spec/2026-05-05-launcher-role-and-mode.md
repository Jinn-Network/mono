# Launcher role and Launcher mode

- **Date:** 2026-05-05
- **Author:** ritsukai with Opus (brainstorm session)
- **Status:** Draft for Captain review
- **Version:** 0.1
- **Related:**
  - Discussion #59 — *Jinn as the knowledge market — implementation roadmap proposal* (substrate vision)
  - Discussion #57 — *Unified GTM around the Prediction SolverNet* (paired GTM)
  - `spec/2026-04-30-phase-a-umbrella.md` — Phase A roadmap this spec lives under
  - `spec/2026-05-02-task-coordinator-one-to-many.md` — funding model this spec composes against (per-attempt budget, Creator Safe)
  - `docs/superpowers/plans/2026-05-02-prediction-solvernet-v1-task-lifecycle.md` — generator design contract
  - `client/src/solver-types/prediction-v1-auto.ts` — generator implementation already in-tree
  - `client/src/config.ts` — config schema this spec extends (the `predictionV1Launcher*` keys originated here)
  - bd `jinn-mono-l2zl` — parent epic; bd issue for this spec's implementation will be filed alongside

---

## 1. Purpose

Define the **Launcher role** and the **Launcher mode** so Jinn team can run the Prediction SolverNet's launcher day-1 from the operator app, and so a clean fork-able shape exists for external launchers later.

The Polymarket-derived Task generator is fully built (`client/src/solver-types/prediction-v1-auto.ts`). What this spec adds is the role/persona layer on top: a launcher's identity in the daemon's role taxonomy, a UI surface in the operator app, and a clear day-1 invariant set. No new on-chain contracts. No changes to the generator's internals.

This is a design spec. Implementation proceeds via a follow-up plan.

## 2. Framing — what a Launcher is

A **Launcher** is a participant who directs the network toward producing knowledge about a specific domain. They believe the resulting knowledge has value — for themselves, for an external market, or for the network's collective intelligence — and they fund Task creation in a SolverNet they own to pull network effort toward producing it.

The Launcher is the third role in Jinn's loop alongside Operator (Solver/Evaluator) and Builder:

| Role | Question they answer | Day-1 reality |
|---|---|---|
| **Builder** | "What kind of knowledge work is this network shaped to produce?" — designs SolverNets, harnesses, plugins | Jinn team only; external builders later |
| **Launcher** | "Which knowledge area should the network produce now? Who pays?" — funds Tasks, runs generators, directs incentives | Jinn team only for Prediction; external launchers fork their own SolverNets later |
| **Operator** | "Whose Tasks do I attempt or evaluate?" — runs Solver/Evaluator loops on enabled SolverNets | Open to external operators today |

Today (Phase A.4) Jinn team is the sole Launcher of Prediction. The launcher funds Tasks directly out of the master EOA-controlled Safe. Later (Phase B+) Launchers will direct protocol-level JINN emissions via ve-JINN gauges; that is **out of scope** for this spec but signposted in the UI.

## 3. Day-1 invariants

The spec rests on these. They are explicit so reviewers can challenge them as a unit:

1. **One SolverNet, one Launcher.** Forking means forking the SolverNet definition (e.g. `prediction.v1` → `myforecast.v1`), not running a parallel launcher on the same net. Two daemons accidentally configured as launcher for the same net would race; first wins on-chain via `taskCid` dedup; the second wastes gas. Gas cost is the natural disincentive — no on-chain coordination protocol is needed.
2. **One identity, one Safe, one bootstrap.** The Launcher reuses the operator's master EOA + Safe + 11-step earning bootstrap (`client/src/earning/bootstrap.ts`). No separate launcher wallet. The same Safe pays for OLAS staking *and* for posted Task budgets.
3. **Multi-role daemon.** A single daemon can run any combination of `solving`, `evaluating`, `launching` roles per SolverNet, building on the `roles: Array<...>` schema shipped in `jinn-mono-l2zl.15.4.8`. The team's daemon can launch Prediction *and* solve/evaluate other SolverNets simultaneously.
4. **Modes are UI lenses, not daemon state.** *Switching* between Operator and Launcher mode is a localStorage preference; the switch itself never writes daemon config. *Actions inside a mode* (e.g. completing the Launcher setup flow, ticking a role checkbox in Operator-mode Configuration) do write daemon config — that's how the role state is set. The distinction matters because it means a user can freely flip between modes to look around without changing what their daemon does.
5. **Roles are configured by the mode that owns them.** Operator mode owns the per-SolverNet `solving`/`evaluating` checkboxes shipped in `.15.4.8`. Launcher mode owns the per-SolverNet `launching` configuration. There is no prerequisite "first enable launching elsewhere" — entering Launcher mode is the entry point to launcher setup.
6. **Launcher economics deferred.** Whether the launcher Safe earns staking rewards / fees / future ve-JINN gauge weight is Phase B+ territory. Day-1 the launcher runs at a net cost (Task funding flows out; no in-spec earning flows in). The SolverNet exists for the *value of the knowledge produced*, not for direct daemon-level rewards.

## 4. Conceptual frame — roles vs modes

| | Roles | Modes |
|---|---|---|
| **What it is** | Daemon capability per SolverNet | UI lens in the operator app |
| **Where it lives** | `~/.jinn-client/config.json` | `localStorage` |
| **Who sets it** | Whichever mode's UI surface owns it (Operator mode for solving/evaluating; Launcher mode for launching) | The user, via the mode switch in the app header |
| **Effect on daemon** | Determines which loops run | None |
| **Day-1 values** | `solving`, `evaluating`, `launching` | `operator`, `launcher` (`builder` deferred) |

Modes provide an **information hierarchy and entry point**, not a security or capability boundary. All modes are always available in the header switch; switching to a mode you have not used yet lands you on its empty/setup state.

## 5. Daemon shape

### 5.1 Role enum extension

Per-SolverNet `roles` adds a third value:

```ts
// before (.15.4.8)
roles: Array<'solving' | 'evaluating'>

// after (this spec)
roles: Array<'solving' | 'evaluating' | 'launching'>
```

Validation rules from `.15.4.8` carry forward unchanged:

- Non-empty array.
- Deduped on read.
- Zod `preprocess` auto-migrates legacy `role: 'X'` config to `roles: ['X']`. (Only relevant for `solving` / `evaluating` — `launching` was never expressed as a single-value `role`.)
- Setup endpoint accepts both wire shapes for backwards-compat; persists canonical `roles`.

### 5.2 Generator gating — replace the boolean, hot-spawn the loop

Today the Polymarket generator is gated behind `predictionV1LauncherEnabled: boolean` (`client/src/config.ts:318`). That flag is **removed**. Gating moves to:

```ts
solverNets.prediction.roles.includes('launching')
```

The generator's internals (`client/src/solver-types/prediction-v1-auto.ts`) do not change. What does change is **how the gate is evaluated**: today the boolean is read at startup and decides whether the generator loop ever spawns; this spec requires the role gate to be evaluated at runtime so toggling `'launching'` in or out of `roles` takes effect **without restarting the daemon**.

Two acceptable implementations (the implementation plan picks one):

- **Always-spawn, tick-time gate.** The generator loop is started at daemon boot regardless of role; each tick checks `roles.includes('launching')` for the SolverNet — if false, sleep + continue (no Polymarket call, no posting); if true, run the poll. Cost: a near-zero idle loop. Simplest.
- **Spawn-on-demand.** The daemon watches the per-SolverNet config; on transition to `launching` it spawns the generator loop, on transition off it tears it down cleanly. Cleaner separation; slightly more plumbing around lifecycle and in-flight poll-cycle drains.

Either way, **adding or removing `'launching'` from `roles` does not require a daemon restart**. The change takes effect within one cadence tick. Restart-required signaling on the Launcher mode setup flow is therefore not necessary.

The other generator config keys (`predictionV1CadenceMs`, `predictionV1MaxNewRoundsPerPoll`, `predictionV1MaxNewRoundsPerDay`, `predictionV1MaxOpenRounds`, `predictionV1AllowlistConditionIds`, `predictionV1BlocklistConditionIds`, `predictionV1WindowMs`, `predictionV1ResolveGapMs`) stay where they are. They are launcher-tunable; Launcher mode's Configuration page edits them. These keys are read each tick, so edits to them also hot-apply.

### 5.3 Read endpoints

Two new endpoints under `/v1/launcher/*` for the Launcher mode UI:

#### `GET /v1/launcher/status`

Per-SolverNet generator and budget state for any SolverNet with `'launching'` in its roles.

```ts
interface LauncherStatusResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: Array<{
    name: string;                         // SolverNet name, e.g. 'prediction'
    generator: {
      state: 'active' | 'paused' | 'errored';
      lastPollAt?: string;
      lastPollSummary?: {
        evaluated: number;
        posted: number;
        skipped: number;
        skipReasons?: Record<string, number>;  // e.g. { 'liquidity-floor': 12, 'spread-too-wide': 4 }
      };
      lastError?: { message: string; at: string };
      cadenceMs: number;
      stale?: boolean;                    // true if (now - lastPollAt) > 2 × cadenceMs
    };
    openTasks: number;
    budget: {
      safeAddress: string;
      safeBalanceWei: string;             // ETH balance — gas + collateral
      reservedBudgetWei: string;          // sum across open Tasks (maxClaims × perAttemptPayment)
      runwayDays?: number;                // estimate: spend rate vs. balance
    };
  }>;
}
```

The generator's existing in-memory state (last-poll summary, dedup map cardinality, error log) becomes readable via this endpoint. No new persistence layer; if the daemon restarts, the status reflects post-restart state.

#### `GET /v1/launcher/tasks`

Tasks posted by this daemon's creator address. Sourced from the existing router log polling (the `l2zl.12` polling-hardening lane is the natural place to add this filter; the launcher endpoint can ship before that lane completes by reusing the existing watcher).

```ts
interface LauncherTasksResponse {
  schemaVersion: 1;
  generatedAt: string;
  cursor?: { before: string };  // pagination
  tasks: Array<{
    taskId: string;
    taskCid: string;
    solverNet: string;
    postedAt: string;
    state: 'open' | 'claims-in-flight' | 'fully-claimed' | 'settled' | 'failed';
    claims: { current: number; max: number };
    budget: { totalWei: string; remainingWei: string; reclaimableAt?: string };
    summary?: {                  // SolverNet-specific projection — Prediction shows the predicate
      title?: string;
      resolutionTime?: string;
    };
  }>;
}
```

Pagination by posted-time cursor; default page size 25.

### 5.4 What is **not** in the daemon spec

- **Manual one-off Task posting (`POST /v1/launcher/tasks`)** — UI affordance and endpoint deferred. Auto-generator covers day-1.
- **Pause/resume runtime control** — intersects with hot-reload (`jinn-mono-t62s`). Day-1 launcher pauses by editing config + restarting (or by removing `'launching'` from roles, which restarts the generator loop on next config write). Runtime pause is a follow-up.
- **Dedicated launcher Safe / treasury contract** — explicitly absent (invariant 2).
- **Launcher activity-checker / earning hooks** — Phase B+.

## 6. Operator app shape

### 6.1 Header mode switch

A persistent control at the top of the app shell (`client/src/dashboard/spa/src/shell/Header.tsx` or equivalent). Two states for day-1:

- `Operator`
- `Launcher`

State persists in `localStorage` under a stable key (e.g. `jinn.app.mode`). Default = `Operator`. Switching is an instant route change; no daemon write.

Builder mode is a future possibility but **not** in this spec or the day-1 UI. The mode switch is two-state only.

### 6.2 Route layout

| Route | Mode | Page |
|---|---|---|
| `/` | Operator | Overview (today's page) |
| `/configuration` | Operator | Configuration (today's page) |
| `/launcher` | Launcher | Launcher overview |
| `/launcher/configuration` | Launcher | Per-SolverNet generator config |

Mode-specific routes are gated only by the localStorage mode preference for navigation purposes; the routes themselves are reachable directly. Hitting `/launcher` from a fresh install lands on the empty/setup state (§6.4).

### 6.3 Operator mode

No changes from today. Existing pages, existing role checkboxes (`solving` / `evaluating`) on per-SolverNet cards continue to work as shipped in `.15.4.*`.

**Strict mode separation.** Operator mode displays *zero* launcher state. The OperatorCard pills only render `solving` and `evaluating`; `launching` never appears in Operator mode anywhere — no pill, no banner, no "you are also launching" hint. This matches the Airbnb framing: when you're in guest mode you don't see hosting state, and vice versa.

To enforce this at the type level, `operator.solverNet.roles` in the operator-status payload narrows to `Array<'solving' | 'evaluating'>`. The daemon's gather-status filters `'launching'` out of the operator-status payload at the boundary; launcher state lives exclusively in `/v1/launcher/status` (§5.3).

### 6.4 Launcher mode

#### Empty / setup state

When no SolverNet has `'launching'` in its roles:

> **You haven't launched a SolverNet yet.**
>
> A SolverNet directs the network's effort toward producing a kind of knowledge. As Launcher you fund the Tasks operators attempt — and own what gets produced.
>
> [ Launch Prediction SolverNet ]

The CTA opens a setup flow:

1. **Confirm SolverNet.** Day-1 only Prediction is launchable. Show the SolverNet's intent ("Calibrated probabilistic forecasts of Polymarket-listed events") + the canonical scoreboard ("Brier spread vs. Polymarket consensus over a rolling window").
2. **Confirm generator defaults.** Cadence, market filters, caps from `prediction-v1-auto.ts`. Operator can edit; defaults are sensible.
3. **Show informational budget plan.** Read Safe balance via the existing balance API; display "this funds approximately N Tasks at the current per-attempt payment, ~M days at current cadence". No funding action — Safe is funded out-of-band like operator earning Safe.
4. **Save.** Patch sets `roles: [...currentRoles, 'launching']` for the prediction SolverNet via the existing `api.updateSolverNet` endpoint. Per §5.2 the generator hot-spawns within one cadence tick — **no daemon restart**. The setup flow shows a "starting up — first poll within Xs" indicator instead of a restart banner.

After save, Launcher mode lands on the configured-state overview (§6.5).

#### 6.5 Configured state — Launcher overview

Information hierarchy reflects the framing in §2 (Launcher = direct knowledge production, not "run the auto-generator"):

1. **What knowledge is this SolverNet producing.** Brier spread vs. Polymarket consensus (reuse the existing scoreboard from `jinn-mono-l2zl.5`), corpus growth (count of settled Verdicts in window), recent settled forecasts (top 5 with predicate + outcome). The headline section.
2. **Cost of producing it.** Safe burn rate over last 7d, Tasks funded over last 7d, current open-Task budget reservations. A second-tier section.
3. **Generator status.** State pill (active / paused / errored), last poll timestamp + summary, recent posted Tasks (5 latest with state). Tactical, third tier.
4. **Direct JINN emissions to this SolverNet.** Phase B+ placeholder section. Disabled, with explanatory copy: "When ve-JINN gauges ship, you'll be able to direct protocol-level emissions toward this SolverNet here."

Per-SolverNet card actions:

- **Edit generator config** → deep-link to `/launcher/configuration#<solver-net>`.
- **View all Tasks** → expands the Tasks list (paginated via `/v1/launcher/tasks`).
- **Stop launching** → patches `roles` to remove `'launching'`. Confirms before submit.

#### 6.6 Launcher configuration page

Per-SolverNet form for the generator config keys listed in §5.2. Layout mirrors the Operator-mode Configuration page (`SectionCard` + `ConfigField` components from `client/src/dashboard/spa/src/components/`). Edits hot-apply per §5.2 — no restart-required signaling needed for these fields. Save = `api.updateSolverNet` with the generator config block.

For day-1 Prediction, the editable fields are:

- Cadence (ms)
- Max new rounds per poll
- Max new rounds per day
- Max open rounds
- Allowlist condition IDs
- Blocklist condition IDs
- Window (ms) — Task claim/submission window
- Resolve gap (ms) — buffer between resolution and claim cutoff

Filters that are not safely operator-tunable (e.g. liquidity floor, spread max) stay in `prediction-v1-auto.ts` defaults for day-1; if external launchers later need them tunable, they graduate to config keys then.


## 7. Wallet / bootstrap

The Launcher reuses the existing 11-step earning bootstrap unchanged (`client/src/earning/bootstrap.ts`). The bootstrap is role-agnostic — it makes the master EOA, predicts and deploys the Safe, registers the OLAS service, stakes, deploys the mech. None of that is operator-specific.

A user who installs `@jinn-network/client` and goes straight to Launcher mode without ever solving:

1. Bootstrap runs as today on first `jinn run`.
2. Funding gate at `awaiting_funding` blocks until the master EOA has ETH and the Safe has OLAS — same as operator path.
3. After bootstrap completes, Launcher mode's setup flow patches `roles: ['launching']` on the prediction SolverNet.
4. Launcher mode's Overview displays a "fund the Safe to start posting Tasks" banner if Safe ETH is below a launcher-specific threshold (separate from the operator gas-runway threshold). Funding action is the same as operator: send ETH to the Safe address shown.

Same Safe pays for OLAS staking collateral *and* for posted Task budgets. The launcher's daily Task spend is bounded by `maxClaims × perAttemptPayment × maxNewRoundsPerDay`; the launcher mode's overview surfaces this as the "burn rate" so the Safe doesn't drain unnoticed.

## 8. Day-1 scope

**In scope (this spec → implementation plan):**

1. Daemon: extend `roles` to include `'launching'`; remove `predictionV1LauncherEnabled`; gate the Polymarket generator on `roles.includes('launching')` evaluated at runtime (hot-spawn — no daemon restart needed to toggle launching role; §5.2).
2. Daemon: filter `'launching'` out of operator-status payload (`operator.solverNet.roles` narrows to `'solving' | 'evaluating'`) so Operator mode UI never sees launcher state.
3. Daemon: `GET /v1/launcher/status` endpoint with stale-poll detection (§5.3).
4. Daemon: `GET /v1/launcher/tasks` endpoint.
5. App: header mode switch with Operator / Launcher (two-state).
6. App: `/launcher` overview empty state + setup flow.
7. App: `/launcher` configured-state overview with the four-tier information hierarchy from §6.5, including a stale-generator warning banner when `status.stale === true`.
8. App: `/launcher/configuration` per-SolverNet generator config page (no restart-required signaling — all edits hot-apply).
9. Tests at the corresponding levels (config schema migration, role hot-spawn, endpoint shape, SPA route + component coverage, setup-flow happy path, stale-warning rendering, Operator mode strictly hides launcher state).
10. Type updates in `client/src/dashboard/spa/src/api/types.ts` for the new launcher payload shapes and the narrowed operator-status `roles` type.

**Deferred (filed as bd issues post-spec, not addressed by this implementation plan):**

- Manual one-off Task posting (`POST /v1/launcher/tasks` + UI form).
- Builder mode and the Builder persona spec.
- Launcher economics — staking rewards, ve-JINN gauges, fee capture (Phase B+).
- Launcher Safe / Operator Safe separation (only revisit if an external use case demands it; today they share by design per invariant 2).

**Explicitly disclaimed (won't re-litigate):**

- Multi-launcher coordination on the same SolverNet. Invariant 1 makes this a non-problem; gas cost is the natural disincentive against accidental duplication.

## 9. Open questions

All four open questions raised during the brainstorm have been resolved into the spec body:

- **Builder mode placement** → not in this spec; mode switch is two-state (§6.1, §8 deferred).
- **Launcher status freshness** → `stale` flag on the status payload, banner in Launcher overview when stale (§5.3, §6.5, §8 in-scope #7).
- **Operator Overview vs launcher state** → strict mode separation; Operator mode never displays launcher state; operator-status payload narrows to exclude `'launching'` (§6.3, §8 in-scope #2).
- **Restart-required vs hot-spawn** → hot-spawn within one cadence tick; no daemon restart for role flip or generator-config edits (§5.2, §6.4, §6.6, §8 in-scope #1).

No remaining blockers for the implementation plan.

## 10. References

- `client/src/solver-types/prediction-v1-auto.ts` — generator implementation
- `client/src/config.ts:304-348, 697-730` — current generator config schema + env var bindings
- `client/src/dashboard/spa/src/pages/configuration/NetCard.tsx` — per-SolverNet card pattern to mirror in Launcher mode
- `client/src/dashboard/spa/src/components/{SectionCard,ConfigField,RestartPill}.tsx` — reusable building blocks
- `spec/2026-05-02-task-coordinator-one-to-many.md` §8 — lazy attempt funding model the launcher's Safe interfaces with
- `docs/superpowers/plans/2026-05-02-prediction-solvernet-v1-task-lifecycle.md` — generator design contract
- bd `jinn-mono-l2zl.15.4.8` (closed) — `roles: Array<...>` schema this spec extends
- bd `jinn-mono-l2zl.12` — router log polling hardening lane that intersects with `/v1/launcher/tasks`
- bd `jinn-mono-t62s` (open) — hot-reload, intersects with launcher pause/resume
