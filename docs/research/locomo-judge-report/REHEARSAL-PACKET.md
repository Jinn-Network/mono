<!-- SPDX-License-Identifier: CC-BY-NC-4.0 -->

# Excluded 12-item annotation rehearsal

**Status:** ready to instantiate; not run<br>
**Purpose:** test human-attestation feasibility, blinding, timing, and evidence handling before development<br>
**Exclusion:** every rehearsal source question and candidate is permanently barred from the 72-item development and 240-item confirmatory banks<br>
**Human budget:** 2 person-hours total<br>
**Model budget:** 12 evidence/shadow-assistance calls; zero Arm A, B, or C grader calls

## 1. Hard prerequisites

No source question is opened and no assistance call is made until all are complete:

- [ ] licence review permits the private rehearsal use;
- [ ] Labeler 1 and Labeler 2 are named;
- [ ] evaluator IRIs, DSSE key fingerprints, identity bindings, conflicts, and roles are frozen in the labeler roster;
- [ ] operator predictions P10-P11 are completed, timestamped, and signed;
- [ ] `HUMAN-ATTESTATION-PROFILE.md`, `SHADOW-LABEL-PROMPT.md`, and the task-core, candidate, evidence, shadow, and label-resolution schemas are hash-bound in the current manifest;
- [ ] a fixture-only walkthrough proves the shadow conclusion and peer label cannot appear in either primary labeler's view; and
- [ ] a custodian who is not a primary labeler controls shadow-record access and reveal timestamps.

The operator may be Labeler 1. Neither Codex nor the shadow model counts as a human labeler.

## 2. Predictions to complete before selection

| Prediction | Operator value |
|---|---|
| Human primary-pair agreement across 12 items | `[P10 REQUIRED]` |
| Expected number excluded for disagreement or `inconclusive` | `[P10 REQUIRED]` |
| Expected median active seconds per primary attestation | `[P10 REQUIRED]` |
| Expected total person-minutes, including replacement authoring and relabeling | `[P10 REQUIRED; MUST BE ≤120]` |
| Shadow-assistant agreement with final human truth | `[P11 REQUIRED]` |
| Expected shadow evidence-locator failure count | `[P11 REQUIRED]` |

## 3. Locked rehearsal matrix

The matrix deliberately balances six human-accept and six human-reject candidates while covering all four LoCoMo categories. Slot assignment is frozen before source selection.

| Slot | Diagnostic group | LoCoMo category | Answer form | Candidate class | Required construction truth |
|---:|---|---:|---|---|---|
| RH-01 | closed-form | 1 multi-hop | finite unordered set | verbatim-correct | accept |
| RH-02 | closed-form | 2 temporal | canonical date/interval | paraphrase-correct | accept |
| RH-03 | closed-form | 4 single-hop | single entity | flat-wrong | reject |
| RH-04 | closed-form | 4 single-hop | integer/decimal | plausible-but-wrong | reject |
| RH-05 | paraphrase/partial boundary | 1 multi-hop | semantic | paraphrase-correct | accept |
| RH-06 | paraphrase/partial boundary | 2 temporal | temporal explanation | partial | reject |
| RH-07 | paraphrase/partial boundary | 3 open-domain | semantic | paraphrase-correct | accept |
| RH-08 | paraphrase/partial boundary | 4 single-hop | semantic | partial | reject |
| RH-09 | inference/plausible-wrong | 1 multi-hop | semantic | plausible-but-wrong | reject |
| RH-10 | inference/plausible-wrong | 2 temporal | temporal inference | paraphrase-correct | accept |
| RH-11 | inference/plausible-wrong | 3 open-domain | ordinary inference | paraphrase-correct | accept |
| RH-12 | inference/plausible-wrong | 3 open-domain | ordinary inference | plausible-but-wrong | reject |

## 4. Deterministic source selection

After the prerequisites are signed:

1. Build the pinned Category 1-4 source-frame records without copying full conversations into the rehearsal ledger.
2. Derive `rehearsal_seed = SHA-256(UTF8(dataset_sha256 + "\nlocomo-judge-report/rehearsal/v1"))` using the lowercase dataset digest from `DESIGN.md`.
3. For each category, sort eligible source-question IDs by `SHA-256(UTF8(rehearsal_seed + "\n" + slot_id + "\n" + source_question_id))`, ascending lowercase hex.
4. Starting at the top, take the first source that satisfies the slot's answer-form and candidate-class feasibility rules.
5. Record every inspected rejection with one frozen reason code. Do not skip an eligible source because it is easy, difficult, or expected to agree with a grader.
6. A source question selected or inspected for this rehearsal is marked `rehearsal-exposed` and excluded from both later banks.

Eligibility decisions occur without any grader output or shadow conclusion. Candidate authoring follows `ITEM-BANK-PLAN.md` exactly.

## 5. Per-item workflow

1. The custodian materializes canonical `task-core.json` and `candidate.json` and records their SHA-256 digests.
2. The candidate author writes the assigned class without seeing any grader output.
3. The custodian renders `SHADOW-LABEL-PROMPT.md`, makes one assistance call, validates the response schema, and seals the complete shadow record.
4. Software extracts only candidate evidence locators, resolves exact source passages, and constructs `evidence-packet.json`. On assistant failure it supplies the complete predeclared context and records the failure.
5. Labeler 1 and Labeler 2 independently inspect the task, candidate, evidence packet, and pinned source. They issue separate DSSE-signed Jinn Result Evaluations.
6. The deterministic policy validates both envelopes, subjects, method/spec/evidence digests, identities, visibility measurements, and verdicts.
7. Matching binary verdicts admit the item. A mismatch or `inconclusive` excludes it and opens the next same-cell replacement without any third evaluator.
8. The policy deterministically recomputes `label-resolution.json` for an admitted item or records the exclusion and replacement lineage.
9. After truth freeze, the custodian reveals the shadow record and records the reveal event.
10. The ledger records active human time, elapsed wall time, locator failures, visibility incidents, disagreement, exclusion/replacement, and any schema/signature failure.

## 6. Mandatory integrity criteria

The rehearsal cannot pass unless:

- all 12 task/candidate/evidence/shadow records have matching canonical-byte digests;
- all 24 primary human evaluations are valid DSSE-signed Jinn Result Evaluations from distinct approved identities;
- no primary human sees a peer verdict, shadow conclusion, or grader output before submission;
- every shadow reveal occurs after the corresponding truth freeze;
- every agreement, disagreement, exclusion, and replacement follows the frozen policy; and
- total human time does not exceed 120 person-minutes.

Any integrity failure stops the rehearsal immediately. A protocol correction requires amendment and a fresh rehearsal with 12 new disposable questions.

## 7. Feasibility review

Passing integrity does not automatically establish budget feasibility. After all 12 items, publish the following rehearsal-only process table:

- primary-pair agreement count;
- disagreement/inconclusive exclusion and replacement counts;
- median and interquartile active seconds per primary attestation;
- candidate-authoring, evidence-review, primary-label, and replacement person-minutes;
- assistant locator success/failure counts;
- shadow-versus-final-human agreement after reveal;
- schema, signature, identity, and visibility failures; and
- projected person-hours for 312 bank items under the observed workflow.

If the projection exceeds 32 person-hours, the second human label is never removed to save time. Amend item counts, workflow, or budget before development.

## 8. Rehearsal disposition

| Field | Value |
|---|---|
| Started at | `[NOT RUN]` |
| Completed at | `[NOT RUN]` |
| Final status | `[NOT RUN / PASS / FAIL / AMEND]` |
| Total person-minutes | `[NOT RUN]` |
| Protocol amendment required | `[NOT RUN]` |
| Operator signature | `[REQUIRED AFTER REVIEW]` |

No rehearsal result enters the confirmatory metrics. The sole decision is whether the labeling and attestation process is ready for the development bank.
