# Design prompt — verified environments and task supply for the graded-evidence economy

**Date:** 2026-07-31

**Shape:** `design` — output is one specification (plus dated amendments where it supersedes
earlier designs). No code, no package moves.

**Supersedes:** [`2026-07-31-task-harvester-design-prompt.md`](./2026-07-31-task-harvester-design-prompt.md)
(retired the same day, before implementation — see §0).

**Required reading:** [`../notes/2026-07-31-task-supply-research-findings.md`](../notes/2026-07-31-task-supply-research-findings.md)
— five research lanes plus two market surveys, and the record of the two reframes that
produced this charter. It exists so this session starts from evidence rather than a blank
page; do not re-run its lanes without a reason.

---

## 0. Read this first, before the objective

The predecessor charter designed a product that argument dissolved. It framed consent-gated
mining of a user's repositories as the demand-side twin of capture — users contribute their
open-source work, the plugin hosts the flow. Two collapses followed, both operator-driven:

1. **Consent is not a feature for public repositories.** An open-source license already
   grants derivation and redistribution; SWE-bench mined thousands of repos without asking
   anyone. A consent ceremony is legally load-bearing only where the license is missing or
   unclear. With consent demoted, the repo owner leaves the loop — and mining never needed
   their machine anyway (a public clone, Docker, and compute suffice).
2. **"A task-supply pipeline" is what SWE-rebench already is** — and our own daemon already
   imports its rows. Rebench is automated commit-echo *plus* the curation layer that makes it
   worth doing. Rebuilding that, with less curation, is not a product.

What survived is sharper than either, and it came from two operator observations that the
research then confirmed with market data:

- **Environment reliability is the industry's unsolved problem and its concentrated cost.**
  Docker build failures average 36% of environment-construction failures; automated setup
  succeeds on as few as 6.7% of Python repos in one study; SWE-rebench V2 ships known-issue
  flags rather than guarantees. Commercially, environments sell for $20k–$300k while
  individual tasks sell for $200–$2,000. **Nobody treats a verified-working environment as a
  separately-owned durable product, and nobody offers third-party-verifiable environment
  attestation.**
- **Once a repository's environment works, tasks are cheap derivatives of it** — imported
  rows, injected bugs, later mined commits — and every additional task amortizes the same
  capital.

Add the flywheel: every graded attempt in the marketplace updates a task's empirical pass
rate, which is exactly the difficulty signal labs currently pay to estimate with their own
rollouts (useful band ≈ 2%–70% pass rate, peak value near 50%; curation beats volume by 16.4
points of pass@1 in one study). **Our exhaust is the curation product.**

And there is a standards-shaped opening: `verifiers` (2,500+ community environments) and
OpenEnv (Meta/HuggingFace/Nvidia/Microsoft committee, spec 0.1) are consolidating as the
interfaces for RL environments. **Neither has a verification story or a settlement layer.**
Jinn slots underneath them rather than competing.

Three failure modes to guard against:

1. **Designing a benchmark.** The SWE-bench family optimizes for leaderboard integrity. We
   optimize for continuous supply whose graded attempts are valuable training signal. When a
   prior-art technique serves benchmark integrity but not data value (or vice versa), say so
   and choose deliberately.
2. **Reinventing the verification we already have.** The legacy differential-admission
   receipt is *ahead* of published prior art — independently checkable proof that a suite
   discriminates. The environment attestation this session designs should be the same
   machinery pointed one level down, not a parallel invention.
3. **Letting "environment" and "task" blur.** The market sells them bundled and the prior art
   conflates them; the whole insight here is that they are different assets with different
   lifecycles, costs, and owners. If the design cannot say which layer owns a fact, the
   boundary is wrong.

## 1. Objective

Answer four questions, in order. Do not start a question until the previous answer is
approved.

**Q1 — What is a verified environment?** The unit: what it binds (repository at a commit,
image by content digest, install and test invocation, platform), what its verification
*asserts* (the suite runs; K-run determinism; baseline green; runtime bounds), and what a
third party must do to re-verify it — including the honest cost, since a re-verification
nobody can afford is a claim, not a proof. Then its record: tier-2 sealed record kind versus
an extension of the existing environment binding; its identity and digest rules; its
lifecycle (images rot, dependencies drift — does an environment expire, get re-attested, or
carry a staleness signal?); and whether third-party attestations compose (several parties
independently attesting the same environment). Run the standards audit: OCI image digests and
referrers, in-toto/SLSA build attestation, hermetic and Nix builds, dependency time-travel
proxies, OpenEnv RFC 008's environment auto-validation.

