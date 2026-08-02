# Jinn Platform Architecture — Boundary, Tiers, and Topology

- **Date:** 2026-07-30
- **Status:** **approved and in force.** Designed section-by-section in session (operator:
  Ritsu, 2026-07-30); written form reviewed 2026-07-30 — architecture review (4 major / 4
  minor) and adversarial review (2 blocker / 8 major / 2 minor), all findings dispositioned
  in-text (§12); ratified with DR-2026-07-30 on the operator's commit approval. Ownership
  effects (§3 graduation, supersessions in the DR `amends:` line) are in effect as of that
  commit
- **Shape:** `design`
- **Decision record:** [`log/decisions/2026-07-30-platform-boundary-and-topology.md`](../../../log/decisions/2026-07-30-platform-boundary-and-topology.md)
  (DR-2026-07-30)
- **Scope:** what the Jinn platform is responsible for (the functional boundary), how that
  boundary reconciles with the four-tier layering law, where code lives (repository topology),
  the mechanical inclusion test and extraction gate, and the disposition of every existing tree
- **Out of scope:** operator-daemon composition and migration mechanics (queued design session);
  plugin and marketplace product designs (queued); any physical move, rename, or repository
  creation; canonical-doc rewrites (follow-up); publish-path implementation (follow-up)

**Live topology:** this specification owns the platform boundary and tier semantics. Current
package membership, classification, paths, dependencies, release groups, public surfaces,
ownership, and transition state come from the catalog-derived
[generated platform topology](../../../architecture/generated/platform-topology.md). Fixed
inventory figures below that describe the 2026-07-30 research are historical context, not current
package authority.

## 1. Problem statement

The stack designs of 2026-07-23 → 2026-07-28 produced a coherent layered architecture, but its
governing ideas ended up spread across four places with no owning home:

- the **four-tier layering law** lives in one section of a tier-2 design
  ([benchmarking §2](./2026-07-28-benchmarking-application-design.md));
- the **executable-architecture discipline** (guards over prose) lives in the evidence layer
  architecture ([§5](./2026-07-25-evidence-layer-architecture.md));
- the **collected principles** live in a derived index that deliberately owns nothing
  ([stack design principles](./2026-07-30-stack-design-principles.md));
- and the **functional boundary** — what Jinn owes anyone who builds on it — existed only as an
  unratified conversation framing ("four contracts") produced without repository access.

Meanwhile the repository's true topology went unstated (this paragraph is a historical research
snapshot reproduced at stack head
`82e20064a`): 13,795 tracked files of which a disconnected host fork (`apps/jinn-agent`, 6,063
files) and an inert archive (`legacy/`, 1,918 files) are 58%; two disjoint dependency regimes
(a fully guarded stack, an unguarded product estate); no root workspace; and a then-current
platform package set dressed for npm that no workflow published.

This specification is the owning home for the platform boundary and the architecture principles
behind it. Where it restates a rule another approved design owns (sealing, dependency direction,
per-layer semantics), the owning design wins; where it defines the boundary, the tiers-as-law,
the inclusion test, the extraction gate, and the dispositions, **this document owns them**.

## 2. Platform, network, products — the triad

Jinn is three kinds of thing, and most boundary confusion comes from collapsing them into two:

1. **The platform** — code and record disciplines *anyone can run anywhere*: the sealed record
   protocols, the protocol-extending record kinds, the reusable capabilities, and the
   conformance machinery that makes all of it independently verifiable. The platform is defined
   by the tier test (§3, §5). It has no privileged deployment.
2. **The network** — the canonical deployment the platform binds to: the TaskCoordinator /
   JinnRouter contracts on Base, the OLAS Mech Marketplace, OLAS staking and its activity
   checker, and the delivery-fee escrow. The network is an *instance*, not a tier. `contracts/`
   defines the venue, not platform semantics. Per DR-2026-06-30 the network's on-chain surface
   is deliberately tiny and OLAS-native.
3. **Products** — opinionated compositions people actually use: the operator app, Autopilot, the
   launcher surfaces, benchmarking services, skill factories, explorers, concrete plugins.
   Products are built *on* the platform, may target the network, and are swappable by
   construction — a claim whose falsifier is the first second implementation, which does not
   yet exist. First-party status confers maintenance, never privilege.

The seam between platform and network is the marketplace binding, and the constraints frozen at
that seam (§8.2) are **venue guarantees**: promises the canonical network makes — as of the
specified contract revision, per the binding design's two-generation discipline — so that
platform-level identities and economics survive contact with it.

