---
title: Operator app — Overview + Configuration page split
date: 2026-05-04
author: oak
status: draft
supersedes: portion of `docs/superpowers/plans/2026-05-01-operator-local-app.md` that establishes the single-Operating-page model
---

# Summary

Split the current single-page Operating dashboard into two top-level surfaces — `Overview` and `Configuration` — connected by a persistent shell and a persistent right-rail Agent panel. Make every operator-tunable runtime setting editable from the app. Drop the framing that surfaces config state as red `ERROR` rows; replace with calm in-place affordances that match the operator's actual cognitive model.

This spec covers information architecture, page composition, the SolverNet catalog data model, save lifecycle, restart-required signaling, the API surface, and the migration path away from `Operating.tsx` as a monolith.

Out-of-scope (filed as separate issues, see §11): hot-reload of SolverNet config without daemon restart; smooth restart-with-auto-reconnect overlay; full `Activity` page; Brier scoreboard / leaderboard surface inside the SPA; multi-Safe / multi-fleet operators.

# Why

The current Operating page mixes ambient state (status, activity, identity), occasional actions (claim, top-up, restart), and config state (SolverNet status framed as red `ERROR`s with no in-app fix path) into one scroll. It works for a single SolverNet at a single moment of bad config. It does not scale to:

- The catalog of SolverNets the operator picks among (currently `prediction`, soon `portfolio` and others).
- The operator-tunable surface beyond enable/disable: Role per SolverNet (Solving vs Evaluating), Harness, Claude model, Plugins, RPC URL.
- The operator's actual behaviour pattern: ambient check-ins many times a day, focused config sessions occasionally, deep investigation rarely.

Discovered while walking the operator-app testnet flow on 2026-05-04 (`operator-shakedown` branch). Phase A+B of in-app config edit (jinn-mono-336m, jinn-mono-* SolverNet enable + version-swap) shipped as an interim fix on the existing Operating page. This spec establishes the page-split that those affordances should ultimately live in.

# Goals

1. Two purposeful surfaces — `Overview` for ambient state + occasional actions; `Configuration` for intentional change.
2. Every operator-tunable config field is editable from the app. Operators never need to leave the dashboard to edit `~/.jinn-client/config.json`.
3. Configuration follows progressive-disclosure UX best practice: collapsed sections by default, ordered by frequency-of-change, edit affordances revealed only when the operator opts in.
4. The persistent right-rail Agent panel works on both pages. Agent never gets hidden behind a tab.
5. Alerts on `Overview` deep-link into the exact `Configuration` section that resolves them.
6. Per-section save lifecycle (no global save button, no global dirty-state). Each section's edits land or get discarded independently.
7. Restart-required vs hot-reload-safe is communicated *per field*, not just per-action. Operators always know what their save will do.
8. Public network state and operator-specific state are visually separated on Overview — the same SolverNet shows two cards, one read-by-anyone (counters), one operator-only (role + state). This prevents the conflation that motivated Issue #86 §2.
9. Operator-facing copy is consistent (one term — *node* — for the runtime; *daemon* reserved for engineer-facing logs) and never contradicts itself with vacuous prompts (e.g. "start the daemon" when the daemon is already running). Issue #86 §1.
10. The Safe-to-agent ERC-1271 binding state is surfaced and retryable in-app even while the contract-side fix lands separately. Issue #86 §6.

# Non-goals

- Hot-reload of SolverNet / harness / plugin config without daemon restart (separate spec).
- Auto-restarting + auto-reconnecting the daemon as part of save flow (separate spec — for now operators click the existing `Restart Node` quick action).
- A dedicated `Activity` page with full task history. The Overview's recent-activity card carries that load until a richer surface earns the slot.
- Mobile / narrow-viewport layout. The dashboard is desktop-first; narrow-viewport behaviour is correct-but-ugly fallback.

# Information architecture

## Persistent shell