**Q2 — The environment capability and its supply.** The tier-3 capability that produces and
verifies environments: inputs, ports (git, container runtime, registry — all injected per
custody law), the verification pipeline and its gates, the failure taxonomy, and the
conformance fixtures that must precede it. This question owns **where environments come
from** in v1: imported from upstream datasets whose images already exist (rebench, smith,
Live), constructed by our own setup pipeline, or both — with the yield and cost evidence in
the research note driving the answer, not preference. It also owns what happens when
verification *fails*, since that is the common case: a rejected environment is a fact worth
recording, and possibly the most valuable free signal we can publish.

**Q3 — Task derivation on a verified environment.** The strategy seam and its v1 members.
Import (upstream rows against a verified environment), procedural injection (mutate green
code, keep candidates where a previously-passing test fails — zero marginal cost, the
multiplier on every verified environment), and later commit-echo mining and LLM-based
injection. For each: what it produces, how `provenance.kind` and lineage are populated,
whether problem statements are deterministic or generated (and how generated text is
labeled), and what admission proves. This question also owns the honesty surface: for public
repositories the answer to a derived task is discoverable — echo answers sit in the repo's
history, injected answers in the diff against the public original. State that plainly, name
the protections that actually work, and do not design secrecy theater. Whether *any* v1 task
carries private evaluation material is decided here, against the finding that grant hosting,
minting, and redemption exist nowhere.

