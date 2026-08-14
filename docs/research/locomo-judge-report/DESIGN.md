<!-- SPDX-License-Identifier: CC-BY-NC-4.0 -->

# Pre-registered experiment design: `locomo-judge-report`

**Working title:** The judge report<br>
**Design status:** Amended draft after operator rulings; research-side attestation/rehearsal artifacts prepared, awaiting licence clearance, the signed labeler roster and predictions, the excluded annotation rehearsal, product-gap resolution, and external critique. Not frozen; no development or confirmatory judge calls have run.<br>
**Product base:** `Jinn-Network/mono` commit `9062c337fb92d5384fa15f043b38dde3d7427f10` on `integration/evidence-v1` at packet creation.<br>
**Source dataset:** `snap-research/locomo` commit `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`; `locomo10.json` SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.<br>
**Audited judge source:** `EverMind-AI/EverMemOS` commit `1f2f083d9fd07fd6580064bbdfc7b97da39c47bb`, as reconstructed and tested by `dial481/locomo-audit` commit `9493fb4b4af4256ed17a18e8fd0b3cfdeec29539`.<br>
**Public actor:** GitHub account `ritsukai`; this design session posts nothing.<br>
**Publication posture:** free contribution artifact, not a revenue artifact; publication is blocked on the licence gate in §18.<br>
**Approved confirmatory bank:** 240 items: 192 probability-sampled core items plus 48 separately reported stress items.<br>
**Approved development bank:** 72 source-question-disjoint items.<br>
**Grader-call replicates:** `k = 3` independent calls per LLM grader and item, declared inside the sealed arm contract; proposed Colophon task-cell replicates `= 1` for the item-level Wilson denominator (§11, §17).<br>
**Operator rulings recorded:** R1-R4 in §23 and `OPEN-QUESTIONS.md`, approved 2026-08-14; R4 supersedes R3's conditional-adjudication branch.

## 1. Purpose

This report tests the scoring instrument used in a family of LoCoMo-derived agent-memory evaluations. It does not evaluate or rank memory vendors.

The motivating audit reported that a later LoCoMo LLM judge accepted 62.81% of intentionally wrong, vague-but-topical answers and 10.61% of intentionally wrong, specific answers. This design turns that hand-run stress result into a locked comparison of grader behavior against independently human-labeled answers. It measures both false acceptance and the strictness cost of false rejection, and it quantifies what changes when the rubric changes.

The report is the founding artifact of the memory-cluster wedge. It enters the discussion by testing the ruler. Its public value is a reusable item bank, sealed grader definitions, human truth labels, a deterministic verdict comparator, and an independently verifiable bundle.

## 2. Provenance finding that controls the design

There is no single canonical “LoCoMo LLM judge.”

At the pinned original LoCoMo release, answer generation used language models but QA scoring in `task_eval/evaluation.py` was deterministic normalized token F1, with category-specific handling for multi-hop and adversarial questions. The original repository does not ship an LLM-as-judge grader.

Later evaluation harnesses introduced materially different LLM judges:

| Provenance point | Observable grading method | Prompt/model topology | Transcript visible to grader? |
|---|---|---|---:|
| Original LoCoMo, commit `3eb6f2c…` | Deterministic token F1 | No grader model | No |
| EverMemOS, commit `1f2f083…` | LLM binary label; three calls; per-run mean/std in published evaluator | System + user prompt; default `gpt-4o-mini`; temperature 0 | No |
| Historical Mem0 harness, commit `aae5989e78a6188b3b047c104d960c9ad0927e75` | LLM binary label; one call | Related generous prompt; `gpt-4o-mini`; JSON response | No |
| Zep paper harness, commit `4b7f26c…` | LLM binary label; one call | Related generous prompt; `gpt-4o-mini`; structured parse | No |
| Current `mem0ai/memory-benchmarks`, commit `4b61c5d…` | LLM binary label under a revised rubric | Different detailed prompt; default `gpt-5`; evidence optional | No by default |

The 62.81% result is specifically tied to the EverMemOS-derived prompt and parsing behavior reconstructed in `dial481/locomo-audit`; it is not a property of the original LoCoMo evaluator. The audit records the alias `gpt-4o-mini`, temperature 0, and three calls, but its saved outputs do not seal the API provider, endpoint, or dated model snapshot. Therefore the proposed Arm A is a pinned reconstruction of the audited judge, not a claim to reproduce the exact hidden service state that produced 62.81%.

If provenance review later establishes that published numbers used additional judge variants, the report will show a provenance table and assign each result only to its exact prompt, parser, provider, model snapshot, aggregation rule, and commit. Results from non-identical graders will not be pooled. Variation itself is reportable instrument heterogeneity, not a reason to pick an implicit canonical implementation.

## 3. Claim and decision question

### Claim being stood up

For this pre-registered LoCoMo-derived item bank, grader verdicts can be evaluated directly against double-human truth labels. The report will estimate:

1. how often each grader accepts known-wrong answers;
2. how often each grader rejects known-correct answers;
3. how often repeated calls on the same input disagree;
4. how those rates change under a stricter, pre-frozen rubric; and
5. for a pre-declared closed-form subset, how often any LLM grader is necessary at all; and
6. whether a deterministic verifier can enforce the registered two-human strict-agreement, visibility, exclusion, and tamper rules before accepting truth as an evaluation input.

### Decision question

Does the audited judge reconstruction exhibit a practically material false-accept pattern on the probability-sampled core bank, and what false-reject and stability tradeoffs appear when only the grading rubric is changed?

The confirmatory result is about these pinned graders, inputs, truth labels, and service snapshot. It is not a causal estimate of how any memory system performs, a re-ranking of published systems, or a universal estimate for every LoCoMo implementation.

## 4. Frozen-input boundary

The confirmatory lock must contain exact bytes or content digests for:

