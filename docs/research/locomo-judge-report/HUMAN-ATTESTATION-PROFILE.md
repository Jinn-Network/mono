<!-- SPDX-License-Identifier: CC-BY-NC-4.0 -->

# LoCoMo human-attestation application profile

**Profile:** `locomo-human-evaluation/1.0`<br>
**Status:** rehearsal-freeze candidate; no attestation has been issued<br>
**Base evidence format:** Jinn Result Evaluation Evidence, predicate `https://spec.jinn.network/attestations/result-evaluation/v1`<br>
**Canonicalization:** RFC 8785 JSON Canonicalization Scheme (JCS), then lowercase SHA-256<br>
**Signature container:** DSSE v1 carrying an in-toto Statement v1

## 1. What this profile establishes

Each human label is a normal signed Jinn Result Evaluation, not a new evidence family. The human evaluator decides whether one candidate answer satisfies one LoCoMo-derived grading task. Two independently issued primary evaluations become the inputs to a deterministic strict-agreement policy.

This separation is deliberate:

- the human supplies a signed, evidence-backed judgment;
- Jinn's existing Result Evaluation format binds that judgment to exact task and candidate bytes;
- the report's deterministic label-resolution policy derives one truth label only when both primary humans agree; and
- the report's deterministic grader adapter compares each grader-arm verdict with that truth label.

Conformance, artifact integrity, signature validity, identity binding, and trust remain separate checks. A valid DSSE signature proves control of a key; it does not by itself prove that the signer is the named or trusted human.

## 2. Content-addressed object graph

The records form an acyclic graph:

1. `task-core.json` contains the question, released and proposed grading references, source-question identifier, dataset provenance, and exact source-context digest. It excludes candidate class, stratum, truth, human labels, shadow conclusions, and grader outputs.
2. `candidate.json` contains the candidate answer and its immutable candidate identifier. Candidate class and stratum may live in a custodian allocation record when they must remain hidden from a labeler.
3. `shadow-label.json` binds the task-core, candidate, source-context digest, prompt/configuration, and the model's complete provisional output.
4. `evidence-packet.json` binds the task-core, candidate, shadow-label digest, and exact source-resolved passages shown to humans.
5. Each human Result Evaluation DSSE envelope names `task-core.json` as `taskSubject`, names `candidate.json` as its sole `resultSubject`, and includes `evidence-packet.json` as evidence.
6. `label-resolution.json` is a reproducible application projection binding the two primary Result Evaluation envelope digests and policy digest and recording the deterministically derived truth label. It is not an additional source-of-truth record; a verifier recomputes it from the signed evaluations.
7. The final item record binds all preceding digests.

No record contains a digest of a downstream record. This prevents a circular hash dependency.

## 3. Result Evaluation mapping

| Jinn Result Evaluation field | Required LoCoMo value |
|---|---|
| `subject[]` | Exact `task-core.json` and `candidate.json` SHA-256 subjects |
| `predicate.evaluatedAt` | Actual RFC 3339 submission time supplied by the labeling system, not the model |
| `predicate.evaluator.id` | Pre-approved absolute evaluator IRI from the labeler roster |
| `predicate.taskSubject` | Subject name for `task-core.json` |
| `predicate.resultSubjects` | One entry: the subject name for `candidate.json` |
| `predicate.verdict` | `pass` for human `accept`; `fail` for human `reject`; `inconclusive` for human `indeterminate` |
| `predicate.evaluationSpecification` | Descriptor and whole-file digest for frozen `ITEM-BANK-PLAN.md`; §§5-8 contain the human correctness and eligibility rubric |
| `predicate.evaluationMethod` | Descriptor and whole-file digest for this application profile, whose normative sections define the signing, strict-agreement, visibility, exclusion, and reveal method |
| `predicate.evidence` | Descriptor and digest for `evidence-packet.json` |
| `predicate.explanation` | Human-written rationale identifying the essential facts and why the candidate does or does not satisfy them |
| `predicate.limitations` | Any evidence ambiguity, world-knowledge dependency, caption dependency, conflict, or interface limitation |

Every Result Evaluation envelope must carry at least one valid DSSE signature. The key identifier and evaluator identity must match a roster frozen before the rehearsal. Editable display names are insufficient.

## 4. Required measurements

Each primary human evaluation contains these stable measurement names:

