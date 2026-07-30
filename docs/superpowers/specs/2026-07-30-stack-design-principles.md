# Jinn Protocol Stack — Design Principles

- **Date:** 2026-07-30
- **Status:** Derived index. Distilled from the 2026-07-27/28 design sessions and the
  implementation program charter this branch executes
- **Role:** The shared principles behind the six stack design specifications and the
  refactor implementing them. It **does not** define anything; every principle names the
  spec that owns it. Where this document and an owning spec differ, the owning spec wins.

## 0. Why this document exists

The stack was designed as seven sessions over two days, each re-applying one charter, so the
six specifications are structurally identical and share a small set of load-bearing rules.
Those rules are stated in full in the founding brief and restated per-spec, but they were
nowhere collected. Implementers reading one spec see its rules; they do not see that the same
rules hold across all of them, or which ones are the frozen ones.

## 1. The owning documents

| Layer | Specification |
| --- | --- |
| Task Execution Protocol + stack | [`2026-07-27-task-execution-protocol-and-stack-design.md`](./2026-07-27-task-execution-protocol-and-stack-design.md) |
| Task profiles + EvaluationSpecs | [`2026-07-27-task-profiles-and-evaluation-specs-design.md`](./2026-07-27-task-profiles-and-evaluation-specs-design.md) |
| Trust and identity | [`2026-07-27-trust-and-identity-layer-design.md`](./2026-07-27-trust-and-identity-layer-design.md) |
| Record discovery | [`2026-07-27-record-discovery-protocol-design.md`](./2026-07-27-record-discovery-protocol-design.md) |
| Local execution backend | [`2026-07-27-local-execution-backend-design.md`](./2026-07-27-local-execution-backend-design.md) |
| Marketplace binding | [`2026-07-28-marketplace-binding-design.md`](./2026-07-28-marketplace-binding-design.md) |
| Benchmarking application | [`2026-07-28-benchmarking-application-design.md`](./2026-07-28-benchmarking-application-design.md) |

Ancestors that set the pattern: the Evidence Protocol design
([`2026-07-23-jinn-execution-evidence-protocol-design.md`](./2026-07-23-jinn-execution-evidence-protocol-design.md)),
the evidence layer architecture
([`2026-07-25-evidence-layer-architecture.md`](./2026-07-25-evidence-layer-architecture.md)),
and the application layer index
([`2026-07-27-evidence-application-layer-index.md`](./2026-07-27-evidence-application-layer-index.md)).

## 2. The layering law

> **Owning home (2026-07-30):** the layering law, the platform boundary built on it, and the
> repository topology are now owned by
> [`2026-07-30-jinn-platform-architecture.md`](./2026-07-30-jinn-platform-architecture.md)
> (DR-2026-07-30). This section remains as the index summary.

Four tiers, defined in benchmarking
[§2](./2026-07-28-benchmarking-application-design.md), extending the frozen dependency
direction one level up:

1. **Protocol** — sealed record families and their semantics. Records and meaning; no behavior.
2. **Protocol-extending records** — record kinds defined *above* the protocol layers using the
   same sealed-record discipline, so third parties can produce and verify them **without
   running Jinn code**.
3. **Applications** — reusable capabilities that consume protocol records and do work, each
   one job, none naming a product.
4. **Products** — compositions of applications that people actually use.

The discipline that makes the tiers real: **nothing in tiers 1–3 ever names a product**, and
products are swappable compositions.

**Dependency direction is frozen:** applications → discovery → TEP + Evidence → trust.

- Record protocols never import discovery.
- A backend imports evidence **contracts** only; bindings are injected by hosts.
- `discovery/facts/*` leaves are the only place a discovery edge and a record-kind edge meet.
- The final dependency graph is acyclic and explicit.

## 3. Composition over invention

> We are composers of existing standards. Jinn-specific work should focus on the composition
> that existing standards do not provide.

