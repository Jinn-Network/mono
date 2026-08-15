# Design prompt — the Jinn platform boundary and repository topology

**Date:** 2026-07-30

**Shape:** `design` — output is a decision record plus one specification. No code, no moves, no
migration.

---

## 0. Read this first, before the objective

Two framings arrive with this session from earlier conversations. **Neither is settled, and
neither is an input you may assume.**

1. **The four platform contracts** — that Jinn is responsible for exactly *Request Work*,
   *Deliver Work*, *Deliver Evidence*, *Request Evidence*, and that everything else is either
   cross-cutting machinery or an application above the boundary.
2. **The thin-kernel thesis** — that the platform repo should hold only canonical contracts,
   schemas, SDKs, conformance kits, and minimal reference implementations, while the production
   operator, the indexer/explorer, host integrations, concrete plugins, hosted APIs, and all
   vertical products move to separate first-party repositories.

Both are plausible and both are attractive. Your job is **not** to elaborate them. Your job is to
test them, find where they break, and either ratify them in a form that survives contact with
this repository, or replace them with a better boundary.

The single most common failure mode for this session is producing a beautifully organized
directory tree that no one can act on. Guard against it.

## 1. Objective

Answer two questions, in this order, and record the answers durably:

**Q1 — What is Jinn responsible for?** The functional boundary. What the platform owes anyone
who builds on it, stated so that a thing can be tested against it and found in or out.

**Q2 — Where does the code live?** The topology that follows from Q1: what stays in
`Jinn-Network/mono`, what becomes a separate first-party repository, what leaves entirely, and —
critically — **the gate that decides when each move happens.**

Q2 without Q1 is rearranging furniture. Q1 without Q2 is a blog post. Do both, in order, and do
not start Q2 until Q1 is approved.

## 2. What is settled — treat as law

- **The seven stack design specifications** on `integration/evidence-v1` are approved and
  reviewed. They are law. A discovery that one of them is wrong is a **finding surfaced with a
  proposed disposition**, never a silent patch.
- **The four-tier taxonomy** — protocol / protocol-extending records / applications / products
  ([`../specs/2026-07-28-benchmarking-application-design.md`](../specs/2026-07-28-benchmarking-application-design.md)
  §2) — is approved, including its discipline that **nothing in tiers 1–3 ever names a product**.
- **The frozen dependency direction** — applications → discovery → TEP + Evidence → trust.
- **The collected principles** in
  [`../specs/2026-07-30-stack-design-principles.md`](../specs/2026-07-30-stack-design-principles.md).
  §2 (layering law), §9 (built for implementers outside this repo), and §11 (the architecture
  must be executable) bear directly on this session.
- **[`PRINCIPLES.md`](../../../PRINCIPLES.md)** governs the decision. This is not decoration —
  see §5.
