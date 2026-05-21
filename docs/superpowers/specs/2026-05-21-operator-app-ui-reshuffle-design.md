# Operator App UI/IA Reshuffle — Design Spec

**Date:** 2026-05-21
**Author:** Claude (handoff from [docs/superpowers/plans/2026-05-21-operator-app-ui-reshuffle-brief.md](../plans/2026-05-21-operator-app-ui-reshuffle-brief.md))
**Status:** Draft
**Scope:** [`client/src/dashboard/spa/`](../../../client/src/dashboard/spa/) only — no daemon changes.

---

## 1. Problem statement

The six-phase spec-alignment pass landed the right *components* on the operator dashboard. It did not land an *information architecture*. An operator who lands on `/overview` today sees nine to eleven cards arranged in a single vertical column. Every card uses the same recipe:

```ts
background: 'var(--bg-elevated)',
border: '1px solid var(--border)',
borderRadius: '10px',
padding: '20px' | '20px 24px',
```

Eyebrow labels share one rule (`11px / 0.14em / uppercase / fg-muted`). Body text shares one font (`'JetBrains Mono'`). Nothing rises and nothing recedes. The dashboard has no rhythm.

The audit confirmed:

- **Ten render slots on `/overview`** (`HeroStats`, `FundsCard`, `RewardsCard`, action notice, `NetworkCard`, `OperatorCard`, `ActivitySections`, `IdentityCard`, `HarnessStatusPanel`, `AdvancedDetails`) — all peers in the same flex column with the same `gap: 24px`. ([client/src/dashboard/spa/src/pages/Overview.tsx:273-435](../../../client/src/dashboard/spa/src/pages/Overview.tsx))
- **~122 inline `style={{ ... }}` blocks** across the overview tree, almost all of which re-state the card recipe by hand.
- **All font sizes are hardcoded px strings** — `11px`, `12px`, `14px`, `17px`, `18px`, `24px`, `26px`, `64px` — none of them named.
- **Severity colors (`--break-red`, `--accent-gold`, `--vow-green`) are wired but `NotificationItem` doesn't use them.** ([client/src/dashboard/spa/src/notifications/components/NotificationItem.tsx](../../../client/src/dashboard/spa/src/notifications/components/NotificationItem.tsx) — issue [#444](https://github.com/Jinn-Network/mono/issues/444))
- **Notifications panel is invisible when empty.** `AppShell` only renders the `NotificationsList` row when `notices.length > 0`. ([client/src/dashboard/spa/src/shell/AppShell.tsx](../../../client/src/dashboard/spa/src/shell/AppShell.tsx))
- **`AdvancedDetails` is empty after Phase 2.** Identity + Harness were promoted out; the disclosure is left as a phantom `▸ Advanced details` button with no content. ([client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx](../../../client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx))
- **`/operator/*` sub-routes have ~40-60% empty viewport** below their single block of content, no consistent page header.
- **`/operator/execution-data` mashes two unrelated concerns** — Data Donation (gov/eligibility) and Execution Artifact Browser (data) — on one route without visual separation.

**Note on the brief's "duplication" claim.** The brief asserts the harness/SolverNet attention state renders in four places on `/overview`. After Phase 6 retired `LiveNowBand`, the actual count on `/overview` is one (the `StatusStat` tile inside `HeroStats`). The real problem is not redundancy but *uniform weight*: every concern reads as equally important, so nothing reads as primary.

## 2. Design principles for this pass

These are working principles. Each derives from `BRAND.md`, `DESIGN.md`, or `OPERATOR-APP-SPEC.md`. Anywhere they conflict with the existing SPA, the SPA loses.

