# Benchmark Product Web — App Spec

| | |
|---|---|
| **Version** | 0.2 |
| **Date** | 2026-08-07 |
| **Author** | Packet BP-30, amended by packet BP-31 of the standalone benchmarking product implementation program |
| **Shape** | `feat` |
| **Status** | draft |
| **Depends on** | [`../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md`](../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md) (the product design spec — domain model, surfaces, presets, venue honesty, branding isolation; this document formalizes none of its decisions and reopens none of them) |

This is the app spec for `@colophon-claims/web`
(`packages/benchmark-product/web`), required by the repo frontend rules
(root `CLAUDE.md` §Frontends): every frontend ships a spec, and every
component in it is described on four axes — **State**, **State messages**,
**Collections**, **Actions** — with an explicit "none" wherever an axis is
empty. This document does not restate the product design spec's decisions;
it cites them and adds only web-surface presentation detail.

## 1. Purpose and position

The web app is the product's **human surface** — design spec §5.3: a
Next.js App Router + shadcn/ui application that imports the operations
library exported by `@colophon-claims/core` **server-side, in
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
operation). The matrix's GUI column is authoritative: every rendered server
action is registered against a shipped operation, and every eligible
operation is either registered or carries a named packet deferral.

## 2. M3 scope ladder

Design spec §5.3 names the web app "milestone M3." BP-30 shipped the
**skeleton**:

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

BP-31 now realizes the setup half of M3. The web app has one production
product dependency edge, `web` → `@colophon-claims/core`, and
imports only that package's public entry from server-only modules. Its
fail-closed product context requires an explicit absolute workspace path
and principal. No private-key, credential, or ambient environment material
is copied into browser state.

The shipped routes cover workspace initialization; draft create/read/list/
edit/inspect; bundled sample, SWE-bench intake, and real Inspect runtime
selection; arm add/update/remove/
list; authority show plus sponsor-only grant/revoke; real-local-venue
preview; quote; and authority-gated lock. All facts and transitions come
from core operations through Server Actions. Successful mutations
revalidate the workspace and draft surfaces. Typed operation failures are
rendered with their retry guidance; unexpected exceptions are redacted to
a generic invalid-invocation failure, and runtime-origin execution/venue
details are replaced with safe typed retry guidance at the GUI boundary.

BP-33 completes M3 with the result/report/verification route and stable
`run.results`, `run.report`, and `run.verify` Server Actions. BP-40 adds the gated
`run.publish` Server Action. The generated
matrix now has zero deferred operation rows. The two pre-existing
non-operation capability exclusions remain explicit: `unverifiableAxisCounts`
is a helper, while standalone `bundle verify` deliberately has no browser
filesystem-path surface. `run.publish` is a shipped, gated core operation and
GUI action. Sections 3.1–3.6 now describe the rendered M3 surface.

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
  included) are never presented as if any workspace member can invoke
  them.
- **Every failed action renders its typed error code with retry guidance.**
  Per design spec §4.3, operations return typed results or typed errors,
  never a silent fallback; the GUI never swallows an error into a generic
  "something went wrong" or a console log the operator cannot see.

### 3.1 Workspace

Covers the design spec §4.6 Workspace row and the Audit journal row (the
journal renders inside the Workspace surface, not as a separate screen).

- **State** — a server-configured workspace indicator (the absolute path never
  crosses the browser boundary); storage version; draft count; run count; and,
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
  `init`; anchoring configure → operation `anchoringConfigure`, CLI verb
  `anchoring configure` (**gated**). The journal has **no actions of its
  own** — entries appear only as a side effect of other operations; there
  is no "add journal entry" control.