```
┌──────────────────────────────────────────────────────────────────┐
│ jinn operator       TESTNET  ● rpc healthy   master 0xE64b…B5CF  │   ← Header (persistent)
├──────────────────────────────────────────────────────────────────┤
│  Overview   Configuration                                         │   ← TopTabs (persistent)
├────────────────────────────────────────────────┬─────────────────┤
│                                                 │                 │
│  [tab content fills main column]                │  Claude         │   ← AgentRail
│                                                 │  ● connected    │      (persistent,
│                                                 │  auto mode      │       collapsible)
│                                                 │  [terminal]     │
└────────────────────────────────────────────────┴─────────────────┘
```

- **Header** — brand mark (Instrument Serif `jinn operator`), network chip, RPC health pill (vow-green dot), master EOA short. Brand mark click = navigate to `/overview`.
- **Top tabs** — ALL CAPS MONO labels, 0.14em tracking, 1px sky underline 4px below the active label per `DESIGN.md` nav rules. Two tabs: `Overview`, `Configuration`.
- **Agent rail** — extracted from the current `Operating.tsx`. Persistent across tabs. Collapsible to a slim icon column; collapsed-state preference persists in `localStorage`.
- **Layout** — CSS Grid: `grid-template-rows: auto auto 1fr`, `grid-template-columns: 1fr 320px`. Rail sticky to the top of the body region.

## Routing

Introduce `wouter` (~3 kB, hooks-based, no provider noise). Routes:

| Path                       | Renders            | Notes |
|----------------------------|--------------------|-------|
| `/`                        | redirect           | `mode === 'running'` → `/overview`; otherwise stay in Onboarding (existing behaviour) |
| `/overview`                | `OverviewPage`     | default operating destination |
| `/configuration`           | `ConfigurationPage`| sections collapsed by default |
| `/configuration#solvernets`| `ConfigurationPage`| section auto-expands on mount via hash |
| `/configuration#solvernets/prediction` | `ConfigurationPage` | section + named net auto-expands |
| `/configuration#network`   | `ConfigurationPage`| section auto-expands |
| `/configuration#security`  | `ConfigurationPage`| section auto-expands |

Why hash anchors not sub-routes: deep links route to a *position within the page*, not a separate sub-view. Hash anchors match this semantic without inflating the route tree, and they survive history/back exactly like a normal anchor.

Onboarding mode unchanged — `App.tsx` continues to short-circuit to `<Onboarding />` while `mode !== 'running'`. The new shell only matters once bootstrap completes.

# Overview page

Single-column scrolling layout in the main column. Sections in this order:

1. **Hero stats** — four cards in a 4-up grid: `Tasks delivered`, `JINN earned`, `Gas runway`, `Node status`. Numbers are JetBrains Mono (data = doing per the two-voices rule).
2. **Alert band** — only renders when something needs attention. Gold-bordered `bg-elevated` card with a single-line message and a sky `Configure <name> →` link that hash-routes into the relevant Configuration section. Multiple alerts stack as additional bands. The alert band is the *only* gold element on Overview (gold-as-hint rule).
3. **Recent activity** — card with the last 10 events, "View all" footer that toggles a longer in-place list (no separate page yet).
4. **Quick actions** — 4-up grid: `Claim JINN`, `Top up gas`, `Manage wallet`, `Restart node`. Ghost buttons (transparent, hairline, mono).
5. **Identity** — single card: agent NFT (`#5474 active`), chain (`Base Sepolia`), service Safe (`0x0e76…4FC`).
6. **Advanced details** — collapsed disclosure, current `AdvancedDetails` content from `Operating.tsx` retained verbatim.

## Multi-SolverNet handling on Overview — public / operator split