- source repository commits and dataset file;
- inclusion/exclusion ledger and sampling script;
- development-bank IDs and confirmatory-bank IDs;
- question, released reference, human-verified `reference_for_grading`, candidate answer, category, candidate class, core/stress stratum, and truth label for every item;
- the machine evidence-assistance record, source-resolved evidence packet, and embargoed shadow-label record for every item, including their prompt/model/configuration and digests;
- canonical `task-core.json` and `candidate.json` subjects, two independently issued DSSE-signed Jinn Result Evaluation envelopes, the verifier-recomputable `label-resolution.json` application projection for admitted items, the exclusion/replacement ledger, visibility measurements, evaluator roster and identity bindings, timestamps, and record digests;
- the exact `HUMAN-ATTESTATION-PROFILE.md`, `SHADOW-LABEL-PROMPT.md`, task/candidate/evidence/shadow/label-resolution schemas, rehearsal procedure, and licence disposition;
- every grader's system prompt, user prompt template, normalizer, parser, request parameters, model snapshot, provider endpoint identity, code and dependency lock;
- Arm C eligibility and normalization rules;
- item order and call order seed;
- evaluator adapter bytes;
- `k = 3`, failure rules, analysis code, and `wilson@1` method identifier;
- environment and secret-free runtime description; and
- every file in the publication candidate, with SHA-256 hashes.

The development bank, its labels, and all Arm B development outputs remain available for audit but are not confirmatory observations. Confirmatory question IDs and candidate answers are inaccessible to prompt authors until Arm B and Arm C have been frozen. No judge is called on a confirmatory item before lock.

## 5. Fixed call configuration

The following is the approved common grader-call configuration. It becomes frozen with the arm artifacts and pre-run manifest.

| Field | Proposed frozen value |
|---|---|
| API provider | OpenAI direct API |
| Model | dated snapshot `gpt-4o-mini-2024-07-18`, not moving alias |
| Endpoint family | Chat Completions, matching the audited implementation |
| Temperature | `0` |
| Top-p and other sampling fields | omitted; provider defaults recorded |
| Seed | omitted because the audited path omitted it |
| Max output | omitted unless preflight proves a required provider limit; any addition is frozen before development |
| Messages | arm-specific system message followed by arm-specific user message |
| Input fields | question, frozen human-verified `reference_for_grading`, candidate answer only |
| Conversation transcript | not supplied |
| Calls per item | three sequential independent requests per arm |
| Cross-item concurrency | fixed at 1 for confirmatory calls |
| Retry policy | no retry after a delivered model response; infrastructure replacement under §16 |
| Session state | stateless request; no cross-item memory |
| Raw capture | request hash, response bytes, response metadata, timestamps, endpoint identity, parser output |

OpenAI documents dated snapshots as the mechanism for locking a model version. Using the dated snapshot improves reproducibility, but because the audit did not preserve provider/snapshot metadata it does not make this an exact service-state reproduction.

Before the lock, a secret-free model identity probe must show the dated snapshot is accepted and that the response metadata records the expected model family. A silent provider alias, route change, or fallback invalidates the run.

## 6. Experimental arms

Arms are graders. Memory-system answers are not generated or compared in this experiment.

### Arm A: audited judge reconstruction

Arm A preserves, byte for byte, the EverMemOS judge prompt at commit `1f2f083…`, the two-message request shape, `temperature=0`, JSON-extraction order, and binary mapping used by the audited reconstruction:

- prompt file SHA-256: `ba4f668e72c3fba74a58b8ee56064568fb9c6aae1441e4f0f7a8f5edba498ee9`;
- historical `llm_judge.py` SHA-256: `d837bd7cd02eaf564efd663df41b0da2a3ce87c34527dcb3ae85f56fea01b572`.

1. extract a JSON object from a Markdown code block if present;
2. otherwise extract an object containing string key `label`;
3. otherwise attempt to parse the raw response;
4. return `accept` only when the normalized label equals `CORRECT`; and
5. map any other delivered response or parse failure to `reject`, while reporting parse failure separately.

The historical implementation swallowed API exceptions as false. This design separates transport/provider failures from delivered verdicts: an exception that yields no model response is an invalid infrastructure cell and is replaced under §16. That difference prevents availability incidents from masquerading as grader strictness and is disclosed as a reconstruction boundary.

Arm A receives only question, frozen human-verified `reference_for_grading`, and candidate answer. It does not receive a conversation transcript, released-key status, repair rationale, candidate class, truth label, source locator, other replicates, or another arm's output. On a repaired-key item this is a deliberate input correction, so the prompt/parser is reconstructed exactly but the historical corrupt input is not; repaired items and their rate are reported separately.

Per R1, the confirmatory Arm A is this audited reconstruction alone. Original token F1 and other historical harnesses remain provenance context and are not measured arms. No result is called simply “the LoCoMo judge” without its provenance qualifier.

### Arm B: corrected rubric

Arm B uses the same API provider, dated model snapshot, temperature, message topology, call count, ordering, and input fields as Arm A. Only the rubric, allowed output schema, normalizer, and parser change.

The rubric must encode these rules before it is frozen:

1. Accept only if the candidate entails every essential fact needed to answer the question under the human-verified reference.
2. Accept faithful paraphrases, Unicode/case/punctuation variants, and equivalent canonical date/number expressions.
3. Reject a topical supercategory when the question requires a more specific fact.
4. Reject a true but incomplete answer when it omits an essential requested fact.
5. Permit non-material extra text, but reject any material contradiction or unsupported replacement of a required fact.
6. For temporal answers, require the same date or interval at the granularity requested; a broad interval that merely contains the answer is insufficient.
7. Reject refusals, evasions, statements of ignorance, and answers that do not commit to an answer.
8. Return exactly one JSON object conforming to the frozen schema, with binary `ACCEPT`/`REJECT` and one enumerated reason code. Any delivered but schema-invalid output maps to `reject` and is reported as a parse failure.

Arm B is developed only on the 72-item development bank. At most two prompt revisions after the initial draft are allowed. The frozen selection objective is the lowest unweighted mean of development false-accept rate and false-reject rate; ties are broken first by lower item-level instability and then by fewer rubric tokens. Development classes and categories receive equal weight. Confirmatory outcomes never inform the choice.

The exact Arm B prompt is intentionally not written into this design draft. It becomes a hash-bound artifact after development and critique, and before any confirmatory item is authored or revealed.

### Arm C: deterministic closed-form matcher

Arm C is defined only on items classified as closed-form from the question and human-verified reference before candidate answers are exposed. Eligible types are a single name/entity, canonical date or bounded interval, integer/decimal with declared tolerance, yes/no, or finite unordered set.