Anchoring configuration follows the publication-locator rule: the browser never
names an anchor provider or endpoint. This server contacts the configured
endpoint on every later lock, so a form-supplied URL would be an
outbound-request primitive; the deployment supplies its providers through
`BENCHMARK_PRODUCT_ANCHOR_PROVIDERS`, and the form carries only the decision to
apply them or to clear the block. With nothing configured server-side the
action refuses `invalid-invocation` rather than accepting a browser value. Both
the rendered configuration and the action's own success state name **provider
profiles only** — an endpoint is an operator-typed URL that can carry userinfo
or a key, and neither is worth serializing into a browser to state which
providers are configured. Action states: `idle → applied | cleared`, with
`failed` as the terminal alternative (typed `validation` for a profile or
endpoint the product cannot use, `authority-denied` without the grant).

Rendered at `/workspace` as the **Third-party time** card: the server-configured
profiles, an *apply* control (disabled with nothing configured server-side) and
a *turn anchoring off* control. Both are gated.

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
  - evaluation runtime selection → `selectInspectEvaluation` /
    `runtime inspect select`; the form selects an existing task and runtime
    configuration and is not an authoring environment
  - preview → `runPreview` / `preview` — ungated, non-advancing; every
    rendered preview artifact leads with the "rehearsal — not official
    evidence" marker (design spec §7.2, BP-20 addendum) so it cannot be
    mistaken for an official result
  - quote → `runQuote` / `quote`
  - lock → `runLock` / `lock` — **gated**; irreversible once it succeeds.
    After the transition completes, **both surfaces** run the anchor-evidence
    design's §7.2 hook through the same exported
    `anchorAfterLockIfConfigured`: with a configured workspace the lock obtains
    one anchor over the sealed Run record, and any refusal or failure is
    swallowed — the CLI emits a note (stdout in human mode, stderr under
    `--json`), the GUI discards the outcome entirely, and neither the lock
    result nor the exit code moves. The durable record of the attempt is the
    audit journal in both cases. The CLI additionally offers `--no-anchor` to
    skip the errand for one invocation; the GUI has no such control, because a
    browser lock that quietly skipped a configured anchor would be a second,
    invisible policy.
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
  `cancelled` result; a closed run with a valid marker says cancellation is
  finalized, never still draining. Venue/finalization contention retains the
  operation's typed retry guidance rather than being presented as terminal cancellation.