1. **Three weights of surface.** Primary (operator's attention surface), secondary (live state), reference (identity / status / config). Today there is one weight.
2. **One question first.** The above-the-fold answer to "what is my node doing right now and is anything wrong?" gets at most two visual elements. Everything else is reference, accessed by scroll or by nav.
3. **Severity is visible.** Blocking notices use `--break-red`. Warnings use `--accent-gold` / `--wane`. Info uses `--accent-sky` or recedes. Operators should never have to read text to feel severity.
4. **Empty states orient.** A `/operator/registry` empty state explains *what a SolverNet is and why an operator might join one*, not just "0 discoverable".
5. **Tokens are the source of truth.** Hardcoded values are the exception, not the rule. Adding typography + spacing + motion tokens is part of this work.
6. **Headless, not styleless.** Per `BRAND.md`: lexicon is protocol, visuals are narrative. We can fork the visual treatment freely; we keep every notification kind, severity tier, and spec'd component contract intact.
7. **No new component classes in the spec.** Visual composition can split or merge; the 13 spec components and 12 notification kinds stay. Spec proposals are out of scope for this PR series.

## 3. Token expansion

`globals.css` currently exposes colors, four radii (`--radius-1..3`, `--radius-pill`), and two font-family aliases. It does **not** expose typography sizes, spacing scale, shadows, or motion tokens — even though `DESIGN.md` defines them all.

### 3.1 Tokens to add to `globals.css`

```css
/* Typography sizes — match DESIGN.md `typography.*.fontSize` */
--text-2xs:   10px;   /* danger zone meta, smallest chips */
--text-xs:    11px;   /* labels, eyebrows, small chips */
--text-sm:    12px;   /* secondary body, captions */
--text-base:  14px;   /* body (DESIGN body.fontSize) */
--text-md:    17px;   /* section titles (DESIGN title.fontSize) */
--text-lg:    20px;   /* card big numbers */
--text-xl:    24px;   /* hero big numbers */
--text-2xl:   26px;   /* header wordmark, wish-size (DESIGN wish.fontSize) */
--text-display:    64px;   /* loading screen / hero display */
--text-display-xl: 88px;   /* DESIGN display.fontSize */

/* Spacing scale — match DESIGN.md `spacing.1..10` */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 24px;
--space-6: 32px;
--space-7: 48px;
--space-8: 64px;

/* Motion — minimal set, matches DESIGN system */
--dur-fast:    80ms;
--dur-base:    140ms;
--dur-slow:    240ms;
--ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

/* Severity surfaces — derived, not new colors. These let cards and
   notifications signal severity without re-stating the color recipe. */
--severity-blocking-fg:     var(--break-red);
--severity-blocking-border: rgba(168, 90, 90, 0.6);
--severity-blocking-bg:     rgba(168, 90, 90, 0.06);
--severity-warning-fg:      var(--wane);
--severity-warning-border:  rgba(184, 128, 47, 0.6);
--severity-warning-bg:      rgba(184, 128, 47, 0.06);
--severity-info-fg:         var(--accent-sky);
--severity-info-border:     rgba(122, 167, 220, 0.4);
--severity-info-bg:         transparent;
--severity-success-fg:      var(--vow-green);
```

These are additive. Nothing existing changes.

### 3.2 Tokenised primitives

Today `.j-card` exists in `globals.css` but most components recreate the recipe inline. The reshuffle introduces (in CSS, not React) three card weights:

```css
.j-surface-primary {
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-3);
  padding: var(--space-5);
}

.j-surface-secondary {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-3);
  padding: var(--space-5);
}

.j-surface-reference {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-2);
  padding: var(--space-4) var(--space-5);
}
```

The visual difference is small but real:

- **Primary** uses `--border-strong` (sky blue), the same colour the design system reserves for hover / focus / structure. It calls itself out without shouting.
- **Secondary** is the existing card recipe.
- **Reference** is unfilled, narrower padding, smaller radius — recedes into the page.

Severity classes layer on top:

```css
.j-surface--blocking { border-color: var(--severity-blocking-border); background: var(--severity-blocking-bg); }
.j-surface--warning  { border-color: var(--severity-warning-border);  background: var(--severity-warning-bg); }
.j-surface--info     { border-color: var(--severity-info-border); }
```

These are additive — a `.j-surface-primary.j-surface--blocking` is a primary surface tinted red.

Components consume `className="j-surface-secondary"` instead of restating the recipe inline. This is the migration path for Phase 1.

## 4. `/overview` IA — proposed layout

The current page is a single vertical column with `gap: 24px`. The proposed layout introduces two clear zones — *Now* (everything an operator needs to feel oriented within five seconds) and *Detail* (everything else, ordered by likelihood of need).

### 4.1 Zone A — "Now" (above-the-fold)

A **two-column grid at ≥720px viewport width** (collapses to single column on narrow). Left column wider (`2fr 1fr` or `7fr 5fr`).

**Left column — primary status surface (`j-surface-primary`):**

- Wordmark-sized status label ("WORKING", "ATTENTION", "WAITING", "EVICTED") using `--text-md` weight 500.
- `statusReason` line below ("Selected Harness 'hermes-agent' does not support prediction.v1 restoration Tasks.") at `--text-base`, line-height 1.4.
- One primary action button if applicable (Restart, Re-stake, Resolve in /operator/...).
- Tone of the whole card switches with severity: `.j-surface--warning` for `attention`, `.j-surface--blocking` for `evicted` or `bootstrap_blocked`, no severity class for `working` / `waiting`.

This **replaces** the `StatusStat` tile in `HeroStats`. `HeroStats` becomes a small two-stat strip (Solutions, optionally one more) that lives in Zone B.

**Right column — primary action surface, picked by the daemon's most-load-bearing fact at this moment:**

- If joined to a SolverNet AND no in-flight work: `OperatorCard` content (SolverNet name, roles, waiting message, Change link).
- If joined AND in-flight: condensed in-flight tile ("2 tasks in flight · 1 restoration · 1 evaluation · oldest 4m ago"). Click → `/overview/activity`.
- If not joined to any SolverNet: a `j-surface--info` "Pick a SolverNet" card with a link to `/operator/registry`. This subsumes today's `AlertBand` and the `no_solvernets_joined` notification (which still exists as a notification row — see §7).

This combination — status on the left, "next thing" on the right — answers the brief's primary requirement: an operator can articulate the node's state and their next action without scrolling.

### 4.2 Zone B — "Detail" (below-the-fold, reordered)

After Zone A, the rest of `/overview` flows top-to-bottom in this order:

1. **Stat strip** — small row of `j-surface-reference` tiles: Solutions delivered, ETH balance, JINN claimable, last claim. Three or four tiles total. No buttons. Recedes from primary surfaces. Replaces `HeroStats` + a slimmed `FundsCard` + a slimmed `RewardsCard`.
2. **Activity** — `ActivitySections` (In flight + Recent). Already the cleanest surface in the app; left mostly alone. Treated as a `j-surface-secondary`.
3. **Funds + Rewards detail row** (`j-surface-reference` × 2 in a 1fr 1fr grid) — the full per-role drill-down (master/agent/safe) + the Top Up and Change Password actions; the lifetime claimed + Claim action. These are *reference* surfaces, not primary; an operator who needs them goes to them deliberately.
4. **Identity** — `j-surface-reference`. Master / Agent / Safe / Service ID / Agent ID rendered as a labeled grid. *"Chain of authority"* visual treatment: master at top, agent below, safe at the bottom, with thin connector lines drawn between them. This is the only place in the design where a small narrative visual is allowed — it earns its keep because the relationship between these addresses is non-obvious.
5. **Harness status** — `j-surface-reference`. Mode (train/frozen), code digest, harness name. Small.
6. **Network** — `j-surface-reference`. The 6-stat counter row (tasks / active / solutions / verdicts / settled fail / local err), scoped to the joined SolverNet. Tinted via severity: `settledFailed > 0` triggers `.j-surface--warning`; `localErrors > 0` triggers `.j-surface--blocking`. (This is the single place where severity tones bleed into the data surfaces. Justification: failures and errors are the only place where the operator should be visually pulled toward action.)

### 4.3 What goes away

- **`AdvancedDetails`** — empty disclosure. Deleted, not preserved. ([AdvancedDetails.tsx](../../../client/src/dashboard/spa/src/pages/overview/AdvancedDetails.tsx))
- **The `notice` banner** in [Overview.tsx:380-395](../../../client/src/dashboard/spa/src/pages/Overview.tsx) — replaced by inline action confirmations within whichever card owns the action. Top-up confirmation lives inside the Funds card; Restart confirmation lives inside the Now surface. Auto-clear behaviour preserved.
- **The `AlertBand` "pick a SolverNet" surface** — moved into the Zone A right column when there is no joined SolverNet (see §4.1). The `no_solvernets_joined` notification row also disappears in this case because the Now surface is *better* than a notification (less generic, has the right link, more visible).

### 4.4 Token-driven typography rhythm

| Element | Token | Weight |
| --- | --- | --- |
| Primary status label (Zone A left) | `--text-md` | 500 |
| Hero number (Solutions, ETH, JINN) | `--text-xl` | 500 |
| Card section title | `--text-md` | 500 |
| Eyebrow label | `--text-xs` | 500, `letter-spacing: 0.14em`, uppercase |
| Body text | `--text-base` | 400 |
| Reason / caption | `--text-sm` | 400 |
| Stat detail (unit, sub) | `--text-sm` | 400 |
| Status indicator dot | `--text-base` | inline |

## 5. `/operator/*` sub-routes — polish

The four sub-routes (Memberships, Registry, Network, Security) and `/operator/execution-data` need (1) a shared page header, (2) better empty states, (3) breathing room.

### 5.1 Shared `OperatorPageHeader` component

Introduces a small primitive (in `client/src/dashboard/spa/src/pages/operator/` next to `OperatorShell.tsx`) that every sub-route mounts at the top of its content area:

```tsx
<OperatorPageHeader
  title="Memberships"
  description="SolverNets this operator has joined."
  // Optional action — appears top-right of the header
  action={<Link href="/operator/registry">Browse registry →</Link>}
/>
```

Renders as: large `--text-md` title (mono), single-line `--text-sm` muted description, optional sky-blue text link top-right. Bottom border `1px solid var(--border)`. The header is what gives each `/operator/*` page a sense of place.

### 5.2 Empty states

| Route | Current | Proposed |
| --- | --- | --- |
| `/operator/memberships` (empty) | "You haven't joined any SolverNets yet. Browse the Registry to participate." | Same line, but rendered inside an `j-surface--info` card with a primary "Browse registry" CTA button. |
| `/operator/registry` (empty) | "No unjoined SolverNets available." | Empty surface that explains: *"A SolverNet is a market where operators agree on harness, evaluator and reward rules for a class of tasks. Joining a SolverNet binds your daemon to its manifest CID."* + a `Learn more →` link to the relevant runbook + the empty-list message. |
| `/operator/security` | Form-only, no context | Form sits below a `j-surface-reference` card that shows: when the keystore was last rotated, why rotation matters in one sentence, and what happens to in-flight work during rotation. (Surfaced field: `lastPasswordRotationAt` per issue [#441](https://github.com/Jinn-Network/mono/issues/441).) |
| `/operator/network` | Functional, no empty state needed | No change to data; add the shared page header. |

### 5.3 Execution Data split

`/operator/execution-data` currently renders Data Donation **above** the Execution Artifact browser. This proposal:

- Keeps both on the same route (don't split the route — Ritsu signed off on this consolidation in `b00fcdfa`).
- Renders them as two **explicitly named tabs** within the page (`Donation` | `Artifacts`), driven by a query param `?tab=donation|artifacts`. Default is `artifacts` because that's the read-side concern most operators need.
- The `OperatorDataMarket` (donation config) collapses into a header strip when `tab=artifacts` is active — visible but quiet, with a "Manage donation" link that flips the tab.

### 5.4 Sub-nav active state

`OperatorSubNav` uses wouter's `useRoute` and sets `aria-current="page"` plus `background: 'var(--bg-elevated)'` on active items. Visual change: increase active-state contrast — switch to `border-left: 2px solid var(--accent-sky)` instead of the background swap, so the active route is unmistakable even at the periphery of vision. Keep the `aria-current` attribute.

## 6. `AppShell` and `Notifications` visibility

### 6.1 Notifications panel — always present

Today `<NotificationsList>` only mounts when `notices.length > 0`. Two problems: (1) the operator never learns the panel exists; (2) the page-grid `auto auto auto minmax(0,1fr)` vs `auto auto minmax(0,1fr)` row-template toggle causes a layout shift every time a notice arrives or clears.

Proposed: render `<NotificationsList>` unconditionally, but with two states.

- **`notices.length === 0`** — a single thin row, `--text-xs`, `var(--fg-dim)`, content: `"No active notices."` Total height ~28px. Quiet.
- **`notices.length > 0`** — current behaviour, with severity colors applied per row (§6.2). Sticky below tabs.

This keeps the panel discoverable and removes the layout shift. The empty state is so quiet (a single line of dim text) that an operator with a clean board barely notices it; an operator whose board lights up sees the change instantly.

### 6.2 NotificationItem severity color (issue [#444](https://github.com/Jinn-Network/mono/issues/444))

Current implementation (`NotificationItem.tsx`) renders the severity word in uppercase but with no color. Proposed:

```tsx
<li
  data-kind={notice.kind}
  data-severity={notice.severity}
  className={`j-notification j-notification--${notice.severity}`}
  aria-label={`${notice.severity} notice: ${notice.message}`}
>
  <span aria-hidden="true" className="j-notification__severity">
    {notice.severity}
  </span>
  <span className="j-notification__message">{notice.message}</span>
  {notice.jumpTo && <Link href={notice.jumpTo} className="j-notification__jump">resolve →</Link>}
</li>
```

With CSS rules in `globals.css`:

```css
.j-notification { display: flex; gap: var(--space-3); align-items: baseline; padding: var(--space-2) var(--space-4); border-left: 2px solid transparent; font-family: var(--mono); font-size: var(--text-sm); }
.j-notification__severity { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.14em; min-width: 64px; }
.j-notification__message  { flex: 1; }
.j-notification__jump     { color: var(--accent-sky); text-decoration: none; }

.j-notification--blocking { border-left-color: var(--severity-blocking-fg); background: var(--severity-blocking-bg); }
.j-notification--blocking .j-notification__severity { color: var(--severity-blocking-fg); }

.j-notification--warning  { border-left-color: var(--severity-warning-fg);  background: var(--severity-warning-bg); }
.j-notification--warning  .j-notification__severity { color: var(--severity-warning-fg); }

.j-notification--info     { border-left-color: var(--severity-info-fg); }
.j-notification--info     .j-notification__severity { color: var(--severity-info-fg); }
```

This closes [#444](https://github.com/Jinn-Network/mono/issues/444) and gives operators a glance-able severity at the edge of vision.

### 6.3 Header chrome

Header today has wordmark, TESTNET / RPC HEALTHY / MASTER address. Two changes:

- Make the wordmark *quieter* — drop from `--text-2xl` to `--text-md`, reduce visual contrast with the rest of the row. The wordmark today competes with status messages.
- Render the network pill (`TESTNET`) and RPC health (`RPC HEALTHY` / `RPC DEGRADED`) using severity tones — `--severity-info-fg` for healthy, `--severity-warning-fg` for degraded. Currently they look identical.

These are cosmetic-only; no behavior changes.

## 7. Spec compliance

**Components touched** (no contract changes): §2.1 Daemon, §2.2 Identity, §2.3 Funds, §2.4 Memberships, §2.5 Registry, §2.6 Tasks, §2.7 Rewards, §2.9 Harness Readiness, §2.10 Notifications, §2.11 Settings.

**Notification kinds touched**: all twelve continue to render unchanged in `NotificationsList`. `no_solvernets_joined` is also surfaced as the Zone A right-column primary action when applicable; this is an additional render path, not a replacement.

**Severity tiers**: blocking / warning / info — preserved. The proposed CSS tokens (`--severity-*`) are derived from existing colour tokens, not new colours.

**Lexicon**: no new vow-language is introduced. Words used: SolverNet, harness, vessel, vow, evaluator, master, agent, Safe.

**Out of scope (deferred to spec changes / other PRs):**
- Issue [#438](https://github.com/Jinn-Network/mono/issues/438) — Output Stats §2.14 question. Not resolved here.
- Issue [#440](https://github.com/Jinn-Network/mono/issues/440) — daemon harness-readiness rollup.
- Issue [#441](https://github.com/Jinn-Network/mono/issues/441) — `lastPasswordRotationAt`.
- Issue [#442](https://github.com/Jinn-Network/mono/issues/442) — `claim_failed` wiring.
- Issue [#443](https://github.com/Jinn-Network/mono/issues/443) — offline signal during bootstrap.

These remain open. The proposal renders empty / placeholder state where the daemon doesn't yet supply data, so the SPA changes do not block daemon work.

## 8. Phasing

The implementation plan (`docs/superpowers/plans/2026-05-21-operator-app-ui-reshuffle.md`) breaks this into four reviewable PRs:

- **PR 1 — Design tokens + primitives.** Add typography / spacing / motion / severity tokens to `globals.css`. Introduce `.j-surface-primary`, `.j-surface-secondary`, `.j-surface-reference`, `.j-notification--*` CSS classes. Migrate `NotificationItem` to use them — closes [#444](https://github.com/Jinn-Network/mono/issues/444). No layout changes elsewhere.
- **PR 2 — `/overview` IA rebuild.** Introduce the Zone A primary status surface and Zone A right-column action surface. Reorder Zone B. Delete `AdvancedDetails`. Migrate `HeroStats`, `FundsCard`, `RewardsCard`, `NetworkCard`, `IdentityCard`, `HarnessStatusPanel` to use the new surface classes. Move action confirmation banners inline.
- **PR 3 — `/operator/*` polish.** Introduce `OperatorPageHeader`. Rebuild empty states. Split Execution Data into tab UI. Improve sub-nav active state.
- **PR 4 — AppShell + Notifications.** Make NotificationsList always-rendered. Cosmetic header treatment.

Each PR is small enough to review in one sitting. Each PR is independently revertable. Each closes at least one cited Issue from the brief.

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Operator's muscle memory built on Phase 1-6 surfaces | The 13 spec components are preserved by name and contract; only their layout / visual weight changes. Phase 1-6 PRs are not reverted. |
| Visual hierarchy changes "feel" subjective and could regress | Each PR is screenshot-tested where possible (vitest + snapshot for component layout; manual capture for full-page). Manual smoke test against the running daemon at `http://127.0.0.1:7331` before each PR opens. |
| Token migration introduces regressions in unrelated views | Phase 1 adds tokens *additively* — no existing token is renamed or removed. Inline hardcoded values are migrated incrementally; mixed states are allowed during the transition. |
| Notification severity coloring breaks accessibility | All severities retain a text label (`blocking`, `warning`, `info`) in addition to color. WCAG 2.1 AA contrast verified against `--bg` for each `--severity-*-fg`. |
| Deleting `AdvancedDetails` breaks a test | Tests on `AdvancedDetails.tsx` are deleted with the component. Other tests reference `IdentityCard` and `HarnessStatusPanel` directly already, since those were promoted in Phase 2. |

## 10. Definition of done

For each PR:

- The PR's stated scope is implemented.
- No new violations of `BRAND.md` non-negotiables (no emoji, no decorative gradients, no uncoined vow-language).
- The full vitest suite passes, modulo pre-existing failures the brief acknowledges (`claim-readiness-gate.test.ts`, `daemon.test.ts`, `HeroStats.test.tsx`, `JoinFlow.test.tsx`).
- Manual smoke test against the running daemon: rebuild the SPA, copy the bundle to the running daemon's serving directory per the brief, hard-reload Chrome, walk every operator-facing route, confirm no console errors and visual correctness.
- PR body links to this design spec and to the Issues it closes.

For the series as a whole:

- An operator landing on `/overview` for the first time can articulate (without scrolling) what their node is doing right now, whether anything is wrong, and what their next action is.
- A returning operator with an in-flight task sees a coherent picture of progress, not eleven equal-weight cards.
- Severity colors are visible across notifications and tinted data surfaces.
- `DESIGN.md` typography, spacing, radius, and motion tokens are the source of truth in `globals.css`.

---

**References:**
[`client/OPERATOR-APP-SPEC.md`](../../../client/OPERATOR-APP-SPEC.md),
[`BRAND.md`](../../../BRAND.md),
[`DESIGN.md`](../../../DESIGN.md),
[`DESIGN.json`](../../../DESIGN.json),
[`docs/superpowers/plans/2026-05-21-operator-app-ui-reshuffle-brief.md`](../plans/2026-05-21-operator-app-ui-reshuffle-brief.md),
[`docs/superpowers/plans/2026-05-20-operator-app-spec-alignment.md`](../plans/2026-05-20-operator-app-spec-alignment.md).