The proposed matcher applies only class-wide rules: Unicode NFKC, case folding, surrounding punctuation and whitespace normalization, conservative article removal, canonical integer/decimal rendering, explicit date parsing to the granularity asked, and order-insensitive comparison only when the question requests a set. It has no item-specific aliases or post-result exceptions. Synonyms and semantic entailment are out of scope.

Per R2, Arm C is included. It is reported with its pre-declared coverage rate and its error rates on the eligible subset. It is not compared as if it covered the full bank.

## 7. Item-bank construction

The detailed construction protocol is in `ITEM-BANK-PLAN.md`; this section is normative where it overlaps.

### Sampling frame

- Start from the 1,540 Category 1-4 questions in pinned `locomo10.json`.
- Exclude Category 5 adversarial/unanswerable questions from this report rather than mixing a different task definition into the binary rubric.
- Exclude items whose truth cannot be established from released conversation text and released image captions without relying on private data, unavailable image pixels, hidden search-query metadata, or uncheckable world knowledge.
- Correct reference-key errors before candidate authoring through the human protocol; never use a known-corrupt released answer as truth.
- Use source-question-disjoint development and confirmatory banks.

### Approved counts

| Bank | Construction | Count |
|---|---|---:|
| Development | 3 independently selected source questions per 4 category × 6 candidate-class cell | 72 |
| Confirmatory core | 8 probability-sampled source questions per category × class cell | 192 |
| Confirmatory stress | 2 source questions per category × class cell, selected under the with/without-dial481 rule | 48 |
| Confirmatory total | Core + stress; strata never pooled for the primary headline | 240 |

Each item uses one distinct source question; a question never appears with multiple candidate classes in the same bank. That avoids treating near-duplicate candidates from one question as independent units.

### Candidate classes

1. `verbatim-correct`
2. `paraphrase-correct`
3. `partial`
4. `plausible-but-wrong`
5. `flat-wrong`
6. `non-answer`

Class names are construction strata, not truth labels. A candidate enters the locked bank only if two humans establish its truth label. In particular, a `partial` item must omit an essential requested fact and receive human `reject`; a plausible candidate that accidentally becomes correct is rejected from that cell and replaced before any judge call.

### Randomization

After Arm B is frozen, core question IDs are sampled within category from a sorted eligible frame using a committed script and the first NIST Randomness Beacon 2.0 pulse after a pre-announced UTC timestamp. The pulse record and derived seed are sealed. Candidate-class assignments are balanced within category using the same seed.

The 48 stress items are selected separately and are not used to estimate population prevalence. The confirmatory item/arm cell order is a deterministic seeded shuffle that spreads arms and categories across the run and prevents A and B for the same item from being adjacent. Within a cell, its three grader calls run sequentially on the identical input, matching the audited execution shape; subcall indices are fixed as 1, 2, and 3. Arm labels are concealed from labelers and from any public interpretation until labels are frozen.

## 8. Candidate generation rules

Humans author candidate answers from the verified source evidence and class rubric. An LLM may not author, paraphrase, repair, or screen confirmatory candidates. The machine assistance defined in §9 may propose evidence locators and a shadow label, but that proposal is embargoed, has no vote, cannot repair a reference, and cannot enter the truth rule. The confirmatory candidate bank remains human-authored even in the dial481-participation variant.

The audit stress set may contribute seeds only with dial481's active participation and agreed attribution/licence terms. “Seed” means a declared candidate-generation pattern, difficult source-item type, or permissioned candidate—not silent copying. Without their participation, no audit candidate or 99-error entry is used to select or author an item; the audit remains motivation and provenance evidence only.

Candidate length is bounded at 40 whitespace-delimited tokens unless the verified reference itself requires more. Length, negation, and presence of the reference string are recorded for descriptive checks but do not change allocation after lock.

## 9. LLM-assisted, human-attested truth protocol

Truth is source-grounded and established only when two independently acting human labelers issue matching binary evaluations. A model may reduce evidence-search effort and produce a deliberately non-authoritative shadow label; it does not establish truth.

For each candidate, one pre-label machine-assistance call receives the question, candidate answer, released reference, and relevant released conversation/caption context. It returns structured candidate evidence locators, essential facts, released-key status, rationale, uncertainty, and a provisional `accept`/`reject`/`indeterminate` label. The proposed configuration is the same dated direct-OpenAI snapshot as the grader arms, `gpt-4o-mini-2024-07-18`, at temperature 0, one call per candidate. Its exact prompt, context-window construction, parser, and model receipt are frozen before the excluded rehearsal.

The machine record is split at ingestion:

- humans may receive only source-resolved evidence passages and locators, mechanically copied from the pinned dataset after locator validation; and
- the model's provisional label, essential-fact proposal, key-repair proposal, generated rationale, and uncertainty remain encrypted or access-controlled and hash-committed until the final human truth record is sealed.

This makes the model useful for retrieval without letting its answer anchor either human. Any proposed locator that cannot be resolved exactly is excluded from the evidence packet. Each human must inspect the cited source and may add or reject locators. Neither the evidence packet nor the released reference is treated as self-authenticating.

Two named labelers independently inspect the question, candidate, corrected reference, and the relevant released source conversation/caption evidence. They do not see grader outputs. The second labeler does not see the first label, proposed candidate class, dial481 provenance, or item stratum where the labeling interface can conceal them.

Each labeler records:

- `accept`, `reject`, or `indeterminate`;
- essential fact atoms required by the question;
- evidence locator(s) into pinned LoCoMo source;
- a short rationale;
- whether the released reference is correct, incomplete, or corrupt;
- whether closed-form Arm C eligibility applies; and
- potential PII/licence concern.

Each primary human issues a DSSE-signed Jinn Result Evaluation under `HUMAN-ATTESTATION-PROFILE.md`. It binds:

- canonical `task-core.json` and `candidate.json` subject digests;
- the evidence-packet, evaluation-specification, and evaluation-method digests;
- evaluator IRI, pre-approved DSSE signing key, submission timestamp, verdict, and rationale;
- machine-assistance, peer-attestation, candidate-class, stratum, conflict, and grader-output visibility measurements; and
- the canonical Result Evaluation envelope digest.

