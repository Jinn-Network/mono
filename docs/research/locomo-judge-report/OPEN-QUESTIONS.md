<!-- SPDX-License-Identifier: CC-BY-NC-4.0 -->

# LoCoMo judge report: open questions and operator rulings

**Status:** Amended draft. R1-R4 are recorded; the remaining questions are fact-resolution, personnel, licence, and product gates that block freeze, not this design packet.
**External actions taken:** none; no outreach, API calls, item labeling, publication, or posting occurred in this session.

## 1. The four recorded operator rulings

The operator approved R1-R3 and subsequently approved R4 in this task on 2026-08-14. Everything below these recorded decisions is a fact-resolution gate or preflight check.

### R1 — What exactly is measured as Arm A?

The provenance review found that original LoCoMo shipped deterministic token-F1 scoring, not an LLM judge. The ~63% audit result belongs to a later EverMemOS-derived judge, and the audit did not preserve its exact provider or dated model snapshot.

**Recorded ruling:** focused reconstruction. Arm A is only the pinned EverMemOS prompt/parser under direct OpenAI `gpt-4o-mini-2024-07-18`, with three calls. Original F1 and other harnesses remain provenance context. The report keeps the non-exact service-state reproduction caveat explicit.

### R2 — Is deterministic Arm C in this report?

**Recorded ruling:** include the conservative closed-form matcher for pre-labeled names, dates, numbers, booleans, and finite sets. Report coverage and error only on eligible items. It directly tests how much of the sampled task requires an LLM grader and exercises a deterministic arm that demo report #1 does not.

### R3 — Approve the bank and human-label budget?

**Recorded ruling:** approve 72 development items, 192 probability-sampled core items, 48 separately reported stress items, two primary human evaluations per item, and a 32-person-hour bank-label cap. The original conditional-adjudication branch is superseded by R4. A disposable 12-item annotation rehearsal has a separate 2-person-hour cap. Confirmatory A+B uses 1,440 grader calls; the experimental grader-call cap remains 2,124 and the all-in cap including evidence/shadow assistance is 2,484.

### R4 — How are human disagreements resolved?

**Recorded ruling:** confirmatory truth requires matching binary verdicts from the two primary humans. Any disagreement or `indeterminate` excludes the item and triggers a same-category/class/stratum replacement before grader calls. No authoritative adjudicator can restore the item. Raw disagreement and replacement attrition publish.

## 2. Judge-provenance findings

| ID | Finding or remaining question | Established evidence | Cheapest resolution | Design effect |
|---|---|---|---|---|
| P-1 | Did original LoCoMo ship an LLM judge? | No. At `snap-research/locomo` commit `3eb6f2c…`, QA scoring in `task_eval/evaluation.py` is deterministic normalized token F1 with category-specific handling. | Retain the exact file and commit in the sealed source register; invite SNAP correction during public critique. | Headline provenance finding. Never call Arm A “the original LoCoMo judge.” |
| P-2 | Which judge produced the dial481 stress result? | Their prompt digest and provenance notice trace to the EverMemOS LLM judge at commit `1f2f083…`: system+user prompt, JSON label, `gpt-4o-mini`, temperature 0, three sequential calls. | Ask dial481 to confirm the provenance table if they participate; otherwise rely on the public commit trail and disclose no participation. | Defines the focused Arm A candidate. |
| P-3 | Is the reported 62.81% exactly reproducible? | Not from saved metadata alone. The audit preserves model alias and temperature but not the exact provider, endpoint, or dated model snapshot in result artifacts. Environment variables could change all three. | Ask dial481 for a secret-free run receipt/config or provider invoice metadata if they participate. If unavailable, use a dated snapshot and label it a reconstruction. | Blocks the word “exact reproduction,” not the experiment. |
| P-4 | What aggregation did the historical evaluator use? | EverMemOS computed each of three full-bank run accuracies, then mean/std. A related audit artifact also uses majority vote in another analysis. | Preserve historical aggregate secondarily; use registered per-item majority as the primary truth-comparison unit. | Avoids pseudo-replication and explains numerical differences. |
| P-5 | Did the judge see conversation transcripts? | The inspected EverMemOS, audit, historical Mem0, and Zep grader calls pass question, reference, and generated answer only. | Lock request fixtures and inspect serialized requests in the excluded preflight. | Public item bundle needs no transcripts. |
| P-6 | Did all published LoCoMo-derived numbers use the same judge? | No standardized grader was found. Historical/current harnesses differ in prompt, system message, call count, parser, model alias, evidence field, and aggregation. | Complete a source-by-source provenance appendix only for numbers the eventual report cites; request author confirmation where metadata is absent. | Each result must be tied to its exact instrument; heterogeneity is separately reportable. |
| P-7 | What is the full commit for the inspected historical Mem0 judge? | Resolved during packet review as `aae5989e78a6188b3b047c104d960c9ad0927e75` through the repository commit endpoint. | Retain the full commit. Retrieve the exact historical tree only if a later registered experiment measures it. | Source-register hygiene for this focused report. |
| P-8 | Can the dated model snapshot be called with the audited request shape at run time? | Official model documentation lists `gpt-4o-mini-2024-07-18` as a snapshot intended to lock behavior. Availability is still runtime-dependent. | Run a small excluded identity/plumbing preflight after budget authority, recording secret-free response metadata. | Blocks confirmatory lock if unavailable; no fallback alias without amendment. |

