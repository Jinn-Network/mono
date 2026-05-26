# Issue #427 — Promote Identity (§2.2) and Harness Readiness (§2.9) to first-class /overview surfaces

- **Issue:** [#427](https://github.com/Jinn-Network/mono/issues/427) — operator-app: Identity + Harness Readiness buried under "Advanced details"
- **Date:** 2026-05-26
- **Shape:** `refactor`
- **Author:** Claude (implement-issue Stage 1)
- **Anchors:** `docs/superpowers/plans/2026-05-20-operator-app-spec-alignment.md` Phase 2 (Tasks 2.1–2.3); `client/OPERATOR-APP-SPEC.md` §2.2, §2.9

## State of the world (correcting the issue body)

The issue points at `▶ Advanced details` on `Overview.tsx` lines 378–386, but `AdvancedDetails.tsx` was already deleted on 2026-05-21 (commit `e47dd57e`, "refactor(overview): Node Health card + two-column layout") as an "empty disclosure left over from Phase 2." There is no longer an `AdvancedDetails` block to extract from. The real current state is:

- **Identity** lives as the `wallet-section-identity` block inside `client/src/dashboard/spa/src/pages/overview/WalletCard.tsx` (lines 273–355). `WalletCard`'s own docstring states it "absorbed the separate Funds, Rewards, and Identity cards" — Identity is fused into a stat card whose primary read is gas balance and tJINN earnings. This buries Identity even more thoroughly than the original "behind a disclosure triangle" framing.
- **Harness Readiness** has no surface on `/overview` at all. The daemon already serves `GET /v1/harnesses/readiness` and `/v1/harnesses/:name/readiness` (`client/src/api/harness-readiness-endpoint.ts`), and the SPA exposes `api.harnessReadiness(name)` returning `HarnessReadinessEntry` (`client/src/dashboard/spa/src/api/client.ts` line 252). Today only `JoinFlow.tsx` and the notifications derivation read it; the operator sees harness state only as a transient `harness_not_ready` notification toast.
- Neither `IdentityCard.tsx` nor `HarnessStatusPanel.tsx` exist on disk (`find client/src/dashboard -name "IdentityCard*" -o -name "HarnessStatusPanel*"` returns nothing). The plan's checklist that says "modify `IdentityCard.tsx` to drop from AdvancedDetails" is itself stale — both components must be authored as part of this refactor.

The acceptance-criterion line "no behaviour changes — same data, just promoted in the hierarchy" is therefore narrowly true for Identity (extraction + relocation, same fields) but materially understates the Harness work (new component, new query, new state-message rendering). This design note carries that revision forward.

## Chosen approach

**Two new components, both rendered in the main column above the existing `ActivityCard`.** The /overview grid stays a two-column shell (`[grid-template-columns:minmax(0,1fr)_minmax(0,380px)]`); the right rail (Node Health + Wallet) is unchanged. The main column gains a stacked pair at the top:

```
┌─ MAIN COLUMN ─────────────────────────────┐  ┌─ RIGHT RAIL ─────┐
│ EvictionBanner (conditional)              │  │ NodeHealthCard   │
│ IdentityCard       (NEW — §2.2)           │  │                  │
│ HarnessStatusPanel (NEW — §2.9)           │  │ WalletCard       │
│ ActivityCard                              │  │  (Identity sect. │
│                                           │  │   removed)       │
└───────────────────────────────────────────┘  └──────────────────┘
```

**Ordering rationale.** Identity above Harness Readiness because Identity is the identity of *the operator* (a constant of the deployment — master/agent/Safe/service/agent IDs); Harness Readiness is a per-component liveness gate (it changes more often, and its prominent placement immediately under Identity puts the "you / your tools" pair together at the top of the surface, which matches how operators triage). Both sit above `ActivityCard` because Activity is the per-task fire-hose — the right altitude for it is "below the things that gate whether it can run at all."

**`IdentityCard.tsx` (§2.2 mapping).** A shadcn `Card` rendering five labelled monospace stats — master address, agent address, Safe address, service ID, agent ID — using the same `eyebrow` / `sectionLabel` token classes the existing WalletCard identity block uses (so we don't fork the visual language). The "binding pending" disclosure + `Retry binding` action and the `retryAgentBinding` plumbing move out of `WalletCard` together with the data; the action surface stays attached to the component the spec says owns it. State-message slot at the top of the card renders the three §2.2 messages (Safe not bound, agent ID not minted, identity migration pending). The component is purely a relocation + visual reshape — no new daemon endpoints; data comes from the existing `/v1/setup/bootstrap` and `/v1/status` queries already wired in `Overview.tsx`. `WalletCard` retains the `wallet-section-gas`, `wallet-section-tjinn`, and `wallet-section-password` sub-sections; the Identity section and its props (`masterAddress`, `agentId`, `safeAddress`, `services`, `bindingError`, `onRetryBinding`) are removed.

**`HarnessStatusPanel.tsx` (§2.9 mapping).** A shadcn `Card` listing one row per harness the operator has joined a SolverNet against (derived from `bootstrap.joinedSolverNets[*].harness`), each row consulting `api.harnessReadiness(name)` via TanStack Query with a 30s refetch. Per-row fields: name, installed pill, authenticated pill, ready pill, and `nextStep.description` when not-ready (with `cli` / `url` hints from `HarnessReadinessNextStep`). Per-row actions: `Re-check` (refetch the query) and `Re-authenticate` (`window.open(nextStep.url)` for harnesses whose re-auth is browser-flow — Claude / Codex — and a copy-to-clipboard for the `cli` form for shell-flow harnesses; the spec treats both as "re-authenticate"). State-message slot at the panel level renders the three §2.9 messages (harness not installed, auth expired, version mismatch). The harnesses to enumerate come from `joinedSolverNets`, not the full registry, because the spec frames §2.9 as "each supported execution harness" *for this operator* — and that scope keeps the panel useful (one row, usually) rather than a long list of harnesses the operator doesn't run.

**What stays "advanced" / does not get promoted.** Per the issue's acceptance criterion, `AdvancedDetails` should continue to hold "genuinely advanced/reference data (build sha, runtime flags, raw RPC URL — anything that doesn't belong on the primary surface)." Since `AdvancedDetails.tsx` is already deleted and there is currently no surface holding that residue, this refactor will **not** re-introduce an `AdvancedDetails` disclosure. If/when build-sha or runtime-flag fields surface in a later phase, they belong on `/operator/network` (raw RPC URL — already there per Phase 5 of the plan) and `/operator/about` (build sha, runtime flags) rather than as a folded-up disclosure on `/overview`. The note for #427 records this explicitly so future work doesn't re-create a buried-disclosure pattern. The plan's Task 2.1 "drop IdentityCard from AdvancedDetails" step becomes a no-op.

## Testing approach

Anchored on the plan's Tasks 2.1–2.3 with one substitution (testing "above the fold" instead of "outside `<details>`"):

- **`pages/overview/IdentityCard.test.tsx`** (new) — covers props → DOM mapping for each of the five identity stats, the three state-message rows (rendered iff condition holds), the binding-pending disclosure + Retry binding action (relocated from `WalletCard.test.tsx`), and the empty/null states for each address.
- **`pages/overview/HarnessStatusPanel.test.tsx`** (new) — mocks `api.harnessReadiness` with `ready: true` and `ready: false + nextStep` fixtures and asserts the row layout, the three state-message renderings, and that `Re-check` triggers a refetch.
- **`pages/Overview.test.tsx`** (modified) — adds the two failing-first tests from plan Task 2.1 Step 1 and Task 2.2 Step 1, rewritten to drop the obsolete `expect(screen.queryByText(/advanced details/i)?.closest('details'))` (no `<details>` exists). The substitute assertion is positional: the new tests assert the `IdentityCard` and `HarnessStatusPanel` are rendered as direct children of the main-column container (`overview-page-grid > main > [data-testid="identity-card"]` and `[data-testid="harness-status-panel"]`) and that they appear *before* `[data-testid="activity-card"]` in document order. That is what "above the fold" means in a vitest/jsdom context where there's no viewport.
- **`pages/overview/WalletCard.test.tsx`** (modified) — drops the existing Identity-section coverage (`wallet-service-id`, `wallet-master-address`, binding-pending retry) since those assertions move to `IdentityCard.test.tsx`. The remaining Wallet tests (gas, tJINN, password rotation) are untouched.
- **`client/test/dashboard/spa.e2e.test.ts`** (modified, plan Task 2.3 Step 1) — the existing /overview smoke walk gains two assertions: `getByTestId('identity-card')` and `getByTestId('harness-status-panel')` resolve without expanding any disclosure. This is the test the issue's acceptance criterion is asking for — "visible without expanding any `<details>`" — and at the e2e level it's a literal `expect(...).toBeVisible()` against a real browser.

## Key trade-offs considered

- **Visual density above the fold.** Stacking two new cards above `ActivityCard` pushes Activity below the viewport on a 768px-tall laptop screen. We accept this: the issue's framing — Identity and Harness gate everything else — is the right one, and Activity is already the page's tallest card; it always needed scrolling. The right rail (Node Health + Wallet) absorbs the at-a-glance read for operators who only want a single screen-full.
- **Ordering — Identity vs Harness Readiness on top.** Tried both. Harness-on-top reads as "your tools" first, which matches the troubleshooting altitude. Identity-on-top reads as "you" first, which matches the orientation altitude. Picked Identity-on-top because identity changes rarely (the slot stays stable as the operator's stable address-of-record) and Harness Readiness changes per-auth-event — variability sits below stability, so the eye lands on the constant first and then sweeps the variable below it.
- **Keep an `AdvancedDetails` shell at all?** No. The disclosure was an attractive nuisance: anything dropped in it became invisible. A residue surface keeps tempting future refactors to "just hide it under Advanced." Better to send the actual residue to its proper home (`/operator/network` for RPC; `/operator/about` for build/runtime) and explicitly forbid re-creation on `/overview`.
- **Component scope of `HarnessStatusPanel` — joined harnesses vs all harnesses.** The spec is ambiguous ("each supported execution harness"). Picked joined-only because (a) the §2.9 state messages all describe harnesses the operator is *trying to use*, and (b) enumerating all known harnesses (claude, codex, hermes, prediction-v1-baseline, …) on every operator's `/overview` creates a wall of "ready: true" rows for harnesses the operator doesn't care about. If a future spec change demands the full enumeration, the data path is the same — only the iteration source flips from `bootstrap.joinedSolverNets` to a `GET /v1/harnesses` listing.