Agreement on `accept` or `reject` by two distinct approved human evaluator identities becomes the truth label. Disagreement or any `indeterminate` excludes the item from the confirmatory truth bank and triggers a replacement from the same category/class/stratum before lock. There is no authoritative adjudicator and no path by which a third opinion restores the item. Raw pairs, rationales, exclusions, replacement lineage, and rates by category/class publish. No majority of LLMs can create or override ground truth.

Only after the final human truth or exclusion decision and any reference repair are sealed does the custodian reveal the shadow record for descriptive machine-versus-human analysis. It can never reopen or restore an item. The public bank includes human labels, Result Evaluation envelope digests, visibility measurements, essential-fact annotations, rationales, evidence locators, machine shadow output, and admission/exclusion status. Labeler identities may be pseudonymous, but trusted key bindings, conflicts, roles, and the operator's real-person-distinctness attestation are disclosed. Full conversations are not bundled.

Jinn already supplies the signed Result Evaluation evidence format, a `human-review` EvaluationSpec family, multi-verdict policy fields, and unanimous reduction. The report-specific deterministic admission policy additionally requires exactly two complete primary evaluations, verifies canonical task/candidate/evidence digests, DSSE signatures, approved identity/key bindings, roster/conflict and visibility declarations, and strict agreement, then recomputes `label-resolution.json`. The projection is not a new evidence record or source of truth. The grader adapter compares an arm verdict with the admitted human truth. Humans supply signed evaluation evidence while label resolution and grader comparison remain deterministic.

Distinct DSSE keys and resolved evaluator IRIs prove key control and declared agent-distinctness. They do not prove real-world party independence. The signed roster supplies the operator's separate attestation that the evaluator identities correspond to different humans; the report states that trust boundary explicitly.

## 10. Label and call budget

R3 approved this budget on 2026-08-14.

| Human work | Assumption | Budget |
|---|---|---:|
| Candidate authoring and evidence extraction | 312 items × 2.0 min | 10.4 h |
| Independent labeler 1 | 312 × 1.5 min | 7.8 h |
| Independent labeler 2 | 312 × 1.5 min | 7.8 h |
| Disagreement/inconclusive exclusion, replacement authoring and relabeling | reserve | 3.0 h |
| PII, attribution, manifest and release QA | reserve | 3.0 h |
| **Total** | rounded operating envelope | **32 person-hours** |

The budget is a cap, not a reason to skip double labeling. If work exceeds it, stop before revealing confirmatory outcomes and amend counts or obtain more label time.

Before development, run a disposable 12-item annotation rehearsal: four closed-form items, four paraphrase/partial boundary items, and four inference/plausible-wrong items. It has a separate cap of 2 person-hours, uses no Arm A/B/C grader calls, and its questions can never enter development or confirmatory banks. It tests evidence retrieval, blinding, attestation capture, disagreement handling, and time per item. Any protocol change it motivates requires a dated amendment and new manifest before development.

Approved LLM-call envelope:

- confirmatory A+B: `240 × 2 × 3 = 1,440` calls;
- Arm B development, including at most three candidate prompt versions: cap `72 × 3 × 3 = 648` calls;
- identity/plumbing smoke: at most 36 excluded calls;
- machine evidence/shadow assistance: `312 + 12` calls, plus at most 36 replacement-item calls;
- Arm C: zero LLM calls.

The grader-call cap remains 2,124; the all-in cap including at most 360 machine-assistance calls is 2,484 short LLM calls. No early stopping occurs based on observed verdicts. The shadow calls are label-process records, not experimental grader-arm calls.

## 11. Replicates and verdict unit

Each LLM arm receives three independent, stateless calls for every confirmatory item. The primary per-item verdict is majority rule:

- `accept` if at least two of three parsed calls accept;
- `reject` otherwise.

The item, not the individual call, is the inferential unit for FAR, FRR, and balanced accuracy. Treating three calls as three independent labeled items would understate uncertainty.

At the pinned product base, setting draft `replicates = 3` would create three separately scorable Matrix cells, and baseline `wilson@1` would count them in its denominator. It does not collapse those cells to one per-item majority. The registered design-around is therefore one Colophon task cell per arm/item (`replicates = 1`) whose sealed grader arm makes and returns the three declared subcalls plus their majority. `graderCallReplicates = 3` is hash-bound in the arm pinning and runtime. The deterministic adapter verifies every subcall and scores the one majority. This preserves an item-level Wilson denominator and still publishes the full instability evidence.

The historical EverMemOS aggregate averaged three whole-bank run accuracies. This report additionally publishes that historical-form aggregate for comparability, but it is secondary. The pre-registered primary uses majority verdicts because truth and candidate construction are item-level.

## 12. Deterministic evaluator adapter

The evaluator that scores the graders contains no model and exercises no subjective rubric. For each arm/item result bundle it:

1. verifies both Jinn Result Evaluation DSSE envelopes, their canonical `task-core.json` and `candidate.json` subjects, and their evidence-packet, specification, and method descriptors;
2. requires exactly two complete primary evaluations and verifies distinct approved evaluator IRIs and signing keys, the roster's real-person-distinctness attestation, required visibility measurements, roster/conflict policy, and matching binary verdicts;
3. verifies the three declared grader-subcall request and response hashes;
4. invokes the arm's frozen parser on each delivered response;
5. records `accept`, `reject`, `parse-failure`, or `infrastructure-invalid` per subcall;
6. derives the three-call majority verdict when all required valid calls exist; and
7. compares that verdict with the sealed human truth label using exact equality.

Its atomic score is `pass = grader majority verdict equals human truth`, else `fail`. FAR, FRR, balanced accuracy, class summaries, and instability are deterministic projections of these atomic records. Nobody judges the judge of the judges.

The adapter must pass fixture tests covering valid strict-agreement admission, disagreement and `indeterminate` exclusion, fewer than two complete primary evaluations, tampered task/candidate/evidence/evaluation digests, duplicate or untrusted identities/keys, forbidden visibility, missing or invalid DSSE signatures, every truth/verdict combination, every three-call pattern, parse failure, and invalid infrastructure conditions. Its source, fixtures, expected outputs, executable environment, and SHA-256 digest are lock inputs.

## 13. Pre-registered metrics

All headline rates are two-sided instrument diagnostics. “Known-correct” and “known-wrong” mean sealed human truth labels, not candidate-class names.

### Primary metrics, confirmatory core only

For each arm separately:

- **False-accept rate (FAR):** human-`reject` items with majority `accept` divided by all human-`reject` core items.
- **False-reject rate (FRR):** human-`accept` items with majority `reject` divided by all human-`accept` core items.
- **Balanced accuracy:** `(1 - FAR + 1 - FRR) / 2`.
- **Any-flip instability:** items whose three valid replicate verdicts are not identical divided by all items with three valid verdicts.

FAR is the lead headline; FRR must appear beside it with equal visual weight. Balanced accuracy may not replace the pair.

### Secondary pre-registered metrics

- FAR, FRR, balanced accuracy, and any-flip instability on the 48-item stress stratum, explicitly labeled stress-set estimates.
- Acceptance rate and truth error rate by candidate class.
- FAR/FRR by LoCoMo category.
- Three-call pattern frequencies: `AAA`, `AAR`, `ARR`, `RRR` after order-insensitive grouping.
- Per-run acceptance rates and the historical per-run mean/std aggregate.
- Parse-failure rate, transport/provider-invalid count, and replacement count.
- Arm C eligibility coverage and its metrics on eligible items only.
- Core-versus-stress deltas, descriptive only.
- Paired arm-change table: A wrong/B correct, A correct/B wrong, both correct, both wrong; and paired point deltas in FAR/FRR/balanced accuracy.
- Human-label-process diagnostics: raw pair agreement, Cohen's kappa, disagreement/`indeterminate` exclusion rate, replacement rate, median and interquartile time per attestation, and exclusions by category and candidate class.
- Shadow-assistant diagnostics after truth freeze: agreement and balanced accuracy versus final human truth, error by category/class, and overlap between shadow errors and human disagreements. These are descriptive diagnostics of this pinned context-assisted model, not validation of LLM-derived ground truth.
- Result Evaluation/label-resolution fixture result: whether the deterministic verifier accepts every valid signed strict-agreement pair and rejects every registered disagreement, `indeterminate`, fewer-than-two-evaluation, tamper, invalid-signature, untrusted or duplicate identity/key, and forbidden-visibility fixture.

No system ranking, memory-system score correction, benchmark-wide re-ranking, or extrapolated vendor result is a registered metric.

## 14. Intervals and analysis rules

Every binomial proportion is reported with count, denominator, point estimate, and two-sided 95% Wilson score interval using the registry method `wilson@1`. Wilson intervals are calculated across items. A zero numerator is not reported as zero uncertainty.

Balanced accuracy receives a point estimate plus a stratified nonparametric 95% bootstrap interval over items, 10,000 resamples within human-truth class using a frozen seed. The bootstrap is a deterministic companion analysis; it is not mislabeled `wilson@1`.

Paired arm deltas receive a descriptive paired bootstrap interval, 10,000 item resamples within truth class. No unregistered null-hypothesis p-value or “statistical tie” language is used. Small per-class cells are presented as counts and wide intervals, not over-interpreted.

The primary confirmatory denominator is the 192-item core bank. Stress results are never pooled into the headline. Development outcomes, replaced infrastructure calls, and dropped/disputed items are excluded by construction and remain in their own ledgers.

## 15. Interpretation table

This table is frozen before outcomes. It constrains report language without choosing a preferred arm.

| Observed pattern | Permitted interpretation | Not established |
|---|---|---|
| Arm A core FAR is high; FRR is low or moderate | The pinned audited reconstruction grants credit to a material share of human-rejected answers on this bank | That every published LoCoMo score has the same bias or magnitude |
| Arm A stress FAR is high but core FAR is not | The motivating failure is reproducible under declared stress construction but does not generalize at the same rate to the probability-sampled core | That the audit was wrong, or that the instrument has no other failure modes |
| Arm B lowers FAR while FRR is similar | The stricter frozen rubric changes false acceptance without a large measured strictness cost on this bank | A uniquely correct or universally preferable grader |
| Arm B lowers FAR and raises FRR | The rubric exposes an explicit leniency/strictness tradeoff | Which tradeoff every benchmark user should choose |
| Arm B changes neither rate materially | The frozen correction did not materially alter observed error on this bank | That all possible corrected graders would behave similarly |
| Either arm has high any-flip instability | Single-call scoring is sensitive to repeated evaluation even at the frozen configuration | The cause of every flip or behavior under another service snapshot |
| Arm C covers a substantial subset with low error | A declared closed-form subset can be scored without an LLM under these normalization rules | That semantic/open-form items need no LLM grader |
| Human pair agreement is high, exclusion/replacement is uncommon, and every Result Evaluation/label-resolution fixture passes | Evidence-backed signed human evaluation is operationally usable as the sealed reference input for this Jinn evaluation | That humans are infallible or that every future attestation task will be equally simple |
| The shadow assistant agrees closely with sealed human truth | This pinned context-assisted model approximates the final labels on this bank and may reduce evidence-search effort | That its outputs can replace independent human attestations or establish ground truth |
| Human disagreement, exclusion/replacement, or labeling time is high in a class | That class imposes a measurable human-attestation cost and is underrepresented in the admitted truth bank | That an LLM should silently become the truth source |
| Judge variants differ | LoCoMo-derived scores are conditional on grader provenance and cannot be treated as one instrument without qualification | That any vendor result should be called a loser or winner |

Report prose names instruments and configurations, not vendors as winners or losers.

## 16. Validity, failure, and replacement rules

### Valid model response

A delivered response from the expected model snapshot with complete request/response metadata is a valid call even if it is empty or unparsable. The arm's frozen parser handles it, and parse failure is disclosed.

### Invalid infrastructure cell

A call is infrastructure-invalid if no model response is delivered because of transport failure, authentication failure, rate limiting, provider outage, timeout before response, unexpected model identity, missing raw capture, or request-hash mismatch.

Invalid subcalls remain in the ledger and are retried once with the same arm, item, and subcall index after the cell's initial three-call sequence. A second infrastructure failure for that subcall makes the whole item/arm cell `could-not-grade` and stops the run for a public amendment. Successfully delivered sibling subcalls are retained, but no majority is emitted until all three indices have valid delivered responses. Results already observed are not used to decide the amendment.

### Other validity rules