## 3. Licence confirmations needed

No project-specific licence memo was found in `colophon-claims/ops` or the product repository during this session. The legal code was reviewed, but this packet does not supply legal advice or clearance.

| ID | Open licence question | What was observed | Cheapest resolution | Gate/effect |
|---|---|---|---|---|
| L-1 | Is a free report on a commercial Colophon project surface a permitted NonCommercial use? | LoCoMo's root licence is CC BY-NC 4.0. The legal code turns on purpose, not price alone. | Written operator/counsel memo applying the licence to the actual host, funding, calls to action, and reuse plan. | Hard publication gate. |
| L-2 | What attribution package is required? | CC BY-NC 4.0 requires appropriate credit, licence link, source indication, and indication of changes, subject to supplied attribution information. | Build a source-by-source attribution table and have the memo approve its presentation. | Hard publication gate; include it in bundle and report. |
| L-3 | Is original LoCoMo code under the root CC BY-NC licence? | The pinned repository has a CC BY-NC 4.0 root licence and no separate code licence found. | Ask SNAP or obtain written licence interpretation; avoid redistributing original evaluator code until resolved. | Context citation can proceed; copied code may not. |
| L-4 | What is the audited judge code's licence? | The exact EverMemOS prompt/code at commit `1f2f083…` is under the repository's Apache License 2.0. The audit's third-party provenance notice identifies it as Apache-derived. | At freeze, inventory copied files, retain Apache licence/NOTICE and modification notices, and verify the historical tree's licence bytes. | Confirmed in principle; packaging compliance remains. |
| L-5 | What covers dial481's own stress candidates and error annotations? | Their repository declares CC BY-NC 4.0, but the outreach strategy requires participation before building on their material. | Obtain explicit permission, requested attribution, and scope if Variant W; otherwise follow Variant N and do not reuse those artifacts. | Selects the predeclared participation variant, not core design validity. |
| L-6 | Can CC BY-NC packet files live in this Apache-2.0 monorepo? | The product repo root is Apache-2.0; this packet carries file-level SPDX `CC-BY-NC-4.0`. | Maintainer/licence memo approves a clearly bounded derived-work directory or moves the packet to the private ops repository before merge. | Merge/package gate; the worktree draft can exist locally. |
| L-7 | Does any measured provenance arm import ShareAlike material? | The inspected Zep paper harness is CC BY-NC-SA 4.0. R1 keeps it as context only. | Do not copy it. If a later registered experiment measures it, obtain licence review and keep compatible boundaries/attribution. | No present arm dependency; provenance citation only. |
| L-8 | May corrected labels/reference repairs be distributed under the planned terms? | They are annotations derived from the LoCoMo source and are intended for CC BY-NC publication. | Include them in the same memo and attribution/modification notice. | Hard publication gate. |

