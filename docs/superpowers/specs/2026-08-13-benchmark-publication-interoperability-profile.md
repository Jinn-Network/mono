# Benchmark Publication Interoperability Profile

| | |
|---|---|
| **Version** | 0.4 |
| **Date** | 2026-08-13 |
| **Amended** | 2026-08-18 — Inspect-as-specified second named suite protocol ([DR-2026-08-18](../../../log/decisions/2026-08-18-inspect-as-specified.md)); 2026-08-17 — direct-mode job grain ([DR-2026-08-17](../../../log/decisions/2026-08-17-runtime-engine-direct-mode.md)); official suite protocol and one Job per arm ([DR-2026-08-17-b](../../../log/decisions/2026-08-17-official-suite-protocol.md)); no §8.4 marketplace rewrite |
| **Shape** | interoperability profile and design amendment |
| **Status** | draft; revised after independent design review; §8.3 grain note added 2026-08-17; §8.3 suite protocol added 2026-08-17; Inspect-as-specified added 2026-08-18 |
| **Applies to** | any benchmarking product publishing through Jinn, including Colophon |
| **Depends on** | [stack design principles](./2026-07-30-stack-design-principles.md), [benchmarking application](./2026-07-28-benchmarking-application-design.md), [record discovery](./2026-07-27-record-discovery-protocol-design.md), [evidence publication](./2026-07-25-evidence-publication-design.md), and [execution evidence](./2026-07-23-jinn-execution-evidence-protocol-design.md) |
| **Companion research** | [Colophon, Harbor, and marketplace publication spike](../../spikes/2026-08-13-colophon-harbor-marketplace-publication.md) |

## 0. Decision in plain language

A public benchmark needs to preserve two different things:

1. **What the publisher intended to run** — the benchmark, method, configurations, and expected
   cells fixed in the Benchmark and Run records.
2. **What actually happened** — every dispatch, including failed and replaced dispatches, and the
   exact evidence used to construct the final Matrix and any Report.

Jinn already has the durable records for most of this. It does not need a second benchmark model,
a Harbor-shaped benchmark model, or a Colophon record family. The missing reusable piece is a
small sealed **BenchmarkAccounting** record that indexes the complete dispatch lineage claimed by
the publisher. The Matrix remains the terminal account of outcomes. The Report remains the signed
interpretation. BenchmarkAccounting connects the two to the underlying execution records without
copying their meaning.

Two assurances remain deliberately separate: the Report's existing `preregistered` field says
that its analysis method was fixed in the Run, while BenchmarkAccounting says whether publication
of that Run can be shown to precede dispatch. A run may satisfy either, both, or neither.

Publishing is a three-stage flow:

```text
registration                 accounting                         report
what will run                what actually ran                  what it means

Task / Benchmark             Submission / Attempt               signed Report v2
runtime selection            observation archive
EvaluationSpec               Delivery / Evidence
Run (last)                   BenchmarkAccounting
                             Matrix (last)
```

The reusable Jinn application computes and publishes those stages. A product such as Colophon
decides when the user consents, which source name and public site it uses, which native artifacts
may be disclosed, and how the records are presented.

This design does **not** require the Jinn marketplace backend. A direct Harbor run, a local native
run, and a marketplace operator using Harbor all produce the same Jinn publication shape. Venue
and runtime are independent facts.

## 1. The user experience this enables

### 1.1 Public from the start

A user chooses “public run,” reviews the publication and disclosure plan, and locks the run. The
registration records are durably published before execution begins. The run proceeds locally or
through a selected backend. Colophon continuously retains the accounting inputs, then publishes
the complete accounting and terminal Matrix. It publishes a Report only when the evidence and
consent gates permit it.

The user does not separately upload records, understand source chains, or operate a discovery
service. Those are consequences of the publish action, not extra workflow steps.

### 1.2 Publish a run completed locally

A Colophon-managed local run is always retained in a publication-capable workspace. If the user
later chooses to make it public, Colophon builds the same closure from the Jinn records and native
artifacts captured during execution. The benchmark does **not** run again.

The Report's `preregistered` field retains its existing meaning: the exact analysis tuple was fixed
in the sealed Run. A separate BenchmarkAccounting `publicRegistration` disclosure says
`pre-dispatch`, `post-hoc`, or `unverifiable`. “Post-hoc” changes the public-timing assurance, not
the record format or the truth of analysis preregistration.

An arbitrary historical Harbor Job that did not run through a Jinn-aware adapter is different. It
has no historical Jinn Submission, Attempt engagement, or authoritative TEP observation stream.
This profile does not synthesize those facts after completion. Retrospective import requires a
separate attestation design and is deferred (§16).

### 1.3 Publish accounting without overclaiming

Accounting and interpretation are separate. A cancelled, partial, unsupported, or failed run can
still publish an honest BenchmarkAccounting record and Matrix. No Report is required. A product
must never hide the run merely because a clean comparative claim could not be produced.

## 2. Scope and non-scope

This profile fixes:

- the stages and dependency order of public benchmark publication;
- the one-dispatch lineage boundary;
- the BenchmarkAccounting record and observation-archive artifact;
- exact-byte persistence and discovery announcement behavior;
- runtime-native evidence contribution and disclosure rules;
- the relationship among payload, signature envelope, public URL, and record identity;
- Harbor compatibility at the publication boundary; and
- conformance fixtures that direct and marketplace-backed publishers must share.

The eventual conformance profile URI is
`https://spec.jinn.network/profiles/benchmark-publication/v1`. This document's `0.4` version is the
revision of the draft design; it does not change that intended profile major version.

It does not design:

- marketplace scheduling, selection, pricing, settlement, or operator UX;
- a Harbor launcher or remote provider;
- cross-cell parallelism policy;
- a new public website or catalog;
- new statistical methods;
- a universal translation of native runtime artifacts; or
- a requirement that public records live on one chain or in one storage product.

## 3. Standards composition

The profile follows the stack rule to compose existing standards before inventing another one.