- No changes to prompts, parsers, labels, candidates, or model configuration after the first confirmatory request.
- No trial is dropped because its verdict is surprising.
- No candidate is reclassified after a grader response is visible.
- Any evidence that a confirmatory item leaked into development invalidates that item and triggers a pre-outcome replacement if possible; discovery after outcomes requires a disclosed sensitivity analysis and amendment.
- All raw arm outputs are collected before any headline analysis is rendered.

## 17. Colophon lifecycle and current product gaps

The intended lifecycle is:

`import task set → bind signed human Result Evaluations → recompute strict-agreement label resolution → bind grader arms → bind deterministic adapter → lock → run → collect → report → publish → standalone verify`

The bank imports as a task set with a content digest. Existing Jinn Result Evaluation Evidence binds each human judgment to the exact task, candidate, evidence, method, evaluator identity, and signature. A deterministic report policy admits only exactly two valid, matching primary human verdicts and recomputes the reference label; disagreement or `indeterminate` is excluded and replaced before any grader call. Each grader is a pinned arm whose locked runtime declares `graderCallReplicates = 3`; the Colophon run declares one task-cell replicate so the Matrix has one item-level majority cell per arm. The deterministic adapter then emits pass/fail cells against that truth. The sealed Matrix is collected before the Report. The public bundle is checked by the standalone verifier from a clean checkout.

The current `integration/evidence-v1` product cannot yet express all required mechanics:

| Gap at pinned product base | Design-around for this report | Prohibited shortcut |
|---|---|---|
| CLI importer supports the sample and SWE-bench path, not a generic LoCoMo JSONL task set | Freeze a canonical item-bank schema and digest now; schedule importer/profile work as a separate approved product session before any official run | Disguise LoCoMo records as SWE-bench tasks |
| Draft records can describe custom arm pinning, but the local venue has no arbitrary LLM-grader launcher | Freeze arm contracts and runtime requirements; later add or approve a contained custom runtime through normal product work and preflight it before lock | Run unsealed scripts and call their outputs official |
| Evaluator adapter allowlist has no exact verdict-vs-human-truth adapter | Freeze deterministic adapter fixtures/spec now; implement and register it only in a separate product session | Use another LLM or manual analyst as evaluator |
| Product `replicates = 3` would give `wilson@1` three scorable cells per item rather than one majority cell | Declare `graderCallReplicates = 3` inside each sealed arm, return all subcalls plus one majority, and use one Colophon task-cell replicate | Treat three correlated calls as three independent items |
| `wilson@1` currently summarizes overall pass/fail per arm; it does not natively render FAR, FRR, class strata, or instability | Make the atomic Matrix truth-agreement pass/fail; seal a deterministic companion analysis and, if necessary, separate truth-stratum Reports. Publish the limitation and verifier coverage of each artifact | Present an unverified notebook as part of the sealed claim |
| Jinn already has DSSE-signed Result Evaluation Evidence, `human-review` EvaluationSpecs, `minVerdicts`/`distinctEvaluator`, and unanimous reduction, but no external-human review surface/adapter or verifier for this report's roster, blinding, strict two-complete-evaluation admission, exclusion/replacement, and reveal-order policy. The generic Matrix marks a cell `judged` after one valid verdict even when more were requested. | Reuse the existing evidence and strict-agreement primitives; freeze the report-specific admission method and fixtures; make `label-resolution.json` a recomputable application projection; implement/approve only the missing human-input and verification path in a separate product session | Invent a parallel attestation family, treat the derived projection or an unsigned spreadsheet as source truth, claim keys prove independent people, or let an LLM participate in label admission |

These are product gaps, not permissions to build features in this design session. A confirmatory run cannot start until the official path can seal and verify the required artifacts or the design is amended before any outcome is observed.

## 18. Licence, attribution, privacy, and publication gate

No project-specific licence memo was found during this design session. This packet therefore records questions rather than legal clearance.

Observed source licences:

- original `snap-research/locomo` root: CC BY-NC 4.0, with no separate code licence found;
- pinned EverMemOS judge code and prompt: Apache License 2.0;
- `dial481/locomo-audit`: CC BY-NC 4.0 for its repository contributions, with the imported EverMemOS prompt identified as Apache-2.0 in its provenance notice;
- historical/current Mem0 repositories inspected: Apache License 2.0;
- inspected Zep paper harness: CC BY-NC-SA 4.0.

This design packet is marked `CC-BY-NC-4.0` because it is intended to describe and eventually package a LoCoMo-derived noncommercial contribution. The repository root is Apache-2.0, so file-level licensing and eventual bundle boundaries must be confirmed before merge or publication.

The publication gate requires a written memo or counsel/operator approval covering:

1. whether free distribution from Colophon's commercial project surface is “NonCommercial” for this use;
2. the attribution form, creator names, source links, licence links, modification notices, and disclaimer required by CC BY-NC 4.0;
3. preservation of Apache-2.0 licence/NOTICE obligations for copied judge code or prompt;
4. whether any dial481 candidate/error material may be used, under what permission and credit, before it enters the bank;
5. whether an Arm C or provenance-suite inclusion imports any CC BY-NC-SA material; and
6. whether file-level CC BY-NC material may live in this Apache-licensed monorepo and how packaging prevents ambiguity.

Public artifacts contain no full conversation transcripts, credentials, endpoint secrets, or raw private operator data. The inspected LLM judge sees only question/reference/candidate, so transcript inclusion is unnecessary. Human labelers may inspect pinned source transcripts locally; the release carries source IDs and evidence locators. A PII and licence scrub precedes publication.

Free price alone is not treated as legal proof of noncommercial purpose. Until the memo resolves the gate, nothing is published.

## 19. Pre-registration, sealing, and execution sequence