The eventual memo must also decide whether the published bundle should include its own `LICENSE`, `NOTICE`, machine-readable SPDX metadata, and a source-offer pointer rather than relying on file headers.

## 4. dial481-dependency variants

The experiment does not depend on a reply. Core sampling, human labels, graders, metrics, and verifier mechanics remain the same.

### Variant W — dial481 participates

- Ask them to verify the judge provenance and run metadata if available.
- With explicit permission, let them nominate stress source IDs/patterns from their 99-error audit and V1/V2 work.
- Record exact contribution provenance, modifications, licence, and requested credit.
- Keep all truth labels independent and double-human.
- Require the non-authoring primary labeler to be independent of any contributed candidate or seed and disclose all contribution conflicts.
- Publish a contribution statement they have had a chance to correct.

### Variant N — no participation

- Do not copy or adapt their candidate answers or use the 99-error list to select bank items.
- Create the 48 stress items independently from the pinned official LoCoMo source and the frozen generic strategy taxonomy.
- Discover any reference error through this project's own human evidence review.
- Cite the public audit only as motivation and provenance evidence.
- State clearly that dial481 did not participate and their artifacts were not used in bank construction.

### Participation facts to resolve later

| ID | Question | Cheapest resolution | Effect |
|---|---|---|---|
| D-1 | Are they willing to participate after demo report #1 and under what credit? | Follow the existing outreach sequence in a separately authorized session; do not contact them from this design session. | Selects W or N. |
| D-2 | Can they provide provider/snapshot metadata for the 62.81% run? | Ask only after participation is accepted; request secret-free metadata, not credentials. | Narrows the reconstruction caveat if available. |
| D-3 | May any V1/V2 candidate or 99-error annotation be reused or transformed? | Obtain explicit item-level or category-level permission and licence/credit statement. | Determines stress sources only. |
| D-4 | Will they review the draft provenance appendix without being positioned as an endorser? | Offer factual review with a deadline and preserve corrections. | Improves provenance accuracy; no veto over results. |

## 5. Product-expression gaps

These are recorded gaps, not work authorized by this session.

| ID | Current gap at `integration/evidence-v1` commit `9062c337…` | Cheapest next resolution | Blocks |
|---|---|---|---|
| G-1 | No generic LoCoMo JSONL/task-set importer or profile in the CLI at product commit `9062c337fb92d5384fa15f043b38dde3d7427f10`. | Review the frozen `locomo-judge-item@1` schema, then implement an importer in a separate scoped product issue/session. | Official task-set import and digest. |
| G-2 | Arbitrary arm metadata can be drafted, but the local venue has no approved arbitrary LLM-grader launcher. | Specify a contained runtime contract and add/approve it through product review, then preflight only fixtures/identity. | Official Arm A/B execution. |
| G-3 | No registered deterministic adapter exactly compares grader verdict with human truth. | Implement the fixture-defined adapter separately and add it to the allowlist with verifier coverage. | Official scoring. |
| G-4 | `wilson@1` currently renders overall arm pass rate, not FAR, FRR, candidate class, stress/core, or instability projections. | Decide and document how sealed deterministic companion analyses and/or truth-stratum Reports enter verifier coverage. | Full registered report/bundle claim. |
| G-5 | Product `replicates = 3` produces three separately scorable cells per task; `wilson@1` does not collapse them to a per-item majority. | Use one Colophon task-cell replicate and seal `graderCallReplicates = 3` inside each arm result, including all three subcalls and the majority. | Correct item-level Wilson denominator and instability capture. |
| G-6 | Jinn already supports DSSE-signed Result Evaluation Evidence, `human-review` EvaluationSpecs, `minVerdicts`/`distinctEvaluator`, and unanimous reduction. It lacks an external-human review surface/adapter and a verifier for this report's roster, blinding, strict two-complete-evaluation admission, exclusion/replacement, and reveal-order rules; generic Matrix derivation marks one valid verdict `judged`. | Reuse the existing primitives; register the narrow label-admission method and fixtures; treat `label-resolution.json` as a verifier-recomputed application projection; implement the human-input and verifier path in a separate product issue/session. | A claim that distinct keys prove independent people or that Jinn admitted combined human truth before the exact policy is verifier-covered. |

