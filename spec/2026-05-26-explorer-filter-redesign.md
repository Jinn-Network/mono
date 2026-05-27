---
version: 1.0
date: 2026-05-26
author: oaksprout + claude
status: proposed
follows: '2026-05-25-demonstrate-solver-learning.md (§5.2 amend)'
related-epic: '#601 — EPIC: Demonstrate solver learning'
---

# Explorer filter UX redesign — progressive disclosure on SolverNetView

Follow-on to the [#676](https://github.com/Jinn-Network/mono/issues/676) merge that brought `/explore` onto `/solvernet/<cid>`. The merge succeeded structurally, but the inherited filter control surface — five stacked sections above the chart (GROUP BY chip row, FILTERS section, active-slice chip strip, WINDOW selector, RAW toggle) — competes with the chart for attention and obscures click-to-filter affordances. This spec replaces that chrome with a progressive-disclosure pattern modelled on consumer-grade data-viz tooling (Plausible, Linear, Notion, Posthog, GitHub Projects).

The chart itself does not change.

## 1. Problem

Current state of `SolverNetView` after [#676](https://github.com/Jinn-Network/mono/issues/676):

- The control surface sits in a `bg-elevated` card with five distinct visual sections. Even at the default landing (no filters, group=none, window=50), the card is fully populated and ~150 px of vertical chrome.
- The `GROUP BY` chip row exposes six dimensions inline (`none / operator / harness / plugin / mode / model`); the `FILTERS` section is a separate stack; the active-slice chip strip below is a *third* representation of the same state.
- Click-to-filter on chart legend entries and leaderboard rows is wired ([#676](https://github.com/Jinn-Network/mono/issues/676) shipped that), but the affordance is invisible — legend items and leaderboard rows look identical to inert text. A viewer has to *know* the interaction to discover it.
- Two functional bugs make the grouped view inconsistent (see §6).

Consumer-grade data-viz tooling has converged on a different pattern: the chart is the focal element; filters surface as compact chips above the chart only when active; group-by lives as a separate dropdown adjacent to the filters; window/time range stays inline with the chart caption; advanced controls hide behind a single `⚙` trigger. The data itself is the primary filter UI — hover affordances signal click-to-filter on every clickable element.

This spec reshapes the control surface to that pattern.

## 2. Domain survey (briefly)

Cross-tool pattern audit (2026-05-26):

| Tool | Filters | Group-by | Window |
|---|---|---|---|
| Plausible | chip strip when active | n/a (page-level segmentation) | separate top-right |
| Posthog | chip strip with `prop = value` | separate Breakdown panel | separate top-right |
| Linear | chip strip | separate dropdown `Group: X ▾` | n/a |
| Notion DB | chip strip | separate button | n/a |
| GitHub Projects | chip strip | separate dropdown | n/a |
| Sentry | search-query chips | separate panel | separate top-right |
| Datadog | inline scope bar (all-in-one) | inline scope bar | inline scope bar |
| Looker / Tableau | filter shelf + dimension shelf (split) | dimension shelf | separate |

**Convergent best practice in consumer-grade tools:** filters as chips; group-by as a *visually distinct* separate control; window/time always separate. Only the heavy BI tools (Datadog, Tableau) combine everything in one bar — and they're tools for analysts who live in the surface daily, not for press-claim viewers landing on a URL.

The redesign follows the consumer-grade convergence point.

## 3. Layout

### 3.1 Default landing (`/solvernet/<cid>` with no params)

State: no filters, `group=none`, `window=50`, `include` not set.

Above the chart panel: a single horizontal row, right-aligned, containing two persistent affordances:

- `+ filter` chip (dashed border, `fg-dim` color, Notion/Linear "add filter" pattern). Click opens a dimension picker → value picker.
- `Group by: none ▾` dropdown. Inactive state (no border accent). Click opens a list of dimensions.

No filter chip strip. No "Showing" label. No ALL CAPS section headings. Vertical chrome above the chart: ~32 px.

The chart panel keeps the existing window selector (`20 / 30 / 50 / 100 / ALL`) inline with the chart caption (top-right of the chart panel). The `⚙` trigger sits to the right of the window selector.

### 3.2 With active filters (e.g. the milestone-canonical URL)

When ≥1 filter is active, a chip strip appears immediately above the chart panel:

- The strip has 1 px hairline top + bottom borders, subtle `bg-elevated` tint.
- Inside the strip, two horizontal regions:
  - Left: filter chips, each in `dim:value ×` shape. `+ filter` dashed chip appears at the end of the chip list.
  - Right: `Group by: <dim> ▾` dropdown. When grouping is set (≠ none), the dropdown takes `accent-sky` border + text (active state).
- When ALL filters are removed, the strip disappears; the `+ filter` chip and `Group by ▾` dropdown reflow back to the persistent right-aligned row from §3.1.

### 3.3 Chart panel (unchanged)

The existing chart panel remains:
- Title / caption row at the top (e.g. `Trailing-30 · N series` or `Trailing-30 over N envelope-enriched verdicts`).
- Window selector + `⚙` button at the top-right.
- Curve + axis annotations (e.g. `t − 99 at index N`) per the existing implementation.

## 4. Interactions

### 4.1 Click-to-filter affordances

Two surfaces support click-to-filter: the chart legend (when grouping is active) and the leaderboard rows.

**Chart legend entries** are buttons (already shipped in [#676](https://github.com/Jinn-Network/mono/issues/676)). On hover:
- Cursor switches to pointer.
- The legend entry's background gains the `bg-elevated` tint.
- The entry's label is followed by the inline hint `→ filter to this` in `fg-dim` color, JetBrains Mono 9 px.

Click adds `filter[<group-dim>]=<value>` to URL state. The chip strip appears (if it wasn't already), the chart re-renders to the single-series slice, the leaderboard re-filters.

**Leaderboard rows** are buttons (already shipped). On hover:
- The row's background gains `bg-elevated` tint.
- The operator address column gains the inline hint `→ filter to this` immediately after the address, in `fg-dim` JetBrains Mono 9 px.
- The cursor switches to pointer over the row content.

Click anywhere on the row body adds `filter[operator]=<address>`. Separately, a small `↗` link icon sits at the right edge of every row, with its own cursor pointer; clicking that link navigates to `/operator/<address>` (the existing operator detail page). The two affordances coexist: row click filters; `↗` navigates.

### 4.2 `+ filter` chip interaction

Clicking the `+ filter` chip opens a two-step popover:

1. **Dimension picker.** Lists the six dimensions (`operator / harness / plugin / mode / model`). The currently-grouped dimension shows a small note ("currently grouped") next to it but stays selectable.
2. **Value picker.** Once a dimension is picked, the popover lists the values that exist in the current slice (drawn from the slice's `series[].groupValue` when grouped by that dim, or from the SolverNet's composition data otherwise). Each value is selectable.

Selecting a value adds `filter[<dim>]=<value>` and dismisses the popover. The chip strip materializes immediately if this was the first filter.

### 4.3 `Group by ▾` dropdown interaction

Clicking opens a flat list of dimensions: `none / operator / harness / plugin / mode / model`. Selecting one sets `group=<dim>` (or `group=none` for the unset state) and the chart re-renders.

When `group=none`, the dropdown shows `Group by: none ▾` in inactive (border-default, fg-muted) styling. When `group≠none`, the dropdown shows `Group by: <dim> ▾` in active (border-accent-sky, fg-accent-sky) styling.

There is no "remove group-by" chip inside the filter strip. The dropdown is the canonical surface for group state; resetting to `none` happens through it.

### 4.4 `⚙` popover

A single small `⚙` icon-button at the right of the window selector row. Click opens a small popover containing:

- `Include raw data` toggle — when on, URL gains `?include=raw` and the surface is marked with a `wane`-bordered chip `INCLUDES RAW DATA` (existing pattern per the prior spec's §4 / §5.3).
- `Reset to default` action — sets `filter={}`, `group=none`, `window=50`, `include` unset. Equivalent to navigating to `/solvernet/<cid>` with no params.

The popover is the only home for these two operations; there is no other UI surface for them.

## 5. Components (new and modified)

**New components:**

- `FilterChipStrip` — renders the chip strip above the chart when ≥1 filter is active. Props: `filters: FilterMap`, `onRemove(dim, value)`, `onAddFilter()`. Hides itself when filters are empty.
- `GroupByDropdown` — labeled dropdown rendering `Group by: <value> ▾`. Props: `value: GroupValue`, `onChange(GroupValue)`. Always visible (in the persistent row at default landing, embedded in the strip when filters active).
- `PersistentControlsRow` — right-aligned row above the chart panel. Contains `+ filter` chip and `GroupByDropdown` when no filters are active. Becomes empty when the chip strip absorbs the dropdown.
- `AddFilterPopover` — two-step dimension → value picker triggered by `+ filter` chip. New popover component; reuse existing `Popover` primitive if one exists, otherwise add.
- `SliceSettingsPopover` — small popover triggered by the `⚙` button. Contains `Include raw data` toggle and `Reset to default` action.

**Modified components:**

- `SolverNetView` — replaces the current `ExploreControls` card with `FilterChipStrip` + `PersistentControlsRow` + the existing chart panel + leaderboard. State propagation via `url-state.ts` is unchanged.
- `LearningCurve` — legend entries gain hover-affordance styling per §4.1. Hover state already implemented for click; visual treatment of `→ filter to this` hint is the addition.
- `Leaderboard` — row hover styling per §4.1, including the inline hint on the operator address column.

**Removed components:**

- `ExploreControls` — replaced. The five-section control card is deleted. Its file may stay for one cycle as a deprecation shim if anything still imports it; otherwise removed in this same PR.

## 6. Bug fixes (acceptance criteria)

Two bugs surfaced during manual review of [#676](https://github.com/Jinn-Network/mono/issues/676)'s live deployment. The redesign must fix both.

### 6.1 "No data yet" with degenerate filter + group

**Today:** visiting `/solvernet/<cid>?group=harness&filter[harness]=codex` renders the chart panel with "No data yet" despite the slice returning 221 verdicts (visible in the KPI strip). The slice engine returns a single series for this query — the chart renders nothing.

**Fix:** the chart must render the single-series slice when `filter[<dim>]=<value>` narrows the active group-by dim down to one value. Two viable implementations — implementer chooses:

- (a) Render the single series. The chart panel does not require ≥2 series to render.
- (b) Auto-clear the group-by dim when `+ filter` (or click-to-filter) adds a value for it, since the resulting group is degenerate. The URL becomes `?filter[harness]=codex` (no `group=harness`) and the chart renders single-series under `group=none`.

Either fix satisfies acceptance; the implementer should pick whichever is cleaner against the existing engine + frontend code.

### 6.2 KPI hero shows wrong value when grouped

**Today:** visiting `/solvernet/<cid>?group=harness` shows the gold KPI hero as `2.6%` despite the slice's aggregate rate being 63.5% (verifiable from `/explorer/slice`'s `kpis` field at the same URL with no filter — the engine returns the correct aggregate). The KPI hero math goes off the rails in the grouped case.

**Fix:** the KPI hero always reflects the slice's aggregate `kpis.resolvedRate` (the `series`-independent number returned by the engine), regardless of grouping. Group-by affects the chart's series shape; it does not change the KPIs.

## 7. Out of scope

- Changes to the slice engine (`/explorer/slice`) API. The endpoint's params and response shape stay as defined in [`spec/2026-05-25-demonstrate-solver-learning.md`](2026-05-25-demonstrate-solver-learning.md) §6.
- Changes to the chart component's data binding, axis behavior, or curve rendering. The chart itself does not change.
- Changes to URL-state encoding. Existing scheme preserved: `filter[<dim>]=<value>`, `group=<dim>`, `window=<n>`, `include=raw`.
- Changes to `NetworkView` or `OperatorsView`. Out of scope; this spec is `SolverNetView` only.
- Cross-SolverNet comparison (still YAGNI per [`spec/2026-05-25-demonstrate-solver-learning.md`](2026-05-25-demonstrate-solver-learning.md) §9).
- Mobile/responsive treatment beyond "the strip wraps to multiple lines when narrow." Detailed mobile layout deferred.
- Onboarding tooltips, guided tours, or first-visit overlays. The hover affordance and persistent `+ filter` chip handle discoverability; no extra onboarding chrome.

## 8. Acceptance summary

- Default landing (`/solvernet/<cid>` with no params): chrome above chart is one right-aligned row (`+ filter` + `Group by: none ▾`). No chip strip.
- Locked-config URL (`/solvernet/<cid>?filter[harness]=codex&filter[model]=gpt-5.4-mini&window=30`): chip strip visible with both filter chips + `Group by: none ▾` dropdown right-aligned within the strip.
- Hovering a leaderboard row body shows `bg-elevated` highlight + inline `→ filter to this` hint after the operator address.
- Hovering a chart legend entry (when grouping is active) shows the same inline hint.
- Clicking a leaderboard row body adds `filter[operator]=<addr>`. Clicking the `↗` icon at row-end navigates to `/operator/<addr>` (existing behavior).
- `+ filter` opens dimension picker → value picker; selecting adds the filter.
- `Group by ▾` opens dimension list including `none`; selecting changes `group=<dim>`.
- `⚙` opens popover with `Include raw data` toggle and `Reset to default` action.
- Bug 6.1: visiting `?group=harness&filter[harness]=codex` renders the chart, not "No data yet."
- Bug 6.2: visiting `?group=harness` shows the correct aggregate KPI hero, not 2.6%.
- All UI changes respect [`Design.md`](../Design.md) tokens (JetBrains Mono labels, Instrument Serif headlines, sky/gold accents per One-Voice rule, softened-brutalist radii, no glass / no shadows beyond hairlines).
- Vitest coverage on the new components (`FilterChipStrip`, `GroupByDropdown`, `AddFilterPopover`, `SliceSettingsPopover`).
- Playwright smoke test (extension of the existing `solvernet-explore.e2e.test.ts`): visit cold landing, assert no chip strip; click `+ filter` → pick harness → pick codex; assert chip appears; remove via × and assert strip disappears.

## 9. References

- Predecessor spec: [`spec/2026-05-25-demonstrate-solver-learning.md`](2026-05-25-demonstrate-solver-learning.md) §5.2 — amend to point at this spec for the post-#676 SolverNetView shape.
- [#676](https://github.com/Jinn-Network/mono/issues/676) (closed) — `/explore` → `/solvernet/<cid>` merge that this spec inherits.
- [#601](https://github.com/Jinn-Network/mono/issues/601) — EPIC: Demonstrate solver learning. This redesign serves the EPIC's "visible artifact" requirement by making the artifact actually usable.
- Design tokens: [`Design.md`](../Design.md).
- Operator-app spec modelling discipline: [`client/OPERATOR-APP-SPEC.md`](../client/OPERATOR-APP-SPEC.md) §1 (Static / Streams / Actions / State messages).
- Live page being redesigned: <https://jinn-indexer-production.up.railway.app/solvernet/bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi?filter[harness]=codex&filter[model]=gpt-5.4-mini&window=30>
- Brainstorm artefacts: `.superpowers/brainstorm/19439-1779829006/content/` (mockup HTML, not committed).