1. Record operator rulings R1-R4; completed 2026-08-14.
2. Obtain the licence memo and any participation permission.
3. Name Labeler 2, freeze evaluator IRIs/DSSE keys/conflicts and the operator's real-person-distinctness attestation in the roster, complete predictions P10-P11, and sign the prepared attestation profile, shadow prompt, task/candidate/evidence/shadow/label-resolution schemas, and rehearsal packet.
4. Run the excluded 12-item annotation rehearsal under the 2-person-hour cap, with no grader-arm calls and no later bank reuse; amend and re-manifest any protocol change before development.
5. Freeze source commits and eligible-frame construction.
6. Complete and sign predictions P1-P9, then build and human-attest the 72-item development bank using the frozen assistance/embargo protocol.
7. Draft Arm B; use no more than the registered development iterations; freeze its exact bytes.
8. Freeze Arm C rules.
9. Draw confirmatory source IDs using the registered public seed.
10. Human-author, machine-assist, independently double-evaluate, exclude/replace disagreements and `indeterminate` labels, and freeze the confirmatory bank without calling a grader arm; reveal shadow labels only after truth freeze or exclusion.
11. Resolve the product gaps through separately authorized implementation; run fixture-only adapter, Result Evaluation signature/identity, strict-agreement admission, and identity/plumbing preflights.
12. Freeze runtime, arms, bank, analysis, call order, manifest, and design; record commit and hash publicly before any confirmatory call.
13. Run in frozen order; retain invalid/replacement ledger.
14. Collect and seal the Matrix before reading the report projection.
15. Produce the two-sided report and deterministic companion analyses.
16. Verify the bundle with the standalone verifier from a clean environment.
17. After licence and PII review, `ritsukai` may publish the free contribution artifact in a separately authorized session.

No step in this design session contacts collaborators, spends API budget, touches confirmatory items, or publishes externally.

## 20. Falsifiable predictions — operator completes before any relevant run

The operator must complete P10-P11 before the annotation rehearsal and P1-P9 before any development or confirmatory grader-arm call, then sign, date, and include the completed section in the frozen hash. The design authors do not backfill predictions after the corresponding observations exist.

| ID | Prediction to fill | Operator value |
|---|---|---|
| P1 | Arm A core FAR, point prediction and 80% plausible range | `[REQUIRED]` |
| P2 | Arm A core FRR, point prediction and 80% plausible range | `[REQUIRED]` |
| P3 | Arm B core FAR and direction/magnitude versus A | `[REQUIRED]` |
| P4 | Arm B core FRR and direction/magnitude versus A | `[REQUIRED]` |
| P5 | Arm A and B any-flip instability | `[REQUIRED]` |
| P6 | Stress FAR relative to core FAR | `[REQUIRED]` |
| P7 | Candidate class with highest false-accept rate | `[REQUIRED]` |
| P8 | Arm C eligible-bank coverage and error | `[REQUIRED]` |
| P9 | Result that would most change the operator's current belief | `[REQUIRED]` |
| P10 | Human-pair agreement, disagreement/`indeterminate` exclusion rate, replacement burden, and median time per attestation | `[REQUIRED BEFORE REHEARSAL]` |
| P11 | Embargoed shadow-assistant agreement versus final human truth | `[REQUIRED BEFORE REHEARSAL]` |

**Operator:** `[REQUIRED]`<br>
**UTC timestamp:** `[REQUIRED]`<br>
**Signature/commit identity:** `[REQUIRED]`

## 21. Amendment procedure

Before the first confirmatory request, any change requires:

- an appended, dated amendment with reason and author;
- exact clauses and files superseded;
- disclosure of all development and smoke outputs already observed;
- a new complete SHA-256 manifest and repository commit; and
- confirmation that no confirmatory item or verdict was viewed.

After the first confirmatory request, prompts, parsers, model/provider, items, labels, counts, metrics, intervals, and interpretation rules are immutable. Only infrastructure amendments allowed by §16 may occur, and they cannot depend on verdict direction. Any other deviation terminates the registered run. A later revised design is a separate experiment with a separate bank or explicitly disclosed reuse.

All prior manifests and amendments remain available. Nothing is overwritten silently.

## 22. Limitations declared before results

1. **Arm B is our judge.** Its stricter rules are arguable. The prompt, parser, development record, truth labels, and rationales publish. The standing offer is: disagree, propose a sealed judge, and it can run as another arm under a new pre-registration.
2. The original LoCoMo release did not define an LLM judge, and later harnesses vary. Arm A is a provenance-qualified reconstruction, not an original canonical instrument.
3. The audit did not seal provider, endpoint, or dated model snapshot for the 62.81% run. Behavioral drift may prevent exact numerical reproduction.
4. Human labels can be wrong or contestable. Double labeling, strict agreement, evidence locators, exclusion accounting, and publication make the judgment surface inspectable but do not eliminate it. Excluding disagreements narrows the headline claim to the unambiguous admitted bank and may underrepresent difficult boundary cases.
5. The shadow assistant uses the same dated model family proposed for Arms A and B. Its agreement is therefore not independent evidence, and its retrieved evidence can still omit or foreground the wrong passage. Humans must inspect the pinned source; the shadow output has no vote and stays hidden through final truth freeze.
6. Human-authored candidates may differ from memory-system answer distributions. The report measures grader behavior over declared classes, not the prevalence of those classes in any system.
7. The 192-item core is a modest, stratified sample. Category/class cells are small, and wide intervals constrain subgroup claims.
8. The 48-item stress stratum is deliberately enriched and cannot estimate LoCoMo-wide prevalence.
9. Correcting documented reference errors changes the evaluation target and means Arm A does not reproduce the historical corrupt input on those items. Every change must be versioned and published; repaired items are separately identified, and no grader sensitivity to the unrepaired key is claimed without separately registered calls.
10. Majority-of-three reduces but does not eliminate service stochasticity. It also differs from published per-run mean aggregation, which is reported secondarily.
11. Arm C's coverage depends on contestable closed-form eligibility and conservative normalization. It says nothing about ineligible semantic items.
12. No conversation transcripts ship in the bundle. Evidence is independently checkable by resolving locators against the separately licensed pinned source, but not wholly self-contained offline.
13. Individual human judgments, `human-review` EvaluationSpecs, and multi-verdict unanimous reduction already exist in Jinn. The missing product path is external-human collection plus enforcement of exactly two complete primary evaluations, roster/conflict and visibility declarations, exclusion/replacement, and reveal order. Until it is verifier-covered, the report cannot claim that Jinn natively admitted the combined human truth.
14. Product support for this task profile, custom grader arms, deterministic adapter, and registered secondary projections is incomplete at the pinned base. The report cannot claim an official sealed run until those gaps are resolved and verifier coverage is explicit.
15. CC BY-NC and mixed-source licence questions remain a publication gate. This packet is not legal advice or legal clearance.
16. The study evaluates the instrument. It neither names a vendor as a loser nor identifies a comparative winner.