- **Collections** — cells, each with its dispatch lineage; live events.
- **Actions** — launch → `runLaunch` / `launch` (**gated**; spend authority
  on paid venues); watch/status → `runStatus` / `status`; resume →
  `runResume` / `resume`; collect → `runCollect` / `collect`; cancel →
  `runCancel` / `cancel` (**gated**; durable and idempotent, with typed
  `requested` and terminal `cancelled` results); anchor → `runAnchor` /
  `anchor` (**ungated**; the browser names the draft and which sealed record
  to anchor — `lock` or `matrix` — never a provider or endpoint, which come
  from the workspace's own configuration).

Anchoring is opt-in and never blocking. With nothing configured, no anchor is
attempted and nothing is said about it. Once configured, `lock` attempts one
anchor over the sealed Run record *after* the lock transition has already
completed, and any refusal or failure is a note plus its own audit entry — the
lock's own result is unchanged, so the rendered lock outcome never depends on a
third party being reachable. The standalone anchor action exists to retry a
failed lock-time attempt before launch, to anchor the terminal Matrix after
close, and to upgrade a pending proof before publish. Action states:
`idle → anchored`, with `failed` as the terminal alternative (typed
`venue-unavailable` when nothing resolves or the provider does not answer,
`venue-unverifiable` when what came back does not hold, `conflict` on a
re-anchor, `illegal-transition` for a lock anchor after dispatch began).

Rendered at `/workspace/[draftId]/run` as the **Third-party time** card: one
control per subject — the sealed Run record (enabled while `locked`) and the
terminal Matrix (enabled once the run is closed, reported, or published).
Neither form carries a provider or an endpoint.

BP-32 renders these controls at `/workspace/[draftId]/run`. The monitor is a
durable read: every refresh/poll calls `runStatus` against the sealed Run,
draft, cancellation marker, and append-only journals; an in-memory promise is
never rendered as truth. Launch and resume run the exact public core promise
in-process under Next's request-lifetime `after()` retention. A journaled
driver generation means the real venue's synchronous state-root ownership
check succeeded; async readiness/drive failures are paired to that generation
and remain visible after the response. Cancellation-wrapper close and venue
shutdown are part of the generation, before its terminal journal event, so a
late resource-release rejection is durably failed rather than falsely
successful. Pre-ownership contenders return typed errors without creating a
generation. A restart may leave an active generation without a terminal
outcome; Resume recovers through core's durable journal.

The browser view preserves the durable failure's typed code but replaces its
detail and issues with safe retry guidance at the server-only view projection;
the core journal and CLI retain the exact diagnostic. This fail-closed boundary
covers arbitrary execution and venue/preflight errors that can carry paths or
secret-bearing command material. Action forms are min-width-contained and long
terminal results wrap or scroll locally so a 390 px viewport does not widen the
document.

The deliberately slow real-attempt control is server-only and needs two exact
environment opt-ins. Its default is absent, it is never serialized to browser
state, it accepts at most core's 60,000 ms maximum, and it injects only core's
explicitly `ForTesting` delay dependency.
This exists for production-build browser verification of requested → draining
→ cancelled; it is not a product setting.

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
  `verify`; report → `runReport` / `report` (**gated**); publish or re-verify
  the digest-addressed draft-owned bundle → `runPublish` / `publish` (**gated**).

BP-33 renders this surface at `/workspace/[draftId]/results`, linked from
both the draft and run monitor. The route calls the public `runResults`
operation server-side and semantically renders its exact returned facts:
summary cards, locally scrollable named tables, dissent and failure detail,
axis verification, and local-venue honesty. It does not calculate a score,
statistic, validity judgment, or replacement value. The result action
refreshes this durable projection; report is visibly gated; verify has a
dedicated live result/error region rather than a generic JSON dump.

BP-40's publish control emits the fixed-schema public-bundle closure through the core
operation; it does not expose arbitrary export paths or call interop directly.

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
  not a second implementation); publish/re-verify → `runPublish` / `publish`.

Once a draft is durably reported, the public `runResults` document adds an
exact stored Report/claim projection. It re-reads the sealed payload and
envelope by digest and validates the claim schema, but explicitly reports
verification as `not-run`; only `runVerify` authenticates the signature and
independently re-derives the Matrix, Report, and claim consistency. The
report action revalidates this route, so a reload shows the same durable
Report and claim facts. Named verification checks and digests are rendered
on success; record-integrity or recomputation divergence is a prominent
typed error and never a passing status.

The browser submits only the draft id. The server resolves the immutable
digest-addressed draft-owned target, and projects only its workspace-relative location,
identity, and named checks back to the browser. It never accepts an arbitrary
browser filesystem path. On `published-bundle`, the same action re-verifies
the existing immutable bundle without re-running orchestration. Every publish
failure is reduced to a typed browser-safe receipt with logical relative issue
paths; server filesystem paths and raw filesystem messages never cross the
browser boundary. Reloading the route reads and renders the durable bundle
identity, relative path, publication time, and named checks from RunState.

#### 3.5.1 Claim package (sub-surface of the report)

- **State** — bundle version; digest links to the report, matrix, run, and
  benchmark records; scope statement including each arm's stored pinning;
  the claim's own completeness, attrition, assurance, disclosures,
  limitations, venue-honesty, and rehearsal blocks.
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
- **Actions** — grant → `authorityGrant` / `authority grant`
  (**sponsor-only**); revoke → `authorityRevoke` / `authority revoke`
  (**sponsor-only**); show → `authorityShow` / `authority show`.

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

The display name and tagline are read from the public core entry's
`PRODUCT_BRANDING`. `src/lib/branding.ts` is only a public-entry re-export;
it contains no local copy of product identity or other domain semantics.
The brand-neutrality test proves the web source remains free of the Jinn
lexicon, sigils, palette, and design-system imports.

