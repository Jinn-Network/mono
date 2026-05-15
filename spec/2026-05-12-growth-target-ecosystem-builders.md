- **Date:** 2026-05-12
- **Author:** Oak (with Claude)
- **Status:** Proposal
- **Version:** 0.1

## Motivation

The §3 trajectory over the past week has tightened from "AI builders"
(`spec/2026-05-06-growth-canonical-restructure.md`) to "open-source agentic
project contributors" (`spec/2026-05-07-growth-niche-and-pitch-pmf-search.md`,
AM) to "open-source coding agent contributors"
(`spec/2026-05-07-growth-cluster-tightening-coding-agents.md`, PM). Each
step narrowed the recruit shape toward what Sprint #3's swe-rebench v2
commitment actually implies. The recruit shape Jinn lands is the one §3
points at — every loosening at §3 leaks back as out-of-cluster warm rows
and unanchored discovery, as the 2026-05-07 PM tightening forensically
established.

The current §3 is close but still misses on the contributor / consumer
axis. "Open-source coding agent contributors" reads correctly if the
cluster's own naming centres on contribution to the *harness*. In
practice the cluster is shifting around a different organising centre:
a leading open agentic harness (Hermes today, OpenCode before that)
whose social and economic gravity attracts both contributors and
adopters. Adopters signal taste — they are nodes in the cluster's
audience graph — but adopting Hermes is not the recruit shape Jinn's §1
legitimacy bet requires. The recruit shape is *people whose work pools
naturally because they ship verifiable artefacts others consume*.
Calling the cluster "contributors" is closer than "builders" but lets
in adopters whenever an account's bio or recent posts cite the leading
harness. The boundary needs to be the artefact, not the affiliation.

The leading harness will move over time — OpenCode held the mantle a
quarter ago; Hermes (Nous Research) holds it now; an Anthropic feature
release could shift it again. §3 names the leading harness inline
("currently Hermes, formerly OpenCode"). When the leading harness
changes that is a §3 change and goes through the same canonical-doc
flow as any other §3 change per `spec/2026-04-28-canonical-docs.md` —
no separate mechanism needed.

A second observation surfaces the artefact list. The cluster's recruit
shape pools around a small set of artefact types that are load-bearing for
SolverNet supply: skills, plugins, MCP tools, custom harnesses, harness
extensions, routers, models, evaluators, and ERC-8004 ecosystem
components (registry entries, discovery surfaces, attribution
components, anything in the ERC-8004 pipeline). Enumerating these inside
§3 is the legibility move — `discover-twitter-recruits` and
`cluster-model` both need a concrete set of work products to anchor
against, not the broader gesture toward "verifiable coding-agent
artefacts at the harness layer" that the 2026-05-07 PM §3 currently
uses.

The fix is a single §3 rewrite that (a) names the cluster as **ecosystem
builders shipping verifiable artefacts on the leading open agentic
harness** (currently Hermes, formerly OpenCode), extended to ERC-8004
ecosystem builders; (b) enumerates the artefact list as the functional
boundary; (c) keeps §6.1's token-tolerance ethos and the §3 disposition
preamble verbatim. This is a tightening on the contributor / consumer
axis and a widening on the artefact-type axis — the net is a sharper
recruit boundary, not a broader one.

This is a §3 rewrite. §1, §2, §4, §6, §7, §8, and §9 do not move. §5 may
need light touches if the daily-loop skill chain shifts; the audit in
*Downstream skill audit* below identifies what shifts where and what
sits unchanged.

**Supporting research.** Per-ecosystem motivation profiles for the
eleven ecosystems named in §3 (Hermes, OpenCode, Aider, OpenHands,
Cline, ERC-8004, Continue.dev, Roo Code, Goose, SWE-agent, plus
OpenClaw as the deceased-predecessor reference point) are in
[`growth/docs/2026-05-12-ecosystem-builder-motivations.md`](../growth/docs/2026-05-12-ecosystem-builder-motivations.md).
That doc carries the field evidence, the cross-ecosystem synthesis, and
the four-cluster table (Distribution / Research / Substrate-capture /
Sovereignty) that this spec's §3 rewrite implicitly relies on. Read it
before reviewing the cluster definition below.

## What this proposal changes

### §3 cluster name and definition tighten on the contributor axis, widen on the artefact axis