## 3. The layering law (owned here as of this specification)

Four tiers, with one frozen dependency direction. Introduced by the benchmarking design
([§2](./2026-07-28-benchmarking-application-design.md)); this specification graduates it to its
owning home. The benchmarking text remains valid as the origin; future references cite this
section.

1. **Tier 1 — protocols.** Sealed record families and their semantics: TEP (Task, Submission,
   Attempt, Lifecycle Observation, Delivery), Evidence (Execution Evidence, Result Evaluation,
   Execution Verification), Trust (key bindings, authorizations, trust-policy documents),
   Discovery (announcement entries, source heads), Profiles (task profiles, EvaluationSpecs).
   Records and meaning; no behavior.
2. **Tier 2 — protocol-extending records.** Record kinds defined above the protocols under the
   same sealed-record discipline — I-JSON, JCS-once, sha256-of-exact-bytes, media types, DSSE
   where signed — so third parties can produce and verify them **without running Jinn code**.
   Benchmarking's Benchmark, Run, Matrix, and Report records are the exemplars.
3. **Tier 3 — applications.** Reusable capabilities that consume protocol records and do work,
   each one job, none naming a product: the task-execution backend contract and its bindings
   (local, marketplace), evidence capture / retrieval / contribution, discovery serving and
   projection.
4. **Tier 4 — products.** Compositions of applications that people use. The ratified examples:
   the operator app, Autopilot, a marketplace benchmarking service, the skill factory, a
   leaderboard site.

**The disciplines that make the tiers real:**

- nothing in tiers 1–3 ever names a product, and products are swappable compositions;
- the dependency direction is frozen — applications → discovery → TEP + Evidence → trust —
  record protocols never import discovery, backends import evidence *contracts* only, and
  `discovery/facts/*` leaves are the only meeting point of a discovery edge and a record-kind
  edge;
- the architecture is executable: every platform tree carries package-inventory,
  source-boundary (allowlist), and packed-types guards wired into CI. A dated design document
  does not replace a failing import canary.

## 4. The boundary, functionally: four verbs, four properties

**The boundary statement: the Jinn platform is tiers 1–3 plus the machinery that makes them
independently verifiable. Everything in tier 4 is a product built on Jinn — above the platform
boundary. Where a product lives is a topology question (§6–§7), not a boundary question.**

For a newcomer, the platform's offer reads as **four verbs** — the market acts one party
performs toward another, the 2×2 of {work, evidence} × {request, deliver}:

| | Demand | Supply |
| --- | --- | --- |
| **Work** | Request Work | Deliver Work |
| **Evidence** | Discover & Retrieve Evidence | Publish Evidence |

("Commissioning new evidence" — run these tasks so I can compare the results — is Request Work
with evaluation and capture required, not a fifth verb.)

The verbs are the pitch, not the definition. Tested mechanically against the eight approved
specifications, only 31 of 127 record families, interfaces, and named procedures land cleanly in
exactly one verb; 52 are shared machinery; 44 are genuine remainders. The remainders are not
noise — they are the platform's **four guaranteed properties**, the qualities that make the
verbs trustworthy:

1. **Attributability** — every consequential statement resolves to an accountable identity. The
   trust layer's record families and verification procedures; "accounts vouch, keys sign."
2. **Exactness** — a record is its exact sealed bytes. JCS-once, sha256, digest-bound
   references; no consumer re-canonicalizes; repository location is never identity.
3. **Observability** — execution lifecycle is append-only, canonical, and consultable by
   anyone, not only the requester. The Lifecycle Observation family, `observe`/`watch`, the
   normative fold, and discovery's observation streams. *Recorded decision: observation is
   deliberately a guarantee, not a fifth verb — verbs are bilateral market acts; observation is
   the platform keeping account. Admitting Observe as a verb would equally admit Announce,
   Cancel, Recover, and Revoke, and the pitch dies of enumeration.*
4. **Replaceability** — every implementation is swappable: conformance kits precede
   implementations, a fake/reference implementation proves each kit passable, no tier-1–3 code
   names a product, and no kit encodes a first-party implementation's behavior as normative.
   This is the structural defense against the reference implementation becoming the de-facto
   spec (the Matrix failure mode).

Four verbs the platform offers; four properties the platform guarantees. Verbs for the pitch,
properties for the gate.

## 5. The inclusion test (mechanical)