The attribution line (`PRODUCT_BRANDING.attribution`) appears only inside the
results route's verification landmark. Design spec §9 permits it there (and
in an eventual about surface), never in the product name, primary navigation,
category explanation, hero copy, Matrix summary, Report, or claim sections.

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

## 7. BP-50 accessibility and private-response contract

The optimized application is exercised through a product-owned Playwright
gate against `next start`, at desktop and 390-by-844 viewports. `/`,
`/workspace/new`, both workspace states, invalid action results, all draft/run
states, and sealed through published results receive an axe audit at both sizes
with zero violations of any impact; there is no rule filter or waiver. One
keyboard-only path covers setup, sample intake, two arms, quote, lock, the
real local venue, results, report, verification, and local publication.

Every page provides one primary heading, logical section headings, a main
landmark targeted by the first-focusable skip link, named grouped navigation,
programmatic labels, visible focus, and word-plus-color status. Action results
are polite atomic live regions; success, scheduled, and error outcomes receive
focus after completion with a computed visible outline or ring. Activating the
skip link likewise focuses `main#main-content` with a computed three-pixel
foreground outline on every route, even where a route retains a local outline
utility. Lifecycle-illegal controls are disabled. Reduced-motion,
200% zoom, and 390 px containment are acceptance states rather than visual nits.

Every private route and Server Action response is non-cacheable and carries the
header policy in the product security note (`../SECURITY.md`). The CSP is
same-origin and denies active embedded content and off-origin requests while
retaining only the inline bootstrap/style allowances required by the shipped
Next App Router and Server Action runtime. The browser never receives the
absolute workspace path, arbitrary runtime diagnostics, private credentials,
or an arbitrary filesystem-path control. The gate uses an exact owner-marked UUID
root per invocation, scans build/runtime/credential sentinels and actual generated
private-key bytes, then copies and standalone-verifies the publication after
deleting its source workspace. Deployment status remains none.

The finite Permissions Policy is pinned to Playwright 1.59.1's Chromium
147.0.7727.15 surface. Its exact denied features live in
`permissions-policy.mjs` and are reproduced in the product security note: 80 on
Linux and 81 on Darwin, where Chromium additionally exposes Web Bluetooth. The
optimized gate requires the runtime-recognized list to match byte-for-byte in
sorted order, requires `document.featurePolicy.allowedFeatures()` to be empty,
and rejects every header-parser warning. Browser capability drift is therefore a
reviewed policy update, never an implicit permission.

## 8. Colophon design-system adaptation

The public product identity is **Colophon**. Its category is “Benchmark
publishing for agent configurations,” its tagline is “Compare agents on the
same work,” and its public promise is “Publish benchmark claims people can
check.” “Built on Jinn” appears only as attribution in about, verification, and
report-footer contexts. The earlier neutral shell and placeholder-brand notes
above are historical milestone records; they no longer describe production.

The approved Colophon source bundle is preserved under
`../design-system/reference/` with its source digest and adaptation decisions.
Production uses the real source mark, the Newsreader/Public Sans/IBM Plex Mono
font roles, warm-paper/ink/vermilion tokens, hairline rules, restrained small
radii, and no ornamental content shadows. The runtime adapter preserves the
existing shadcn components, operations, routes, accessibility contracts, and
responsive containment instead of copying prototype mechanics wholesale.

The operational workspace remains truthful to the currently implemented local
lifecycle. The public landing page may link to read-only previews for reports,
task sets, entrants, evaluators, runs, agents, billing, docs, and pricing. Every
such page carries the persistent label “Preview — future hosted service,”
contains no operational form or Server Action, and must not imply that hosted
accounts, billing, registries, or report delivery are live. These future SaaS
views are intentionally retained as product-direction prototypes rather than
removed; implementation claims remain limited to the local workspace.

The frozen public bundle keeps the exact `benchmark-product-public-bundle/1`
file roles and evidence semantics. Its five presentation assets use the same
Colophon identity and embed their fonts and mark for source-deleted, offline
rendering. No presentation asset computes a winner or changes a stored Matrix,
Report, or Claim fact.