Every design ran a standards audit against three options before designing anything: adopt an
existing standard wholesale, compose existing standards with a thin Jinn profile, or define
something bespoke. Bespoke required demonstrating that composition could not represent the
semantics cleanly. For each candidate the audit reported what it already owns, what Jinn adopts
unchanged, what needs a profile or extension, what does not fit, its maturity, and **whether it
combines transport, storage, and semantics in ways we should separate**.

A standard is never adopted because it is popular.

## 4. Six concerns kept separate

> Keep semantic protocol, serialization, carrier, backend API, persistence, and application
> policy separate.

Enforced by an explicit list of what the protocol layer is forbidden to know (TEP
[§4.1](./2026-07-27-task-execution-protocol-and-stack-design.md)): local process APIs, HTTP
routes, queues, databases, marketplace contracts, wallets, prices, rewards, GitHub, Autopilot,
Kubernetes, specific model providers.

Ownership per layer (TEP [§4](./2026-07-27-task-execution-protocol-and-stack-design.md)):

- **Protocol** — portable data, identities, relationships, lifecycle semantics, error-category
  vocabulary, conformance profiles.
- **Backend contract** — a language-level, service-neutral operational interface. It never
  exposes shared-mutation capability, credential passthrough, application-lifecycle authority,
  or settlement operations.
- **Bindings** — adapters onto a substrate. **Bindings translate protocol concepts; they never
  redefine them.** Claims, leases, escrow, transport request identifiers, and settlement
  sequencing are binding-internal.
- **Applications** — what work exists, backend selection, scheduling, decomposition, budgets,
  retry and competition policy, acceptance, evaluation policy, applying results, shared
  mutation, pricing and rewards, evaluator selection, trust and admission, UX.

Autopilot remains lifecycle and shared-mutation authority for its own workflows; its lifecycle
phases are GitHub-fact predicates and never appear in the protocol.

## 5. Sealed once, forever

Inherited unchanged from the Evidence Protocol; restated in TEP
[§6](./2026-07-27-task-execution-protocol-and-stack-design.md):

- SHA-256 over exact bytes, written `sha256:<64 lowercase hex>`; in-toto
  `ResourceDescriptor` shape where a descriptor is used.
- The authoring implementation canonicalizes **once** with RFC 8785 JCS, under I-JSON
  constraints, at the moment of sealing. **Those bytes are the document forever.**
- Verifiers hash the exact bytes they received. No consumer re-canonicalizes to check a digest.
  No system parses-and-re-emits a sealed document and calls it the same document.
