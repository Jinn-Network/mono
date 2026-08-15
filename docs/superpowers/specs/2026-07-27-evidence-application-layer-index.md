# Evidence Application Layer Index

- **Date:** 2026-07-27
- **Status:** Four priority application designs and implementation plans collected and reconciled
  against the recorded Evidence integration head; implementation has not begun
- **Role:** A short dependency and ownership index for the authoritative application
  specifications. It does not replace them.

## 1. Priority application capabilities

The first application-level capabilities above the Evidence substrate are:

1. Execution Evidence Capture;
2. Evidence Retrieval; and
3. Evidence Contribution.

> **Superseded 2026-07-28 — Evaluation Runner.** A fourth capability was originally listed here as
> an `@jinn-network/evaluation-runner` package. Per the Local Execution Backend design
> ([`2026-07-27-local-execution-backend-design.md`](./2026-07-27-local-execution-backend-design.md)
> §10.4, §17) it is **not** built as a standalone package: its host-orchestration half is superseded
> and its surviving evaluator-adapter core is implemented as the evaluation harness in
> [`../plans/2026-07-28-local-execution-backend.md`](../plans/2026-07-28-local-execution-backend.md).
> Evaluation remains an available capability (an evaluation-profile Task run as an ordinary Attempt),
> just not a separately packaged one.

They are independently usable capabilities. The Jinn plugin will later compose Capture, Retrieval,
and Contribution. A marketplace operator may use Capture and the evaluation harness without
depending on the plugin.

Corpus curation is not a required fifth application. A live corpus is a query, a saved corpus is a
versioned query value, and a frozen corpus is a query evaluated against recorded source or Catalog
checkpoints. A Dataset or Benchmark Builder may materialize the resulting record references when
portability requires it.

Task Execution Protocol and its backend contract form a separate sibling design stream. They are
not hidden inside these applications.

## 2. Settled package outcomes

| Capability | Shared package outcome | Host-owned integration |
| --- | --- | --- |
| Execution Evidence Capture | No new Capture domain package. TypeScript hosts use Execution Recorder directly; non-TypeScript hosts may use `@jinn-network/execution-recorder-bridge`. | Host lifecycle mapping, observation scope, trace production, capture policy, correlation, and supervision |
| Evidence Retrieval | `@jinn-network/evidence-retrieval` | Candidate providers, search indexes, provider queries and ranking, repository bindings, acceptance policy, and consumer projection |
| Evidence Contribution | `@jinn-network/evidence-contribution` | Eligibility and disclosure decisions, actor authentication, policy authority, destinations, credentials, scheduling, and product UX |
| Evaluation Runner | **No standalone package — superseded 2026-07-28.** The surviving evaluator-adapter core ships as the evaluation harness at `packages/task-execution/evaluation-harness` (`@jinn-network/task-execution-evaluation-harness`), a sibling package of backend-local; see backend design §10.4/§17 and [`../plans/2026-07-28-local-execution-backend.md`](../plans/2026-07-28-local-execution-backend.md). | Durable jobs and leases, evaluator registrations, execution providers, material resolver, signer authority, trust, submission, and product policy |

The package grouping under `packages/evidence/` does not make these application capabilities part
of the lower-level Evidence Protocol. Dependency direction remains downward into stable substrate
contracts.

## 3. Dependency direction

```text
Evidence Protocol ------------------------------+
Evidence Repository ----------------------------+---------------------+
                                                 |                     |
Execution Recorder --> Execution Recorder Bridge                     |
                                                                       |
Discovery ------------------------> Evidence Retrieval                 |
                                                                       |
Derivation + Publication ----------> Evidence Contribution             |
                                                                       |
Attestation Issuer ----------------> Evaluation Runner <---------------+
```

> **Diagram notes (2026-07-28).**
> - The `Attestation Issuer → Evaluation Runner` edge is superseded: it is now
>   `Attestation Issuer → evaluation harness` at `packages/task-execution/evaluation-harness`
>   (`@jinn-network/task-execution-evaluation-harness`), a sibling package of backend-local. The
>   harness still composes Attestation Issuer, Evidence Protocol, and Evidence Repository, so the
>   substrate feeds are unchanged; only the standalone Evaluation Runner package is gone. See backend
>   design §10.4/§17 and
>   [`../plans/2026-07-28-local-execution-backend.md`](../plans/2026-07-28-local-execution-backend.md).
> - **"Discovery"** in this diagram is the existing, frozen `@jinn-network/evidence-discovery`
>   package — not the 2026-07-27 Record Discovery Protocol layer, whose §11 keeps these
>   `evidence-discovery` contracts unchanged.

The application packages do not depend on one another in their initial implementations:

- Capture does not call Retrieval.
- Retrieval does not call Capture.
- Contribution resolves exact source material through injected Repository capabilities; it does
  not depend on Retrieval search.
- The evaluation harness (see §2) consumes an injected exact-material resolver; it does not depend
  on the Evidence Retrieval package.
- Contribution and the evaluation harness remain independent. Contribution may later publish an
  already-issued Result Evaluation through its normal one-record workflow.

This prevents a cycle and permits all three implementation streams to share one substrate base.

## 4. Shared semantic boundaries