The current `PredictionPanel` mixes two distinct concerns into one card: public network-wide counters (Tasks, Active, Solutions, Verdicts, Failed — these describe the *SolverNet*, not this operator) and operator-specific state (the operator's Role, Harness, Plugins, Task generator — these describe *this node*). Per Issue #86, this conflation makes the panel hard to read and prevents reuse of the public counters in non-operator surfaces (marketing, public explorer, third-party dashboards).

The page-split splits this in two:

- **Network card** (one per known SolverNet, regardless of operator opt-in): public counters only — `<net name> · tasks · active · solutions · verdicts · failed`. Sourced from the public status feed; renders even when the operator is not participating. No operator-specific state. No "View" CTA — the Network card is informational.
- **Operator card** (one per *enabled* SolverNet only): operator-specific state — `<net name> · role · state pill · "View" link to Configuration`. Disappears entirely when the operator is not participating in any SolverNet; in that case the empty-state CTA replaces both — "Pick a SolverNet to participate in →" deep-linking to `/configuration#solvernets`.
- The detailed PredictionPanel diagnostic surface (recent tasks list, harness readiness, plugins) moves into the per-net card *inside* the SolverNets section on Configuration. It is no longer on Overview.

When zero nets are enabled but several are known, the page renders the Network cards above an empty-state operator-side band. This communicates "the network is doing X; you are not participating" without conflating the two views.

## Status copy correctness

A symptom of the same conflation: the operator dashboard simultaneously shows "Node status: Running" (top tile), "Prediction SolverNet is configured; start the daemon to watch shared Tasks. `jinn run`" (mid card), and "Quiet. The daemon is running; nothing has happened recently." (bottom). The middle string is a stale setup-mode template that fires regardless of whether the daemon is actually running, and the dashboard alternates between calling the same thing "node" and "daemon" with no defined difference.

The page-split fixes both:

- **Drop the "start the daemon" diagnostic** when `mode === 'running'`. The diagnostic lives in `prediction-operator-ux.ts` and is correct for the setup-mode UI but vacuous on the running-mode dashboard. Replace with a "Waiting for Tasks" message that shows *why* nothing is happening — "SolverNet active, Harness loaded; no incoming Tasks since startup" or similar.
- **Pick one term and use it consistently.** The codebase calls the runtime process the *daemon*; the operator-facing copy calls it the *node*. The page-split standardises on **node** in operator-facing copy (Overview, Configuration, Quick Actions, alert messages) and reserves *daemon* for engineer-facing logs and diagnostic envelopes. Define this in a one-line tooltip on the "Node status" tile so the operator who follows the documentation isn't confused by log lines that say "daemon".

## Safe-to-agent binding: surface and retry

The `setAgentWallet` ERC-1271 binding step inside `agent_registered` reverts on Base Sepolia today (Issue #86 §6). The bootstrap correctly continues with `safe_bound_to_agent=false`, but the operator has no in-app signal that the binding didn't land.

Surface this on the `IdentityCard` (Overview) as a wane-coloured chip: `binding pending`. Click expands a small inline disclosure with the last failure summary (drawn from `state.services[i].error` or the bootstrap-error envelope) and a `Retry binding` button. Clicking calls `POST /v1/setup/agent-binding/retry` (new endpoint, see §API surface), which re-runs `stepBindAgent` for the affected service without a daemon restart.

The contract-side investigation of *why* the bind is reverting (ERC-1271 wiring on the IdentityRegistry against a fresh 1/1 Safe) is out of scope for this spec — filed separately. The page-split fix is purely operator-app surface: the UX should not silently leave the operator on a half-bound service, and a one-click retry is cheap to add now while the contracts work happens in parallel.

# Configuration page

Sections, in frequency-of-change order:

1. **SolverNets** (catalog)
2. **Network** (editable RPC, locked chain)
3. **Security** (password rotation, danger zone)

Each section is a `SectionCard` with a clickable head that toggles expand/collapse. Default state on first render: all collapsed except `SolverNets`.

The previous `Defaults` and `Custom tasks` sections are removed:

- **Defaults removed** — every SolverNet specifies its own Harness and Claude model. A separate "fallback for nets that don't override" section is redundant once the catalog model lands; nets without an explicit override fall back to the SolverNet plug-in's bundled default, not to a config field. (Decision made during the v3→spec transition; if this proves wrong in implementation we add it back as a single field, not a section.)
- **Custom tasks removed** — operators do not configure tasks. Tasks come from launcher-owned task generators; the operator's node consumes them. What the node is currently doing appears in Overview's Recent activity.

## Section card pattern

```
┌── SectionCard ──────────────────────────────────────────────┐
│  Title                                  [meta-chip]   ▸ / ▾ │
│  summary text (live state, single line)                     │
├── (only when expanded) ─────────────────────────────────────┤
│                                                              │
│  body content                                                │
│                                                              │
│  ──── (only when dirty) ─────────────────────────────────── │
│  X changes pending · field names                  [Cancel] [Save changes] │
└──────────────────────────────────────────────────────────────┘
```

- Head is always visible. Always shows the section title and a one-line summary of current state.
- Optional `meta-chip` (vow-green `Live`, wane `Needs attention`, fg-dim `Default`, vow-green `Healthy`, break-red `Danger zone`).
- Body renders only when expanded.
- Save lifecycle is per-section: while editing, a footer renders with `Cancel` (revert local edits) + `Save changes` (POST to the relevant API). On success, footer collapses; the section's summary updates from the new server state.
- While saving, footer disables both buttons and shows a "Saving…" sky-coloured line.
- On save failure, error renders in the footer in break-red; buttons re-enable.

## SolverNets section (catalog)

Body renders one `NetCard` per SolverNet known to the registry. Cards are ordered:

1. Live (operator-enabled and currently running)
2. Available (registered, not enabled)
3. Coming soon (registry placeholder, locked toggle)

Each `NetCard`:

- **Head row** — sigil mark (placeholder until per-net sigils land, see `BRAND.md`), name + one-line description, state pill, enable toggle.
- **State pill** — `Live` (vow-green), `Available` (border, fg-muted), `Needs attention` (wane), `Coming soon` (locked).
- **Body** — renders only when enabled. Grid of fields:
  - **Role** — full-width segmented control: `Solving` | `Evaluating`. Operator picks one. Sub-label below each segment explains the role in one line.
  - **Harness** — dropdown of harnesses compatible with the chosen role.
  - **Claude model** — dropdown of supported models from the SDK.
  - **Plugins** — list of currently-attached plugins; `+ Add plugin` opens a picker (modal) with available plugins for the chosen role + harness combination. Picker UX details deferred to the implementation plan.
- **Footer** — same per-section save pattern as `SectionCard`, but scoped to *this net* — operators can have one net mid-edit while another saves cleanly.

### Disable-while-dirty

If an operator clicks the toggle to disable a net while edits are pending, prompt: "Discard pending changes and disable `<name>`?" Confirm → drop edits, disable net, save. Cancel → keep edits, leave net enabled.

### Restart-required signaling

Each field carries a `restart` pill on its label when changing it requires a daemon restart. Examples:

- `RPC URL` → `restart` (the daemon's chain reads are bound at startup)
- `Harness` → `restart` (the harness instance is constructed at startup)
- `Claude model` → `restart` (passed to the runner constructor)
- `Role` → `restart` (the SolverNet registry binds role-specific listeners)
- `Plugins` (add/remove) → `restart`
- `Enable toggle` → `restart`

When *any* persisted change is restart-required, render a persistent banner across both tabs: `Configuration saved. [Restart node] to apply.` Banner sits between the header and the top tabs. Clicking `Restart node` triggers `/api/admin/restart` (existing endpoint).

In practice for v1 every config field is restart-required. The pill is mostly future-proofing — when hot-reload lands (separate spec), some pills disappear, and the banner only shows when at least one restart-required save is pending.

## Network section

Body has two fields:

- **Chain** — read-only, with a small `locked` pill on the label and helper text: "Switching chains resets fleet state. Separate flow."
- **RPC URL** — free-text input. The placeholder shown when the field is empty is the chain's default URL (sourced from `client/src/earning/contracts.ts` chain config — `https://sepolia.base.org` for Base Sepolia, `https://mainnet.base.org` for Base mainnet). Helper text: a "Use default" link clears the field, which the API treats as "revert to default".

Section's meta-chip on the head reflects live RPC health: `Healthy` (vow-green) when reachable, `Slow` (wane) on degraded latency thresholds, `Unreachable` (break-red) on persistent failure. Source: existing `/v1/status` rpc field.

## Security section

Body holds the password-rotate flow that already exists in `SettingsCard.tsx`. Visual treatment: break-red border, break-red `Danger zone` chip on the head. No structural change to the existing flow; just relocated and reframed.

# Data model

## SolverNet registry

The SPA reads the available SolverNet catalog from a new endpoint `GET /v1/solvernets`:

```ts
interface SolverNetCatalogEntry {
  name: string;                    // e.g. 'prediction'
  description: string;             // single-sentence summary
  state: 'live' | 'available' | 'coming_soon';
  // What this net needs from the operator:
  supportedRoles: ('solving' | 'evaluating')[];
  // The SolverNet plug-in's intrinsic identity. Operators do not set this.
  intrinsicSolverType: string;     // e.g. 'prediction.v1' — display only, not editable
  // Compatible harnesses (server-derived from registry + role).
  compatibleHarnesses: { name: string; version: string; supportsRoles: ('solving' | 'evaluating')[] }[];
  // Compatible plugins (server-derived).
  compatiblePlugins: { name: string; version: string; source: string }[];
}

interface SolverNetCatalogResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: SolverNetCatalogEntry[];
}
```

The endpoint reads the in-process registry; it is purely descriptive and changes only when the daemon restarts with a different plug-in surface.

## Operator selection

Per-net operator config (read from `/v1/bootstrap` and `/v1/status`, written via the API below):

```ts
interface OperatorSolverNetConfig {
  name: string;                    // catalog entry name
  enabled: boolean;
  role: 'solving' | 'evaluating';
  harness: string;                 // matched against catalog.compatibleHarnesses
  model: string;                   // Claude model identifier
  plugins: string[];               // plugin names from catalog.compatiblePlugins
}
```

`solverType` is removed from the operator-side config shape. If a stale config has `solverType`, the daemon ignores it and logs a single warning at startup.

## Network config

```ts
interface OperatorNetworkConfig {
  chain: 'base' | 'base-sepolia';  // read-only from the operator app
  rpcUrl: string;                  // editable; falls back to chain default when empty
}
```

# API surface

New / modified endpoints:

| Method | Path                                  | Purpose |
|--------|---------------------------------------|---------|
| GET    | `/v1/solvernets`                      | New. Returns the SolverNet catalog (see §Data model). |
| POST   | `/v1/setup/solvernets/:name`          | Modified. Accepts `{ enabled?, role?, harness?, model?, plugins? }`. Drops `solverType`. Atomic file rewrite via existing `persistTopLevelConfigValue`. Returns `{ ok, restartRequired, name, config }`. Validates `role` against catalog; rejects `harness` not in `compatibleHarnesses`. |
| POST   | `/v1/setup/network`                   | New. Accepts `{ rpcUrl?: string \| null }`. `null` means "revert to default". Validates URL syntax; performs a one-shot reachability probe before persisting (warns but does not block on probe failure — operators may save an RPC that's currently rate-limited). Returns `{ ok, restartRequired: true, rpcUrl, healthProbe }`. |
| POST   | `/v1/setup/agent-binding/retry`       | New. Accepts `{ serviceIndex?: number }` (defaults to all services with `safe_bound_to_agent=false`). Re-runs `stepBindAgent` from the bootstrap module without a daemon restart. Returns `{ ok, attempts: Array<{ serviceIndex, txHash?, status: 'queued' \| 'success' \| 'reverted', detail? }> }`. |
| POST   | `/v1/setup/change-password`           | Existing. Used by the Security section. No change. |
| POST   | `/api/admin/restart`                  | Existing. Used by the persistent restart banner + Quick Actions. No change. |

Out of scope for this spec: per-field hot-reload endpoints. Every save returns `restartRequired: true` until the hot-reload spec lands.

The deprecated `solverType` field on the existing `POST /v1/setup/solvernets/:name` endpoint stays accepted for one release cycle (with a deprecation warning in the response body) so any stale SPA bundles in browsers don't crash mid-session. Removed in the next release.

# Component map

```
src/dashboard/spa/src/
├── App.tsx                         (modified — wraps shell in wouter Router)
├── shell/
│   ├── AppShell.tsx                (new — header + tabs + outlet + rail layout)
│   ├── Header.tsx                  (new)
│   ├── TopTabs.tsx                 (new — wouter useLocation for active state)
│   ├── AgentRail.tsx               (new — extracted from Operating.tsx)
│   └── RestartBanner.tsx           (new — persistent banner when a restart-required save is pending)
├── pages/
│   ├── Overview.tsx                (new — composes the six Overview sections)
│   └── Configuration.tsx           (new — composes section cards)
├── pages/configuration/
│   ├── SolverNetsSection.tsx       (new — catalog list)
│   ├── NetCard.tsx                 (new — per-net card + edit affordances)
│   ├── NetworkSection.tsx          (new)
│   └── SecuritySection.tsx         (new — wraps existing password-rotate flow)
├── pages/overview/
│   ├── HeroStats.tsx               (new — extracted from Operating.tsx)
│   ├── AlertBand.tsx               (new — alert pattern + deep-link routing)
│   ├── NetworkCard.tsx             (new — public counters, one per known SolverNet)
│   ├── OperatorCard.tsx            (new — operator-side state, one per *enabled* net)
│   ├── RecentActivity.tsx          (new — extracted)
│   ├── QuickActions.tsx            (new — extracted from SettingsCard.tsx)
│   └── IdentityCard.tsx            (new — extracted; adds `binding pending` chip + retry inline disclosure)
├── components/
│   ├── SectionCard.tsx             (new — shared collapsed/expanded with save footer)
│   ├── ConfigField.tsx             (new — input + label + restart pill + validation)
│   └── RestartPill.tsx             (new — small reusable indicator)
└── regions/
    ├── Onboarding.tsx              (unchanged)
    ├── Operating.tsx               (deleted in the swap commit; preserved one revision back via git history)
    └── ...                         (all other current regions unchanged)
```

# Migration

Single PR replaces `Operating.tsx`. No feature flag, no v2-suffix route. `git revert` is the rollback plan; `Operating.tsx` is well-tested and the swap is mechanical.

The current `SettingsCard.tsx` content is decomposed into `QuickActions.tsx`, `IdentityCard.tsx`, and `SecuritySection.tsx`; the file itself is removed. `PredictionPanel` is decomposed into `SolverNetSummaryCard.tsx` (one-row Overview placement) and the inside of `NetCard.tsx` (Configuration placement).

The `SolverNetConfigCard` shipped earlier today on `operator-shakedown` (jinn-mono-* Phase A+B) is deleted as part of this change — its functionality moves into `NetCard.tsx` properly. The relevant tests are rewritten against the new component, not lifted-and-shifted.

# Testing

- **Component-level**: each new component gets a Vitest + Testing Library test covering its core states (collapsed / expanded / dirty / saving / saved / failed). `SectionCard` and `NetCard` are the highest-leverage; the others are mostly composition.
- **API-level**: `GET /v1/solvernets` test covers the registry-derived catalog shape. `POST /v1/setup/solvernets/:name` test extends the existing setup-endpoints suite with role/harness/model/plugins validation. `POST /v1/setup/network` test covers the RPC validate + revert-to-default + reachability probe paths.
- **Integration / Playwright**: a single happy-path Playwright test that loads the running-mode SPA, navigates to Configuration, opens SolverNets → prediction, switches role from Solving to Evaluating, saves, asserts the persistent restart banner appears. Existing `client/test/dashboard/spa.e2e.test.ts` provides the harness.
- **Visual regression**: out of scope. The branding canon is the source of truth; we don't snapshot pixels against it.

# Open decisions resolved in this spec

| Decision | Resolution |
|----------|------------|
| Defaults section needed? | No. Per-net config is the source of truth. Falls back to plug-in's bundled default, not to a config field. |
| Custom-tasks section needed? | No. Tasks come from launcher-owned generators; operator does, doesn't configure. |
| Solver type field per net? | No. Intrinsic to SolverNet identity. Removed from config. |
| Task generator per net? | No. Launcher-owned. Removed from config. |
| Plugin add interaction? | Modal picker driven by `compatiblePlugins` in the catalog. Implementation detail, deferred to plan. |
| Disable-while-dirty? | Confirm-discard-edits prompt. |
| Restart-required UX? | Per-field pill on labels + persistent banner across both tabs when at least one restart-required save is pending. |
| Multi-SolverNet on Overview? | Two cards per known SolverNet: a public NetworkCard (counters, always visible) and an OperatorCard (operator-side, only when enabled). Empty-state CTA when zero operator-enabled. |
| Status copy ("start the daemon" mid-running)? | Drop the diagnostic when `mode === 'running'`. Replace with "Waiting for Tasks. SolverNet active, Harness loaded; no incoming Tasks since startup." Standardise on *node* in operator copy. |
| Safe-to-agent binding pending? | `binding pending` chip on IdentityCard with inline retry; calls new `/v1/setup/agent-binding/retry` endpoint that re-runs `stepBindAgent` without a daemon restart. |
| Hot-reload? | Out of scope. Every save returns `restartRequired: true` for v1. |

# Out of scope (filed separately)

- Hot-reload SolverNet config without daemon restart — `bd jinn-mono-t62s`.
- Smooth restart-with-auto-reconnect overlay — `bd jinn-mono-*` (already filed). Issue #86 §5 (Restart Node has no supervisor) maps here.
- Full operator-config editor for fields not surfaced here (deployment-shape config, env overrides) — `bd jinn-mono-j5ib`.
- Activity page with per-task drill-down + history — file as follow-up. Issue #86 §3 (live activity feed) maps here.
- Claude rail width / overflow-wrap fix at narrow viewports — Issue #86 §4. File as follow-up.
- ERC-1271 contract-side investigation of why `setAgentWallet` reverts against fresh 1/1 Safes — Issue #86 §6 contracts half. File as follow-up. The page-split spec ships the operator-app surface (chip + retry); the on-chain fix ships separately.
- Brier scoreboard / leaderboard surface inside the SPA — separate spec; CLI exists today.
- Multi-Safe / multi-fleet operators — protocol does not support today; separate concern.

# Dependencies

This spec assumes one of PR #84 (`oak/onboarding-faucet-cap-and-rerip`) or PR #85 (`fix/faucet-drip-cap`) lands before implementation begins. Both PRs replace the static faucet drip cap with a dynamic computation; this branch (`operator-shakedown`) currently holds an interim static-120 fix in `setup-endpoints.ts` that is strictly weaker than the merged PRs and conflicts with their changes in the same files. The implementation plan instructs reverting our static fix in favour of the merged dynamic cap before touching the page-split work.

# References

- `BRAND.md` — voice, posture, content non-negotiables, gold-as-hint rule.
- `DESIGN.md` — palette, type, components (cards, inputs, nav, chips), named rules.
- `client/ARCHITECTURE.md` — current SPA region inventory and operator-app contract.
- `docs/superpowers/plans/2026-05-01-operator-local-app.md` — original two-mode SPA plan.
- `docs/reviews/2026-04-28-operator-experience-audit.md` — operator-UX audit findings.
- `bd jinn-mono-336m` — parent issue: operator config is not editable from the app.
- `bd jinn-mono-*` (Phase A+B SolverNet enable + version-swap) — interim fix shipped earlier today on `operator-shakedown`.