A thing is inside the platform if and only if it passes its tier's test. Each test is a check
that can go red.

**Tier 1–2 (record kinds).** The record kind ships: a published JSON Schema; sealed identity
(I-JSON, JCS-once at sealing, `sha256:` of exact bytes, a media type); a conformance kit with
golden **and** adversarial fixtures; and a named verification procedure — such that a third
party can produce and verify records without running Jinn code. Mechanical: kit exists and
passes in CI; schema published; **no code identifier, import, export, or dependency names a
product** (the source-boundary guards' allowlist discipline; prose comments and test names may
mention products when documenting a seam, and are out of the check's scope). "Published" is
mechanical: the schema and kit are retrievable as registry artifacts or at stable URLs
**without cloning this repository**. Until the publish path (§6, follow-up 1) lands, the
in-repo schema files satisfy only the weaker in-tree form of this clause.

**Tier 3 (capabilities).** The capability: carries an allowlist source-boundary guard (imports
fail by omission); respects the frozen dependency direction; names no product (same
identifier-level check as above); and exposes its public surface through a kit **proven
passable by an in-tree fake or reference implementation** (the backend-contract kit with its
in-memory fake backend is the existing form). "One job per capability" is the design intent the
tier expresses; it is enforced by review, not by a check.

**Tier 4 (products).** Everything that composes capabilities into a participant experience. Two
mechanical rules: nothing in tiers 1–3 imports it (enforced by the dependency direction and the
guards), and **no tier-1–3 kit, guard, or fixture references it** — the checkable core of the
broader intent that no first-party product's behavior is ever treated as normative.

The test describes a line the repository has already mostly drawn. The current generated
[`platform-v1` view](../../../architecture/generated/platform-topology.md#release-and-trusted-publishers)
contains 50 core candidates with guards and kits; receipt-gated canary publication is implemented,
while stable publication remains blocked on live `jinn.network` hosting verification. The catalog's
legacy/product and transition entries remain outside that release set. Two honesty notes:
the "third party could verify" property has a first-party proxy today — kits passing in Jinn's
own CI — and its outstanding falsifier is the first external implementation, which does not yet
exist; and kit **fixtures must be derivable from the specification text or the in-tree
reference fake, never captured from a first-party product run** — a provenance rule enforced by
review for now, named here so a mechanical check can later assert it. Design-time influence by
first-party products on tier-1–3 specs has no mechanical control; it is accepted residual risk
carried by review.

## 6. The extraction gate (mechanical)

The platform boundary is enforced **inside the monorepo**; components leave it only through a
gate. Extraction is a consequence of readiness, never a goal. Per component, the gate is green
when:

1. every platform dependency resolves from the **published npm registry** — no `portal:` link
   and no `resolutions:` override pointing into the repository tree;
2. CI is green from a **clean clone of the component's tree alone** — no cross-tree
   build-from-source steps;
3. its deploy artifacts build without copying sibling trees, and its deploy-platform
   configuration (watch patterns, build contexts, ignore files) points at the new home;
4. (products) no tier-1–3 kit, guard, or fixture references it;
5. no **repo-global workflow** in the remaining repository references the departing tree, and
   the component carries its own CI equivalent to what the shared workflows provided —
   **including its own conformance-kit run** (a lint-only CI does not satisfy item 2);
6. the component has its **own release and tag pipeline** — the monorepo's shared tag
   namespace (`v*`, `<name>-v*`) and publish workflows no longer produce its artifacts, and
   any npm **trusted-publisher registration is re-bound** to the new repository and workflow;
7. **review protection migrates** — CODEOWNERS entries covering the tree move with it, so
   extraction never silently weakens a human-surface merge gate;
8. **no vendored platform code** — the component contains no copied platform record-kind or
   capability source; platform behavior resolves only to the canonical published artifacts
   (the same versions the platform repository releases and consumes itself, which also closes
   the throwaway-tarball cheat). The vendored `packages/autopilot` copy is the in-repo
   counterexample this item exists to prevent.

**Extraction of any tree additionally requires its own decision record** — the gate proves
*readiness*; a DR records the *decision* (audience, cadence, maintenance) and its authority.
A green gate is never itself authorization to move.

Each candidate gets the gate as a guard script — a check that can go red — before any move.

**What the gate asserts:** that the component consumes the platform exactly as an external
builder would, so its departure changes nothing about how it builds. **What it cannot assert:**
that the component *should* leave — that remains a decision (audience, release cadence,
maintenance), recorded per-tree in §7.

**The gate's enabling precondition is the stack publish path.** It now derives the exact 50-package
`platform-v1` set and runtime waves from the catalog and manifests, runs same-run verification,
and publishes only those exact receipt-bound tarballs in the canary lane. Stable publication is
still mechanically disabled pending verified live `jinn.network` profile hosting, so stable npm
consumption does not yet satisfy gate item 1. The generated
[release and topology view](../../../architecture/generated/platform-topology.md#release-and-trusted-publishers)
is the current authority for this precondition.

**One precedent of the gate's shape: Autopilot** — extracted to
[`Jinn-Network/autopilot`](https://github.com/Jinn-Network/autopilot), consuming the published
`@jinn-network/sdk`; its own design
([§6.7](./2026-07-23-autopilot-oss-maintainer-product-design.md)) independently specified the
same gate ("self-contained and passes a non-Jinn repository fixture"). Stated precisely: this
proves the gate's *mechanics* against the **legacy** published packages, not against the
platform proper — no component has yet passed the gate against a stable published `platform-v1`
set, and none can until the hosting blocker clears. The vendored `packages/autopilot` copy is residue; removal is
tracked in [#2252](https://github.com/Jinn-Network/mono/issues/2252).

## 7. Per-tree dispositions

Cataloged manifest entries are not enumerated here. Their live classification, tier, release
group, stability, and transition/sunset details are in the generated
[inventory and transition report](../../../architecture/generated/platform-topology.md#transitional-and-deprecated-entries).
That view preserves this specification's semantics: tiers 1–3 remain the platform; tier 4 remains
product; legacy and transitional entries follow their cataloged cutover conditions. The table below
retains only non-catalog repository-tree dispositions from the ratified decision.

| Tree | Classification | Disposition | Trigger |
| --- | --- | --- | --- |
| `contracts/` | **network** (the venue) | stay; a per-audit contracts split (the OLAS pattern) is explicitly deferred — OLAS's six-way split forced a synthetic umbrella repo to reconstruct the whole | external audit, if ever |
| `apps/jinn-agent` | external host fork (6,063 files, 44% of tracked files, zero `@jinn-network` **package-dependency** edges — but three operational inbound edges, see note) | **leaves first** — as a *small extraction with a three-item checklist*, not a blind delete: (1) relocate the plugin source-of-truth (`jinn-plugin-split.yml` mirrors `apps/jinn-agent/plugins/jinn` and declares it the editing home of `Jinn-Network/jinn-plugin`); (2) re-home `layer-runtime.json` (read by `verify-layer-stable-version.mjs:58`, the layer publish gate); (3) re-home the `cold-stock-e2e` product gate (a `jinn-agent-ci.yml` job gating `client/` and `packages/{plugin,core,layer}` changes) | own issue carrying the checklist |
| `legacy/` | archive (1,918 files, zero inbound edges; one comment-only reference) | delete; git history is the archive | immediate; own chore issue |
| `apps/broadcast-bot`, `apps/website`, `deploy/`, `.github/`, `docs/`, `spec/`, `log/`, `growth/`, `examples/`, `scripts/`, `scratchpad/` | repository operations and record | stay | — |

Notes on the decision-bearing rows:

- **`client/` stays as a product in-repo** — this reverses the earlier conversation's
  "extract the operator now" endpoint, on sequencing rather than philosophy: the operator
  cannot pass gate item 1 until the stack publishes and the daemon recomposition lands, and
  moving it before then manufactures version skew for zero boundary gain (the boundary is
  already machine-enforced). The operator image today builds from five trees
  (`client/Dockerfile` copies client + sdk + core + plugin + layer); that is the deploy seam
  the gate's item 3 will eventually test.
- **`legacy/`** leaves without a gate — genuinely zero inbound edges; removal is a chore.
  **`apps/jinn-agent` is not a chore**: it has zero package-dependency edges but three
  operational inbound edges (plugin mirror source-of-truth, the layer publish gate's
  `layer-runtime.json` read, the cold-stock product gate), so its removal is a small
  extraction executed against the checklist in its row.
- **`packages/{core,layer,plugin}` dissolution is bounded by `client/`'s build**: `client`
  resolves `layer` (and dev-resolves `core`/`plugin`) through `portal:` links, and the
  operator image copies all three trees. The plugin session's authority to dissolve or
  re-derive them is sequenced after — or must preserve — `client/`'s portal surface until the
  daemon recomposition lands.
- **First-party products remain welcome in the repository** — as products, behind the
  dependency direction, never imported by tiers 1–3. The gate makes leaving *possible*;
  audience and cadence make it *sensible*; neither is mandatory.

## 8. Reconciliation notes

### 8.1 Trust's station

Under the four-contract framing, trust read as "cross-cutting machinery" — awkward for a layer
that authors three sealed record families, ships its own conformance kit, and supplies the check
the marketplace design calls "the load-bearing control" for verdict independence. Under the tier
framing there is no tension: trust passes the tier-1 inclusion test on its face and sits at the
root of the frozen dependency direction, wearing the attributability property. The
"cross-cutting" description is retired with the demoted framing.

### 8.2 The marketplace seam: venue guarantees

The binding *as code* is tier 3 — a replaceable adapter; the same kits could be passed by a
binding to a different venue. Three constraints the binding design freezes are not adapter
details but **venue guarantees** — the canonical network's promises to the platform:

- the reservation-escrow invariant ("no valid delivery, net no spend");
- `attemptIndex` strict monotonicity, protecting the deterministic Attempt URI (a protocol
  identity) from venue-side reuse;
- the single-projector censorship cross-check (consumers verify announced open Submissions
  against the on-chain count).

Their tense follows the binding design's two-generation discipline: the escrow invariant and
`attemptIndex` monotonicity are **specified by the contract revision** (binding §5 — "specified
now, built later"; today's deployed contract conflates the counters and has no reservation),
while the censorship cross-check binds in today-mode already. Until the revision deploys, the
first two are commitments of the specified venue, not behaviors of the deployed one.

They live in the binding design because that is the platform–network seam. A future venue must
either make the same guarantees or declare weaker ones in its own binding profile.

**Venue guarantees are a governed surface.** Being neither platform (no kit gates them) nor
product, they would otherwise be mutable by the ordinary agent pipeline: `.github/CODEOWNERS`
covers neither `contracts/` nor the binding design today, and AI-workflow rule 4 permits
agent-merge of non-code-owned PRs. Therefore: any change touching a named venue guarantee
requires its own decision record and human review, and `contracts/` plus the marketplace
binding design and profile gain CODEOWNERS entries (follow-up 9). The same follow-up covers
the guard scripts and allowlists themselves — the check that fails by omission must not be
amendable in the same agent-merged diff that adds the violating import.

### 8.3 What remains of the four-contract framing

It survives as the **functional read for newcomers** (§4) and in the About-block paragraph
(§11). It is retired as a definition (44 remainders of 127) and as a repo-gating test (the
tier test, §5, is the gating instrument). The naming refinement it produced — "Request
Evidence" means discover-and-retrieve; commissioning evidence is Request Work — is preserved.

### 8.4 Historical verification snapshot

The following figures were reproduced, not inherited, at stack head `82e20064a` on 2026-07-30;
they are preserved as evidence for the decision, not as live topology. Current package facts are
in the [generated platform topology](../../../architecture/generated/platform-topology.md).
At that historical head: 13,795 tracked files; two disjoint
dependency regimes with zero edges between them; exactly one cross-tree relative-import
violation in the repository (`client/scripts/distill-run-manifest-live.ts` →
`packages/layer/src`), sitting in the unguarded regime; 5 packages actually published (client
0.2.2, core/plugin/jinn-layer 0.1.2, sdk 0.1.1); the then-current stack was publishable-but-unpublished
resolving through 204 stack-internal `portal:` links (218 repo-wide); 36 CI workflows of which
18 are repo-global; 24 architecture-guard scripts.

## 9. Impact on the running program; follow-ups

**Impact on the stack implementation program (PR #2292): none.** This specification moves no
files, renames nothing, and opens no PR against implementation branches. All dispositions with
triggers wait on their triggers.

Follow-ups (recorded once; none block this specification):

1. **Stack publish path** — implemented for same-run verified canaries over the catalog-derived
   50-package `platform-v1` set. Stable publication remains intentionally disabled until live
   `jinn.network` profile hosting verification exists. Current package order, trusted-publisher
   registrations, and policy are generated in the
   [release view](../../../architecture/generated/platform-topology.md#release-and-trusted-publishers).
2. **Remove `apps/jinn-agent`** — a small extraction against the three-item checklist in §7
   (plugin source-of-truth relocation, `layer-runtime.json` re-homing, cold-stock gate
   re-homing), not a blind delete. (`chore`, own issue carrying the checklist.)
3. **Delete `legacy/`.** (`chore`, own issue.)
4. **Vendored Autopilot removal** — existing [#2252](https://github.com/Jinn-Network/mono/issues/2252).
5. **Indexer logical split** — projector (tier 3) vs explorer SPA (tier 4) naming + guard.
   (`refactor`, own issue.)
6. **Fix the single cross-tree import violation** in `client/scripts`. (`chore`.)
7. **Stale canonical docs** — PRINCIPLES.md and README are stale relative to the current
   architecture; canonical-doc rewrites go through Discussion + CODEOWNERS per
   `spec/2026-04-28-canonical-docs.md`. This spec's newcomer paragraph (§11) is input to that
   rewrite. (`docs`, own issue.)
7a. **Pointer notes in the amended documents** — at ratification, add graduation pointers to
   [benchmarking §2](./2026-07-28-benchmarking-application-design.md) and the
   [2026-07-23 architecture map](../../2026-07-23-jinn-mono-architecture-map.md) header
   (the DR-2026-06-30 apply-at-ratification pattern), so a reader of either discovers the
   ownership move. (Same commit as ratification.)
8. **Guard the unguarded** — as legacy product trees are recomposed by their owning sessions,
   each gains the guard trio; new platform trees gain guards with the packages, per the
   standing rule.
9. **Governed surfaces under CODEOWNERS** — add entries for `contracts/`, the marketplace
   binding design and profile (the venue guarantees, §8.2), and the `.github/scripts/*` guard
   scripts and their allowlists, so none is amendable by an agent-merged PR. (`chore`, own
   issue.)

## 10. Explicit non-goals

- No physical move, rename, or repository creation in this specification.
- No migration mechanics — the operator-daemon session owns the cutover; product sessions own
  their trees' recompositions.
- No new record kinds, no protocol changes, no changes to any frozen interface.
- No governance-process changes; canonical-doc rewrites follow the existing process.
- No mandate that first-party products eventually leave the repository — the gate enables,
  it does not oblige.

## 11. What is Jinn? (the newcomer paragraph)

> Jinn is an open platform for work and the evidence work creates. It defines sealed records
> for requesting work, delivering it, and publishing what happened — designed so third parties
> can produce and verify them without running Jinn's code — and reusable capabilities for
> executing work and retrieving evidence. Jinn contributors operate a canonical network on
> Base where work is escrowed, delivered, and evaluated, and operators earn OLAS. Everything
> above that — operators, benchmarks, skill factories, agents — is a product anyone can
> build, swap, or compete with.

What this does not yet prove, in the press-release discipline: the schemas and kits are not
yet published (follow-up 1), so third-party verification is a designed property no third party
has yet exercised; the network runs on Base Sepolia today with mainnet operation the Phase-2
target; per-task settlement economics are the contract revision's scope and evaluator
economics are Phase B. Canonical-doc rewrites consuming this paragraph (§9.7) carry this
caveat with it.

## 12. Provenance

Produced by the 2026-07-30 platform-boundary design session
([prompt](../prompts/2026-07-30-platform-boundary-design-prompt.md)), run under the
session method of [stack design principles §12](./2026-07-30-stack-design-principles.md):
five read-only research lanes (repository topology and violations; the four-contract framing
tested against the eight approved specifications; comparable protocol projects from primary
sources — OLAS, atproto, Farcaster, Matrix, libp2p, Cosmos, Sigstore, in-toto; release and
agent-workflow extraction costs; SolverNet vocabulary surface), reconciled by the coordinating
agent; sections approved one at a time by the operator; architecture and adversarial reviews
run on the written form before presentation. The four-contract framing arrived as a hypothesis
from an earlier conversation without repository access and was tested, demoted, and partially
preserved as described in §8.3.

Review dispositions: the architecture review's findings (venue-guarantee tense, product-name
check calibration, indexer classification, extraction-gate coupling classes, count precision,
unmechanical clauses, pointer notes, dissolution ordering) and the adversarial review's
findings (the `apps/jinn-agent` operational edges, schema-publication vacuity, the vendoring
and lint-only-CI cheats, the Autopilot-precedent overclaim, newcomer-paragraph tense, venue
governance, fixture provenance and allowlist self-amendment, unfalsifiable-claim inventory,
extraction decision authority, DR status mechanics, tree-enumeration completeness, figure
pinning) are all resolved in the sections they touch. Claims that remain aspirational are
marked with their pending falsifiers where they occur.