**Q4 — The market surfaces: curation, interop, and posting.** Three surfaces that turn the
pipeline into a product:
- **Curation from exhaust.** Empirical pass rate per task from marketplace verdicts — where
  it is computed, whether it is a record or a projection (the stack's "derived status is never
  a mutable protocol record" rule applies), how tasks age out of the paid pool as they
  saturate, and whether difficulty is published per solver model or aggregate.
- **Interop.** OpenEnv and `verifiers` adapters — what a Jinn environment/task must carry to
  be consumable by open trainers, and whether adapters live in this program or are named
  extensions with owners.
- **Posting.** The requester on-ramp: the research note lists exactly which adapters are
  type-only (broadcast port, durable intent store, recovery scan, terms defaults). Decide
  what this program builds in the marketplace binding tree versus what it files as findings,
  plus the posting flow itself (does verification auto-post, or is posting an explicit,
  costed action?) and who funds escrow. Escrow is **native ETH via `msg.value`** and an EOA
  can post — the economics are smaller than the predecessor charter assumed.

## 2. What is settled — treat as law

- **Framing** (operator-approved, 2026-07-31): verified environments are the durable asset;
  tasks are cheap derivatives; the marketplace's graded attempts are the curation product.
  The purpose of the whole pipeline is verifiable graded evidence, not a leaderboard.
- **Two decisions survive the reframes** and are not reopened:
  1. The capability is **standalone tier-3**, never daemon-embedded; its output is sealed
     documents, and submission stays with the backend contract / marketplace binding.
  2. The legacy harvest-loop is **frozen reference**, superseded at a gate once the
     capability demonstrably covers its job — never migrated wholesale.
- **Compose, do not build a monolith** (operator direction, 2026-07-31). This is not one
  product with internal modules; it is several standalone capabilities that combine. The
  session's job is to draw the seams, not to decide whether to have them. §4a states the
  test and the candidate decomposition.
- **Everything else from the predecessor charter is reopened**, including consent's role,
  held-out material, statement derivation, license posture, and the plugin attach point.
  The research note §8 lists them; treat each as an open question, not an inherited answer.
- **The platform architecture** (DR-2026-07-30,
  [`../specs/2026-07-30-jinn-platform-architecture.md`](../specs/2026-07-30-jinn-platform-architecture.md)):
  the tier law — nothing in tiers 1–3 names a product; guards and conformance kits ship with
  packages.
- **The stack designs own their concerns**: sealing and confidential inputs
  ([`../specs/2026-07-27-task-execution-protocol-and-stack-design.md`](../specs/2026-07-27-task-execution-protocol-and-stack-design.md)),
  the repository-work profile and EvaluationSpec families
  ([`../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md`](../specs/2026-07-27-task-profiles-and-evaluation-specs-design.md)),
  posting and settlement
  ([`../specs/2026-07-28-marketplace-binding-design.md`](../specs/2026-07-28-marketplace-binding-design.md)),
  assertions and identity
  ([`../specs/2026-07-27-trust-and-identity-layer-design.md`](../specs/2026-07-27-trust-and-identity-layer-design.md)),
  discovery
  ([`../specs/2026-07-27-record-discovery-protocol-design.md`](../specs/2026-07-27-record-discovery-protocol-design.md)),
  and benchmark composition
  ([`../specs/2026-07-28-benchmarking-application-design.md`](../specs/2026-07-28-benchmarking-application-design.md),
  whose §19 disclaims task authoring). A finding that a stack surface cannot serve this
  application is a finding with a proposed disposition — never a fork.
- **The custody law** (consumption-boundary design): no key material, no ambient authority,
  signer-object-only, fail-closed, trusted-publisher provenance.
- **Sealed once, forever** (principles §5) and **derived status is never a mutable protocol
  record** (§7) — both bite directly on Q1's lifecycle and Q4's curation surface.
- **The collected principles**
  ([`../specs/2026-07-30-stack-design-principles.md`](../specs/2026-07-30-stack-design-principles.md)):
  §3 standards audit, §9 kits-first, §12 session method, §13.1 designs-are-law.

## 3. What is explicitly unsettled — bring a conclusion, not a summary

- Where exactly the seams fall (§4a gives the candidate decomposition and the test; *whether*
  to decompose is settled). Specifically: whether each derivation strategy is its own unit or
  one unit with a strategy registry; whether admission is separable from derivation; and
  whether one specification can charter several packages or the session should emit a spec
  per standalone unit.
- What re-verification actually costs a third party, and whether the design should offer a
  cheaper tier (attestation chain only) beside full re-execution.
- Whether rejected environments and failed candidates are published. They are the pipeline's
  most abundant output and a genuinely useful public signal, but publishing failure has an
  adversarial surface (a rejection list is a to-do list for a bad actor).
- Difficulty as a *market* signal: whether pass rate should feed pricing, and whether that
  belongs in this design at all or is a marketplace-economics question with another owner.
- Where the consent/endorsement record lands now that it is optional — parked with an owner,
  designed as an optional enhancement, or dropped until private/live tasks need it.
- The plugin's relationship to this product, if any. It may be nothing in v1; say so
  explicitly rather than leaving the parked mint extension point ambiguous.
- Whether the daemon runs this capability, a hosted service does, or CI does — and what that
  implies for identity, since the poster of record follows whoever escrows.
- Naming, per principles §13.5: "task harvester" is retired with its charter; the working
  title for this product is settled in one pass.

## 4. The reconciliation that matters most

**Verification is the product, not a feature of it.** Every layer here already has a
non-verifiable competitor: rebench supplies tasks, Prime Intellect's hub supplies
environments, vendors supply trajectories, and all of them ask you to trust the author. The
one thing Jinn can offer that none of them structurally can is *evidence anyone can check* —
an environment whose determinism is attested, a task whose grader is provably
discriminating, a trajectory whose verdict is signed and anchored. The design succeeds when
each layer's claim is independently checkable and honestly bounded; it fails if it produces
a supply pipeline whose quality rests on our word, because that product already exists and is
better funded.

## 4a. Compose, do not build a monolith

The operator's standing direction, and the through-line of this whole program: **split into
whatever can stand alone, then combine.** It is what dissolved the plugin trio, what made
this capability standalone rather than daemon-embedded, and what the tier law already
encodes. Treat it as law here.

**The test for a seam:** could a consumer plausibly want this piece *without* the others, or
substitute their own? If yes, it is a standalone unit with its own package, guards, and
conformance kit. If no, it is an internal module and splitting it only buys ceremony.

The strongest signal is an external consumer who is not us. Environment verification passes
that test loudly — an RL lab, a benchmark author, or a `verifiers` hub contributor wants
attested environments and has no interest in Jinn's marketplace. Derivation strategies pass
it too: someone may want injection against environments they already trust, and importing
upstream rows is useful to anyone with a marketplace to fill.

**Candidate decomposition** — a starting point for the session to refine, not a verdict:

| Unit | One job | Plausible standalone consumer |
| --- | --- | --- |
| Environment verification | repo@commit + image → attested verified-environment record | Any lab or benchmark author wanting trustworthy environments |
| Admission | candidate task + environment → differential-admission receipt proving the suite discriminates | Anyone grading anything; the machinery is task-source-agnostic |
| Derivation strategies | verified environment → sealed Task + EvaluationSpec pairs (import / injection / later mining) | A marketplace operator filling supply; each strategy usable alone |
| Curation projection | verdicts → empirical pass rate and saturation signal | Anyone selecting tasks by difficulty, including buyers of our data |
| Interop adapters | Jinn records ↔ OpenEnv / `verifiers` | Open trainers consuming Jinn supply |
| Requester on-ramp adapters | broadcast port, durable intent store, recovery scan | **Not ours** — belongs in the marketplace binding tree |

Note what that table implies: admission is probably not "part of mining" at all — it is the
verification primitive that mining, import, and injection each call, and it is the piece
already ahead of published prior art. Splitting it out is likely the single highest-value
seam in the design.

**The counter-discipline, so this does not become fragmentation:** every split costs a
package inventory, a source-boundary allowlist, a packed-types canary, a conformance kit, and
release coordination. Splits are justified by *substitutability and independent consumers*,
never by tidiness. A unit nobody could plausibly consume alone, and that we would never
substitute, is a module — say so and move on. Where a seam is genuinely uncertain, prefer the
cheaper reversible choice: one package with a clean internal boundary can be split later;
two packages with a leaky contract between them are much harder to rejoin.

## 5. Session gates and triggers

- **Gate to open:** none outstanding — the stack surfaces this composes exist on the
  integration branch, and the research note supplies the evidence base.
- **Trigger:** operator judgment. Natural forcing functions: the plugin program needing its
  mint extension point resolved (possibly to "nothing, by design"); marketplace supply
  running dry; or the requester on-ramp work wanting its first real consumer.
- **This session must not gate:** the plugin clean-slate program, the daemon cutover, or the
  marketplace binding program.

## 6. Method

Per principles §12, with one adaptation: **the research note replaces the first research
round.** Start from it. Commission new lanes only where a question needs evidence the note
lacks — likely candidates: an environment-verification standards lane for Q1 (OCI referrers,
SLSA, hermetic builds, time-travel proxies), an OpenEnv/`verifiers` interface lane for Q4 if
interop is taken up, and the mandatory adversarial lane at the end.

One material question at a time; section-by-section approval; one specification; two fresh
reviews before presenting — the adversarial review to cover environment forgery, attestation
replay, injected-task gaming, pass-rate manipulation by colluding solvers, and rejected-list
abuse; commit only on explicit approval.

**A note on this session's predecessor:** it produced no spec because the framing changed
underneath it twice. That was the method working, not failing — the questions surfaced the
collapse before code existed. If a third collapse surfaces here, the same rule applies:
recharter rather than write a spec around a framing that is dying.

## 7. Scope discipline — what this session does not own

- Reward and staking economics, including the activity-farming vector a self-mint-self-solve
  actor opens (filed as a finding to the reward/activity layer; no mining-side mechanism can
  close it).
- The marketplace binding program's execution, contract revisions, and deploys.
- The plugin clean-slate program's v1 scope.
- Protocol or profile changes — findings with dispositions to the owning specs.
- Live-work forwarding, private-repository tasks, and session mining — the products where
  consent becomes load-bearing again. Named as inheritors; designed elsewhere.
- Executing the legacy harvest-loop's supersession — this session sets gates; the daemon's
  programs execute them.

## 8. Success criteria

1. One specification under `docs/superpowers/specs/`, sections approved one at a time.
2. The verified-environment unit and record fully specified: what it binds, what its
   attestation asserts, its identity and lifecycle, and a re-verification story with an
   honest cost — with the standards audit on the record.
3. The environment capability's boundary and pipeline, including the failure path and the
   disposition of rejected environments.
4. The task-derivation strategy seam with its v1 members, provenance rules, and a plainly
   stated honesty surface on answer discoverability.
5. The market surfaces: curation-from-exhaust (as a projection, not a mutable record),
   interop disposition, and the posting decisions — with the requester on-ramp findings
   filed and their build location decided.
6. The decomposition: each standalone unit named with its one job, its consumers, its
   dependency direction, and its guards/kit — plus, for every seam considered and rejected,
   one line on why that piece is a module rather than a unit (§4a). The naming pass covers
   all of them.
7. A follow-ups list with owners, including consent's parking record and the activity-farming
   finding.
