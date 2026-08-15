# Policy Identity and Outcomes — Design

- **Date:** 2026-08-03
- **Version:** 0.1
- **Status:** draft — written in-session; pending architecture review, standards/adversarial
  review, and operator approval
- **Shape:** `design`
- **Scope:** the substrate for policy optimization: (1) execution-policy identity — one
  canonical, derivable identity for "the configuration that ran"; (2) the candidate manifest —
  a sealed, attributable identity for "the configuration someone proposes"; (3) the
  policy-outcomes projection — the policy-keyed sibling of `@jinn-network/task-curation`;
  (4) the treatment-fidelity semantics both consume.
- **Out of scope:** the campaign engine, proposers, adoption, economics, venue selection, and
  every product decision — owned by the companion product design
  ([`2026-08-03-policy-optimization-product-design.md`](./2026-08-03-policy-optimization-product-design.md));
  any new tier-1/tier-2 record kind (nothing here is a record kind); trust-policy or
  marketplace changes.
- **Layering:** everything in this document is tier 3 or below-the-product convention, under
  the [platform architecture](./2026-07-30-jinn-platform-architecture.md) §3 layering law.
  Nothing in it names a product.

## 1. Problem statement

Four defects block any credible policy-optimization work on the current stack:

1. **No policy object exists.** The stack pins execution treatments per Submission
   (`harness`, `model`, `loadout`, `isolationPolicy` — profiles
   [§5](./2026-07-27-task-profiles-and-evaluation-specs-design.md)), but nothing names the
   *combination* that ran. Outcomes cannot be pooled "by policy" because "policy" has no
   identity.
2. **The identity that does exist is forked.** The shipped learner computes
   `codeDigest = sha256(implStateDir − .git)` — on every delivery, indexed on-chain — while
   the profiles pinning vocabulary content-addresses loadouts as `loadout.sha256`. Two
   digest schemes for the same bytes — three counting the daemon-status surface, which
   hashes the same tree with no ignore list at all (`client/src/main.ts:627`) — and no join
   between them. The ratified 2026-07-23 impl-state-sharing spike (`learner-public.v1` hash
   profile, `harness.checkpoint.v2`) designed the bridge and remains unimplemented.
3. **No policy-keyed outcome signal.** `@jinn-network/task-curation` projects observed
   verdicts into per-*task* pass rates; nothing projects the same verdict stream by the
   *treatment* that produced it. Policy-value estimation from organic work is impossible.
4. **Treatment fidelity has vocabulary but no producer.** The per-axis
   `match | mismatch | unverifiable` status exists in benchmarking's ports, Matrix cells, and
   Report rollups, and the local backend both enforces pins at admission
   (`verifyRunPinning`) and captures Runtime Observations — but no implementation bridges
   them. The only `PinningObservationPort` in the tree hardcodes every axis `unverifiable`.

Without (1) and (2) any optimizer compares name tags pinned to invisible treatments. Without
(3) it is blind between benchmark runs. Without (4) its comparisons are unverifiable claims.

## 2. Position in the architecture

Two new packages, both **tier 3**, both in a new `experimental-policy` release group
(publication disabled; the `experimental-task-supply` maturity posture), both carrying the
standard guard trio plus a source-scanning purity guard where stated:

| Package | One job |
| --- | --- |
| `packages/policy/identity` (`@jinn-network/policy-identity`) | Canonicalize, digest, seal, and validate the execution-policy tuple and the candidate manifest. Pure: no clock, no network, no filesystem, no randomness. |
| `packages/policy/outcomes` (`@jinn-network/policy-outcomes`) | The policy-keyed outcomes projection: fold verdict observations into per-(tuple, bucket) rows. Pure, same discipline as `task-curation`. |

