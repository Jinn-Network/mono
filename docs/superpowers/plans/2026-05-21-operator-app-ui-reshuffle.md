# Operator App UI/IA Reshuffle — Implementation Plan

**Date:** 2026-05-21
**Status:** Draft
**Design:** [docs/superpowers/specs/2026-05-21-operator-app-ui-reshuffle-design.md](../specs/2026-05-21-operator-app-ui-reshuffle-design.md)
**Brief:** [docs/superpowers/plans/2026-05-21-operator-app-ui-reshuffle-brief.md](2026-05-21-operator-app-ui-reshuffle-brief.md)
**Base branch:** `next` (the integration branch was merged in `aea3a82d` on 2026-05-21 — phases 1–6 plus the UI reshuffle brief are on `next` now).

---

## Shape

Four PRs, each reviewable in one sitting, each independently revertable. Total ≈8–14 commits.

| PR | Title | Scope | Closes |
| --- | --- | --- | --- |
| 1 | `refactor(spa): design-token expansion + surface primitives` | Add typography / spacing / motion / severity tokens; introduce `.j-surface-*` and `.j-notification--*` CSS; migrate `NotificationItem` | [#444](https://github.com/Jinn-Network/mono/issues/444) |
| 2 | `refactor(overview): two-zone IA + delete AdvancedDetails` | Zone A primary+action surface; reordered Zone B; inline action confirmations; delete `AdvancedDetails` | — |
| 3 | `refactor(operator): shared page header + empty-state polish + Execution Data tabs` | `OperatorPageHeader`; Memberships/Registry/Security empty states; Execution Data tab UI; sub-nav active-state | — |
| 4 | `refactor(shell): persistent notifications panel + header chrome tuning` | `NotificationsList` always-rendered with quiet empty state; header wordmark size; RPC pill severity tone | — |

## Working setup

I am in a worktree at `/Users/gcd/Repositories/main/mono/.claude/worktrees/nifty-euclid-d14fe0/` on branch `feat/operator-app-ui-reshuffle`, rebased onto `next` after the integration branch landed (merge `aea3a82d`). The brief's recommended worktree path is moot — this worktree is already isolated.

Build + manual smoke loop (per the brief):

```bash
cd client && yarn build
rm -rf /Users/gcd/Repositories/main/mono/.claude/worktrees/upbeat-vaughan-3a570b/client/dist/dashboard
cp -R dist/dashboard /Users/gcd/Repositories/main/mono/.claude/worktrees/upbeat-vaughan-3a570b/client/dist/
# Hard-reload Chrome on 127.0.0.1:7331
```

Tests:

```bash
cd client && yarn typecheck
yarn vitest --run src/dashboard/spa
```

Known pre-existing failures the brief whitelists: `claim-readiness-gate.test.ts`, `daemon.test.ts` (port-in-use), `HeroStats.test.tsx`, `JoinFlow.test.tsx`. Do not try to fix them in this work; do not introduce new failures.

## PR 1 — Design-token expansion + surface primitives

**Goal:** Adopt `DESIGN.md` tokens for typography / spacing / motion / severity into the SPA. Replace inline-hardcoded values incrementally. Migrate `NotificationItem` to a CSS-class-driven severity treatment (closes [#444](https://github.com/Jinn-Network/mono/issues/444)).

**Files touched:**

- `client/src/dashboard/spa/src/styles/globals.css` — additive token block + new CSS classes.
- `client/src/dashboard/spa/src/notifications/components/NotificationItem.tsx` — switch to className-driven severity.
- `client/src/dashboard/spa/src/notifications/components/NotificationItem.test.tsx` — assertions on the new class names + severity tinting (snapshot).

**Out of scope (deferred to PR 2/3):** migrating overview / operator components to the new surface classes; touching layout in any way.

### Steps

1. **Add token block to `globals.css`** (additive, no token renames). Verbatim block from §3.1 of the design spec: `--text-2xs` through `--text-display-xl`; `--space-1..8`; `--dur-fast/base/slow`; `--ease-out/-in-out`; `--severity-*` colors.
2. **Add surface + notification CSS classes** to `globals.css` per §3.2 and §6.2 of the design spec: `.j-surface-primary`, `.j-surface-secondary`, `.j-surface-reference`, `.j-surface--blocking/warning/info`, `.j-notification`, `.j-notification--blocking/warning/info` and child selectors.
3. **Migrate `NotificationItem.tsx`** to render the new structure with `className="j-notification j-notification--${severity}"`. Move the inline `style={{ display: 'flex', gap: 12, ... }}` into CSS. Add `min-width: 64px` on the severity column so messages align. Keep the `data-kind` / `data-severity` / `aria-label` attributes — they're test surfaces.
4. **Update `NotificationItem.test.tsx`** to assert the className-based structure rather than the inline styles, and to assert the severity color appears in the rendered DOM (via the `--severity-*-fg` CSS variable resolving to the expected color — using `getComputedStyle` on the severity span).
5. **Visual sanity check:** rebuild SPA, smoke-test the daemon. With no notices, nothing changes. To synthesise notices, temporarily import `useNotifications.fixtures.ts` (or whatever the project uses) and confirm each severity tone renders distinctly. Roll back the test injection before committing.

### Acceptance

- `yarn typecheck` passes.
- `yarn vitest --run src/dashboard/spa/notifications` passes.
- `globals.css` diff is purely additive — no deletions, no renames.
- Manual: trigger a `harness_not_ready` notification (set a bad harness in config and `jinn run`) and confirm the row renders red. Trigger a `password_rotation_due` info and confirm it renders sky-blue. Both severities show the severity word in matching colour and a left border tint.

### Commit shape

```
refactor(spa): add typography/spacing/motion/severity tokens to globals.css
refactor(spa): introduce .j-surface-* + .j-notification--* CSS primitives
refactor(notifications): NotificationItem reads severity from CSS classes (closes #444)
test(notifications): assert NotificationItem severity tinting + structure
```

## PR 2 — `/overview` IA rebuild

**Goal:** Implement the two-zone (Now / Detail) information architecture per §4 of the design spec.

**Files touched (heavy):**

- `client/src/dashboard/spa/src/pages/Overview.tsx` — rewriting the JSX tree.
- `client/src/dashboard/spa/src/pages/overview/` — every existing component migrated to use surface classes; `AdvancedDetails.tsx` + `.test.tsx` deleted.
- New components in `pages/overview/`:
  - `NowSurface.tsx` — Zone A left primary status surface.
  - `NextActionSurface.tsx` — Zone A right primary action surface.
  - `StatStrip.tsx` — Zone B reference strip (Solutions / ETH / JINN / lastClaim).
  - `DetailGrid.tsx` — Zone B 2-up grid wrapper for Funds + Rewards detail surfaces.
  - `IdentityChain.tsx` — chain-of-authority Identity render (master → agent → safe with connector lines).
- Tests for each new component.

**Out of scope:** `/operator/*` polish (PR 3); AppShell + Notifications (PR 4); daemon changes.

### Steps

1. **Stand up `NowSurface.tsx`.** Props: `statusState`, `statusLabel`, `statusReason`, `activeAction`, `evicted`, `evictedServiceId`, `onRestart`, `onRestake`. Uses `.j-surface-primary` plus a `.j-surface--blocking` or `.j-surface--warning` tone driven by `statusState`. Renders the wordmark-size label + reason + the right primary action (Restart, Re-stake, or none). Includes inline restart-confirmation tail (replaces the old top-level `notice` band when the action originates here). Tested in isolation.

2. **Stand up `NextActionSurface.tsx`.** Props: `joined` (joined SolverNet from `detectJoinedSolverNet`), `inFlightCount`, `inFlightRestoreCount`, `inFlightEvalCount`, `oldestInFlightAgeMs`, `waitingMessage`. Three render modes:
   - **no joined SolverNet** — info-toned card with "Pick a SolverNet" CTA → `/operator/registry`. (Subsumes today's `AlertBand`.)
   - **joined, no in-flight** — repurposes OperatorCard's content (name, roles, waiting message, Change link).
   - **joined, in-flight** — condensed "2 tasks in flight · 1 restoration · 1 evaluation · oldest 4m ago" with link to `/overview/activity`.

3. **Rewrite the page body** in `Overview.tsx`:
   - Zone A: a single `<div>` with a `grid-template-columns: minmax(0, 7fr) minmax(0, 5fr)` at `min-width: 720px`, collapses to single column below.
   - Zone B: vertical column with `gap: var(--space-5)`, contents in the order from spec §4.2.

4. **Split `HeroStats` into `StatStrip`.** Drop the 24px hero font; the strip uses `--text-lg` numbers and `--text-xs` labels. Removes the Solutions+Status combo since Status is now Zone A. Renders Solutions / ETH balance / JINN claimable / last claim → 4 tiles. Old `HeroStats.test.tsx` is deleted; new `StatStrip.test.tsx` covers it.

5. **Move action confirmations inline.** The `notice` state + `runAction` helper move into the surface that owns the action:
   - Restart confirmation lives inside `NowSurface` (auto-clear 10s).
   - Top-up confirmation lives inside `FundsCard` (auto-clear 5s).
   - Reward-claim confirmation lives inside `RewardsCard` (no auto-clear).
   - The top-of-page `notice` `<div>` is deleted.

6. **Build `IdentityChain.tsx`.** Replaces `IdentityCard`'s flat label grid with a labeled chain: `MASTER` → connector line → `AGENT` → connector line → `SAFE`, with the address text on the right of each node. Connector lines are 1px `var(--border)`. The "binding pending" / "bound" chip moves to the connector between Agent and Safe. `IdentityCard` becomes a thin shell that mounts `IdentityChain`.

7. **Tint `NetworkCard` by failure counts.** When `totals.settledFailed > 0`, apply `.j-surface--warning`; when `totals.localErrors > 0`, apply `.j-surface--blocking`. (Tone takes the louder of the two.) Snapshot tests for each tone.

8. **Migrate `FundsCard`, `RewardsCard`, `OperatorCard`, `HarnessStatusPanel`, `NetworkCard`** to use `className="j-surface-reference"` (or `j-surface-secondary` for the surfaces that earn it — `OperatorCard` when it's *not* used as the Zone A right column; `ActivitySections` always; everything else reference). Each migration removes the inline `style={{ background, border, borderRadius, padding }}` block and lets the CSS class own it. Inline `style={{}}` for layout (`display`, `gap`, `grid-template-columns`) stays.

9. **Delete `AdvancedDetails.tsx` and its test.** Confirm no other file imports it.

10. **Manual smoke.** Walk every state combination:
    - Bootstrap in progress.
    - Joined SolverNet + no work.
    - Joined + restoration in-flight.
    - Joined + evaluation in-flight.
    - Joined + evicted from staking.
    - Joined + harness mismatch (current real state on dev daemon).
    - No SolverNet joined.

### Acceptance

- `yarn vitest --run src/dashboard/spa/pages` passes (modulo whitelisted pre-existing).
- Visual: an operator landing on `/overview` sees Zone A occupying the top half of the viewport, with the status label + reason clearly distinguished from the rest of the page.
- Zone B contents are in the order from §4.2 and use the reference surface class.
- `AdvancedDetails` is gone.

### Commit shape

```
refactor(overview): NowSurface — Zone A primary status surface
refactor(overview): NextActionSurface — Zone A right primary action
refactor(overview): StatStrip — slim Zone B reference strip
refactor(overview): IdentityChain — chain-of-authority Identity render
refactor(overview): two-zone page body + delete AdvancedDetails
refactor(overview): tint NetworkCard by failure counts
refactor(overview): migrate cards to .j-surface-* classes; move action notices inline
```

## PR 3 — `/operator/*` polish

**Goal:** A shared page header, empty states that orient, Execution Data tabs, better sub-nav active state.

**Files touched:**

- `client/src/dashboard/spa/src/pages/operator/` — new `OperatorPageHeader.tsx`; updates to each `*Tab.tsx`; updates to `OperatorSubNav.tsx`.
- `client/src/dashboard/spa/src/pages/captures/CapturesTab.tsx` — tab UI (`?tab=donation|artifacts`).

**Out of scope:** Overview (already in PR 2); AppShell (PR 4).

### Steps

1. **Stand up `OperatorPageHeader.tsx`.** Renders title (`--text-md` weight 500), single-line description (`--text-sm` muted), optional right-side action element. Bottom 1px border. Renders inside the tab's main column above the existing content.

2. **Mount it on each `*Tab.tsx`:**
   - `MembershipsTab`: title "Memberships", description "SolverNets this operator has joined.", action `<Link href="/operator/registry">Browse registry →</Link>`.
   - `RegistryTab`: title "Registry", description "Discover SolverNets that are open to operators.", no action.
   - `NetworkTab`: title "Network", description "Chain, RPC endpoint, and connectivity for this operator.", no action.
   - `SecurityTab`: title "Security", description "Keystore rotation and operator-local credentials.", no action.

3. **Memberships empty state.** Wrap the existing "You haven't joined any SolverNets yet" message in a `.j-surface--info` card with a primary CTA button "Browse registry" linking to `/operator/registry`.

4. **Registry empty state.** Render an `.j-surface-reference` block above the empty-list message, with copy: *"A SolverNet is a market where operators agree on harness, evaluator and reward rules for a class of tasks. Joining a SolverNet binds your daemon to its manifest CID."* Add a "Learn more →" link to whichever runbook is most relevant — `docs/runbooks/` content TBD; if no good runbook exists, link to the SolverNet creation spec.

5. **Security context panel.** Above the password form, add a `.j-surface-reference` card with:
   - "Last rotated: {lastPasswordRotationAt}" (renders `never` when null — daemon-side wiring is [#441](https://github.com/Jinn-Network/mono/issues/441), so SPA tolerates null gracefully today)
   - One sentence: *"Rotating the keystore password re-encrypts the agent's private key. The daemon must be restarted with the new password for new work to be claimed; in-flight tasks complete on the old password."*

6. **Execution Data tab UI.** Inside `CapturesTab.tsx`:
   - Read `?tab=donation|artifacts` from URL; default to `artifacts`.
   - Render a small tab strip below the page header: `[ Donation | Artifacts ]`, active tab uses `border-bottom: 2px solid var(--accent-sky)`.
   - When `tab=artifacts` (default), render the existing two-column artifact list / detail layout. Above it, collapse `OperatorDataMarket` to a one-line strip ("Donation: ON · 14 eligible runs · Manage →") with the Manage link flipping to `?tab=donation`.
   - When `tab=donation`, render `OperatorDataMarket` expanded and hide the artifact browser.

7. **Sub-nav active state.** In `OperatorSubNav.tsx`, replace the `background: 'var(--bg-elevated)'` swap with `border-left: 2px solid var(--accent-sky); padding-left: 14px;` (`px - 2` to compensate for the border so labels don't jump). Keep `color: var(--fg)` for active items. Keep `aria-current="page"`.

8. **Manual smoke.** Walk each sub-route empty + non-empty. Tab between Donation and Artifacts on Execution Data. Confirm sub-nav active state is visible at a glance.

### Acceptance

- `yarn vitest --run src/dashboard/spa/pages/operator` passes.
- Each sub-route has a clear page header.
- Each empty state explains *what* the route is about, not just "0 X".
- Execution Data has visible tabs.

### Commit shape

```
feat(operator): OperatorPageHeader primitive
refactor(operator): mount OperatorPageHeader on memberships/registry/network/security
refactor(operator): empty-state polish — registry, memberships, security
refactor(operator): Execution Data donation/artifacts tabs
refactor(operator): sub-nav active state — left-border indicator
```

## PR 4 — AppShell + Notifications + header tuning

**Goal:** Persistent notifications panel; header chrome cosmetic refinement.

**Files touched:**

- `client/src/dashboard/spa/src/shell/AppShell.tsx`
- `client/src/dashboard/spa/src/notifications/components/NotificationsList.tsx`
- `client/src/dashboard/spa/src/shell/Header.tsx`
- relevant tests

### Steps

1. **`NotificationsList` always-rendered.**
   - In `AppShell.tsx`, remove the `notices.length > 0` conditional. The notifications row always exists.
   - In `NotificationsList.tsx`, when `notices.length === 0`, render a single `.j-notification--empty` row with `"No active notices."` in `var(--fg-dim)` at `--text-xs`. Height ~28px.
   - Update `AppShell.tsx` `grid-template-rows` to always be `auto auto auto minmax(0, 1fr)` — no more shift.
2. **Header cosmetic.** In `Header.tsx`:
   - Reduce wordmark size from current to `--text-md`.
   - Render network pill (`TESTNET` / `MAINNET`) using `--severity-info-fg`.
   - Render RPC pill (`RPC HEALTHY` / `RPC DEGRADED`) using `--severity-info-fg` when healthy and `--severity-warning-fg` when degraded.
3. **Tests.** Snapshot for empty notifications row. Visual sanity test: header tone changes when RPC is degraded (driven by `useRpcStatus` or whatever the existing source is).

### Acceptance

- `yarn vitest --run src/dashboard/spa/shell src/dashboard/spa/notifications` passes.
- The notifications row is visible (quietly) when empty.
- Page layout no longer shifts when a notification arrives.

### Commit shape

```
refactor(shell): NotificationsList always-rendered with quiet empty state
refactor(shell): header wordmark size + RPC pill severity tone
test(shell): cover persistent notifications + header tonal pills
```

## Cross-cutting tasks

- **Token sanity audit** — at the end of PR 1, ensure every `var(--text-*)` and `var(--space-*)` token actually resolves in the bundle (typo check). Add a small Vitest unit (`token-resolution.test.ts`) that reads `globals.css` and verifies every consumer reference exists in the source.
- **Visual snapshot drift** — Phase 2 will invalidate snapshots in `Overview.test.tsx` and component tests. Update intentionally as part of each commit, never bulk-regenerate.
- **Documentation** — once PR 1 lands, update [`docs/design/jinn-design-system/project/README.md`](../../../docs/design/jinn-design-system/project/README.md) Quick-reference table to mention the SPA's `--text-*` and `--space-*` tokens as the canonical site for typography / spacing reuse in the dashboard SPA. (Short paragraph; not a docs PR by itself.)

## Sequencing

PR 1 must land first (everything downstream consumes its tokens). PR 2, 3, 4 are independent after that; reviewers can take them in any order.

Suggested cadence: one PR per working day, with rebuild + manual smoke + screenshot capture per PR for the body. The full series should be reviewable within four working days.

## What this plan does not do

- Does not introduce new notification kinds or new component classes (per design spec §7).
- Does not touch the daemon. Every change is SPA-only.
- Does not resolve open spec questions ([#438](https://github.com/Jinn-Network/mono/issues/438) Output Stats, [#440](https://github.com/Jinn-Network/mono/issues/440)–[#443](https://github.com/Jinn-Network/mono/issues/443)). The SPA renders sensible empty / placeholder state where the daemon doesn't supply data, so daemon work is unblocked.
- Does not touch the Launcher (`/launcher`) — out of scope. The brief notes Launcher is the best-tuned empty state already.
- Does not touch the AgentRail (right-side embedded agent panel) — out of scope; default-off behind a flag.
- Does not refactor existing component logic beyond what the IA changes require. We are reshuffling, not rewriting.

---

**Once approved, execute via the [executing-plans](../../../.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/executing-plans/SKILL.md) or [subagent-driven-development](../../../.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/subagent-driven-development/SKILL.md) skill.** Each PR is a checkpoint.