- Canonical identity is always an Evidence family plus exact SHA-256 digest.
- Repository location, availability, indexing, search relevance, signature validity, trust,
  publication, admission, settlement, and reward remain separate facts.
- Capture completion never implies contribution.
- Retrieval candidates and Catalog projections are not canonical Evidence.
- Contribution authorization binds an exact prepared disclosure and exact destinations.
- Evaluation verdicts are completed claims; operational failures never become failing verdicts.
- Immutable records are appended, superseded, or disputed through new records rather than mutated.
- Host and product state remains outside Evidence Protocol.

## 5. Implementation ordering

The complete Evidence substrate DAG is merged. The recorded integration head is:

```text
branch: integration/evidence-v1
head:   f65880c4e244e32334f0fed98bf00ff9b307e87d
```

It was produced by merging all 38 substrate pull requests, in topological order and with merge
commits only, onto a branch cut from `next` at `918e683d44a237d61d6f84a082cb2be9dc6a6f76`. Its tree
is byte-identical to the former stack tip across `packages/evidence/`, `.github/scripts/evidence-*`,
and `.github/workflows/evidence-ci.yml`. Every application worktree starts from this head or a
descendant containing it, and each plan's preflight asserts that with
`git merge-base --is-ancestor`.

A 2026-07-28 re-audit advanced the approved integration head to `3650ac65e` — a descendant of
`f65880c4e` that additionally contains PR #2226 — and that descendant is the current baseline every
plan's 2026-07-28 addendum preflights against. Because it still contains `f65880c4e`, each plan's
`git merge-base --is-ancestor` assertion continues to hold.

Application work targets `integration/evidence-v1`, not `next`. Migration and product cutover land
on the same branch, and a single merge-commit pull request promotes it to `next` at the end.

From that common head:

- Execution Recorder Bridge may proceed independently.
- Evidence Retrieval may proceed independently.
- The evaluation harness (formerly the standalone "Evaluation Runner") is **not** an independent
  lane. It lands as a work item inside the Local Execution Backend sequence
  ([`../plans/2026-07-28-local-execution-backend.md`](../plans/2026-07-28-local-execution-backend.md);
  backend design §10.4/§17), after that backend's supervisor and assembly exist — it does not proceed
  as its own stream.
- Evidence Contribution may proceed once the hardened Derivation and Publication packages are
  present.

The exact commits named in individual plans are minimum reviewed ancestry requirements, not
instructions to discard later substrate work. Each implementation worktree must start from the
current approved integration head containing its required commits.

Plugin, marketplace, Autopilot, and other host migrations follow in separate designs and PRs after
the reusable application capabilities are implemented and verified.

## 6. Shared CI guard ownership

All three lanes add their package to the same four files:

- `.github/scripts/evidence-package-inventory.test.mjs`
- `.github/scripts/evidence-source-boundaries.test.mjs`
- `.github/scripts/evidence-packed-types.test.mjs`
- `.github/workflows/evidence-ci.yml`

**Each lane registers its own package.** A single preparatory pull request registering all three
slots ahead of the lanes is not possible: `evidence-package-inventory.test.mjs` asserts an exact
package count, asserts that every listed package's `package.json` exists on disk, and reconciles
the declared list against the packages actually present under `packages/evidence/`. A slot declared
before its package exists fails from both directions.

The edits are additive entries in sorted lists, so concurrent lanes conflict only when two land on
adjacent lines. That is an ordinary textual conflict, not a serialization requirement, and it does
not make the lanes dependent on one another.

Package naming follows the substrate component a package extends, not a uniform `evidence-` prefix.
`@jinn-network/execution-recorder` and `@jinn-network/attestation-issuer` already omit the prefix in
the merged substrate, so `@jinn-network/execution-recorder-bridge` is consistent with existing
practice rather than an exception to it.

## 7. Authoritative documents

### Execution Evidence Capture

- [Design](./2026-07-26-execution-evidence-capture-design.md)
- [Implementation plan](../plans/2026-07-27-execution-recorder-bridge.md)

### Evidence Retrieval

- [Design](./2026-07-26-evidence-retrieval-design.md)
- [Implementation plan](../plans/2026-07-27-evidence-retrieval.md)

### Evidence Contribution

- [Design](./2026-07-26-evidence-contribution-design.md)
- [Implementation plan](../plans/2026-07-27-evidence-contribution.md)

### Evaluation Runner — superseded 2026-07-28

- [Design](./2026-07-26-evaluation-runner-design.md) — **superseded in part**; the host-orchestration half is re-homed. See its status header and the [Local Execution Backend design](./2026-07-27-local-execution-backend-design.md) §10.4/§17.
- [Implementation plan](../plans/2026-07-27-evaluation-runner.md) — **superseded**; `@jinn-network/evaluation-runner` is not built. The surviving evaluator-adapter core ships as the evaluation harness in the [Local Execution Backend plan](../plans/2026-07-28-local-execution-backend.md).

The specifications own semantics. The plans own the proposed implementation sequence. Their
baselines are reconciled by the 2026-07-28 plan addenda, which preflight against the current
integration head recorded in §5 (`3650ac65e`, containing `f65880c4e` + PR #2226); the
pre-integration mid-stack and abandoned-branch commit references they previously named are
superseded.