Dependency direction: both import protocol/record layers only (`task-execution-protocol`
types for requirement shapes; nothing else). Evidence-retrieval envelope shapes referenced
by the candidate manifest (`SavedEvidenceQuery` digest, `QuerySnapshotReceipt`) are
**mirrored as neutral types, never imported** — the curation `CurationObservation`
precedent, because the retrieval package's capabilities exceed what a pure package may
depend on. Neither package imports discovery, a backend, or each other's internals
(`outcomes` imports `identity` for the tuple type and digest — one direction, declared).
Nothing here is imported by tiers 1–2. Consistent with the frozen
dependency direction and the tier test
([platform architecture §5](./2026-07-30-jinn-platform-architecture.md)).

**Nothing in this design is a record kind.** Both packages emit *format tokens*
(`network.jinn.policy.*/1.0`) for host-stored or exchanged documents, never media types
claiming tier-2 status — the discipline established by `task-curation` ("a format, not a
record kind"). §5.4 states the single graduation trigger.

## 3. Standards audit

Per the composition-over-invention rule
([stack design principles §3](./2026-07-30-stack-design-principles.md)):

| Candidate | What it owns | Disposition |
| --- | --- | --- |
| **in-toto ResourceDescriptor / Statement / DSSE** | Artifact reference shape; attestation statement (subject + predicateType + predicate); signing envelope | **Adopt unchanged** — candidate manifests reference artifacts as ResourceDescriptors and sign as DSSE-wrapped in-toto Statements (§5.2), the stack's Result Evaluation Statement precedent. SLSA provenance predicates were considered (proposer ≈ builder, parents/evidence ≈ materials) and not adopted: the manifest's semantics are proposal lineage, not build provenance, and a misfitted predicate would claim SLSA semantics it doesn't honor — but the Statement *layer* is adopted so verifiers reuse one procedure |
| **RFC 8785 JCS + sha256** | Canonicalization + digest | **Adopt unchanged** — sealed-once discipline, [principles §5](./2026-07-30-stack-design-principles.md) |
| **Agent Skills (SKILL.md)** | Skill payload format, cross-harness portability (32+ tools) | **Adopt as payload** — skill-shaped loadout members are SKILL.md directories; this design never defines a skill format |
| **OCI image digests** | Content identity for whole runtime images | **Adopt as identity source** for a future harness-code loadout kind; not exercised in v0 |
| **A2A Agent Card / OASF** | Agent *capability advertisement* (what an agent offers callers) | **No overlap** — advertisement identity, not treatment identity; OASF (OCI-based, protocol-agnostic) is the watch item if a mapping is ever wanted |
| **MLflow / W&B registries, OpenLineage** | Single-organization model lineage and stage promotion | **Rejected** — access-control semantics in one trust domain; no sealed identity, no adversarial verification |
| **Treatment identity for agent configurations** | — | **None exists.** The auto-harness wave (Meta-Harness, HarnessForge, Harbor) each carries a private config format; none defines "the configuration that verifiably ran." This gap is the reason this design exists and is bespoke by demonstrated necessity. |

## 4. Execution-policy identity

### 4.1 The tuple

The execution-policy identity is a derived, canonical form of the run-pinning axes:

```json
{
  "formatToken": "network.jinn.policy.execution-tuple/1.0",
  "harness": { "id": "claude-code", "version": "2.1.34", "digest": "sha256:…" },
  "model": { "id": "anthropic/claude-haiku-4-5" },
  "loadout": { "kind": "jinn.skill.v1", "name": "…", "digest": "sha256:…" },
  "isolationPolicy": "unrestricted"
}
```

**The derivation is a total function of exactly one input triple: the sealed Task, the
sealed Submission, and the resolved task-profile document the Task pins by digest.**
*(Amended 2026-08-03 from "input pair" — C1 kit finding F1: steps 1–2 require the profile's
comparison classes and `requirementKeys`, which the Task carries only as a pin.)* The
deriver MUST verify the supplied profile document against the Task's pin before use — by
**recomputing the digest over the profile's exact sealed bytes**; a self-asserted digest
field on a projection is not verification *(clarified 2026-08-03, C1 review M1: the profile
input carries its sealed bytes)* —
handing two honest derivers different revisions of one profile URI is the quietest way to
fork the identity space. Two honest derivers holding these three documents MUST produce
identical bytes. The function, normatively:

1. Compute the **effective requirements**: the Task∪Submission merge under the profiles
   §5.1 comparison classes (`mergeRequirements` semantics — the winning value per key is
   the merge result, never either source alone).
2. Select keys by a **closed rule**: the four core axes (`harness`, `model`, `loadout`,
   `isolationPolicy`) are always present, `null` when the effective requirements do not
   constrain them; plus every key the Task's profile declares in `requirementKeys` **that
   is present** in the effective requirements. Declared-but-unset profile keys are
   **omitted, never null-filled** (only core axes are null-filled). Every other
   requirement key is excluded. Consequence, stated so it is priced in: two Submissions
   differing only on an excluded key share one `tupleDigest`; a task family that needs an
   additional axis to be treatment-distinguishing must declare it in its profile's
   `requirementKeys` (`repository-work/1.0` declares `effort`, so effort-pinned arms are
   distinguished there).
3. Copy values **byte-exactly** from the effective requirements. Enrichment is forbidden:
   a deriver MUST NOT add fields it knows from elsewhere — a venue that knows the harness
   binary digest does not add it to a value the requirements carried as `{id, version}`.
4. Constraint-shaped values (legal per profiles §5.1, e.g. `model: {provider: …}`) enter
   byte-exactly. Such a tuple identifies a declared configuration **family**, not a point;
   the row's `axes` field (§6.1) exposes the constraint shape so consumers can see which.
   Campaigns that compare treatments pin exact values on every compared axis (normative in
   the product design's arm construction).
5. Canonical bytes: I-JSON, JCS, UTF-16 string ordering — the stack's sealing discipline —
   and `tupleDigest = sha256:<hex>` over those bytes. Validation **fails closed on an
   omitted core axis key**: omission is invalid input, not a different identity.

The tuple is **derivable, never authored**, and it always names the *requested* treatment.
Evidence Runtime Observations never mint a tuple digest: observation feeds the per-axis
fidelity status (§7) that says how much the requested tuple can be believed, and nothing
else. One digest namespace; it names pinned treatments.

**Expression rule (the inverse):** to express a tuple as Submission run pinning, emit one
requirement entry per non-null **axis**, byte-exact; `null` core axes emit no entry, and
`formatToken` is a document member, never a requirement entry *(amended 2026-08-03, C1 kit
finding F4)*. The product design's arm construction cites this rule; it lives here so both
directions have one owner.

**Reserved members:** a task profile that declares a `requirementKey` colliding with a
reserved tuple member (`formatToken`) is invalid input for derivation; the deriver fails
closed *(added 2026-08-03, C1 kit finding F5)*.

**Axis naming:** the tuple uses the requirements-vocabulary key `isolationPolicy`; the
benchmarking Matrix names the same axis `isolation` in its `verification` block. One axis,
two surface names; the mapping is pinned here, and serialized rows (§6.1) use
`isolationPolicy`.

### 4.2 Healing the identity fork: the harness-state loadout kind

This design defines one new loadout **kind** (a value in the existing `loadout` pinning
vocabulary, not a new axis):

```
kind:   "jinn.harness-state.v1"
name:   operator-chosen label (same path-safety rules as jinn.skill.v1)
digest: sha256 of the state tree under the ratified learner-public.v1 hash profile
```

The digest is the tree hash under the `learner-public.v1` profile ratified by the
2026-07-23 impl-state-sharing spike (path-sorted per-file sha256 → outer sha256; excludes
`.git/`, `secrets/`, `transcripts/`, `operator-requests/`; unknown top-level paths fail
closed). The target end-state is one hashing procedure with three uses — freeze-fence
identity, on-chain `codeDigest`, and loadout pinning.

**The healing is forward-only, and it is contingent on #2118.** Today's shipped fence and
on-chain digest ignore only `.git` (and the daemon-status surface ignores nothing), while
the learner deliberately populates `transcripts/` and `operator-requests/` — so essentially
every pre-migration on-chain `codeDigest` is byte-different from the `learner-public.v1`
digest of the same tree. #2118 reroutes the fence and delivery digest surfaces through the
profile as a **recorded breaking digest migration**; from that point forward the three uses
are one scheme. Pre-migration on-chain digests are a permanently non-joining legacy
population, and nothing in this design pretends otherwise.

Consequences, stated so they are checkable:

- **#2118 is on the local-use critical path**, not just distribution: without it, a single
  operator has two digests for one tree (fence digest under `−.git`, loadout digest under
  the profile) — the §1.2 fork reproduced locally.
- **Profile-ignored roots are a materialization fail-closed rule, on every path.** Because
  the profile *ignores* `.git/`, `secrets/`, `transcripts/`, `operator-requests/` at
  hashing, a package carrying arbitrary bytes under those roots would still digest-verify —
  including executable `.git/hooks/*` that fire when the learner's own git machinery runs
  in the materialized workspace. Therefore a `jinn.harness-state.v1` package containing
  **any** profile-ignored root is rejected at materialization — by the Workspace
  Provisioner path, not only by `jinn checkpoint install` (the spike's installer already
  rejects these roots; this rule extends that to every materialization path).
- Materialization and digest verification ride the existing Workspace Provisioner path
  (local backend [§7.2/§8.1](./2026-07-27-local-execution-backend-design.md)) once launchers
  declare the kind in their loadout inventory — implementation work, recorded in the product
  design's companion items.
- Distribution of harness-state loadouts between operators is owned by the spike's
  `harness.checkpoint.v2` train (#2117–#2120), which this design **composes and depends on**
  for any cross-operator flow; it redesigns nothing there. Frozen-only publication (the
  spike's rule) constrains how such loadouts enter any population.

### 4.3 Identity-strength tiers

Identity is only as good as its verification. Every axis, in every context, has exactly one
of three strengths — an extension of the profiles enforcement postures
(`enforced`/`attested`) with `vacuous` added. (The per-axis *verification* tri-state of §7
is a different vocabulary, and that one is the Matrix's.)

| Strength | Meaning | Where it holds today |
| --- | --- | --- |
| **enforced** | The venue rejects or fails the attempt unless the pinned value verifiably ran (digest-verified materialization, admission probe) | local backend: `harness`, `model`, `loadout` via `verifyRunPinning` + provisioner digest checks |
| **attested** | The executor claims the value; evidence may support it but nothing enforces it | marketplace: all four axes (`ATTESTED_RUN_PINNING_KEYS`) |
| **vacuous** | The axis admits only one value, so agreement asserts nothing | `isolationPolicy` everywhere (all launchers: `unrestricted` only) |

**The weakest-axis rule:** any claim keyed on a tuple digest is at most as strong as the
weakest strength among the axes the claim depends on. Consumers of §6 rows and of
benchmarking Reports apply it; producers disclose per-axis status so they can.

## 5. The candidate manifest

### 5.1 What it is

A candidate is a *proposal* — "this tuple may be better" — and needs what no observation can
supply: lineage, provenance, and a declared derivation. The candidate manifest is a sealed
document (JCS-once, sha256-of-exact-bytes) with format token
`network.jinn.policy.candidate/1.0`:

| Field | Content |
| --- | --- |
| `formatToken` | `network.jinn.policy.candidate/1.0` |
| `policy` | the full execution-policy tuple the candidate proposes (§4.1 shape) |
| `parents[]` | **typed** references this candidate derives from: `{ kind: "candidate" \| "tuple", digest }` — a candidate-manifest digest or a bare execution-tuple digest, discriminated so consumers know how to dereference each; empty for seeds; multiple parents allowed (crossover/composition) |
| `proposer` | Agent IRI of the party that produced it |
| `evidenceProvenance` | the frozen evidence input the proposer consumed: saved-query digest + `QuerySnapshotReceipt` (evidence-retrieval's existing envelopes) + a digest over the exact ordered record-reference list actually supplied |
| `declaredChanges` | `{ summary, touchedComponents[] }` — the proposer's claim of what changed relative to `parents` |
| `compatibility` | `{ taskProfiles[]?, harnesses[]?, models[]? }` — declared, not verified |
| namespaced extensions | unknown-field-tolerant, never overriding core fields |

**The manifest carries no score and no self-assessment.** Whether the candidate is better is
established exclusively by subsequent evaluation records; a proposer cannot grade its own
homework. (The corrected model this substrate serves is stated in the product design §4.)

**Cross-operator disclosure is digests-only, normatively:** `evidenceProvenance` carries the
saved-query digest, the `QuerySnapshotReceipt` (source set, per-source checkpoints,
`evaluatedAt`, reproducibility flag — references and instants, no content), and a digest
over the ordered record-reference list. No query text and no record content ever crosses
the operator boundary inside a manifest.

### 5.2 Identity and signing

- Candidate identity = sha256 of the sealed manifest bytes.
- A manifest **MAY** be DSSE-signed by its proposer. Unsigned manifests are valid for
  single-operator local use only; **cross-operator exchange and any adoption decision
  require the DSSE signature** — provenance is load-bearing for adoption security (a
  candidate's payload can contain hooks, i.e. code; see the product design §7.4). Signature
  verification resolves the proposer IRI through the trust layer's existing binding
  verification; no new trust scope is registered by this design (registration, if exchange
  ships, is a one-line trust-layer addition declared at that time).
- **The DSSE payload shape is pinned:** an in-toto Statement whose subject is the sealed
  manifest (digest + name), with `predicateType` = the format token and the manifest as
  predicate — matching the stack's DSSE Result Evaluation Statement precedent, so verifiers
  reuse one procedure. Raw-bytes signing is not a conforming alternative.

### 5.3 Validation

`@jinn-network/policy-identity` ships `validateCandidateManifest`: shape, digest forms,
typed parent references, tuple canonicalization round-trip, extension preservation, and
rejection of any **unrecognized non-namespaced top-level field** (the checkable form of the
no-self-score rule; extension-borne self-assessment cannot be prevented by validation and
is a consumer-MUST-ignore rule instead). It does **not** fetch parents, verify signatures
(host concern via trust layer), or materialize policies (backend concern). Fail-closed on
malformed input.

### 5.4 Graduation trigger

The manifest becomes a tier-2 record kind (published schema, conformance kit, media type,
named verification procedure) **before cross-operator exchange ships** — exchange is the
event, not a second product: a sealed, signed, security-load-bearing document exchanged
between strangers is exactly what the tier-2 inclusion test exists for, and the curation
precedent (a product-internal, throw-away projection) does not cover it. Until exchange
ships it is a product-convention document with a format token. Recording the trigger here
is what keeps the deferral honest.

## 6. The policy-outcomes projection

### 6.1 Shape

The sibling of `task-curation`, transposed: group the observed verdict stream by the
treatment that produced it.

Input observation (neutral type, mirrors `CurationObservation` field-for-field plus the
policy join):

```
PolicyOutcomeObservation = {
  tuple:            ExecutionPolicyTuple      // requested tuple, always present
  perAxisStatus:    { harness, model, loadout, isolationPolicy:
                      "match" | "mismatch" | "unverifiable" }
  taskDigest:       sha256
  verdict:          "pass" | "fail" | "inconclusive"
  observedAt:       instant (announcement/block time, never adapter wall-clock)
  attribution:      evaluator identity (required)
  benchmarkRun?:    run reference (absent ⇒ organic)
  ref:              CurationInputRef-shaped provenance (dedupe tuple identical to curation's)
}
```

Row, keyed `(tupleDigest, bucket)` with `bucket ∈ {"benchmark", "organic"}`:

```
PolicyOutcomesRow = {
  tupleDigest, axes,                    // the tuple's values, denormalized for filtering
  bucket,
  attempts, verdicts,
  passRate: { num, den },               // integers; inconclusive excluded from den
  pinning: per-axis { match, mismatch, unverifiable } counts,
  window: { first, last },
  inputRefs: [ … complete … ]
}
```

### 6.2 Semantics, inherited verbatim from curation

- **Grouping is by the requested tuple; fidelity is disclosed, not assumed.** The
  `pinning` counters carry what verification established per axis, mirroring Report
  disclosures. A consumer may exclude rows or observations whose load-bearing axes are not
  `match` — that is the consumer's cohort filter, same as curation's sybil posture.
- Pure package: no clock, no network, no filesystem, no randomness; a source-scanning
  purity guard enforces it.
- `foldPolicyOutcomes(previous, observations)` is idempotent under at-least-once
  redelivery on the same dedupe tuple; an exact redelivery is a no-op; a conflicting
  redelivery is refused (fail-closed), never last-write-wins.
- Integer ratios only; no floats anywhere on the output.
- Serialization emits format token `network.jinn.policy.outcomes-projection/1.0` — derived
  state, re-derivable from `inputRefs`; throw it away at will.
- **No thresholds in-package.** "Enough samples," "good enough fidelity," and any
  policy-value verdict are consumer decisions with caller-supplied parameters, exactly as
  curation refuses a default saturation threshold. A row is a statement about a population
  of observed verdicts, not about the policy.
- **Late fidelity evidence is a re-derivation, never a fold.** A post-hoc digest
  disagreement on an already-folded observation is a conflicting redelivery and is
  correctly refused; the consistent path is to re-derive the (throwaway) projection from
  the inputs. Stated so no implementer invents an in-place fidelity mutation.
- Manipulation cannot be prevented at this layer; it is made visible in the inputs. The
  conformance kit carries a manipulation fixture (cohort-filtered re-derivation) mirroring
  curation's, **plus a re-announcement fixture**: the same underlying verdict record
  announced through a second discovery source must not inflate a row — the adapter
  contract (§6.3) dedupes on the underlying verdict record digest, not only on the
  announcement dedupe tuple, precisely because re-announcing favorable verdicts is cheaper
  than Sybil verdicts.

### 6.3 The adapter is a tier-4 obligation

As with curation, the production adapter — which needs fetch capability and the seven
documented joins (subject task, verdict, evaluator, time, attempt, provenance,
judged-solution benchmark) *plus* tuple derivation from the (Task, Submission) pair (§4.1)
and per-axis status from whatever fidelity evidence exists — lives **outside** this
package, in the consuming tier-4 product. The adapter contract additionally requires
**deduplication by underlying verdict record digest** across discovery sources (§6.2), or a
pinned single-source input scope declared in its output. A second consumer is required before that join may be extracted
into discovery facts. This repeats curation's deferral deliberately: the Phase C capability
boundaries spec (§2.5) already assigns curation's first adapter to a tier-4 consumer; this
projection takes the identical posture.

## 7. Treatment-fidelity semantics

**Ownership, stated precisely:** the benchmarking design owns the Matrix `verification`
derivation and its `pinning-observation` check ([§8.1/§12.1](./2026-07-28-benchmarking-application-design.md));
where this section and that design differ, that design wins. What is normative *here* is
the producer contract for `PolicyOutcomeObservation.perAxisStatus` (§6.1) — and it adopts
the owning design's rule so the two surfaces never diverge:

- **`match`** — the pinned value is corroborated: on an `enforced` axis, the venue's
  admission gate accepted the pin and the digest-verified materialization (or admission
  probe) succeeded, corroborated by a Runtime Observation where one exists; on an
  `attested` axis, **only** via a verifiable Runtime Observation corroborating the pin
  (benchmarking's rule — attested venues *can* reach `match` that way; no such attestation
  leg exists today, so attested axes are `unverifiable` in practice until those legs land).
  For a constraint-shaped pinned value, corroboration means the observed value *satisfies*
  the constraint — and the row's `axes` field already discloses that the identity is a
  family (§4.1).
- **`mismatch`** — affirmative evidence that a different value ran (observation disagrees
  with pin, or post-hoc digest disagreement). Mismatch is a fact about the cell/observation,
  not a judgment; consumers decide exclusion.
- **`unverifiable`** — neither of the above is establishable. The honest default, and the
  hardcoded posture of the only existing port implementation. Nothing in this design ever
  silently upgrades `unverifiable`.

The existing benchmarking `PinningObservationPort` interface is the production seam; this
design adds no rival interface. The local-venue bridge (admission results + Runtime
Observations → per-axis status) is the single highest-leverage missing producer and is
scheduled, not designed, here.

## 8. Conformance kit

Kits precede implementations ([principles §9](./2026-07-30-stack-design-principles.md)).
Golden and adversarial fixtures, authored before package code:

- **Tuple canonicalization:** valid tuples (all-axes, null-axes, extension-key) with exact
  expected canonical bytes and digests; adversarial: key-order variance (must not change
  digest), omitted-core-axis input (**rejected**, fail-closed — plus a non-collision
  demonstration that null and absent are distinct byte sequences), extension-key stripping
  (must change digest — byte identity is identity), constraint-shaped axis value (enters
  byte-exactly).
- **Derivation equivalence:** a sealed (Task, Submission) fixture pair from which **two
  independent implementations** must derive byte-identical tuples — the fixture that backs
  the "derived, never authored" premise; includes a declared-but-unset profile
  `requirementKey` (must be omitted, not null-filled) and a non-declared Submission key
  (must be excluded); an enrichment case (venue-known harness digest MUST NOT appear).
- **Fork-healing:** one fixture tree hashed under `learner-public.v1` yielding equal
  digests across the three post-#2118 surfaces; a fail-closed unknown-top-level path case;
  a **smuggled-ignored-root package** (bytes under `.git/hooks/`) that digest-verifies but
  MUST be rejected at materialization (§4.2).
- **Candidate manifest:** valid minimal, multi-parent (both reference kinds), extension-
  bearing; invalid per constraint (unrecognized non-namespaced top-level field, malformed
  typed parent reference, missing provenance); sealed-bytes round-trip (no
  re-canonicalization); a **DSSE in-toto Statement verification fixture** (valid signature,
  wrong-subject, wrong-predicateType).
- **Projection:** miniature fold (two tuples × two buckets), idempotent-redelivery no-op,
  conflicting-redelivery refusal, per-axis counter arithmetic, the manipulation fixture
  (unfiltered vs cohort-filtered derivation from identical announcements), and the
  re-announcement fixture (§6.2).

## 9. Non-goals

- No new tier-1 or tier-2 record kind, media type, or protocol amendment. No change to the
  profiles pinning vocabulary beyond one new loadout *kind* value.
- No policy registry, no canonical policy list, no leaderboard.
- No trust, reputation, or admission semantics — attribution rides existing trust bindings.
- No adapter implementations, no backend or launcher changes (companion items, product-side).
- No policy *content* semantics: this design never inspects what a loadout does, only what
  it is.
- No campaign, proposer, adoption, or economic machinery (product design).
- No reconciliation of the isolation axis's vacuity — recorded, not solved.

## 10. Impact and dependencies

- **Composes, unchanged:** profiles §5 pinning vocabulary; local backend provisioner and
  admission gate; evidence Runtime Observation; evidence-retrieval saved queries and
  snapshot receipts; the trust layer's binding verification; `task-curation`'s projection
  discipline (as pattern precedent).
- **Composes, and depends on:** the ratified 2026-07-23 impl-state-sharing spike. **#2118
  (profile-parity digest migration) is on the local-use critical path** (§4.2); the rest of
  the #2117–#2120 train blocks cross-operator distribution only.
- **Heals:** the codeDigest ↔ loadout digest fork — forward-only from #2118 (§4.2);
  pre-migration on-chain digests remain a non-joining legacy population.
- **Supersedes:** nothing. This is substrate; supersessions are declared by the product
  design.
- **Catalog:** two new tier-3 entries in a new `experimental-policy` release group,
  publication disabled, guard trio + purity guard, authority pointing at this document —
  **and** an amendment to the product's release group's allowed dependency groups to
  include `experimental-policy`, without which product→substrate imports fail the catalog
  gate.

## 11. Provenance

Designed 2026-08-03 in a single operator session (operator: Ritsu) run under the
[stack design principles §12](./2026-07-30-stack-design-principles.md) method: two read-only
research lanes (prior art + learner behavior; available stack seams on the PR #2363 head),
findings reconciled by the coordinating agent; material questions resolved one at a time
with operator approval (deliverable split, naming, the two-identity decision, full-tuple
grouping, factory boundary, v0 venue/mutation surface); external standards research
(SKILL.md adoption, GEPA/DSPy, Inspect, Harbor, Environments Hub, RFT, A2A/OASF) performed
live in-session. An earlier external conversation's optimizer framing entered as a
hypothesis and was corrected twice before this design (single-lineage → population;
proposal-task-centric → execution-centric) — the tested-then-adopted pattern of the
four-contract framing precedent. Written form reviewed by an architecture review and a
standards/adversarial review before presentation; dispositions in Appendix A.

## Appendix A — Review disposition (2026-08-03)

Two independent reviews ran on the written form; all findings touching this document were
resolved in-text before presentation:

- **Blockers.** The tuple derivation was underspecified (both reviews' top finding —
  divergent honest derivers via merge ambiguity, unset profile keys, venue enrichment,
  constraint values): §4.1 rewritten as a normative total function of the (Task,
  Submission) pair with a closed key rule, enrichment ban, constraint rule, fail-closed
  omission, expression rule, and a two-implementation derivation-equivalence fixture (§8).
  The fork-healing claim was retroactively false against the shipped tree (fence ignores
  only `.git`; a third no-ignore-list digest surface exists): §1.2 counts three surfaces;
  §4.2 restated as forward-only and contingent on #2118, which §10 moves onto the
  local-use critical path.
- **Majors.** Ignored-root smuggling (executable `.git/hooks` in a digest-verified
  package): fail-closed materialization rule on every path + kit fixture (§4.2, §8).
  Candidate-manifest graduation re-keyed to cross-operator exchange, not a second product
  (§5.4). Untyped parent references typed (§5.1). Fidelity tri-state ownership scoped to
  the observation producer contract with benchmarking §8.1/§12.1 as owner, adopting its
  attested-axis rule (§7); the §4.3 vocabulary cross-reference corrected. Organic-row
  inflation by re-announcement: adapter dedupe on underlying verdict record digest + kit
  fixture (§6.2/§6.3). DSSE payload pinned to in-toto Statement (§5.2, §3).
- **Minors.** Omitted-axis input rejected fail-closed (§4.1/§8); axis naming
  (`isolationPolicy` ↔ Matrix `isolation`) pinned (§4.1); catalog allowed-deps amendment
  named (§10); evidence-shape mirror-not-import rule stated (§2); the no-self-score check
  made precise (§5.3); late fidelity evidence = re-derive, never fold (§6.2);
  cross-operator provenance disclosure pinned to digests-only (§5.1); four fixtures added
  to the kit (§8).