## 23. Recorded operator rulings

The operator approved R1-R3 and subsequently approved R4 in this task on 2026-08-14. R4 supersedes only R3's conditional-adjudication branch; the sample and budget ruling remains unchanged.

| Ruling | Recorded decision | Consequence |
|---|---|---|
| **R1 — What is Arm A?** | Focused EverMemOS-derived audited reconstruction only, under the dated direct-OpenAI snapshot. | Original F1 and other harnesses remain provenance context; the report carries the explicit non-exact-reproduction caveat. |
| **R2 — Include Arm C now?** | Include the conservative closed-form matcher. | Report coverage and error only on the pre-declared eligible subset. |
| **R3 — Approve sample and human-label budget?** | Approve 72 development + 240 confirmatory items and the 32-person-hour bank-label cap. | The excluded 12-item rehearsal has a separate 2-person-hour cap; all-in LLM-call cap is 2,484 after machine assistance. |
| **R4 — How are human disagreements resolved?** | Require two matching primary human verdicts; exclude and replace any disagreement or `indeterminate`; no authoritative adjudicator. | The headline bank is explicitly an unambiguous strict-agreement bank; all exclusion and replacement attrition publishes. |

Licence clearance and dial481 participation are gates/contingencies rather than discretionary substitutions for these rulings. The design has an explicit with/without participation path.

## 24. Source register

| Source | Pinned version | Use in this design | Licence observed |
|---|---|---|---|
| [SNAP LoCoMo](https://github.com/snap-research/locomo) | `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376` | Dataset, original evaluator provenance | CC BY-NC 4.0 root |
| [dial481 LoCoMo audit](https://github.com/dial481/locomo-audit) | `9493fb4b4af4256ed17a18e8fd0b3cfdeec29539` | Motivating rates, provenance reconstruction, documented error population | CC BY-NC 4.0; third-party notice for prompt |
| EverMemOS historical judge | `1f2f083d9fd07fd6580064bbdfc7b97da39c47bb` | Arm A prompt/code provenance | Apache-2.0 |
| Historical Mem0 harness | `aae5989e78a6188b3b047c104d960c9ad0927e75` | Judge-variant provenance only | Apache-2.0 |
| [Mem0 memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) | `4b61c5d31b9c668a12b4f5e78064248a02c82d2b` | Current variant provenance only | Apache-2.0 |
| [Zep papers](https://github.com/getzep/zep-papers) | `4b7f26cc76cca20743314ba9acb8c2cb6adc42f6` | Historical variant provenance only | CC BY-NC-SA 4.0 |
| [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-4o-mini) | accessed 2026-08-14 | Dated-snapshot capability | Site terms apply |
| [CC BY-NC 4.0 legal code](https://creativecommons.org/licenses/by-nc/4.0/legalcode.en) | accessed 2026-08-14 | Publication questions and attribution gate | CC legal code |
| [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.html) | accessed 2026-08-14 | Judge-code redistribution obligations | Apache-2.0 |
| Jinn Result Evaluation Evidence | product commit `9062c337fb92d5384fa15f043b38dde3d7427f10` | Native DSSE/in-toto format reused for human labels | Apache-2.0 product code; report profile remains CC BY-NC-derived |

URLs, retrieval timestamps, repository tree hashes, and the exact copied-file licence/NOTICE inventory join the sealed source register.

## 25. Amendment record

### A1 — 2026-08-14, operator-ruling and human-attestation amendment

- Recorded R1-R3 as approved: focused Arm A, included Arm C, and the 72/240 banks with a 32-person-hour bank-label cap.
- Added one-call context/evidence assistance with an embargoed, non-voting shadow label.
- Recast truth records as two independent human attestations with digest, visibility, identity, time, and signature/commit bindings.
- Added a disposable 12-item, 2-person-hour annotation rehearsal outside both banks.
- Added label-process, shadow-assistant, and attestation-integrity diagnostics; added the missing native-attestation product gap.
- Increased the all-in LLM-call cap from 2,124 to 2,484 while leaving the experimental grader-call cap at 2,124.

The preceding packet's digests are retained in `DRAFT-MANIFEST.v1.sha256`. The current `DRAFT-MANIFEST.sha256` authenticates this amended design packet for review, but it is not the confirmatory pre-registration freeze. A new complete manifest is required after licence clearance, the rehearsal, development, and bank construction.

### A2 — 2026-08-14, Jinn evidence alignment and rehearsal packet

- Replaced the proposed parallel `human-attestation@1` wire format with Jinn's existing DSSE-signed Result Evaluation Evidence.
- Defined an acyclic task-core → candidate/shadow/evidence → Result Evaluations → deterministic quorum → final-item digest graph.
- Narrowed product gap G-6 to the missing multi-human quorum, role/conflict, visibility, adjudication, and reveal-order policy.
- Added the exact human application profile, shadow prompt, task/candidate/evidence/shadow/quorum schemas, excluded rehearsal packet, labeler-roster template, and counsel-ready licence brief.
- Did not select or open rehearsal questions, issue attestations, call a model, or make a legal decision.

The v2 packet's digests are retained in `DRAFT-MANIFEST.v2.sha256`. The current manifest supersedes v2 for design review only; neither is the confirmatory pre-registration freeze.

### A3 — 2026-08-14, stack-alignment and strict-agreement amendment

- Recorded R4: confirmatory truth requires two matching primary human verdicts; disagreement or `indeterminate` is excluded and replaced without adjudication.
- Recognized that Jinn already supplies `human-review` EvaluationSpecs, multi-verdict policy, and unanimous reduction; narrowed the product gap to external-human collection and report-specific admission/visibility/reveal verification.
- Recast `human-quorum.json` as verifier-recomputable `label-resolution.json`, an application projection rather than a new authoritative evidence record.
- Added the hard two-complete-evaluation admission check because generic Matrix outcome derivation treats one valid verdict as `judged` even when the Run requested more.
- Corrected identity language: DSSE keys and Agent IRIs establish key control and declared agent-distinctness; the signed roster separately attests real-person distinctness.

The v3 packet's digests are retained in `DRAFT-MANIFEST.v3.sha256`. The current manifest supersedes v3 for design review only; neither is the confirmatory pre-registration freeze.
