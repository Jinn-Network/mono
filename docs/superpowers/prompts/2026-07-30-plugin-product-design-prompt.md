# Design prompt — the plugin product: core/layer/plugin onto the stack

**Date:** 2026-07-30

**Shape:** `design` — output is one specification (plus dated amendments to the affected
Stage 1/2 plugin designs where dispositions supersede them). No code, no package moves, no
unpublishing.

---

## 0. Read this first, before the objective

This is the **last substantial design session of the Phase A program**: when it closes, the
design surface is closed and everything after is execution, publication, and Phase B.

The subject is not new construction. The plugin stack exists, works, and is **published
with real consumers**: `@jinn-network/core` (0.1.2 — "evidence/contribution stores, scrub,
trajectory parsing, and corpus reads"), `@jinn-network/jinn-layer` (0.1.2 — "standalone
Jinn plugin process layer: host contract, local evidence, corpus reads, distillation"),
`@jinn-network/plugin` (0.1.2 — "ports, product schemas, and the `createJinnPlugin`
factory"). Read those self-descriptions again: **they are a parallel, earlier
implementation of concerns the evidence tree now owns.** The stack that merged in PR #2292
(evidence protocol, recorder, repository, catalog, local-runtime, publication,
contribution, retrieval, discovery) landed *after* the plugin stack was designed, and the
two lineages have never been reconciled. That reconciliation is this session.

Two failure modes to guard against, in tension with each other:

1. **Assuming dissolution.** The platform architecture calls these trees "candidates to
   dissolve or re-derive" — *candidates*, not verdicts. The plugin stack has shipped
   product surfaces (`hermes plugins install`, `jinn create plugin`, the Stage 1/2 PR
   trains) and published versions with external consumers. "Rewrite it on the stack"
   must be argued per package against migration cost and consumer breakage, not inherited
   as a vibe.
2. **Grandfathering duplication.** The stack design principles name duplication as
   forbidden once an owner exists. Two implementations of evidence stores, corpus reads,
   and scrub cannot both be long-term true. "Keep both because both work" is not a
   disposition; it is the absence of one.

## 1. Objective

Answer three questions, in order. Do not start a question until the previous answer is
approved.

**Q1 — What are these things, in stack terms?** Map each of the three packages — and the
distinct capabilities inside them (host contract, evidence capture, corpus reads, scrub,
distillation, product schemas, the factory) — onto the four-tier taxonomy and the
evidence/task-execution package inventory. For each capability: which stack package owns
this concern now, which has no stack owner, and which is genuinely plugin-product-specific
(tier 4). The output is a capability-by-capability ownership table, not a package-level
hand-wave.

**Q2 — The disposition.** Per package: dissolve (consumers migrate to stack packages),
re-derive (same surface, stack internals), or keep (genuinely tier-4 product core, stack
underneath). With, for each: the consumer-migration story (the packages are published at
0.1.x — semver, deprecation notices, the `npm-publish.yml` coupling), the gate that
triggers it, and who executes. This question also owns the two attach-point decisions the
other sessions parked here:

- **Plugin distribution and trust.** Today: `solver-plugins publish / read / feedback /
  block / revoke` verbs against SolverNet-era machinery, being re-keyed to wiring entries
  by the daemon cutover. Decide whether plugin artifacts re-derive as signed records
  (DSSE, digest-addressed, announced through record discovery, trust via the trust layer)
  — which would make plugin distribution a *worked example of the platform* — or keep a
  bespoke registry, and why.
- **The harness attach point.** The local backend's launchers (claude-code, hermes, codex,
  cursor) now own harness invocation, and execution-wiring entries carry `plugins` lists.
  Decide where the plugin's harness-side surface lives relative to launchers and wiring —
  is the Jinn Plugin a launcher loadout, a host integration beside the launcher, or a
  product composition above both?

**Q3 — The build seam and the migration.** The operator image builds from five trees
(`client` + `sdk` + `core` + `plugin` + `layer`); `client` resolves `layer` through a
`portal:` link that this session is bound to preserve until daemon cutover stage 5. Decide
the endgame build topology (what the operator tree depends on after stage 5, what the
standalone plugin consumers depend on), the `jinn-plugin-split.yml` mirror's fate (it is
also item 1 of the `apps/jinn-agent` extraction checklist, #2294), and the reconciliation
of the Stage 2 onboarding flow (`hermes plugins install`, the layer-acquisition open
question from the onboarding design) with the published-stack world.

## 2. What is settled — treat as law

- **The platform architecture** (DR-2026-07-30,
  [`../specs/2026-07-30-jinn-platform-architecture.md`](../specs/2026-07-30-jinn-platform-architecture.md)):
  the tier law, the extraction gate, and §7's assignment of the `core`/`layer`/`plugin`
  disposition to this session — bounded by `client/`'s build: **this session's authority is
  sequenced after, or must preserve, `client/`'s portal surface until the daemon
  recomposition lands.**
- **The operator-daemon composition design**
  ([`../specs/2026-07-30-operator-daemon-composition-design.md`](../specs/2026-07-30-operator-daemon-composition-design.md))
  and its program: the daemon cutover re-keys the plugin-content CLI verbs from
  manifestCid to wiring entries and *stops there* — the deeper disposition is explicitly
  reserved for this session (§9). The five-tree image and portal surface stay intact until
  stage 5.
- **The consumption-boundary design**
  (`2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`): the five-clause
  custody law applies to published packages — no key material, no ambient authority, no
  chain-selection defaults, signer-object-only, fail-closed, trusted-publisher provenance.
  Any plugin-tree disposition that touches publishing conforms.
- **The stack designs** own their concerns: evidence capture, repositories, contribution,
  retrieval, publication, discovery, trust are owned where PR #2292 put them. A finding
  that a stack package cannot serve a plugin need is a finding with a proposed
  disposition, never a fork.
- **The Stage 1/2 plugin designs in-tree** are the record of what was built and why:
  [`../specs/2026-07-14-jinn-plugin-product-roadmap-design.md`](../specs/2026-07-14-jinn-plugin-product-roadmap-design.md),
  [`../specs/2026-07-14-jinn-plugin-stage-1-package-architecture.md`](../specs/2026-07-14-jinn-plugin-stage-1-package-architecture.md),
  [`../specs/2026-07-14-jinn-plugin-stage-1-product-design.md`](../specs/2026-07-14-jinn-plugin-stage-1-product-design.md),
  [`../specs/2026-07-17-jinn-plugin-onboarding-design.md`](../specs/2026-07-17-jinn-plugin-onboarding-design.md),
  [`../specs/2026-06-14-solver-plugin-mounting-model.md`](../specs/2026-06-14-solver-plugin-mounting-model.md).
  They are superseded only by explicit dated amendment from this session, never silently.
- **The release-train coupling** (recorded by the consumption-boundary session): version
  bumps in this family interact with `npm-publish.yml` pins and publish-gate scripts; any
  disposition that bumps or deprecates a published package owns those changes in the same
  PR.
- **The collected principles**
  ([`../specs/2026-07-30-stack-design-principles.md`](../specs/2026-07-30-stack-design-principles.md)):
  §3 standards audit for anything newly designed, §12 session method, §13.6 duplication
  named and forbidden.

## 3. What is explicitly unsettled — bring a conclusion, not a summary

- Whether `core`'s evidence/contribution/scrub/corpus surfaces dissolve into the evidence
  tree, or survive as a tier-4 adapter over it — and what its published consumers
  (including the standalone Autopilot lineage and Hermes hosts) migrate to.
- Whether `jinn-layer`'s process model (standalone plugin process, host contract) is a
  tier-3 capability the stack lacks (a host-integration runtime), a tier-4 product
  runtime, or an artifact of predating the local backend's launcher model.
- Whether plugin artifacts become signed, discovery-announced records (the
  platform-as-its-own-distribution story) or keep bespoke distribution — including what
  happens to `feedback` / `block` / `revoke` semantics, which look like trust-layer
  concerns wearing product clothes.
- Where distillation lives. `jinn-layer` claims it; the corpus and the learner lineage
  touch it; no stack package owns it. It may be this session's one genuinely new design
  surface — or explicitly deferred with an owner named.
- The layer-acquisition open question from the onboarding design, now answerable against
  a published stack.
- Whether the plugin product needs its own conformance kit (a plugin-host kit proving a
  host integration behaves) — kits-first applies if anything new is built.
- The `sdk` interaction: the daemon and surfaces sessions retire `sdk` surfaces on their
  schedules; whether any plugin-tree surface was quietly load-bearing for `sdk` consumers.

## 4. The reconciliation that matters most

**Two evidence lineages, one owner.** `core`/`jinn-layer` implement evidence capture,
stores, corpus reads, and scrub from the pre-stack era; `packages/evidence/*` implements
them post-stack, conformance-kitted, with the operator daemon now being recomposed onto
them. The session's center of gravity is a capability-by-capability merge decision with a
consumer-migration path — done so that the plugin product ends up *hosted on* the
platform it ships for, which is also the platform's best proof: **the Jinn Plugin should
be the first product whose entire runtime is stack-composed.** Where that is not yet
possible, the gap is a named finding against the stack, not a justification for the fork.

## 5. Session gates and triggers

- **Gate to open:** daemon cutover **stage 5** complete (the portal surface constraint
  dissolves; the operator tree is stable to design against), **or** earlier if every
  proposal preserves the portal surface untouched — the platform spec permits either.
  Publishing (#2293 canaries) should exist so migration targets are consumable.
- **Trigger:** the first of — stage 5 landing; a plugin-tree change being forced by
  another workstream (e.g. #2294's mirror re-homing); or a consumer needing a plugin
  capability the stack now owns better.
- **This session must not gate:** the daemon cutover, the marketplace-surfaces follow-ups,
  or Autopilot's adoption pass.

## 6. Method

Per principles §12. Suggested research lanes:

1. **Capability inventory** — every exported surface of the three packages, its consumers
   (in-repo, the operator image, published/external), and its stack counterpart if any;
   the Q1 table's raw material.
2. **Consumer census** — who actually installs/imports the published 0.1.x packages
   (npm downloads tell little; the Stage 2 hosts, Hermes integration, and Autopilot
   lineage tell more); what breaks per disposition option.
3. **Stack-fit probe** — for each capability claimed by both lineages, a code-level check
   that the stack package actually covers the plugin's use (the daemon program's planning
   pass showed static reading lies; probe against real code).
4. **Standards audit** (principles §3) — scoped to whatever Q2 decides is newly designed:
   plugin-artifact packaging/distribution comparables (VS Code extensions, Claude Code
   plugins/skills, OCI artifacts, npm provenance) if records-based distribution is chosen;
   nothing if nothing new is built.
5. **Adversarial review lane** at the end, per the house two-review rule.

One material question at a time; section-by-section approval; one specification; two fresh
reviews before presenting; commit only on explicit approval.

## 7. Scope discipline — what this session does not own

- The daemon cutover and its CLI re-keying (composition program).
- The public work client, `sdk` retirement mechanics, custody-law enforcement (surfaces
  session and its follow-ups).
- The learner/loadout research lineage — consumable as input where in-tree, not a
  deliverable here.
- Protocol or record-family changes — findings with dispositions to the owning specs.
- Executing any migration — this session designs; PR trains execute under their own plans.

## 8. Success criteria

1. One specification under `docs/superpowers/specs/`, sections approved one at a time.
2. The Q1 capability-ownership table — complete enough that any exported surface of the
   three packages can be looked up and lands in exactly one long-term home.
3. A per-package disposition with gates, executors, and a consumer-migration story that
   respects semver and the release-train coupling.
4. The distribution/trust and harness-attach-point decisions, with the standards audit on
   the record if anything new is designed.
5. Dated amendments to the Stage 1/2 plugin designs where superseded.
6. A follow-ups list with owners — including distillation's named home, even if the name
   is "deferred, owned by X".