| Concern | Adopted contract | Jinn-specific work left |
|---|---|---|
| Content identity | SHA-256 over exact bytes; in-toto `ResourceDescriptor` shape | dependency closure and record roles |
| Canonical JSON | RFC 8785 JCS under I-JSON constraints | seal each new Jinn-authored document once |
| Signed claims | DSSE | trust resolution and Report policy |
| Execution lifecycle | Jinn Task Execution Protocol observations | durable run-scoped accounting index |
| Portable execution evidence | Jinn Execution Evidence | runtime-native evidence role contribution |
| Discovery | Jinn Record Discovery source chains and facts profiles | publication ordering and new accounting facts |
| Harbor execution | Harbor Task, Dataset, Trial, Job, and result/artifact layout | identity mapping and exact artifact retention |
| Terminal-Bench | Terminal-Bench 2.1 through its official Harbor harness as a named suite protocol; Harbor's published migration mapping for legacy task packages; Terminal-Bench 2.0 one-task path remains a distinct non-2.1 campaign | pin dataset content-hash revision; disclose coverage vs execution conformance; pin original and migrated material when converting |
| Agent trajectory | Harbor's Agent Trajectory Interchange Format (ATIF) | reference it byte-exactly; do not translate it |
| Test result detail | Harbor-produced CTRF where present | retain as native evidence; do not make it mandatory for all runtimes |