- **The stack implementation program must not be disrupted.** PR
  [#2292](https://github.com/Jinn-Network/mono/pull/2292) is an in-flight train against
  `integration/evidence-v1`. This session moves no files, renames no packages, and opens no PR
  that touches implementation branches.

## 3. What is explicitly unsettled — bring a conclusion, not a summary

- Whether the boundary is best expressed as four contracts, some other number, or not as
  contracts at all.
- Whether *Deliver Work* and *Deliver Evidence* are peer contracts or whether one is an
  obligation discharged inside the other.
- Whether *Request Evidence* should be split (discover/retrieve existing evidence vs commission
  new evidence, which may just be *Request Work* wearing a hat).
- Whether the on-chain `contracts/` tree is network-defining (and therefore inextricable) or
  another replaceable implementation.
- Whether the production operator, the read plane, host integrations, and concrete plugins
  belong in `mono` at all — now, eventually, or never.
- Whether extraction should happen at all, versus a disciplined in-monorepo boundary that
  achieves the same guarantees at lower coordination cost.
- Whether this is one session or two (see §9).

## 4. The reconciliation that matters most

**The four contracts and the four tiers are different axes, and no one has reconciled them.**

- Four tiers is a *structural* claim: what may depend on what.
- Four contracts is a *functional* claim: what Jinn owes the world.

They may compose cleanly — contracts as the functional read of tiers 1–3, products as tier 4.
They may also conflict. Some candidate conflicts to test rather than assume away:

- The discovery protocol's announce plane is trust-bearing and the query plane is not. Which
  contract owns that split — or does it cut across all four?
- The marketplace binding is tier 3 by the taxonomy, but escrow, claim sovereignty and
  settlement look like network-defining policy, not a replaceable adapter.
- The taxonomy says tiers 1–3 never name a product. Does "Request Work" name a product?
- Evaluation composes the four contracts by the contracts reading, but has its own record family
  and its own profile by the specs. Which reading governs?

If the two framings cannot be reconciled, say so plainly and recommend which one governs. Do not
publish a document that quietly asserts both.

## 5. Argue the boundary from PRINCIPLES.md, not from tidiness

[`PRINCIPLES.md`](../../../PRINCIPLES.md) has direct purchase here, and the strongest version of
the thin-kernel thesis is a principles argument rather than an aesthetic one:

- **Legible** — "if the official operator, explorer, and integrations can only work by importing
  internal source files, Jinn does not yet have a real external platform boundary" is a
  Legibility claim: the platform boundary should be *independently verifiable*, not asserted.
  This is the strongest available argument for extraction and you should develop it.
- **Neutral** — an extracted operator is *an* operator; an in-repo one drifts toward being *the*
  implementation. Note the existing precedent: [`README.md`](../../../README.md) line 36 already
  states Jinn has no canonical frontend and that the in-repo reference surfaces are not
  authoritative. Does that precedent already do the work extraction would do, or is it a claim
  the repository structure contradicts?
- **Permissionless** and **Governance Minimal** — a boundary that requires entering the core
  repository to ship a plugin or an explorer is a permission system by another name.
- **Prestige** and **Learning Maximised** — cut against over-fragmentation; a kernel nobody can
  run end-to-end teaches nothing and attracts no one.

Where principles pull in opposite directions, name the tension and make a call. Do not resolve
it by listing both.

## 6. Argue the counter-case honestly

The thin-kernel thesis has real costs. A design that does not engage these has not been tested:

1. **Atomic cross-cutting change is why the evidence refactor worked.** Thirty-eight PRs moved a
   protocol, its packages, and its consumers together. Multi-repo turns that into version skew
   and a release-ordering problem. What is the equivalent capability after extraction?
2. **The team is small and agent-heavy.** Autopilot, `eng-day`, the dispatcher, the PR train, the
   CI guards, the dist-tag cadence — all monorepo-shaped. What breaks, and what does it cost to
   fix?
3. **"Official but not privileged" is hard to hold.** An extracted `jinn-operator` maintained by
   the same contributors can still be de-facto canonical. What structurally prevents that, beyond
   intention?
4. **Extraction mid-refactor is the worst timing.** The generic stack is being implemented right
   now against `integration/evidence-v1`. Any topology decision must survive that train landing.
5. **A kernel with no runnable path is unfalsifiable in the other direction.** If nobody can run
   request-work → deliver-work → publish-evidence → query-evidence end to end from `mono` alone,
   the conformance claim is untested.

Consider seriously whether a **disciplined in-monorepo boundary** — public-interface-only
imports, independent manifests and release artifacts, guard-enforced — delivers most of the
benefit at a fraction of the cost, with physical extraction as a later option rather than a goal.

## 7. Make the gate mechanical, not editorial

The most valuable single output of this session may be the **extraction gate**: the test that
says a component is ready to leave.

The editorial version — "it builds, tests, and releases using only published Jinn packages and
documented network interfaces" — is right but unenforceable as prose. This repository already
has the machinery to make it executable: the evidence tree's package-inventory, source-boundary,
and packed-types canaries plus their CI workflow, per
[`../specs/2026-07-25-evidence-layer-architecture.md`](../specs/2026-07-25-evidence-layer-architecture.md)
§5, under the standing rule that *a dated design document does not replace a failing import
canary.*

Design the gate as **a check that can go red**, and say exactly what it asserts, what it cannot
assert, and what a component must do to turn it green. A boundary that is only a document will
be violated within a quarter.

## 8. Inspect before concluding

Work from a **fresh worktree** cut from `origin/integration/evidence-v1`. Do not edit or
interrupt active implementation worktrees. Read-only subagent research lanes are encouraged;
reconcile their findings in your own voice and never paste their reports through.

Ground truth to establish rather than assume — earlier conversations cited a repository
architecture audit with specific figures, and **its existence in this repo is unverified**.
Locate it or re-derive the numbers yourself; do not cite figures you have not reproduced. As a
starting point, the tracked-file distribution on this branch is roughly: `apps/` 6,098 files (of
which `apps/jinn-agent` is 6,063 — that one tree is ~44% of the repository), `packages/` 2,728,
`client/` 1,970 (≈134k LOC of TypeScript under `client/src`), `legacy/` 1,918, `docs/` 472,
`contracts/` 130.

Useful independent lanes:

1. **Current topology and its violations** — what actually imports across which boundaries
   today; where `client/`, `packages/{core,layer,plugin}`, and `apps/jinn-agent` sit relative to
   the new stack; what the existing CI guards already enforce.
2. **The four-contract framing tested against the specs** — does every approved record family and
   interface land in exactly one contract, and what falls outside?
3. **Comparable protocol projects** — how did projects with a similar shape (a specification, a
   reference implementation, and first-party applications) actually split, what did it cost them,
   and what did they regret? Prefer primary sources: their repository histories and governance
   documents, not commentary.
4. **Release, versioning, and agent-workflow impact** — dist-tags, the Monday cadence, Autopilot,
   the PR train, CI, and the deployment surfaces under `deploy/`.
5. **Adversarial boundary review** — for each proposed split, what breaks, what version-skews,
   what becomes unfalsifiable, and what a bad actor or a lazy consumer does with the seam.

## 9. Scope discipline

**In scope:** the functional boundary, the topology that follows, the extraction gate, the
disposition of each existing tree, and the sequencing constraint relative to the running program.

**Explicitly out of scope — do not design these here:**

- **Operator-daemon composition.** A queued design session already owns "the new `jinn run` =
  discovery + claim predicate + local backend + marketplace binding + reward loops," together
  with its cutover, triggered when the backend and binding are green. This session decides
  *where the daemon lives and what it may depend on*. It does not decide what it composes.
- **Migration mechanics** for any tree. Target state and gates only.
- **Plugin-composes-applications** and **marketplace product surfaces** — both are queued tier-4
  product designs with their own triggers.
- Any physical move, rename, or repository creation.

If Q1 turns out to be large enough to consume the session on its own, **stop after Q1**, ship the
decision record, and propose Q2 as a follow-on. That is a good outcome, not a failure — and a
likely one. Do not compress Q1 to make room for a directory tree.

## 10. Session method

The established pattern, unchanged:

1. Read-only research lanes; the coordinating agent owns all conclusions and reconciles rather
   than concatenates.
2. **One material question at a time**, with full context and implications, at accessible
   altitude — deep detail belongs in the written document, not the conversation.
3. Section-by-section approval before writing.
4. Write the deliverables (§11).
5. **Two fresh reviews before presenting** — an architecture review (does the boundary hold
   against the frozen dependency direction and the four-tier taxonomy; does anything in tiers 1–3
   name a product; is any proposed split circular or version-skewing) and an adversarial review
   (which claims are unfalsifiable; which gates cannot go red; which extraction leaves a
   consumer unable to build; where "official but not privileged" fails in practice).
6. Resolve blocking findings **before** presenting.
7. Commit only on explicit approval.

## 11. Deliverables

1. **A decision record** under `log/decisions/2026-07-<dd>-<slug>.md` recording the functional
   boundary (Q1) and, if reached, the topology decision (Q2) — with the alternatives considered
   and why they were rejected. This is a governance decision and belongs in the decision log, not
   only in a spec.
2. **One specification** under `docs/superpowers/specs/2026-07-<dd>-<slug>.md` containing: the
   boundary statement and its inclusion test; the reconciliation with the four-tier taxonomy; the
   per-tree disposition table with a trigger for each; the extraction gate as a mechanical check;
   the counter-case and why it was overcome or accepted; the impact on the running implementation
   program; explicit non-goals; and genuinely non-blocking follow-ups only.
3. **A one-paragraph answer** to the question a newcomer actually asks: *what is Jinn, and what
   do I get if I build on it?* If the design cannot produce that paragraph, the boundary is not
   yet clear enough to ratify.

Do not write an implementation plan. Do not move anything. Present for review and stop.