- Signing is DSSE-only.
- The UTF-16 canonical string-ordering rule (evidence PR
  [#2226](https://github.com/Jinn-Network/mono/pull/2226)) applies wherever sealed bytes are
  produced.
- Sealing is re-implemented per package, with cross-package equivalence fixtures — the
  established precedent, not an accident.

This is what makes tier-2's "verifiable without running Jinn code" true rather than aspirational.

## 6. Do not conflate identities

The problem this repairs, stated in TEP
[§1](./2026-07-27-task-execution-protocol-and-stack-design.md): the marketplace carried three
coexisting task identities (creator id, IPFS CID, sequential on-chain id), two digest families
over the same envelope bytes, a signed-but-largely-unenforced `claimPolicy`, and a 40-field
per-operator row mixing attempt, execution, delivery, and settlement state.

So Task, Attempt, Execution, Result, Evaluation, and marketplace settlement identities stay
distinct, with deliberately non-containing cardinalities (TEP
[§5](./2026-07-27-task-execution-protocol-and-stack-design.md)), and these separations hold:

- protocol conformance is not backend capability, task acceptance, trust, or marketplace policy;
- a successful backend delivery is not necessarily an accepted Result;
- a passing Evaluation is not necessarily marketplace settlement;
- lifecycle state is not an evaluation verdict;
- cancellation is not rollback;
- backend infrastructure failure is not Result failure;
- Attempt terminality is not later evaluation or settlement.

Bind important inputs and outputs by content digest where exact identity matters. Repository or
transport location is never canonical content identity. Large artifacts are referenced through
standard descriptors rather than embedded without limit.

## 7. Immutable specification, append-only observation, derived status

- Task specification stays distinct from mutable execution state.
- Prefer immutable specifications and append-only observations.
- **Do not create mutable protocol records merely because a backend maintains mutable
  operational state.**
- Canonical lifecycle truth is the observation log. Any "current status" — including the Attempt
  descriptor a backend serves — is a derived projection, never a mutable protocol record.
- Evaluation, acceptance, reward, and trust never rewrite a historical execution record.
  Evaluations may arrive after an Attempt is terminal.

Discovery follows the same shape: the Ponder indexer becomes "projector #1" plus a query-plane
implementation, not a source of truth (discovery
[§6](./2026-07-27-record-discovery-protocol-design.md),
[§19](./2026-07-27-record-discovery-protocol-design.md)); the evidence discovery contracts
conform under the pinned projection in its
[§11](./2026-07-27-record-discovery-protocol-design.md).

## 8. Built for implementers outside this repo

- **Design for third-party implementations outside the monorepo.**
- **Do not optimize the protocol around one local implementation.** Local execution is one
  backend binding, not the definition of execution.
- Protocol identifiers are URI-based and identity-system-neutral. IDs are globally unambiguous
  **without requiring blockchain identity**; wallets, ERC-8004 identities, DIDs, organizational
  and local identities map *above* the protocol.
- Unknown extension fields survive round-trips; extensions never override core semantics.
  Extensions are namespaced.
- Confidential Tasks must not require secrets embedded in portable task documents.
- Protocol v1 is a **complete and stable scoped model, not a deliberately incomplete MVP**.
- Avoid premature compatibility with unpublished Jinn interfaces.

## 9. Conformance kits precede implementations

A sequencing rule, not a testing preference: **kits and fixtures come before the
implementations they test, everywhere, and a layer's kit must be green before dependents build
on it.**

Conformance is layered and the layers are not merged:

1. **protocol conformance** — valid specifications, identity and digest rules, references and
   cardinalities, extension preservation, observation ordering, result binding, terminal-state
   rules, malformed and adversarial fixtures;
2. **backend contract conformance** — submit, observe, cancel, recover, idempotency,
   unsupported capabilities, failure mapping, result retrieval, concurrent attempts, restart
   recovery;
3. **binding integration** — local round trip, marketplace round trip, at least one fake
   third-party backend, cancellation races, backend interruption, delayed evaluation;
4. **application acceptance** — application-specific, explicitly **outside** protocol
   conformance.

Capabilities a backend reports are statements, not proof of behavior; verification and
reputation stay separate.

## 10. The architecture must be executable

From the evidence layer architecture
[§5](./2026-07-25-evidence-layer-architecture.md):

> A dated design document may explain a boundary, but it does not replace a failing import
> canary.

Every new package tree gets the same guards the evidence tree has — package inventory,
source-boundary, and packed-types canaries plus a CI workflow — **built with the packages, not
after**. Those scripts are the executable architecture map; specifications are commentary on it.

Domain is the stable nesting axis for directories. Layer is not a directory axis.

## 11. Non-goals are load-bearing

Every specification ends with an explicit non-goals section, and they are read as binding:
TEP [§27](./2026-07-27-task-execution-protocol-and-stack-design.md),
profiles [§16](./2026-07-27-task-profiles-and-evaluation-specs-design.md),
trust [§19](./2026-07-27-trust-and-identity-layer-design.md),
discovery [§21](./2026-07-27-record-discovery-protocol-design.md),
local backend [§19](./2026-07-27-local-execution-backend-design.md),
marketplace binding [§16](./2026-07-28-marketplace-binding-design.md),
benchmarking [§19](./2026-07-28-benchmarking-application-design.md).

Standing ones worth repeating: do not build a task store, scheduler, workflow engine, message
broker, marketplace, universal sandbox, or hosted execution service inside the protocol. Do not
place Evidence Protocol record definitions, discovery, evaluation methods, trust, or
wallet/token/reward semantics inside TEP. Cancellation is a request and a lifecycle fact — it
cannot claim that arbitrary remote side effects were undone.

## 12. How the design sessions ran

Recorded because the process produced the consistency, and the remaining design tail will reuse
it:

1. research lanes as read-only subagents (standards, current behavior, requirements, adversarial
   boundary review);
2. the coordinating agent reconciles findings and owns all conclusions — subagent reports are
   never pasted through;
3. **one material question at a time**, with full context and implications, at accessible
   altitude — deep detail belongs in the written spec;
4. section-by-section approval;
5. write **one** specification;
6. **two fresh reviews before presenting** — an architecture review (duplication, policy
   leakage into protocol, backend operations leaking into serialization, application lifecycle
   leaking into the backend contract, one-backend assumptions, mutable-where-immutable,
   ambiguous identities, circular package dependencies) and a standards/adversarial review
   (a standard that could replace Jinn-specific design, digest substitution, replay, duplicate
   submission, cancellation races, confidential-data leakage, invalid transitions, late and
   conflicting results, unknown-field handling, underspecified canonicalization, interoperability
   claims unsupported by fixtures);
7. resolve blocking findings **before** asking for review;
8. commit only on explicit approval. No implementation plan until the design is approved.

The adversarial review earned its cost: it caught optional stopping, report-author-chosen
clustering keys, arm sandbagging, and a local-venue guarantee overclaim.

## 13. How the implementation runs

The charter this branch executes (program plan
[`../plans/2026-07-28-stack-implementation-program.md`](../plans/2026-07-28-stack-implementation-program.md)):

1. **Designs are law.** Discovering at planning or implementation time that a design is wrong or
   ambiguous is a **finding surfaced with a proposed disposition** — never a silent patch. Small
   clarifications are dated addendum notes in the plan documents. Conflicts between approved
   documents are surfaced, never silently resolved.
2. **Review per design, not per unit.** When a component is complete, one independent
   high-effort review checks the whole component against its design document — conformance,
   correctness, and an adversarial pass over its frozen interfaces — and its findings are fixed
   before dependents build on it. One overall program review runs across the integrated whole at
   the end. Between those, correctness is carried by automated gates, not model reviews.
3. **Verification before completion, every unit:** typecheck, tests, the relevant conformance
   kit, and the CI guards — run locally, outputs shown. No phase is reported done without them.
4. **Guards ship with packages** (§10), not afterwards.
5. **Package scope names** across the stack designs were working titles; they are settled in one
   naming pass and then used consistently everywhere.
6. **Duplication is named and forbidden.** The Evaluation Runner's host-orchestration half is
   superseded by the local execution backend (local backend §10.4, §17); re-implementing it is
   forbidden duplication. Its surviving evaluator-adapter core ships as the evaluation harness.

## 14. Provenance

The design sessions are Claude Code transcripts in the design worktree
`gallant-dijkstra-768dc8`, 2026-07-27 → 2026-07-28: session `d173e1ae` carries the founding
29 KB charter for TEP and the stack; `dd12960a`, `3a684c93`, `8e5d0c55`, `e4ed08b8`, and
`115a54b0` continue it through profiles, trust, discovery, the local backend, the marketplace
binding, and benchmarking. The charter was re-applied as a compressed principles preamble to
each subsequent design, which is why the specifications are structurally identical. The
implementation program charter is session `a4bcc35c` in worktree `determined-dijkstra-03bb6c`.

The earlier Evidence Protocol design sessions — the pattern all seven follow — are not present
in the local transcript store; only their output specifications survive in-repo.