`Current target cluster: open-source coding agent contributors` becomes
`Current target cluster: ecosystem builders shipping verifiable artefacts
on the leading open agentic harness, plus ERC-8004 ecosystem builders`.

The cluster is defined by *what they ship and where it lands*, not by
whether they call themselves a "contributor" to a specific repo. Two
qualifying populations:

- **Harness ecosystem builders.** People shipping verifiable artefacts
  that compose with the leading open agentic harness — currently Hermes
  (Nous Research), formerly OpenCode. Artefact types in scope: skills,
  plugins, MCP tools, custom harnesses, harness extensions, routers,
  models, evaluators. The artefact must be publicly shippable and
  pool-able: others consume it, attribution flows back, the work product
  has a public surface that an evaluator can verify against.
- **ERC-8004 ecosystem builders.** People shipping verifiable artefacts
  in the ERC-8004 pipeline — registry entries, discovery surfaces,
  attribution components, evaluators, anything that composes against the
  ERC-8004 surface (see [ERC-8004 GitHub](https://github.com/ethereum/ERCs)
  for the canonical reference). The ERC-8004 surface is in scope because
  its native primitives (verifiable artefact registry, attribution,
  evaluator role) are the same shape Jinn's loop produces; recruits
  shipping there are pre-aligned on the verifiability tier without having
  to be sold on it.

The functional boundary is **verifiable artefact, publicly shippable,
others consume**. The harness anchor scopes the first population to the
cluster's gravity well; the ERC-8004 anchor extends the same shape to a
parallel ecosystem whose recruit profile fits §1 by construction.

The ethos boundary is unchanged: token-tolerance per §6.1.

§3 names the *leading* open agentic harness (Hermes today, OpenCode
before that). When the leading harness changes, that is a §3 change and
goes through the normal canonical-doc flow per
`spec/2026-04-28-canonical-docs.md` — same paper-trail cost as any
other §3 rewrite. The ERC-8004 anchor is stable as long as the standard
is the canonical surface for verifiable artefacts on Ethereum-adjacent
stacks.

The contributor / consumer line is now sharp: adoption of Hermes is not
qualifying. Shipping a skill / plugin / MCP tool / harness extension /
router / model / evaluator that others can pick up is qualifying. The
test is whether the artefact has a URL someone else could clone, fork,
import, or call.

Eval-as-research practitioners at institutional labs remain out of the
recruit pool for the same §6.1 reasons.

### Pitch — umbrella unchanged, vertical instance preserved, with ecosystem-builder framing layered in

The umbrella pitch from `spec/2026-05-07-growth-niche-and-pitch-pmf-search.md`
remains verbatim:

> *"This is a public-good network for agentic training data. People
> shipping agentic projects pool their real work into shared SolverNets
> — others attempt the same tasks, evaluators verify, the corpus
> accrues to everyone. It's coordinated via a token because there is no
> central operator; participation is how stake accrues."*

The vertical-instance second paragraph from
`spec/2026-05-07-growth-cluster-tightening-coding-agents.md` also remains
verbatim:

> *"The first SolverNet is swe-rebench v2 — a rolling-refresh
> program-repair benchmark on real GitHub issues. People who ship coding
> agents pool their attempts on the same task stream; evaluators verify
> with docker-grade test gates; the corpus accrues. Help collectively
> train a swe-rebench v2 harness."*

A third sentence is added, scoped to ecosystem builders, that names the
artefact-pooling shape directly:

> *"If you ship skills, plugins, MCP tools, harness extensions, routers,
> models, or evaluators on the leading open agentic harness — or
> verifiable artefacts in the ERC-8004 pipeline — your work is the
> SolverNet's supply side. The corpus that accrues is the public record
> of how those artefacts perform on shared tasks."*

The umbrella generalises (other SolverNets follow). The vertical
instance gives the cluster a concrete surface to recognise.
The ecosystem-builder sentence names the artefact-pooling shape so the
recruit hears their own work product in the pitch. All three are needed
during PMF search.

### Bridge model — same shape, ecosystem-builder examples

The Frame / Frame Jinn offers / Bridge structure stays. The examples
tighten to ecosystem-builder work products.

**Frame this cluster currently holds.** People shipping ecosystem
artefacts on the leading harness iterate against their own private
evaluation — the harness's built-in tests, their dogfooding against a
private workload, their feel for whether the skill or the router or the
evaluator is good. The eval-as-research clusters they look up to
publish *static* benchmarks (SWE-bench, SWE-bench Verified,
swe-rebench v1) that snapshot capability at a point in time. The team's
own dogfooding is starting to be named as the right cadence, but it
stays private — the maintaining team eats the cost and keeps the
signal. The contributor's own iteration loop is structurally solo:
their artefact, their integration tests, their private benchmark, their
corpus. ERC-8004 builders face the same shape one layer down — the
verifiability surface exists in protocol but the live signal does not
yet pool.

**Frame Jinn offers.** The eval-signal is a coordination primitive, not
a private artefact. When a SolverNet exists for a task class the
ecosystem builder's artefact composes against, others attempt the same
tasks; their solutions enter the builder's decision space and the
builder's enter theirs. Static benchmarks are the snapshot; this is the
stream — public, attributable, stake-backed. The harness, the registry,
the evaluator becomes the substrate of a network, not the moat of a
maintaining team. ERC-8004 builders see the same network already
operating under the standard they shipped under.

**The bridge.** The methodology question that moves a cluster member
across the gap: *static benchmarks are last year's coding agents; live
eval against rolling fresh GitHub issues is a coordination problem
nobody owns. What does it look like to run the artefact you already
shipped — the skill, the router, the evaluator — alongside others
shipping in the same surface, and who pays for the task stream?* The
question must not be answerable from the recruit's own README, post, or
pinned thread.

### §3 retired-cluster archive entry

The current §3 ("open-source coding agent contributors", landed
2026-05-07 PM) moves to `growth/.local/growth-log.md` §1 as a dated
archival entry alongside the prior "open-source agentic project
contributors" (2026-05-07 AM) and "AI builders" (2026-05-06) entries.

### Disposition preamble — unchanged

The PMF-search preamble from `spec/2026-05-07-growth-niche-and-pitch-pmf-search.md`
stays verbatim:

> *During PMF search, §3 records our current bet on cluster, pitch, and
> bridge. Bet rotation is the rewrite-and-archive flow already specified
> above — the spec-proposal flow is the velocity governor, not a claim
> that the bet is settled. Read this section as "this is what we're
> testing right now," not "this is who Jinn is for."*

### §4 Phase 1 name update

`Phase 1 — Open-source coding agent contributors (current)` →
`Phase 1 — Ecosystem builders on the leading open agentic harness + ERC-8004 (current)`.

One-line note appended to the existing tightening history:

> *The cluster handle was tightened from "open-source coding agent
> contributors" on 2026-05-12 because the prior handle implicitly
> recruited consumers of the leading harness alongside contributors,
> and because the prior handle did not encode a transition rule for
> harness-leadership shifts. The artefact list (skills, plugins, MCP
> tools, custom harnesses, harness extensions, routers, models,
> evaluators, ERC-8004 components) is the new functional boundary. The
> §6.1 token-tolerance ethos is unchanged.*

The rest of §4 (Phase 2, Phase 3, phase-transition triggers) does not
move.

## What this proposal does *not* change

- §1 The bet (legitimacy as scarce resource — load-bearing, unchanged)
- §2 The bottleneck (operator count — unchanged)
- §3 disposition preamble (PMF-search bet framing — unchanged)
- §3 ethos boundary (§6.1 token-tolerance — unchanged; only the
  functional boundary tightens-and-widens)
- §4 GTM sequence shape (Phase 2 / Phase 3 untouched; only Phase 1's
  cluster name moves)
- §5 Daily loop functions (Understand / Teach / Engage / Refine —
  unchanged in shape; downstream skills update vocabulary per the audit
  below)
- §6 What we will not chase (§6.1 token-tolerance rule landed 2026-05-07
  AM — unchanged; retired-framings list — unchanged)
- §7 Metrics (headline operator count + swe-rebench v2 SolverNet runs —
  unchanged; the pinning from `spec/2026-05-07-growth-cluster-tightening-coding-agents.md`
  holds)
- §8 Channel canon (unchanged)
- §9 Sprint discipline (unchanged)
- The umbrella pitch verbatim
- The swe-rebench v2 vertical-instance pitch paragraph verbatim
- The bridge-model shape (Frame they hold / Frame Jinn offers / Bridge);
  only the examples instantiate to ecosystem-builder artefacts

The umbrella + vertical instance + ecosystem-builder framing is a
three-layer pitch, additive over what landed on 2026-05-07. The third
sentence is the artefact-axis legibility move.

## Downstream skill audit

For each skill: (a) what content currently references §3 or its
vocabulary, (b) what shifts under the new §3, (c) whether the skill
needs structural changes or just vocabulary updates. No skill files are
edited in this pass — this audit produces direction only.

### `growth-day`

**(a) Current §3 references.** Reads §3 every run; uses §3's cluster
definition as the cluster gate for Tier A / Tier B candidates;
Step 1.6 lints sprint § 6 vs §3 alignment with both a cluster-handle
check and a vertical/cluster check (the latter exists precisely
because the 2026-05-07 PM mismatch surfaced); the bootstrap top-3
references the §3 bridge model as the canonical Teach source.

**(b) Shifts under new §3.** The cluster-gate logic still works — it
filters the four data sources (warm-contacts CSV, growth-log §2
bridge angles, growth-log §3 active threads, today's watcher) against
the active sprint's cluster (which must reference §3). The shift is in
vocabulary: the cluster handle changes; the active sprint's §6 block
needs to be re-stated to match the new §3 verbatim or to declare a
sub-segment (per §9's sprint declaration rule).

**(c) Structural vs vocabulary change.** Vocabulary. The bootstrap
top-3 paragraph already cites the §3 bridge model canonically; no edit
needed there beyond the bridge model's instance updating.

### `cluster-model`

**(a) Current §3 references.** Reads §3 as the canonical cluster
definition this skill samples against; writes evidence and bridge
angles tagged with the cluster's canonical name; the
`references/cluster-vocabulary.md` file holds per-cluster search
vocabulary that is updated as the cluster's vocabulary shifts; the
`references/bridge-shapes.md` file holds canonical bridge sub-patterns
by cluster.

**(b) Shifts under new §3.** Vocabulary plus one sub-pattern. The skill
needs to:

1. Refresh `references/cluster-vocabulary.md` against the new cluster.
   Section per anchor — Hermes (current), OpenCode (archival),
   ERC-8004 (parallel). Sampling targets the currently-named harness;
   archival vocabulary stays around for historical drift detection.
2. Add a bridge-shapes sub-pattern for ERC-8004 ecosystem builders.
   Their recruit-side substrate is different enough from harness-side
   that the bridge question has a different shape — the verifiability
   tier is already in protocol; the live signal isn't.

**(c) Structural vs vocabulary change.** Vocabulary plus the ERC-8004
sub-pattern (small structural addition to `references/bridge-shapes.md`).

### `discover-twitter-recruits`

**(a) Current §3 references.** `references/audience-profile.md` defines
the conversion criterion; `references/search-strategy.md` defines
working `bird` CLI invocations and named anti-patterns. Step 1 of the
discovery procedure derives the audience from GROWTH §3 by default.
Both reference files were last calibrated against the OLAS / Bittensor
/ Numerai orbits.

**(b) Shifts under new §3.** Significant. The search vocabulary
changes:

1. The OLAS / Bittensor / Numerai / Pearl vocabulary was calibrated for
   the jinn-adjacent crypto cluster (retired in `spec/2026-05-06-growth-canonical-restructure.md`).
   It is already operationally archival. The new §3 needs a fresh
   search vocabulary calibrated against the leading-harness cluster:
   handles in the Hermes / Nous Research orbit; people shipping
   skills / plugins / MCP tools / harness extensions / routers /
   models / evaluators publicly; their contributor-and-extension
   graph on GitHub and X.
2. A parallel ERC-8004 vocabulary needs to exist: people authoring
   ERC-8004 registry entries, discovery surfaces, attribution
   components; Ethereum-adjacent infra builders shipping verifiable
   artefacts under the standard.
3. The audience-profile bot/shill detection logic stays. The
   conversion criterion in `audience-profile.md` rewrites: from
   "would this person plausibly run a Jinn solver, build adjacent
   tooling, contribute code, or boost the protocol" to "does this
   person ship a verifiable artefact (skill / plugin / MCP tool /
   harness extension / router / model / evaluator / ERC-8004
   component) that others could clone, fork, import, or call".
4. The reference files should structure vocabulary per anchor (Hermes
   primary, OpenCode archival, ERC-8004 parallel) so the next §3
   rewrite that names a different leading harness is a vocabulary-file
   swap, not a from-scratch rewrite.

**(c) Structural vs vocabulary change.** Mostly vocabulary, but the
volume of change is large. The two reference files
(`audience-profile.md`, `search-strategy.md`) need recalibration
against the new cluster from scratch — the prior calibration on the
OLAS / Bittensor / Numerai orbit was already archival post-
2026-05-06; the 2026-05-07 PM coding-agent calibration has run for
five days and produced some signal but not enough to anchor a
reference doc against. The recalibration is itself a discovery round —
which makes it a natural Tier A action immediately after this spec
lands.

### `x-post-builder`

**(a) Current §3 references.** Stage 2 (pre-warm targets) asks the user
to name cluster operators whose take on the post they would want.
"Cluster" here is §3's current cluster. The bridge-post mode consumes
bridge angles produced by `cluster-model` (which are tagged with
§3-cluster identifiers). The voice-constraints section on
*Cluster-fingerprint lag during §3 pivots* explicitly references §3
pivots as a structural cost.

**(b) Shifts under new §3.** Vocabulary. The cluster handle changes;
the artefact-shape examples in pre-warm-target prompting change (the
skill should be able to suggest *artefact-shaped* candidates — "name
2–3 people who ship skills / plugins / MCP tools / harness extensions /
routers / models / evaluators on the leading harness whose take on
this you'd want"). The cluster-fingerprint lag warning stays accurate.

**(c) Structural vs vocabulary change.** Vocabulary.

### `x-algorithm-grader`

**(a) Current §3 references.** `references/scoring-tables.md` and
`references/algorithm-model.md` define the cluster-fit detector. The
detector is calibrated against "crypto+AI-infrastructure" as the
cluster signature; bridging-lexicon vocabulary (agent, autonomy,
distribution, sovereignty, training, outcomes, decentralised execution,
dark talent, value capture) scores 0.8–1.0. SKILL.md Read-first cites
§3 as the cluster the post is graded against.

**(b) Shifts under new §3.** Vocabulary. The cluster-fit detector's
high-scoring lexicon needs to be expanded to include the artefact
vocabulary: skills, plugins, MCP tools, harness, harness extensions,
routers, models, evaluators, registry, attribution, ERC-8004. The
existing crypto+AI-infrastructure bridging lexicon stays — the new §3
cluster is a sub-cluster of crypto+AI-infrastructure, not a different
cluster.

**(c) Structural vs vocabulary change.** Vocabulary in the scoring
tables; one-line note in the algorithm model that the cluster-fit
target is now ecosystem-builder-shaped, not generic-coding-agent-shaped.

### `growth-watcher`

**(a) Current §3 references.** `bird home --following` filter in
Step 4 ("Detect cluster signals") classifies posts against §3's
current target cluster, plus growth-log §1 evidence handles for that
cluster. Watcher entries record `suggested_cluster:` annotations.
Re-classification happens in `growth-day`; watcher is the raw signal.

**(b) Shifts under new §3.** Vocabulary. The "cluster signals"
detector reclassifies in line with the new §3 — leading-harness
artefact-shipping posts and ERC-8004 ecosystem-component posts both
score as cluster signals; pure-adoption posts (someone announcing
they're using Hermes for a task) do not (they would have classified
loosely under the prior §3; the new §3's artefact-axis cleans this
up).

**(c) Structural vs vocabulary change.** Vocabulary. The skill's
structural cleanliness (watcher emits raw, growth-day classifies) is
already the right shape.

### `growth-refine`

**(a) Current §3 references.** §3-drift detection is one of the
canonical drift candidates the skill computes. Drift signals named
include bridge-model staleness, pitch underperformance from the
calibration log, conversion-shape mismatch from the discovery log.
The skill proposes amendments; it does not edit canonical files.

**(b) Shifts under new §3.** Vocabulary. The drift-signal shape under
§3 stays the same; the cluster definition it compares against changes.

**(c) Structural vs vocabulary change.** Vocabulary.

### `twitter-strategy`

**(a) Current §3 references.** Reads §3 as the canonical target
definition; surfaces account-level drift between Oak's posts and §3's
named cluster across 7-day / 30-day windows. Mentions corpus is
classified against §3's target cluster for inbound-interest counting.

**(b) Shifts under new §3.** Vocabulary. The §3 target-cluster
definition changes; the cluster-classification logic for mentions and
inbound-interest counting follows. Account-level drift detection
shape is unchanged.

**(c) Structural vs vocabulary change.** Vocabulary.

### Summary

| Skill                         | Change shape                                | Effort       |
|-------------------------------|---------------------------------------------|--------------|
| `growth-day`                  | Vocabulary                                  | Small        |
| `cluster-model`               | Vocabulary + ERC-8004 bridge sub-pattern    | Small-medium |
| `discover-twitter-recruits`   | Vocabulary recalibration (large)            | Medium-large |
| `x-post-builder`              | Vocabulary                                  | Small        |
| `x-algorithm-grader`          | Vocabulary in scoring tables                | Small        |
| `growth-watcher`              | Vocabulary                                  | Small        |
| `growth-refine`               | Vocabulary                                  | Small        |
| `twitter-strategy`            | Vocabulary                                  | Small        |

`discover-twitter-recruits` carries the largest load because the prior
reference-file calibration is archival — the first invocation post-
canonical-change is itself a recalibration round. The other seven are
vocabulary updates that can ship in a single grouped PR.

## Open questions

- **Is "ecosystem builders" the right cluster handle for the public-facing
  cluster name, or only the doc-internal handle?** The handle reads
  cleanly inside the doc but in DMs and first-touches the phrase that
  works is closer to "people shipping skills / plugins / MCP tools /
  harness extensions on Hermes". Proposed: the doc handle is
  "ecosystem builders on the leading open agentic harness + ERC-8004";
  outreach vocabulary leads with the artefact list. The skills below
  (`x-post-builder`, `discover-twitter-recruits`) calibrate against
  the artefact-list vocabulary, not the doc handle.

- **Should ERC-8004 be in §3 from day one, or sequenced behind harness
  ecosystem builders?** Proposed: ERC-8004 in §3 from day one. The
  surface is small enough that gating its discovery costs more than
  including it; the recruit profile fits §1 by construction; and the
  artefact list overlaps with the harness side (evaluators, registries)
  so the boundary is operationally simpler to maintain as one cluster
  with two anchors. Open to argument that the recruit volume and the
  bridge shape are different enough to warrant a separate sub-cluster
  with separate sampling cadence.

- **Is the artefact list (skills, plugins, MCP tools, custom harnesses,
  harness extensions, routers, models, evaluators, ERC-8004
  components) the right grain?** Some of those overlap (a harness
  extension might be implemented as an MCP tool; a router might be
  packaged as a plugin). Proposed: keep the list redundant; the
  redundancy is legibility, not classification. Recruits self-identify
  into whichever term names their work. Refactor only if the list
  itself becomes a recruit confusion.

- **What happens during an ambiguous harness transition (no single
  leader)?** §3 names a leading harness inline; when there is no clear
  leader, the next §3 rewrite carries the cost of resolving the
  ambiguity (pick one, or name two temporarily). Open: should two-anchor
  state in §3 be expected occasionally, or treated as a forcing function
  to pick? Proposed: treat as a forcing function to pick — two-anchor
  §3 breaks the cluster-gate filtering in `growth-day` and the audit
  in `discover-twitter-recruits`. Revisit if the cluster lands in
  genuine two-anchor state.

- **Does the §3 rewrite under-include adjacent populations the prior
  §3 PM tightening already excluded?** Open. The prior tightening
  explicitly excluded eval-tooling builders, agent-observability
  tooling builders, and RL-environment authors. The new §3 picks up
  some of those (evaluators are in the artefact list; agent-
  observability tooling that ships as a harness extension is in)
  but not all (RL-environment authors who don't ship to a harness
  surface remain out). Proposed: this is correct — the artefact-axis
  boundary admits the recruits whose work pools naturally on the
  cluster's gravity well, and excludes adjacent populations whose
  work does not. The §1 legitimacy bet is the constraint that
  forces this trade.

## Migration plan

### The day this spec lands (proposal status, no canonical change yet)

This spec is a proposal. No canonical doc changes. No skill files
change. The proposal sits in `spec/` while the GitHub Discussion is
opened (by Oak, separately) and CODEOWNERS review proceeds per
`spec/2026-04-28-canonical-docs.md`.

The proposal can be referenced from in-flight work as the *intended*
direction, but no skill should silently start using the new vocabulary
before the canonical change lands — that would invert the canon-vs-
operational ordering this spec is itself an instance of.

### After CODEOWNERS approval (the canonical change lands)

A follow-up PR — separate from this proposal — does the canonical
write:

1. **GROWTH.md updates.** §3 rewrite (cluster name, definition,
   artefact list, leading-harness inline naming, retired-cluster
   archive entry pointer); §3 disposition preamble unchanged; pitch
   gains the third ecosystem-builder sentence; bridge model examples
   re-instantiate to ecosystem-builder artefacts; §4 Phase 1 name
   update plus history note.

2. **growth/.local/growth-log.md updates.** §1 archives the prior
   §3 "open-source coding agent contributors" cluster verbatim, dated,
   retirement note pointing to this spec; §6 active sprint
   cluster-definition block re-stated to match the new §3.

3. **growth/.local/jinn-warm-contacts.csv updates.** Rows whose
   `cluster` value matches the prior cluster handle and which are not
   already frozen update via the sprint-pivot freeze mechanism
   (per `growth-day`'s Step 0). Rows for ecosystem-builder candidates
   that survive the artefact-axis tightening keep their state. The
   audit happens manually before the freeze sweep; not every prior-
   cluster row is auto-frozen if the candidate still ships qualifying
   artefacts.

4. **Sprint #3 disposition.** Sprint #3 (declared 2026-05-07 with
   swe-rebench v2 as the vertical) does *not* retire. Its cluster
   definition in §6 is restated verbatim to match the new §3; window,
   inputs target, and decision rule are unchanged. swe-rebench v2 is a
   coding-agent vertical and the cluster is a *superset* of its
   natural recruit base — `growth-day` Step 1.6 should pass alignment.

### After the canonical change, skill-side follow-ups (separate PRs)

Per the *Downstream skill audit*, each skill change is its own follow-up:

- **`discover-twitter-recruits` vocabulary recalibration.** Largest
  individual skill change; runs as a discovery round itself (the new
  cluster has no calibrated handle list yet). `references/audience-profile.md`
  and `references/search-strategy.md` get rewritten against the new
  cluster. The first invocation post-canonical-change is the
  calibration round; subsequent invocations consume the new reference
  files.
- **`cluster-model` vocabulary refresh + ERC-8004 bridge sub-pattern.**
  `references/cluster-vocabulary.md` reorganises by anchor (Hermes
  current, OpenCode archival, ERC-8004 parallel). New ERC-8004
  bridge-shape sub-pattern in `references/bridge-shapes.md`.
- **`growth-day`, `x-post-builder`, `x-algorithm-grader`,
  `growth-watcher`, `growth-refine`, `twitter-strategy` vocabulary
  updates.** Each small; can ship in a single grouped PR.

Skill changes do not require canonical-doc approval — they go through
normal review per the engineering handbook (work shape: `docs`).

### Sequencing summary

```
Day 0 (today)  : This proposal lands in spec/.
Day 0+         : Oak opens GitHub Discussion linking this proposal.
Day 1–N        : CODEOWNERS review + discussion.
Day N (approved): Canonical PR — GROWTH.md §3 rewrite + growth-log/CSV/sprint
                  block updates.
Day N+         : Skill follow-up PRs:
                  - discover-twitter-recruits (vocabulary recalibration)
                  - cluster-model (vocabulary + ERC-8004 sub-pattern)
                  - grouped vocabulary updates for remaining skills
Day N+M        : First post-canonical sprint either continues Sprint #3
                  (cluster restated, vertical unchanged) or declares
                  Sprint #4 if the postmortem cadence requires.
```

## Risks and limitations

- **"Ecosystem builders" reads broader than "contributors."** Cosmetic
  reading is correct; structural reading is the opposite. The artefact
  list and the leading-harness anchor tighten the boundary; the
  contributor / consumer line is sharper now than before. Mitigation:
  the §3 rewrite enumerates the artefact list inline, in the
  cluster-definition paragraph, so the reading order is *artefact-shape
  first, "ecosystem" gesture second*. Skill calibration consumes the
  artefact list, not the gesture.

- **Harness-anchor change velocity may exceed the canonical-doc flow's
  velocity.** If Hermes shifts to a successor in a four-week window but
  the discussion-plus-CODEOWNERS approval flow takes six weeks, §3 lags
  reality for two weeks. Mitigation: the §3 rewrite that names a new
  leading harness goes through the same canonical-doc flow as any other
  §3 change; the velocity governor is the canonical-doc gate itself,
  not a separate mechanism. During the gap, the operator may surface
  HEADS-UP in `growth-day` for canon-vertical alignment; in-flight
  sprints freeze cleanly when the canon update lands via the existing
  sprint-pivot freeze flow.

- **ERC-8004 is small enough that bundling it into §3 may produce zero
  recruit volume in month one.** Mitigation: the ERC-8004 surface is
  named explicitly as a parallel cluster anchor; if month-one
  discovery rounds return no qualifying ERC-8004 candidates, the
  parallel anchor doesn't fire and the cluster operates as
  harness-anchored only. The structural cost of including ERC-8004 in
  §3 from day one is small; the structural cost of excluding it and
  re-introducing it later when the standard's recruit pool matures is
  higher. The risk is upside-only.

- **The artefact list may date.** Skills, plugins, MCP tools today;
  some other primitive in six months. Mitigation: the artefact list is
  enumerated inline in §3 and changes via the same canonical-doc
  flow as any other §3 change. The list is intentionally not
  abstracted into a "generic verifiable artefact" gesture — concreteness
  is what makes `cluster-model` and `discover-twitter-recruits`
  operationally legible. The cost of periodic spec updates to the
  artefact list is a feature, not a bug.

- **Same-week multiple §3 tightenings risk normalising churn.** This
  spec follows 2026-05-07 AM and PM tightenings (five-day gap). The
  causal chain is documented (PM tightening's contributor-axis
  boundary leaked consumers under the leading-harness gravity well;
  this spec closes that leak). The PMF-search preamble already names
  §3 as a *current bet*; multiple tightenings inside PMF search are
  the right cost of getting the boundary right while Sprint #3 is
  still pre-threshold. The canonical-doc flow is the structural brake;
  this spec respects it (no edit-and-archive — it goes through the
  gate).

- **The 2026-05-12 timing of this spec may be premature against
  Sprint #3's pre-threshold state.** Sprint #3 has run five days under
  the 2026-05-07 PM §3. The signal-to-noise on whether the prior §3
  was the right handle is still partial. Counter-mitigation: the
  observed leak (consumers of the leading harness counted as cluster
  fit under the prior §3) is structural, not data-thin — a single
  daily-loop run with a Hermes-adopter row surfacing as Tier A would
  reproduce it. The contributor / consumer axis fix is independent of
  Sprint #3's outcome and can land without prejudicing it.

## Appendix: prior content for archival

The current §3 "open-source coding agent contributors" + pitch + bridge
model paragraphs move to `growth/.local/growth-log.md` §1 as a third
dated archival entry (2026-05-12), labelled *"Prior §3 cluster, retired
by `spec/2026-05-12-growth-target-ecosystem-builders.md`."* The earlier
"AI builders" (2026-05-06) and "open-source agentic project contributors"
(2026-05-07 AM) and "open-source coding agent contributors" (2026-05-07 PM)
archive entries are unchanged. The retention rule is the same — do not
delete history when §3 is rewritten.

## Sequencing

1. **This spec lands** in `spec/2026-05-12-growth-target-ecosystem-builders.md`
   on branch `claude/growth-ecosystem-builders-spec-XacoV`. Approval
   gate per `spec/2026-04-28-canonical-docs.md`.
2. **Oak opens a GitHub Discussion** linking this spec, per the
   canonical-doc flow. This step is Oak's, not Claude's — the spec
   author drafts, the canon owners ratify, the Discussion is the
   audit trail.
3. **After approval, a canonical PR** lands the GROWTH.md updates
   plus the growth-log / warm-contacts / sprint-block updates listed
   in *Migration plan*.
4. **Skill follow-up PRs** sequence after the canonical change, in
   the order listed in *Migration plan* (`discover-twitter-recruits`
   recalibration → `cluster-model` vocabulary refresh + ERC-8004
   sub-pattern → batched vocabulary updates for the remaining skills).
5. **Sprint #3 carries forward** with the restated cluster definition;
   `growth-day` Step 1.6 should pass alignment on the next run after
   the canonical change.