Harbor's current model treats a Trial as one agent attempt on a Task and a Job as a collection of
Trials. Its result tree preserves Job and Trial configuration/results, reward material, logs,
trajectories, and collected-artifact metadata. This profile adopts those artifacts rather than
recreating them. See [Harbor core concepts](https://www.harborframework.com/docs/core-concepts),
[running evaluations](https://www.harborframework.com/docs/run-jobs/run-evals),
[results and artifacts](https://www.harborframework.com/docs/run-jobs/results-and-artifacts), and
the [ATIF RFC](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md).

Terminal-Bench 2 does not need a parallel Colophon execution framework: Harbor is its official
harness. Colophon should select the Terminal-Bench Dataset through the Harbor adapter and retain
the normal Harbor Job/Trial evidence. For a legacy Terminal-Bench task, Harbor's migration tool can
produce runnable Harbor material, but migration is a transformation rather than identity
preservation. Publication must pin the original task snapshot, the migrated task snapshot, and the
Harbor/mapping version, and must disclose any manual migration. See [running Terminal-Bench on
Harbor](https://www.harborframework.com/docs/tutorials/running-terminal-bench) and [the official
migration guide](https://www.harborframework.com/docs/migration).

## 4. Ownership across the Jinn stack

| Tier | Reusable ownership | Explicitly not owned here |
|---|---|---|
| **1 — protocols** | Existing TEP, Evidence, Trust, and Record Discovery semantics remain unchanged | Harbor, Colophon, backend selection, consent UX |
| **2 — protocol-extending records** | `BenchmarkAccounting` and signed Report v2 record definitions in `benchmarking/records` | discovery imports, publication workflow, storage choice, product URLs |
| **3 — reusable applications** | publication-plan builder; accounting capture; runtime evidence-contributor contract; store-before-announce execution; verification | product source name, branding, publish prompts |
| **4 — products** | Colophon workspace retention, disclosure choices, source configuration, hosted report, import UX | definitions other publishers must copy |

Nothing in tiers 1–3 names Colophon. Nothing in the accounting schema names Harbor, Inspect, the
Jinn marketplace, or a particular chain. Those systems contribute typed references through the
same application seam.

Record facts remain at the one permitted dependency meeting point. The accounting and signed
Report v2 facts documents and recomputers belong in `discovery/facts/benchmarking`, which may import
the tier-2 record package and Record Discovery. They do not belong in `benchmarking/records`.

## 5. Common identity model

The following identities must remain distinct:

| Thing | Identity authority |
|---|---|
| Benchmark, Run, Matrix, BenchmarkAccounting | digest of their exact sealed record bytes |
| Submission and Delivery | their TEP sealed identities |
| Attempt | TEP Attempt URI |
| Execution Evidence and Evaluation | their own sealed or signed record identities |
| Legacy Report v1 record / Report payload | digest of the exact JCS payload bytes |
| Published signed Report v2 record | digest of the exact DSSE envelope bytes |
| Harbor Job / Trial | Harbor correlation identifiers, not Jinn content identities |
| Marketplace request / claim / settlement | binding-native correlation identifiers and stable references |
| Public report URL | a mutable location at which some of the above can be retrieved |

A URL can move while a digest cannot. A source announcement can point to several retrievable
locations without changing record identity. A Harbor Trial ID or marketplace claim ID helps a
reader correlate systems; neither replaces the Submission, Attempt, Delivery, or Evidence
identity.

### 5.1 One Submission is one permitted task attempt

Every benchmark cell dispatch in profile v1 must explicitly seal:

```json
"attempts": { "maxTotal": 1, "maxConcurrent": 1 }
```

A planned replicate is a distinct expected cell. A replacement is another visible dispatch for
the same cell. A retry that actually starts work is also visible in the dispatch lineage. This
keeps Harbor Trial, marketplace claim, TEP Attempt, and benchmark accounting aligned without
pretending that their identifiers are the same.

## 6. Publication stages

### 6.1 Stage A — registration

For a public run that claims pre-dispatch publication, the publisher closes the following
registration dependency set before launch:

1. Task material and exact Task records.
2. EvaluationSpecs and other declared evaluation material.
3. Runtime-selection and runtime-profile artifacts.
4. The Benchmark.
5. The Run, **last**.

The Run announcement is the public registration commitment boundary. A quote or local lock is not
public registration. Launch is permitted only after the publication executor confirms that all
required bytes are durably stored, all records the publisher is authorized to announce have
recoverable source updates, and all required third-party announcements resolve.

An author source announces records authored by its agent or a verifiable delegate. Colophon does
not reannounce an operator-authored Delivery as if Colophon authored it. It may mirror the exact
bytes at a public location and cite the Delivery's operator or marketplace source position. A
record with no required first-party announcement fails closure rather than acquiring false
provenance.

Runtime identity known before launch—implementation version, adapter/profile version, material
configuration, task package, OCI image digest, reward contract—belongs in digest-bound selection
material. Generated Job, Trial, request, claim, and Attempt IDs do not: they do not yet exist.

Profile-conforming Run and Matrix records use the common top-level extension key
`https://spec.jinn.network/extensions/benchmark-publication/v1`. On a Run it contains ordered
`registrationArtifacts`, each with an absolute role URI and digest-bearing descriptor. This makes
the runtime/evaluation closure part of Run identity while letting adapters own the artifact
formats.

The Run therefore proves a **digest commitment** to those artifacts. Their successful retrieval at
verification time proves **present availability**. Neither fact alone proves that ordinary
artifact bytes were publicly retrievable before dispatch. A publisher may claim historical public
availability only when it supplies a store receipt or common-substrate anchor whose temporal
ordering can be verified (§9.3).

### 6.2 Stage B — accounting

The publisher captures and eventually stores for every Jinn-managed dispatch:

1. exact Submission bytes;
2. a canonical observation archive, including the Attempt URI when one was assigned;
3. exact Delivery bytes, when produced;
4. Execution Evidence, evaluations, verdicts, and verification attestations;
5. runtime- and venue-native artifacts or honest availability declarations;
6. correlation artifacts joining native identifiers to the Jinn dispatch; and
7. the authoritative source or substrate position through which the dispatch enters the declared
   accounting scope.

After the close boundary, it seals and publishes:

1. BenchmarkAccounting; then
2. the terminal Matrix, last.

The Matrix is still authoritative for expected cells, attrition, exclusions, completeness, and
the outcome selected for each cell. BenchmarkAccounting is authoritative only for the
publisher's claimed dispatch/evidence closure. It does not contain scores or choose an outcome.

Profile-conforming Matrix derivation uses `jinn.benchmarking.assembly` version `2.0`. Version 2.0
consumes the sealed BenchmarkAccounting record named by the Matrix publication extension. Existing
version 1.0 matrices remain valid, but they do not claim this profile's complete dispatch-reference
closure.

### 6.3 Stage C — report

When the method, evidence-support, verification, disclosure, and consent gates all pass, the
publisher produces the Report payload and its DSSE envelope. Dependencies are stored first; the
signed Report envelope is announced last.

If those gates do not pass, publication ends honestly at the Matrix. The absence of a Report is
not a failure to publish accounting.

## 7. The BenchmarkAccounting record

### 7.1 Why a record is needed

Record Discovery can find records related to a run, but a query response is a projection whose
`complete` claim depends on the source and query plane. TEP observation streams describe
lifecycle truth, but they are not themselves a sealed, announceable record family. The Matrix
records a dispatch count and the dispatch selected for accounting, not every replacement or
failed dispatch reference.

BenchmarkAccounting fills exactly that gap. It is a sealed manifest of the publisher's claimed
input closure at the close boundary. Unlike an unscoped manifest, it also names the versioned
accounting procedure, every authoritative stream, and the exact terminal position through which
each stream is included. A verifier can discover an omitted in-scope dispatch and prove the
manifest incomplete. Where an authoritative stream cannot be independently enumerated, the result
is `indeterminate`, never silently complete.

This profile amends the older benchmarking-design shorthand that the Matrix itself reports “the
full lineage.” The Matrix remains the full terminal cell/outcome account. BenchmarkAccounting is
the complete dispatch-reference lineage used by assembly version 2.0.

### 7.2 Proposed record identifiers

```text
protocol:   https://spec.jinn.network/protocols/benchmarking/v1
kind:       https://spec.jinn.network/records/benchmark-accounting/v1
media type: application/vnd.jinn.benchmarking.accounting.v1+json
facts:      https://spec.jinn.network/facts/benchmark-accounting/v1
```

### 7.3 Illustrative v1 shape

The implementation specification should freeze the exact JSON Schema, named checks, and ordering
rules. The semantic shape is:

```json
{
  "protocol": "https://spec.jinn.network/protocols/benchmarking/v1",
  "run": { "name": "run", "digest": { "sha256": "..." } },
  "publisher": "did:example:publisher",
  "procedure": { "id": "jinn.benchmarking.accounting", "version": "1.0" },
  "scope": {
    "streams": [
      {
        "role": "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
        "kind": "record-discovery",
        "source": { "agent": "did:example:publisher", "name": "benchmarks" },
        "through": { "sequence": "0000000000000042", "entry": "sha256:..." }
      }
    ]
  },
  "publicRegistration": { "status": "post-hoc" },
  "closeBoundary": { "at": "...", "anchor": { "chain": "...", "blockNumber": 1, "blockHash": "..." } },
  "cells": [
    {
      "cellKey": "...",
      "dispatches": [
        {
          "index": 1,
          "submission": { "name": "submission", "digest": { "sha256": "..." } },
          "attempt": "urn:jinn:attempt:...",
          "observations": { "name": "observation-archive", "digest": { "sha256": "..." } },
          "delivery": { "name": "delivery", "digest": { "sha256": "..." } },
          "evidence": [
            {
              "kind": "https://spec.jinn.network/records/execution-evidence/v1",
              "record": { "name": "execution-evidence", "digest": { "sha256": "..." } }
            }
          ],
          "evaluations": [],
          "correlations": [],
          "nativeArtifacts": [
            {
              "role": "https://harborframework.com/artifact-roles/atif-trajectory/v1",
              "availability": "public",
              "artifact": { "name": "trajectory.json", "digest": { "sha256": "..." } }
            }
          ]
        }
      ]
    }
  ]
}
```

Optional fields are omitted only when the corresponding object was not produced or was not
observable. They are not silently omitted because it was inconvenient to publish them.

Normative constraints:

- `procedure` is exactly `jinn.benchmarking.accounting@1.0`.
- `scope.streams` is non-empty, deterministically ordered, and identifies every authority from
  which dispatch completeness is claimed. A Record Discovery stream names `(agent, source-name)`
  and an exact `(sequence, entry digest)` cutoff. A substrate stream names an absolute profile URI,
  authority/contract identity, and a finality anchor. Adapter-specific locators remain inside that
  profile's object.
- Every scope cutoff is known before BenchmarkAccounting is sealed and excludes the accounting
  announcement itself; the record cannot cite a future source position or create an identity
  cycle.
- `cells` contains exactly the Run's expected cell keys in ascending code-unit order.
- A cell's `dispatches` contains every dispatch within the declared input scope, ordered from
  one with no gaps.
- Every dispatch has one Submission with explicit one-Attempt bounds.
- Each Submission's existing benchmarking extension must match the accounting Run digest, cell
  key, arm, replicate, and dispatch index. This check binds enumeration to the sealed dispatch
  rather than trusting the array position.
- `attempt`, `delivery`, and the artifact arrays describe facts; their absence does not imply
  success or failure.
- Every record reference contains both a record-kind URI and a digest-bearing descriptor. Every
  artifact reference contains an absolute role URI and a digest-bearing descriptor when safe
  bytes exist.
- `correlations` contains typed artifact references contributed by a venue/runtime profile. It
  never adds a Harbor or marketplace identifier to the common schema.
- `nativeArtifacts` contains role, availability, and an optional descriptor. Availability is one
  of `public`, `digest-only`, `source-absent`, or `collection-failed`. Non-public entries include
  a non-blank reason.
- The accounting close boundary equals the Matrix close boundary.
- `publisher` equals the Run owner or passes the named
  `benchmark-accounting-publisher-authority` check through an authorization effective no later
  than the close boundary.
- BenchmarkAccounting carries no outcome, aggregate, pass/fail reduction, cost calculation, or
  settlement conclusion.

`publicRegistration.status` is one of `pre-dispatch`, `post-hoc`, or `unverifiable`:

- `pre-dispatch` requires the exact Run announcement boundary and the earliest in-scope dispatch
  boundary, ordered either within one Record Discovery source or by a common substrate anchor;
- `post-hoc` states that the Run was first made public at or after dispatch and needs no attempt to
  reconstruct earlier publication; and
- `unverifiable` is used when the publisher believes publication preceded execution but the two
  boundaries have no comparable ordering authority.

A registration boundary reference is either:

- `{ kind: "record-discovery", source: { agent, name }, position: { sequence, entry } }`; or
- `{ kind: "substrate", profile, authority, anchor }`, where `profile` is an absolute URI and the
  profile defines finality and anchor ordering.

`pre-dispatch` carries `runBoundary` and `firstDispatchBoundary`. Two Record Discovery boundaries
are comparable only when their `source` objects are equal. Two substrate boundaries are comparable
only when the profile says their authority and anchors share one order. `unverifiable` retains the
two non-comparable references when available so a later verifier does not have to guess why proof
was unavailable.

The named `public-registration-order` check returns `pass`, `fail`, or `indeterminate` from those
boundaries. It never reads Report `preregistered`, which remains the independent analysis-plan
check.

On a Matrix, the benchmark-publication extension contains the digest-bearing `accounting`
descriptor. This gives every profile-conforming Matrix one unambiguous accounting input without
changing Matrix's outcome semantics or creating an identity cycle: BenchmarkAccounting references
the Run; the later Matrix references BenchmarkAccounting.

The accounting procedure enumerates each declared stream only through its frozen cutoff. For
Record Discovery streams, a verifier searches Submission/Delivery facts at the cited source and
requires a complete query result at that position. For substrate streams, the venue profile owns
the deterministic event/projector mapping and finality rule. An extra matching dispatch omitted
from `cells` fails accounting completeness; an unreachable stream or incomplete projection makes
the check indeterminate. A self-run source remains owner-controlled, and the resulting omission
residual is disclosed rather than claimed away.

The record's discovery facts are limited to `runDigest`, `publisher`, procedure/version, `closeAt`,
optional close anchor, cell count, and dispatch count, plus reference edges. The Matrix facts
profile exposes its accounting reference when the extension is present. Search-friendly
Submission and Delivery facts remain the existing source of per-cell query attributes. These facts
documents and recomputers live in `discovery/facts/benchmarking`, not the record package.

### 7.4 Observation archive

The observation archive is a sealed artifact, not a new mutable protocol log:

```text
profile:    https://spec.jinn.network/profiles/benchmark-observation-archive/v1
media type: application/vnd.jinn.benchmarking.observation-archive.v1+json
```

It contains:

- the profile identifier;
- the Submission descriptor;
- a capture cutoff (`at` plus the backend cursor when one exists);
- streams partitioned by CloudEvents `source` and `subject`;
- the authoritative/corroborating designation for each Attempt stream;
- the validated observations accepted by the publisher; and
- descriptors of exact signed envelopes or transport captures where those existed.

The semantic shape is:

```json
{
  "profile": "https://spec.jinn.network/profiles/benchmark-observation-archive/v1",
  "submission": { "name": "submission", "digest": { "sha256": "..." } },
  "capturedThrough": { "at": "...", "cursor": "..." },
  "streams": [
    {
      "source": "https://backend.example/observations",
      "subject": "urn:jinn:attempt:...",
      "authority": "authoritative",
      "observations": [],
      "conflicts": [],
      "exactEnvelopes": []
    }
  ]
}
```

`cursor` is omitted where the backend exposes none. `authority` is `authoritative` or
`corroborating`; the named observation-archive check verifies the designation against
`attempt-engaged` where one exists.

Determinism is per stream, not a false global sequence. Streams are ordered by `source`, then
`subject`, using code-unit ordering. Within a stream, observations are deduplicated by
`(source,id)` and ordered by the fixed-width `sequence`, with `id` as a deterministic tie-break.
Sequence gaps and contradictory terminals remain visible. Two non-equivalent observations with
the same `(source,id)` are retained in a `conflicts` collection and make observation conformance
fail; they are never overwritten. The `attempt-engaged` event identifies the authoritative source
for an Attempt, while other sources remain separately corroborating.

The publisher validates each observation, constructs that deterministic projection, and seals the
archive once using JCS. This provides a public capture without pretending that a parsed backend
object preserves original wire bytes. An adapter that receives byte-addressed or signed native
observations must also retain those original bytes as native artifacts.

The current backend abstraction primarily exposes parsed observation objects. Therefore “original
wire-byte preservation for every TEP observation” is not a v1 guarantee. The profile guarantees
exact bytes of the sealed archive and any separately referenced signed/native material.

## 8. Runtime and venue interoperability

### 8.1 Two independent axes

The reusable model records:

- **venue** — where execution was commissioned, such as direct/self-run or open competition; and
- **runtime** — how the accepted work was executed, such as Harbor, Inspect, or a native launcher.

Do not add combined values such as `harbor-local` or `harbor-marketplace`. A Jinn marketplace
operator may execute a claimed Submission as a Harbor Trial. The same task package may be run
directly through Harbor without changing Benchmark identity.

### 8.2 Generic runtime evidence-contributor contract

Each runtime adapter implements a tier-3 contribution contract with three jobs:

1. **Registration contribution** — exact version/configuration/task-package material known before
   dispatch.
2. **Dispatch contribution** — native results, trajectories, logs, artifact manifests, raw metric
   maps, and correlation material produced by the execution.
3. **Verification contribution** — adapter-owned named checks over that material.

The product publication flow consumes contributions through this contract. It does not contain
`if runtime == harbor` or `if runtime == inspect` closure rules.

Adapters contribute artifact role URIs under namespaces they own. Unknown roles are preserved and
shown to verifiers; they do not override common semantics.

Inspect has no separate contribution-profile section in this document. Direct-mode job grain for
Inspect follows the same atoms as Harbor (one sample × arm → one dispatch) and the exclusive
native-log rule in [`packages/benchmark-product/INSPECT-RUNTIME.md`](../../../packages/benchmark-product/INSPECT-RUNTIME.md).

### 8.3 Harbor profile

A Harbor contribution should preserve, when produced:

- Harbor version, adapter version, and material runtime/provider configuration;
- immutable Task package and Dataset snapshot references and digests;
- effective Job and Trial configurations and results;
- raw verifier reward JSON, including the full numeric metric map, or the text fallback;
- ATIF trajectory exact bytes and declared schema version;
- `recording.cast`, CTRF output, stdout, and stderr when present;
- Harbor's artifact manifest and collected artifacts; and
- one correlation artifact containing Harbor Job and Trial identifiers.

Harbor Job is operational grouping, not canonical Jinn Run identity. In a direct run one Job may
conveniently span the Run; for an official multi-arm comparison the faithful grain is **one Job
per arm** spanning that arm's selected tasks and planned trials. Marketplace operators may create
independent Jobs for individual Trials. Harbor Trial is the closest execution boundary to a
single Jinn dispatch and normally correlates to one TEP Attempt.

In profile v1, the adapter must disable or reject Harbor settings that can execute an internal
retry beneath one Jinn dispatch. If another Trial will actually run, the Jinn benchmarking runner
must authorize it as a visible replacement dispatch with a new Submission. This is narrower than
Harbor's general Job capabilities and prevents two retry authorities.

The raw reward map is evidence. The Jinn EvaluationSpec and registered benchmarking method decide
how it contributes to a verdict or Report. Colophon must not reduce Harbor output to a private
boolean or translate ATIF to a proprietary trajectory before publication.

Harbor artifact collection is best-effort. A collection error is published as
`collection-failed`, not represented as if the artifact never existed.

A completed Harbor Job can be published without rerun only when a Jinn-aware adapter captured its
Submission, Attempt engagement, observation streams, and native correlation during execution.
Importing an arbitrary historical Job may preserve Harbor-native evidence, but it cannot claim to
be the original Jinn dispatch under this profile.

**Direct-mode job grain** (amended 2026-08-17, [DR-2026-08-17](../../../log/decisions/2026-08-17-runtime-engine-direct-mode.md)
and [DR-2026-08-17-b](../../../log/decisions/2026-08-17-official-suite-protocol.md)):

- **Allowed.** One Harbor Job per arm spanning that arm's selected tasks and planned trials
  (`n_attempts` = locked scientific replicates). Terminal-Bench 2.1 locks maintainer
  `configs/leaderboard.yaml` `retry.max_retries: 3`; TB 2.0 keeps `0`. Each Trial binds 1:1 to
  a pre-sealed Jinn dispatch; the adapter observes the trial **as it starts** into Submission /
  Attempt / Execution Evidence, including each Harbor retry start as that cell's next dispatch.
  Engine retries and Inspect epochs stay pinned off. A replacement Harbor will not retry is a
  new Submission, filled by a tiny follow-up Harbor job (`n_attempts` = 1, one task) if needed.
  Two retry authorities over the same failure are forbidden. Hub export still copies the planned
  Run+arm job only. A two-arm Colophon Run is two planned Harbor Jobs. Job identity for the
  planned grain is Run + arm, not Submission.
- **Shipped v1 (TB 2.0 one-task).** One engine invocation per cell. That grain remains valid for
  the TB 2.0 path and is an adapter constraint, not Jinn identity.
- **Scheduled (TB 2.1).** The per-arm Job grain above. Inspect stays one execution per cell.
- **Forbidden.** Two retry authorities over the same cells; synthesizing TEP after a foreign
  completed job; folding a Job or eval-set into one Execution Evidence record; wearing an official
  suite name on a custom or cousin method.

**Official suite protocol** (added 2026-08-17, [DR-2026-08-17-b](../../../log/decisions/2026-08-17-official-suite-protocol.md)):

A publisher who wants to wear a suite name must lock that suite's protocol, not a Colophon-flavored
cousin on the same tasks. Named protocols:

**Terminal-Bench 2.1** ([DR-2026-08-17-b](../../../log/decisions/2026-08-17-official-suite-protocol.md)):

- dataset `terminal-bench/terminal-bench-2-1` at the leaderboard content-hash revision;
- planned k ≥ 5 trials per selected task as visible replicates, not Harbor inner retry;
- official env (timeout_multiplier unset or 1.0; no agent/verifier timeout or resource overrides);
- ATIF trajectories required for Hub packaging.

**Inspect-as-specified** ([DR-2026-08-18](../../../log/decisions/2026-08-18-inspect-as-specified.md)):

- operator-chosen Inspect eval locked as specified; `datasetId` is the resolved task name;
- catalog grain is samples; `one_task` / `ten_task` / `full` / `custom` are lexicographic first 1 /
  first 10 / all / custom sample ids from the sealed catalog (`one_task` = one sample here);
- specified Inspect epochs map onto Jinn replicates; the worker stays `epochs: 1`;
- solver is the Task default; `--solver` and `--limit` are not execution-conforming;
- `leaderboard_submit_ready` means as-specified complete of the sealed catalog, not an Inspect Hub
  row. Colophon does not place an Inspect Hub row. A derived Inspect View log bundle is not the
  claim of record.

Comparability is two-axis and must not be collapsed into one bit. Report v2 gains no new required
fields. Bind a product-sealed `SuiteProtocolSelection` through the existing Run publication
extension's `registrationArtifacts`. Surface on the product claim package:

- `execution_conformance` — trial settings match the protocol for the selected tasks;
- `coverage` — `one_task` | `ten_task` | `full` | `custom`;
- `leaderboard_submit_ready` — for Terminal-Bench 2.1: full coverage, execution conformance, ≥5
  trials on every dataset task accounted after collect as judged or Harbor-error 0, and ATIF bytes
  on the retained Harbor job. For Inspect-as-specified: full coverage of the sealed sample catalog,
  execution conformance, Matrix replicates equal specified epochs, and every sample × k accounted
  after collect as judged or unscorable. Quote-time method bits and a job `result.json` are not
  enough.

Named slices (lexicographic first 1 / first 10 / all from the pinned snapshot) are how a publisher
runs cheaply. A protocol-faithful slice is not a leaderboard-complete run. When not
`leaderboard_submit_ready`, Report `limitations[]` carries a canonical sentence. Canonical
Inspect-as-specified limitation copy names Inspect-as-specified, not Terminal-Bench.

**Hub export** is a derived Harbor-shaped artifact of a Colophon-accounted Terminal-Bench 2.1 run,
not the claim of record. The bundle remains what a third party checks. `leaderboard_submit_ready`
may emit an uploadable job plus submit instructions. A named slice may retain or upload the job for
inspection and must not be packaged as a leaderboard submission. Custom or unverifiable runs refuse
suite-named Hub export. A foreign completed Hub job still cannot be imported as a synthesized TEP
run. Copy must not claim Colophon placed a leaderboard row while community submissions are closed.

**Inspect View export** is the analogous derived artifact for Inspect-as-specified: correlated
per-cell `.eval` logs for `inspect view` / `--bundle-dir` semantics. Ready + `full` may copy a
suite-named bundle. A named slice is inspection-only. Cousin Inspect select, custom coverage, and
non-conforming execution refuse suite-named export. This is not an Inspect Hub row.

### 8.4 Jinn marketplace composition

The first marketplace composition keeps one scheduling authority:

1. the Jinn benchmarking runner creates one cell dispatch and posts its Submission;
2. an operator claims it through the marketplace;
3. the operator may execute one Harbor Trial;
4. the operator returns Delivery and Evidence; and
5. the publisher retains marketplace request, assignment, operator, finality, and settlement
   references in venue-native evidence/correlation artifacts.

Do not initially let both a Harbor Job scheduler and the Jinn marketplace scheduler create or
retry the same cross-cell work. Batching can be designed later if it preserves the one visible
dispatch boundary.

## 9. Persistence and discovery

“Persist in the Jinn network” means the records are stored by a compliant public record source,
announced through its signed append-only source, and retrievable by exact digest. It does not mean
that all record bytes must be written directly to a blockchain.

The publishing application composes the existing capabilities as follows:

```text
local exact-byte store
        |
        v
PublicationPlan dependency DAG
        |
        +--> generic artifact store (dependencies first)
        +--> owned records: durable source writer / archive page / Source Head
        +--> third-party records: verify origin source; optionally mirror exact bytes
        +--> public site or gateway location (optional)
```

The source writer is kind-neutral. It already provides digest-path persistence, signed append-only
source updates, archive pages, Source Head recovery, idempotent announcement IDs, and crash
recovery for one record announcement.

`@jinn-network/evidence-publication` cannot directly execute this plan: its record reference type
is intentionally closed to Execution Evidence, Result Evaluation, and Execution Verification. It
must not be widened by importing upper-tier benchmarking kinds. Instead, implementation extracts a
record-kind-neutral `@jinn-network/record-publication` coordinator from the reusable publication
journal mechanics. It accepts kind-bearing record references, generic artifact descriptors,
dependency edges, and publication authority modes. Existing evidence publication becomes a typed
adapter over that neutral core and retains its public API.

The neutral coordinator stores artifacts through an injected generic artifact store, then invokes
the existing durable source writer for each publisher-authored or delegated record in dependency
order. It verifies cited source positions for third-party records and may mirror their exact bytes,
but does not reannounce them as first-hand statements. Its plan journal coordinates multi-object
recovery; the source writer remains the authority for each record/source append. This reuses the
existing source-chain implementation rather than creating another one.

### 9.1 PublicationPlan

`PublicationPlan` is transient tier-3 application data, not a network record. It contains:

- `registration`, `accounting`, and `report` stages;
- each exact record or artifact descriptor and local byte source;
- its dependency edges;
- whether it is stored, mirrored, announced as owner/delegate, or only referenced from its origin
  source;
- the source or substrate cutoff that supplies completeness and ordering authority;
- disclosure/withholding resolution; and
- a deterministic idempotency key for each publication action.

Plan validation refuses a missing dependency, a digest/byte mismatch, an invalid stage order, or a
Report whose support closure is incomplete. Execution may resume safely after a crash.

### 9.2 Source name and public URL

The profile does not reserve a source name called `benchmarks`. A source is operated by an agent
or organization and its name is part of that publisher's discovery surface. Colophon may use
`colophon-benchmarks`; another platform might use `acme-evaluations` or several purpose-specific
sources.

The public URL is a distribution location, not the source name and not record identity. Colophon
may host a human report at a stable product URL and expose machine records through that page, a
gateway, or source locations. Moving the page does not change the records.

### 9.3 Commitment, availability, and temporal ordering

Verification must not collapse three different claims:

| Claim | What proves it |
|---|---|
| Digest commitment | the exact Run bytes contain the dependency descriptor |
| Present retrievability | exact bytes can be fetched now and hash to the descriptor |
| Temporal ordering | positions are comparable within one source chain or through one common substrate anchor |

Record Discovery source positions order entries only within one `(agent, source-name)` pair. A
timestamp on an unrelated source does not make two records comparable. Likewise, an ordinary
artifact is stored and referenced but is not itself a source-chain announcement.

For a `pre-dispatch` public-registration claim, a verifier must be able to show one of:

```text
same source:   Run position < first Submission position
common anchor: Run anchor   < first dispatch anchor
```

The publisher source may then show its owned terminal sequence:

```text
Run < owned Submissions ... < BenchmarkAccounting < Matrix < signed Report v2
```

This sequence says nothing about when an operator's separate Delivery source announced its
record. BenchmarkAccounting cites that origin source through its own cutoff instead. Records and
artifacts needed by a later object must be retrievable before that object is announced, but only a
comparable source position or anchor upgrades that operational rule into independently provable
historical timing.

A self-run publisher must disclose that its dispatch source and publication source are
owner-controlled. An anchored marketplace can supply a stronger independently observable dispatch
boundary. If the Run and first dispatch have no common ordering authority, public registration is
`unverifiable`, not `pre-dispatch` merely because wall-clock timestamps look plausible.

## 10. Signed Report v2 publication identity

The agreed public identity is the digest of the signed DSSE envelope. This follows trust-core's
existing signed-record rule: for a signed record, `recordDigest` is the envelope digest, while the
JCS payload remains independently addressable.

Current benchmarking code diverges from that rule:

- `sealReport` produces and hashes the raw payload;
- Colophon stores `reportSha256` and `reportEnvelopeSha256`; and
- benchmarking discovery facts currently parse announced Report bytes as a raw payload.

The legacy behavior is already contained by repository release tag `layer-v0.1.2` and appears in
proof bundles. The existing kind therefore remains immutable. This profile introduces a new signed
record version instead of reinterpreting old bytes:

```text
legacy raw kind:  https://spec.jinn.network/records/benchmark-report/v1
signed v2 kind:   https://spec.jinn.network/records/benchmark-report/v2
legacy facts:     https://spec.jinn.network/facts/benchmark-report/v1
signed v2 facts:  https://spec.jinn.network/facts/benchmark-report/v2
payload type:     application/vnd.jinn.benchmarking.report.v1+json
record media:     application/vnd.dsse.envelope.v1+json
```

The Report payload schema does not change merely because its record wrapper changes. Profile v1
publishes signed Reports only under `benchmark-report/v2`; `benchmark-report/v1` continues to mean
the legacy raw JCS payload wherever encountered.

Implementations use unambiguous names:

| Name | Meaning |
|---|---|
| `reportPayloadSha256` | SHA-256 of the exact JCS Report payload |
| `reportRecordSha256` | SHA-256 of the exact DSSE envelope; canonical published Report record identity |

`parseReport` continues to exact-parse payload bytes. A separate `parseSignedReportRecord` parses
the DSSE envelope, requires the Report payload type, exposes the exact payload bytes, and calls
`parseReport` without re-emitting them. The v1 facts recomputer remains unchanged. The v2 facts
recomputer structurally parses the envelope and derives facts from its payload.

Structural parsing is not trust. Envelope binding, signature validity, and author/key trust remain
separate named verification steps. A v2 facts recomputer may derive record facts from a
well-formed envelope without claiming its signature is trusted.

## 11. Disclosure and verification

### 11.1 Always-public core

Choosing public benchmark publication makes the following public:

- registration records authored by the publisher and required public material;
- every publisher-authored Submission and available execution/evaluation record needed for
  accounting, plus origin-source references for third-party records;
- BenchmarkAccounting and Matrix; and
- disclosure state and digests for native artifacts referenced by the accounting record.

Native trajectories, logs, prompts, model output, or task attachments may contain secrets or
personal data. Exact public bytes require an explicit product consent/scrub gate. A withheld
artifact is represented honestly by digest and reason where a safe digest exists. It must not be
silently dropped from the closure.

A scrubbed artifact is a new byte identity. Its descriptor never reuses the original digest. It
includes derivation provenance naming the source descriptor when safe to disclose, scrub
procedure/version, responsible agent, and produced-at time. If even the original digest would
expose sensitive low-entropy material, the entry uses `source-absent` with a reason rather than
publishing that digest.

The Report is published only when its evidence is available at the assurance level the method and
product promise. A product cannot publish a confident Report over evidence it chose to withhold if
that prevents independent verification.

### 11.2 Verification layers

A verifier reports separate results for:

1. byte/digest integrity;
2. schema and profile conformance;
3. dependency closure and stage/source ordering;
4. BenchmarkAccounting completeness against the declared input scope;
5. Matrix re-derivation;
6. runtime-adapter native checks;
7. Report envelope binding and cryptographic signature;
8. author/key trust resolution; and
9. Report method recomputation and disclosure faithfulness.

No single “verified” boolean may collapse these into an ambiguous claim.

## 12. Concrete Colophon adoption

Colophon remains a tier-4 product over the common profile.

### 12.1 Colophon-specific responsibilities

- use a product-controlled source such as `colophon-benchmarks`;
- retain every local run in an exact-byte, publication-capable workspace;
- offer “public before run” and “publish completed managed run” without rerunning;
- display analysis preregistration and public-registration timing as separate assurances;
- show the three publication stages and their disclosure implications;
- collect native-artifact consent and scrub decisions;
- host the human-readable report and verification entry point;
- choose product assurance presets and refuse unsupported Reports; and
- present clear recovery state when network publication is interrupted.

Network publication stage is orthogonal to the existing draft/run/report lifecycle. Colophon tracks
`registration`, `accounting`, and `report` publication independently as
`not-started | in-progress | complete`. Registration may complete while the draft is locked,
accounting while the run closes, and the signed Report after reporting. `publish` must therefore no
longer require a `reported` draft: a closed, cancelled, partial, or unsupported run can complete
accounting publication without ever producing a Report. The static product bundle may likewise
offer an accounting-only form.

### 12.2 Reusable packages Colophon should consume

- benchmarking record sealers, including BenchmarkAccounting and signed Report v2 definitions;
- benchmarking facts profiles from the separate Discovery facts leaf;
- a generic benchmark-publication planner/orchestrator;
- the new record-kind-neutral publication coordinator and generic artifact-store port;
- the durable Record Discovery source writer;
- generic runtime evidence-contributor and verifier interfaces; and
- Harbor/Inspect adapters that own their native contribution profiles.

Colophon may continue to emit a static portable website/bundle. That bundle is a product
projection containing the same exact network records and artifacts. Its manifest and visual assets
are not new canonical identities and other Jinn benchmarking products need not copy its layout.

## 13. Current implementation gaps

The repository review found the following concrete gaps between this profile and current code:

1. **No network publish composition.** Colophon's `publish` currently materializes a local
   product bundle; it does not execute a Record Discovery publication plan.
2. **No complete dispatch index.** Matrix keeps the dispatch count and accounted dispatch, but no
   sealed record identifies every failed/replacement dispatch and evidence closure.
3. **Observation capture is insufficiently explicit.** Runner/backend seams expose observations,
   but the product does not yet seal a complete run-publication archive with defined byte rules.
4. **Submission bounds are implicit.** Benchmark launch omits `attempts`; the marketplace binding
   happens to default the omission to one. The profile requires the invariant in the Submission.
5. **Report identity is split.** Raw payload and envelope hashes exist, but discovery v1 names the
   raw payload as the Report record; signed Report v2 is not implemented.
6. **Runtime closure is product-coded.** The public bundle has closed evidence roles and
   Inspect-specific verification conditions instead of a generic adapter contribution seam.
7. **Harbor is not implemented.** The runtime registry has native and Inspect adapters, but no
   Jinn-aware Harbor adapter that captures TEP lineage during execution.
8. **Venue composition stops below the product.** Reusable benchmarking marketplace support
   exists, while Colophon's draft and runtime construction currently permit only self-run/local.
9. **The product trust projection is self-run-specific.** A marketplace path needs to project
   operator identities, anchored ordering, and venue-native references without changing common
   record semantics.
10. **Publication execution is evidence-family-specific.** Existing evidence publication cannot
    accept benchmarking or TEP records, and no neutral multi-record coordinator composes it with
    the durable source writer.
11. **Publish requires a Report.** Colophon's current lifecycle admits publication only after
    reporting, contrary to the required accounting-only path.
12. **Input scope is not sealed.** No current record freezes source/substrate cutoffs from which a
    third party can reproduce dispatch completeness.

These are implementation and application-extension tasks. They do not justify putting Colophon or
Harbor vocabulary into TEP, Evidence, Trust, or Record Discovery.

## 14. Implementation sequence

Implement in dependency order:

1. Freeze BenchmarkAccounting schema, identifiers, accounting procedure 1.0, named checks, JSON
   Schema, and fixtures in `benchmarking/records`.
2. Add its facts document/recomputer in `discovery/facts/benchmarking`; never import Discovery into
   the record package.
3. Add signed Report v2 kind/facts while retaining legacy Report v1 parsing and facts fixtures;
   migrate Colophon to `reportPayloadSha256` and `reportRecordSha256`.
4. Add explicit one-Attempt bounds, observation-archive capture, and complete dispatch lineage to
   the generic benchmarking runner; implement assembly procedure 2.0.
5. Define the runtime evidence-contributor and adapter-owned verifier seam; migrate Inspect to it.
6. Extract a record-kind-neutral publication coordinator and generic artifact-store port; adapt
   existing evidence publication to it and compose it with the durable source writer.
7. Amend Colophon's lifecycle so registration, accounting, and optional Report publication can
   progress independently; integrate the planner with its workspace and portable bundle.
8. Add Jinn-aware direct Harbor execution with hidden retries disabled, proving that a managed Job
   can be published later without rerun.
9. Run Terminal-Bench 2 through that Harbor adapter without another task runner.
10. In a later design, connect Colophon to the existing marketplace backend and allow an operator
    to use the same Harbor contribution profile.

Arbitrary completed Harbor Job import is not an early implementation slice. It remains deferred
until a retrospective-import attestation can describe native historical evidence without
synthesizing TEP history.

## 15. Conformance fixtures and gates

The profile is not complete until third-party code can pass byte-level fixtures for:

1. an analysis-preregistered, publicly pre-dispatch direct Harbor run;
2. Terminal-Bench 2 selected and run through Harbor without a second task runner;
3. a legacy Terminal-Bench task migration that pins both source and transformed material;
4. a Colophon-managed completed Harbor Job published post-hoc without rerun;
5. refusal to synthesize TEP history for an arbitrary completed Harbor Job;
6. a marketplace operator executing one accepted Submission through Harbor;
7. an unsuccessful, host-classified unscorable dispatch followed by a visible replacement and no Harbor-internal retry;
8. a cancelled/partial run publishing accounting and Matrix without a Report;
9. independent combinations of analysis `preregistered` and public-registration status;
10. legacy raw Report v1 facts plus signed-envelope Report v2 identity/facts;
11. public, digest-only, source-absent, collection-failed, and scrub-derived artifacts;
12. byte-exact ATIF and raw Harbor reward retention;
13. equal Benchmark identity across direct and marketplace venues;
14. same-source or common-anchor pre-dispatch ordering, plus incomparable ordering producing
    `unverifiable`;
15. discovery of an omitted in-scope dispatch causing accounting verification to fail;
16. an unavailable/incomplete authoritative stream producing `indeterminate` rather than pass;
17. multiple observation sources with overlapping sequences, duplicates, conflicts, and gaps; and
18. crash recovery and idempotent re-execution at each publication stage.

Cross-package tests must additionally prove:

- JCS sealing equivalence and exact-byte digest checking;
- unknown namespaced artifact roles survive round trips;
- Matrix derivation uses the accounting closure but does not copy its native identifiers;
- publisher sources never substitute for operator/third-party authorship;
- scrub derivatives have new digests and verifiable derivation provenance;
- runtime-native verification results remain separate from trust and method verification; and
- the portable Colophon bundle contains the same bytes and digests announced by the source.

## 16. Decisions and deferred work

### Fixed by this profile

- individual cell dispatches—not only a whole benchmark Job—are the execution accounting unit;
- a complete run publishes both per-dispatch lineage and terminal run records;
- direct and marketplace execution share one publication model;
- runtime and venue remain independent;
- completed Jinn-managed local runs can publish without rerun and are labelled post-hoc when
  appropriate;
- analysis preregistration and public-registration timing remain separate assurances;
- source name is publisher/product policy, while public URL is only a location;
- BenchmarkAccounting is reusable tier 2, publication planning is reusable tier 3, and Colophon
  experience/presentation is tier 4; and
- signed Report v2 uses the envelope as canonical identity while raw Report v1 remains immutable.

### Deferred

- Harbor launcher/provider implementation details;
- distributed batching and cross-cell scheduling through the marketplace;
- operator packaging, pricing, selection, settlement, and dispute UX;
- confidential/private publication profiles;
- a generic public benchmark catalog;
- arbitrary historical Harbor Job import and its retrospective-attestation semantics; and
- whether later protocol versions need signed original-wire observation envelopes.

Those decisions can change without changing the public record structure defined here.

## 17. Independent design-review dispositions

| Finding | Disposition in version 0.2 |
|---|---|
| Analysis preregistration and public-registration timing were conflated | `Report.preregistered` remains analysis-only; BenchmarkAccounting owns separate public-registration timing |
| Evidence publication cannot publish benchmark records | extract a kind-neutral publication coordinator; keep evidence publication as a typed adapter |
| Accounting completeness had no reproducible scope | seal procedure/version, authoritative streams, exact cutoffs, and dispatch-extension consistency |
| Source ordering mixed artifacts and incomparable authors | distinguish commitment, retrievability, and comparable ordering; preserve third-party source authority |
| Report envelope migration could reinterpret v1 | preserve raw Report v1 and introduce signed-envelope Report v2 with distinct media-type rules |
| Arbitrary Harbor import could synthesize TEP history | limit no-rerun publication to Jinn-managed Jobs; defer retrospective import |
| Observation sequence was treated as global | partition by source/subject, identify authority, freeze deterministic per-stream ordering and capture cutoff |

The review's non-blocking recommendations are also incorporated: publisher authorization, typed
references, disabled hidden Harbor retries, new identities for scrub derivatives, accounting-only
Colophon publication, and the explicit Matrix-lineage amendment.
