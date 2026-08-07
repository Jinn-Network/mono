# Benchmark Product Web — App Spec

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-06 |
| **Author** | Packet BP-30 of the standalone benchmarking product implementation program (Claude Fable 5 session) |
| **Shape** | `design` |
| **Status** | draft |
| **Depends on** | [`../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md) (the product design spec — domain model, surfaces, presets, venue honesty, branding isolation; this document formalizes none of its decisions and reopens none of them) |

This is the app spec for `@jinn-network/benchmark-product-web`
(`packages/benchmark-product/web`), required by the repo frontend rules
(root `CLAUDE.md` §Frontends): every frontend ships a spec, and every
component in it is described on four axes — **State**, **State messages**,
**Collections**, **Actions** — with an explicit "none" wherever an axis is
empty. This document does not restate the product design spec's decisions;
it cites them and adds only web-surface presentation detail.

## 1. Purpose and position

The web app is the product's **human surface** — design spec §5.3: a
Next.js App Router + shadcn/ui application that imports the operations
library exported by `@jinn-network/benchmark-product-core` **server-side, in
process**.

**Central commitment (normative):** every action this GUI exposes is a
client of the operations library. There is no second implementation of any
operation, no GUI-only capability, and no HTTP API in v1 — the GUI calls the
library in-process, server-side (design spec §5.1, §5.3, §5.5). A GUI action
that computes, validates, or transitions state on its own, without going
through the library, is a defect in this product's terms, regardless of how
it is implemented.

**Capability parity (design spec §5.4).** Every GUI action must map to a row
of the generated parity matrix
(`packages/benchmark-product/core/parity-matrix.v1.json`, CLI verb ↔ library
operation). From M3 on, the matrix gains a GUI column and a CI test fails
any GUI action with no CLI/library row. Until the GUI is wired (§2), parity
holds by construction because the GUI renders no actions at all.

## 2. M3 scope ladder

Design spec §5.3 names the web app "milestone M3." This packet, BP-30,
ships only the **skeleton**:

- Next.js App Router + shadcn/ui toolchain, wired for build, lint, typecheck,
  and test.
- A neutral placeholder shell: one landing screen rendering the placeholder
  display name and tagline, plus prose explaining what the product does at a
  category level (the cold-start explanation).
- Branding isolation (§4): no Jinn lexicon, sigils, or palette; a temporary
  local branding module standing in for the core import.
- Guards: the web tree is swept by the family's lexicon/brand-neutrality
  test, is registered as a zero-Jinn-dependency row in the package-inventory
  guard, and is included in the source-boundary guard's live sweep with an
  unchanged (still core-only) allow-list.
- CI: the web package's build/lint/typecheck/test steps run under the
  existing `benchmark-product-ci` gate.

**This packet wires no operations.** There is no operations-library
dependency, no server action, no route beyond the single landing page, and
no rendering of any part of the domain model in §3 below. BP-31 and later
packets:

- add the `@jinn-network/benchmark-product-core` runtime dependency (the
  web→core edge, added to the package-inventory guard's dependency graph and
  the source-boundary guard's allow-list together, per the note already
  recorded in both guard files);
- replace `src/lib/branding.ts` with the import of core's
  `PRODUCT_BRANDING`, retiring the temporary duplication (§4);
- implement the component surfaces described in §3, in whatever order the
  program plan sequences them.

**State explicitly:** as of this packet, no component in §3 is rendered.
The domain model below is the target model this GUI will grow into, derived
from the design spec so implementation packets do not re-derive it; it
describes no shipped screen. A reader auditing what exists today should
consult §2, not §3.

## 3. Domain model (four axes)

Every axis below is derived from design spec §4.6 and the sections it
points at; where this document adds anything, it is presentation detail
over the same operations, never new semantics. Per §4.6, the **Quote**
sub-surface renders inside the Draft flow, the **Claim package** sub-surface
renders inside the Report surface, and the **Audit journal**'s axes render
inside the Workspace surface — each is covered where it renders, citing its
own §4.6 row.

Two rendering rules apply across every component and are stated once here
rather than repeated per component:

- **Gated actions are rendered visually distinct** from ungated ones
  everywhere they appear (button treatment, a persistent "requires
  authority" affordance, or equivalent) — the design spec's approval-gated
  operations (§4.1, §4.2: `lock`, `launch`, `cancel`, `report`; `publish`
  once it ships) are never presented as if any workspace member can invoke
  them.
- **Every failed action renders its typed error code with retry guidance.**
  Per design spec §4.3, operations return typed results or typed errors,
  never a silent fallback; the GUI never swallows an error into a generic
  "something went wrong" or a console log the operator cannot see.

### 3.1 Workspace

Covers the design spec §4.6 Workspace row and the Audit journal row (the
journal renders inside the Workspace surface, not as a separate screen).

- **State** — workspace path; storage version; draft count; run count; and,
  for the journal specifically (§4.6 Audit-journal row): entry count, last
  entry.
- **State messages** — `record-integrity` warning when stored sealed bytes
  fail their digest check on read (informational; the specific affected
  read still refuses with its own typed `record-integrity` error, per
  design spec §4.3). The journal itself raises none (§4.6 Audit-journal
  row: state messages — none).
- **Collections** — drafts; runs; sealed records (addressed by digest);
  artifacts; journal entries. The journal entry list is append-only and
  rendered **read-only** — newest last, per design spec §4.4; there is no
  edit or delete affordance for any entry, ever.
- **Actions** — `init` (workspace creation, distinct from the lifecycle
  `create` that starts a draft) → operation `initWorkspace`, CLI verb
  `init`. The journal has **no actions of its own** — entries appear only
  as a side effect of other operations; there is no "add journal entry"
  control.

### 3.2 Benchmark draft

Covers the design spec §4.6 Benchmark-draft row. The **Quote** sub-surface
(§4.6 Quote row) renders inside this flow, reached from a draft in state
`quoted`.

- **State** — lifecycle state (`draft` / `quoted`); validation status;
  selected task-set (as digests); arms with their pinning; assurance preset
  (design spec §6); policy (replicates, `closeAt`, replacement rule,
  budget); venue choice.
- **State messages** — per-field validation messages, each mapping to the
  specific `edit` that resolves it; "quote invalidated by edit" when an edit
  lands on a `quoted` draft (design spec A2 — any edit returns the draft to
  `draft` and drops the quote, because a quote always describes the exact
  draft it priced).
- **Collections** — items (task digests); arms; preview artifacts; prior
  quotes.
- **Actions** (operation → CLI verb; gated actions marked):
  - create → `createDraft` / `draft create`
  - edit → `updateDraft` / `draft update`
  - arm management → `armAdd` / `arm add`, `armList` / `arm list`,
    `armRemove` / `arm remove`, `armUpdate` / `arm update`
  - task intake → `importSweBenchRows` / `import swebench`,
    `sampleInit` / `sample init`
  - preview → `runPreview` / `preview` — ungated, non-advancing; every
    rendered preview artifact leads with the "rehearsal — not official
    evidence" marker (design spec §7.2, BP-20 addendum) so it cannot be
    mistaken for an official result
  - quote → `runQuote` / `quote`
  - lock → `runLock` / `lock` — **gated**; irreversible once it succeeds
  - inspect / read → `inspectDraft` / `inspect`, `getDraft` / `draft show`,
    `listDrafts` / `draft list`

#### 3.2.1 Quote (sub-surface of the draft flow)

- **State** — expected cell count; per-cell and total price (paid venues) or
  time/disk estimates (local venue); hard-cap check result; coverage facts
  (venue-supported pinning keys, per-arm refusals); venue guarantee summary
  (§5, design spec §7.1); a wall-time estimate, present **only** when
  labeled `estimate-from-rehearsal` and backed by real preview timings
  (design spec BP-20 addendum — never synthesized from anything else).
- **State messages** — "venue unavailable / degraded" (design spec §7.3),
  mapping to venue re-selection back on the draft.
- **Collections** — line items, one per arm × item × replicate.
- **Actions** — **none of its own.** A quote is a read (`runQuote` /
  `quote` is invoked from the draft, §3.2); `lock` acts on the draft, not on
  the quote.

### 3.3 Official run

Covers the design spec §4.6 Official-run row.

- **State** — lifecycle state (`locked` / `running` / `closed`); cancellation
  phase when present (`requested` while the venue drains, `cancelled` once a
  terminal Matrix is sealed); Run record digest; per-cell live status
  (dispatched / claimed / delivered / judged); spend against cap.
- **State messages** — infra failures are shown as infra, never as a fail
  (`unscorable` is a named outcome value, not a failure — design spec §4.1,
  §4.6); cap-approach warning; stall notice; "cancellation requested —
  draining in-flight work" until the operation reaches its terminal
  `cancelled` result. Venue/finalization contention retains the operation's
  typed retry guidance rather than being presented as terminal cancellation.
- **Collections** — cells, each with its dispatch lineage; live events.
- **Actions** — launch → `runLaunch` / `launch` (**gated**; spend authority
  on paid venues); watch/status → `runStatus` / `status`; resume →
  `runResume` / `resume`; collect → `runCollect` / `collect`; cancel →
  `runCancel` / `cancel` (**gated**; durable and idempotent, with typed
  `requested` and terminal `cancelled` results).

BP-30 still renders none of these controls: its shipped surface is the
placeholder shell described in §2. The cancellation action enters the GUI
only with the M3 operations wiring and generated GUI-parity coverage; this
target model records the already-shipped BP-22 library/CLI contract rather
than deferring or reimplementing it.

### 3.4 Results (Matrix)

Covers the design spec §4.6 Results (Matrix) row.

- **State** — Matrix record digest; `runOutcome`
  (`complete` / `partial` / `cancelled`); completeness
  (`{expected, judged, floor}`); attrition per arm; asymmetry flags;
  per-axis verification states.
- **State messages** — asymmetry flag raised — informational, a validity
  threat surfaced to the reader, **never absorbed** or silently resolved by
  the UI.
- **Collections** — cells, each with the six-value outcome
  (`judged | unjudged | unscorable | expired | invalidated | excluded`),
  verdicts, dissent, cost, and latency; exclusions.
- **Actions** — results → `runResults` / `results`; verify → `runVerify` /
  `verify`; report → `runReport` / `report` (**gated**).

**Deferred, not renderable:** design spec §4.6 names exports (EvalLog,
Croissant, static bundle) on this row, but no shipped operation produces
them from the GUI's reach today — the interop package's export functions
(design spec §3) are not yet wired through the operations library for this
surface. The GUI must not render an export control until an operation
exists for it to call.

### 3.5 Report

Covers the design spec §4.6 Report row. The **Claim package** sub-surface
(§4.6 Claim-package row) renders inside this surface, materialized at
`report` time (design spec BP-13 addendum).

- **State** — Report record digest; method id, version, and parameters;
  `preregistered` flag; disclosures block (including the rehearsal
  disclosure when the draft's preview log is non-empty, design spec BP-20
  addendum); signature status.
- **State messages** — "recompute divergence" — when an independent
  `verify` recomputation disagrees with the sealed Report, this is
  fail-loud: rendered prominently, never downgraded to a footnote.
- **Collections** — subject matrices; conflicted-cell list; limitations.
- **Actions** — inspect / verify → the same `runResults` / `results` and
  `runVerify` / `verify` operations described in §3.4 (a Report's
  underlying Matrix is inspected and verified through those same calls,
  not a second implementation); `publish` **reserved** — see below.

**Reserved, not renderable:** `publish` is a named lifecycle transition
(design spec §4.1) and a gated operation, but the parity matrix's
`exclusions` list confirms no operation ships it yet. The GUI must not
render a publish control until an operation exists for it to call.

#### 3.5.1 Claim package (sub-surface of the report)

- **State** — bundle version; digest links to the report, matrix, run, and
  benchmark records; scope statement.
- **State messages** — none — an informational asset; it carries no
  warnings of its own beyond what the Report surface already shows.
- **Collections** — derived assets (headline, snippet, machine-readable
  claim).
- **Actions** — **none of its own beyond inspect.** The claim package is
  produced as a side effect of `report` (§3.5); there is no separate
  "generate claim package" control.

### 3.6 Principals & authority

Covers the design spec §4.6 Principals-and-authority row.

- **State** — principals with their grants; approval policy in force.
- **State messages** — "operation awaiting authority" — maps to a sponsor
  grant action; rendered wherever a principal attempts a gated operation
  they do not (yet) hold the grant for.
- **Collections** — grants; pending approvals.
- **Actions** — grant → `authorityGrant` / `authority grant`; revoke →
  `authorityRevoke` / `authority revoke`; show → `authorityShow` /
  `authority show`.

**Approval is a permission policy, not a human-only path** (design spec
§4.2): a delegated agent holding the required grant may execute a gated
action through the CLI or the library exactly as a human sponsor would
through this GUI. This surface renders authority state and lets a sponsor
grant or revoke it; it does not itself own or intermediate approval —
there is no capability that exists only behind a click here (design spec
§5.4).

## 4. Branding isolation

Per design spec §9, this application carries a **neutral visual identity**:
stock shadcn neutral tokens, no Jinn lexicon, no Jinn sigils, and no Jinn
palette anywhere in the shell.

The placeholder display name and tagline are read, today, from
`src/lib/branding.ts` — a **temporary** local module, not the product's
single branding source. `src/branding-isolation.test.ts` pins its two
strings byte-equal to the design spec §9 source of truth,
`packages/benchmark-product/core/src/branding.ts`'s `PRODUCT_BRANDING`, so
the two cannot silently drift while this duplication exists. BP-31 (§2)
retires `src/lib/branding.ts` and imports `PRODUCT_BRANDING` from core
directly — an architectural simplification, not a behavior change, since
the strings are already pinned identical.

The attribution line (`PRODUCT_BRANDING.attribution`) is deliberately
**absent from this shell**. Design spec §9 permits it only in about and
verification contexts, never in the product name, primary navigation,
category explanation, or hero copy — and this packet has no about or
verification screen for it to live in yet. A later packet that adds such a
screen renders the attribution there; nothing in this packet's scope calls
for it.

This product's brand posture is a deliberate departure from root
`CLAUDE.md`'s Jinn design-system requirements (palette, sigils, lexicon,
`docs/design/jinn-design-system/`) — overridden here by the product
charter's separate-brand rule (design spec §1, §9). The parts of
`CLAUDE.md` §Frontends that are **not** brand-specific still apply in full:
Next.js App Router, shadcn/ui as the exclusive UI-primitive source, and the
four-axis app spec this document is.

## 5. UI rules

**Show, don't narrate** (`CLAUDE.md` §Frontends). No caption, subtitle,
legend, or footnote whose only job is to restate a value the screen already
shows or to describe where a link goes or what a control does. Where a term
genuinely needs explaining (an outcome value, a venue guarantee tier, an
assurance-preset name), it gets a tooltip, not permanent caption text.
Prose is reserved for empty states (which must say what will fill them) and
error states (which must say what failed and how to retry, per §3's
typed-error rule) — nowhere else.

**Venue honesty** (design spec §7). Guarantees, observations, estimates,
attestations, and unverifiable claims are visually and structurally
distinct wherever they appear — never rendered with the same weight or
styling as if they carried the same evidentiary strength. The local venue's
limitation copy (design spec §7.1: a local run's pre-registration is a
discipline, not a proof against its own owner) is carried on every screen
§7.1 requires it on — the product copy, and every report produced from a
local run.

**Trust boundaries** (design spec §8.1). The eight things the product must
never imply bind every screen this application renders, without exception.
This spec does not restate the enumerated list — §8.1 is authoritative; a
screen review checks against it directly, not against a paraphrase here.

## 6. Change discipline

Per `CLAUDE.md` §Frontends: a UI change that alters this domain model or
the action surface lands **with** a spec update to this document, in the
same PR. A PR that adds, removes, or regates a GUI action without touching
§3 or §4 is incomplete by definition.