| Measurement | Type | Allowed value |
|---|---|---|
| `locomo.released_key_status` | string | `verified`, `incomplete`, `incorrect`, `indeterminate` |
| `locomo.closed_form_eligibility` | string | `single-entity`, `date-or-interval`, `number`, `boolean`, `finite-set`, `not-closed-form`, `indeterminate` |
| `locomo.assistance_seen` | string | `source-resolved-evidence-only` |
| `locomo.machine_conclusion_seen` | boolean | `false` |
| `locomo.peer_attestation_seen` | boolean | `false` |
| `locomo.grader_outputs_seen` | boolean | `false` |
| `locomo.candidate_class_seen` | boolean | actual interface state |
| `locomo.stratum_seen` | boolean | actual interface state |
| `locomo.conflict_declared` | boolean | actual declaration |
| `locomo.elapsed_seconds` | number | non-negative measured active labeling time |

Essential fact atoms and evidence locators are included as Jinn-compatible predicate extensions under the namespace key `locomo`, with the exact extension shape frozen in the rehearsal interface fixture. They are also rendered in the public item record for inspection.

## 5. Independence and strict-agreement policy

The deterministic policy admits an item only when:

1. both DSSE envelopes and canonical payloads validate;
2. both bind the same task-core, candidate, evidence packet, specification, and method digests;
3. evaluator IRIs and trusted signing keys are distinct, and the signed roster attests that the two identities represent different human labelers;
4. both primary records say that machine conclusions, peer attestations, and grader outputs were unseen;
5. neither signer has a disqualifying conflict in the frozen roster; and
6. both verdicts are the same binary value.

`pass/pass` derives truth `accept`. `fail/fail` derives truth `reject`. Any `inconclusive` or disagreement makes the item ineligible for the confirmatory truth bank. The item is recorded in the exclusion ledger and replaced from the same category, candidate class, and core/stress stratum before any grader-arm call. The raw pair, rationales, exclusion reason, and replacement lineage publish.

For admitted items, `primary_evaluation_sha256` contains the two Result Evaluation envelope digests in ascending UTF-16 code-unit order. Given the same two envelopes and policy bytes, every conforming verifier must produce byte-identical `label-resolution.json` bytes under the sealing rules.

The shadow label never participates in the agreement rule and cannot rescue an excluded item. No third evaluator resolves confirmatory truth. Adjudication may be studied in an explicitly exploratory rehearsal or follow-up, but it cannot restore an item to this report's locked confirmatory bank.

## 6. Identity and trust roster

Before rehearsal, the operator freezes a roster containing:

- role: candidate author, primary labeler, or bank custodian;
- evaluator IRI;
- DSSE key identifier and public-key fingerprint;
- identity-binding evidence;
- declared conflicts;
- permitted bank and role; and
- roster approval timestamp and operator signature.

The report verifies signatures and roster membership deterministically. It reports identity binding separately from signature validity and does not describe a pseudonym as a verified real-world identity unless the binding evidence supports that claim. Jinn proves control of distinct keys and can resolve distinct declared Agent IRIs; real-person independence is an operator-attested trust claim, not a cryptographic conclusion.

## 7. Visibility and reveal log

The labeling system records append-only events for:

- evidence packet made visible;
- each primary evaluation submitted;
- strict-agreement admission or disagreement/inconclusive exclusion;
- human truth frozen for admitted items; and
- shadow conclusion revealed.

The shadow reveal timestamp must be later than the final truth-freeze or exclusion timestamp. Any earlier access by a primary labeler invalidates the item under this profile.

## 8. What current Jinn supports and what remains missing

At product commit `9062c337fb92d5384fa15f043b38dde3d7427f10`, Jinn already defines and can issue DSSE-signed Result Evaluation Evidence with content-bound task, result, method, specification, evidence, measurements, explanation, limitations, evaluator identity, and timestamp. Its benchmark product also implements `minVerdicts`, `distinctEvaluator`, and unanimous `strict-agreement` reduction over multiple evaluation records.

The missing capability is narrower: the product has no external-human review surface/adapter that collects a `human-review` form and signs it with the reviewer's independently bound key, and its generic benchmark Matrix treats a cell as `judged` after one valid verdict even when the Run requested more. This report therefore requires a registered label-admission verifier that refuses fewer than two complete primary evaluations, checks roster/conflict and visibility declarations, applies strict agreement, enforces exclusion/replacement and reveal ordering, and recomputes `label-resolution.json`. Until that path is verifier-covered, the individual evaluations are native Jinn evidence but the report-specific label admission is only a hash-bound application projection.

## 9. Standing limitation

Signed human evaluation is inspectable and attributable, not infallible. Two people can share the same misunderstanding, evidence selection can omit a decisive turn, and identity trust remains policy. Publishing the evidence locators, rationale, signatures, disagreements, and standing invitation for another sealed evaluator makes the judgment contestable without pretending it is objective ground truth.
