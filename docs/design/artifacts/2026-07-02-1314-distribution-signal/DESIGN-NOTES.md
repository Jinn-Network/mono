# Design notes — 1314 · Distribution signal

**Surface 2 · Web.** A read-only analytics section answering one question at a glance: *where is real usage concentrating?* Sorted by volume, seeds excluded from every number.

Preview: [`1314-distribution-signal.html`](./1314-distribution-signal.html) (loads [`distribution.jsx`](./distribution.jsx); keep them together). Shows loaded, loading, error, and empty states. React + Babel from CDN — the JSX is a faithful mirror of the explorer's own primitives, not production code.

Source: Claude Design project `frontends` (`019e2715-c4bc-7eae-af28-e178b95e5156`), files `1314-distribution-signal.html` + `distribution.jsx`.

> **Note on placement — read this first.** The brief specified this view *inside the operator dashboard* (matching `client/OPERATOR-APP-SPEC.md`), and issue #1314's domain-model delta still targets `client/OPERATOR-APP-SPEC.md`. **The design moved it out of the operator app and into the network explorer instead** (see below). This is a substantive divergence from the issue's stated home. Confirm the target surface before implementation — either the design's rationale is accepted and the issue's domain-model delta is re-homed to the explorer, or the view is rebuilt on shadcn primitives inside the operator app as the issue specifies.

---

## Where it lives (changed from the brief)

Moved out of the operator app entirely. It now lives in the **network explorer**, on the `Network` view (`/`), directly below the Activity strip and above / beside Network composition. Rationale: this answers a *protocol-wide* question — where incentives should flow — which is the explorer's job (neutral, legible, public), not an operator's node-management surface. It reuses the explorer's exact component set, so it reads as a native part of that view rather than a bolt-on.

Consequence for the component mapping: the brief asked for shadcn primitives (Table, Card, Badge, Switch, Skeleton, Alert). The explorer is not a shadcn app, so the mapping below is to the explorer's own primitives. If the view is instead built in the operator app, the shadcn equivalents are: Card → Card, headline cells → Card + typography, HBars/share bars → custom (no shadcn bar primitive — flag), table → Table, tags → Badge, segmented control → Tabs or a two-option ToggleGroup, freshness footer → custom, states → Skeleton / Alert / empty slot.

## Seed exclusion = the explorer's native corpus filter

The explorer already excludes seeded/imported corpus entries by default (the strict envelope-only filter; `?include=raw` opts out — see `NetworkView` header comment). Rather than invent a "debug toggle", the seed-exclusion requirement rides that existing control: a two-segment switch, `envelope-only` (default) / `include seeded`. Default excludes seeded entries from every number and states the excluded total plainly under the control; flipping to `include seeded` folds them back in live and annotates the delta per cluster. Same demonstrate-it-live behaviour the brief asked for, expressed in the explorer's own vocabulary.

## Hierarchy — favour the top 1–3

- **Headline**: an Activity-strip-style row (serif big numbers) — envelopes, clusters, distinct contributors, top-3 share.
- **Where usage concentrates**: sorted by volume — the leading cluster takes the sky-accent first bar; the tail recedes to muted fill. Same composition idiom the Network view already uses for by-mode / by-harness.
- **Clusters by volume**: a table — top rows full, the long tail folded into a built-in low-volume section. Tags render as bordered chips; verifiability isn't shown here (this is corpus volume, not scored results — kept honest).

## Component mapping — explorer primitive per element

| Element | Explorer primitive |
|---|---|
| Shell (header, nav, search) | `Chrome` — reused unchanged; Network tab active |
| Headline stats row | `Card` + the `ActivityStrip`/`ActivityCell` pattern (serif big number, dashed cell dividers) |
| Concentration bars | `HBars` (first bar sky-accent, rest muted) — unchanged |
| Clusters table | `DataTable` (sortable head, hairline rows, `lowVolumeRows` for the tail) |
| Tags | bordered caps-mono chips (the explorer's filter-chip idiom) |
| envelope-only / include seeded | `SegmentedControl` (the WINDOW control idiom) |
| Freshness footer | `StatusBar` — reused; shows indexed block + degraded chip |
| Loading / error / empty | Skeleton block · inline error + retry (Network view pattern) · `DataTable` empty-state slot |

Nothing here needs a component the explorer doesn't already ship — the whole section composes from existing primitives. That's the point of attaching it here rather than the operator app.

## States & copy

- **loaded** — as shown; the view refetches on the explorer's standard poll.
- **loading** — skeleton in the shape of the headline + bars + table; no layout shift on settle.
- **error** — inline red row with a `Retry` action, matching `NetworkView`'s own error affordance; `StatusBar` shows `Discovery: Degraded`.
- **empty** — exact copy, verbatim: *"No contributions yet — signal appears as the corpus grows."*

## Legibility & open questions

- **Provenance.** Per *Legible*, each cluster's envelope count should reach its source — a filtered corpus query or an explorer deep-link (e.g. `/solvernets?cluster=…`). Shown as a hover affordance; the exact target is a flagged open question.
- **Clustering method.** How envelopes group into named clusters (embedding + label, tag rollup, manifest tags) is upstream and undecided; the section renders whatever the clustering endpoint returns, sorted by volume.
- **Distinct-contributor total.** Per-cluster contributor counts overlap and don't sum; the headline shows a separately-computed distinct count, labelled as such.
- **Placement within the Network view.** Shown below Activity and above Network composition. Alternatively it could sit beside composition. Flagging the ordering for the explorer owner.
- **Home surface (raised above).** Explorer vs operator-app — resolve before build.