No out-of-band run is labeled an Official Run. Confirmatory calls wait until the required path can lock, collect, report, and independently verify the artifact or the design is amended before outcomes.

## 6. Label-operation facts to resolve

| ID | Question | Cheapest resolution | Effect |
|---|---|---|---|
| H-1 | Who is Labeler 2? | Operator names them before development labels begin and records conflicts. | Blocks double-human truth. |
| H-2 | Can the labeling interface blind class/stratum/provenance and the shadow conclusion from both humans as registered? | Run the 12-item excluded rehearsal; verify access logs/reveal times and document any field that cannot be hidden. | Blocks the assistance protocol if the shadow conclusion leaks; other concealment failures become predeclared bias limitations or prompt an amendment. |
| H-3 | Are released BLIP captions sufficient evidence for selected image questions? | Apply the item-level eligibility rule; drop questions that need image pixels or hidden query metadata. | Deterministic replacements within frozen selection order. |
| H-4 | What PII threshold applies to question/reference/candidate snippets? | Add the actual host/release context to the licence/privacy memo and run a pre-publication scrub. | Publication gate; selected sensitive items may be replaced before lock. |
| H-5 | Where will the confirmatory draw be held until Arm B freezes? | Use a committed script that does not retrieve the post-freeze beacon pulse until the announced time; preserve logs. | Separation assurance. |
| H-6 | Which evaluator IRIs and DSSE keys identify Labelers 1-2, and what evidence supports the operator's real-person-distinctness attestation? | Freeze a signed roster with identity-binding evidence, key fingerprints, roles, conflicts, and the separate human-distinctness declaration before the rehearsal; do not rely on editable display names alone. | Blocks signed Result Evaluation issuance, strict-agreement admission, and accurately scoped Jinn validation claims. |
| H-7 | Does the 12-item rehearsal fit the 2-person-hour cap without weakening double review? | Run 4 closed-form, 4 paraphrase/partial, and 4 inference/plausible-wrong disposable items; record time, locator failures, disagreement, and reveal audit. | If not, amend counts, workflow, or budget before development; never reuse rehearsal items. |

## 7. Freeze checklist

The design remains `Draft` until all boxes below are resolved:

- [x] R1-R4 recorded as approved by the operator on 2026-08-14.
- [ ] Full source commits, file digests, copied-file licences, and notices sealed.
- [ ] `LICENCE-REVIEW-BRIEF.md` receives a signed disposition clearing private rehearsal use, local merge boundaries, and eventual free publication.
- [ ] Variant W or N declared without silent artifact reuse.
- [ ] Labeler 2 named; conflicts and real-person-distinctness attestation disclosed.
- [ ] Prepared `HUMAN-ATTESTATION-PROFILE.md`, shadow prompt, task/candidate/evidence/shadow/label-resolution schemas, evaluator roster/DSSE keys, embargo, and reveal audit are signed into the rehearsal freeze.
- [ ] Excluded 12-item rehearsal completed within its 2-person-hour cap; all protocol changes amended and re-manifested before development.
- [ ] Development bank complete; Arm B iteration ledger retained; Arm B frozen.
- [ ] Arm C rules frozen.
- [ ] Confirmatory bank drawn after Arm B freeze, independently double-evaluated, strict-agreement admitted, exclusion/replacement-accounted, and QA-complete.
- [ ] Product G-1 through G-6 resolved or design amended before any outcome.
- [ ] Dated-model identity and fixture-only plumbing preflight pass.
- [ ] Operator falsifiable predictions completed and signed.
- [ ] Exact call order, analysis code, deterministic adapter, runtime, and manifests hashed.
- [ ] Clean standalone verifier confirms the pre-run bundle.

Until then, no confirmatory call is allowed and nothing is published.
