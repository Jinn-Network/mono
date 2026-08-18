# LoCoMo Judge Report — Colophon Validation Implementation Program

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | 2026-08-19 (chartered 2026-08-18) |
| **Author** | Program planning session (operator + Claude Fable 5); capability re-verification path:line-cited against `next` @ `7bf98816d` |
| **Shape** | `design` (this document); execution packets are `design` / `feat` / `fix` / `test` / `docs` |
| **Design authority** | The experiment design posted publicly in [snap-research/locomo#23](https://github.com/snap-research/locomo/issues/23#issuecomment-5334425775) (2026-08-18). The posted text is the commitment. Any change is a dated amendment posted in that thread **before** any outcome is observed |
| **Depends on** | The binary-judge qualification stack (epic #2689, merged 2026-08-16); house program pattern [`2026-08-11-demo1-venue-glue-implementation-program.md`](./2026-08-11-demo1-venue-glue-implementation-program.md) |
| **Does not do** | Bank construction, item labeling, the freeze, the live run, report writing, thread communication, publication choreography (operator/research-side, outside this repository); demo-1 work; marketplace or network publication topology |

## 1. What this is

Running the LoCoMo judge/disclosure experiment through Colophon, in public, with the design already posted and the community's most credible auditor engaged, is the product's public validation. This program therefore treats engineering sequencing, product readiness, site readiness, and the public run as **one program with gates**, not a feature batch. The engineering finish line is not "features merged" — it is an operator go/no-go checklist for a confirmatory run that the official path can seal and independently verify.

Two constraints bind everything:

1. **Run-start constraint.** A confirmatory run cannot start until the official product path can seal and verify the required artifacts, or the design is amended publicly in the thread before any outcome is observed. Schedule slips are handled by public amendment, never by quiet workaround.
2. **License boundary.** The dataset and audit annotations underlying the experiment are CC BY-NC 4.0. This Apache-2.0 repository receives only original code, generic schemas, and synthetic fixtures. Real items, prompts, labels, and derived annotations remain research inputs outside this repository and are imported at run time. No third-party prompt bytes, dataset rows, or audit-derived text land here — including in fixtures, tests, or documentation.

## 2. Ground truth: the gap list is stale (verified 2026-08-19)

The capability gap list this program was chartered against (F1–F9, drawn against a 2026-08-10 product base) predates two large merges: the binary-judge qualification stack (epic #2689, merged 2026-08-16 — importer, contained judge launcher, registered evaluator adapter, replicate reduction, `binary-instrument@1` method, human-truth admission, bundle v4, standalone verifier v2) and the benchmark-publication interoperability program (Report v2, Matrix v2, durable publication). Re-verification against `next` @ `7bf98816d`:

| Row | Chartered as | Verified state on `next` | Residual (this program's packets) |
|---|---|---|---|
| F1 item-bank import | GAP | **Built.** `import item-bank --profile binary-judgment@1` operation + CLI verb (`packages/benchmark-product/core/src/operations/import-item-bank.ts:73-187`, `core/src/cli/main.ts:1457`); closed item payload (`packages/task-execution/profiles/src/binary-judgment/contracts.ts:92-98`); admission closure enforced before import (`core/src/intake/binary-item-bank.ts:284-301`) | Evidence channel (P2), category strata (P4) |
| F2 grader-arm runtime | GAP | **Built.** Contained Inspect binary-judge launcher: OCI isolation, pinned runtime assets, enforced arm pinning (`core/src/runtime/inspect/binary-judge.ts:260-280,309-320`); sealed prompt-instrument contract with template fields and frozen generation config (`contracts.ts:101-139,218-262`); per-cell observation with provider receipt (`contracts.ts:316-355`) | Judge-model generalization (P1), evidence channel (P2), parsers (P3) |
| F3 verdict-vs-label adapter | GAP | **Built and registered.** ACCEPT/REJECT vs CORRECT/WRONG with sealed comparison oracle and a 22-equality digest join (`packages/task-execution/evaluator-adapters/src/binary-judgment/adapter.ts:503-528`); registered in the venue (`core/src/venue/venue.ts:578-583`) | None (close the issue) |
| F4 secondary projections | GAP | **Mostly built.** `binary-instrument@1` emits confusion counts, agreement/FAR/FRR with Wilson intervals, per-class and per-stratum slices, parser-invalid rate, instability (`packages/benchmarking/aggregate/src/registry.ts:280-298`, `binary-instrument-method.ts:1491`); `paired-delta@1`, `paired-mcnemar@1`, `noninferiority-iut@1` also registered | Cross-arm projections (P5) |
| F5 per-cell subcall majority | Optional GAP | **Built natively.** `replicates` produces separately scorable cells (`packages/benchmarking/records/src/run/cells.ts:80-105`); `binary-instrument@1` reduces odd `k` by strict majority. The registered one-cell/three-subcall workaround is obsolete: `k = 3` Run replicates express "three calls per item, majority verdict, all three published" exactly, and better | None |
| F6 label provenance | GAP | **Largely built.** Full human-review protocol: packet, blinding receipts, two-person roster, reveal receipt, replacement ledger, operator-only assertion (`packages/benchmark-product/verify/src/admission/contracts.ts:64-177`); `human-review` CLI verbs; DSSE-signed result evaluations | Screening-model admission mode (P6). External-reviewer surface deferred (§9 D6) |
| F7 disclosure-specification record | GAP | **Confirmed absent.** All existing disclosure surfaces describe what was executed (`packages/benchmarking/records/src/report/schema.ts:32-68`); arm pinning is an open bag (`core/src/domain/draft.ts:39-45`); nothing expresses declared-but-not-run variables | Lane 4 (design + implementation, not run-blocking) |
| F8 external-citation record | Optional GAP | **Confirmed absent.** Only free-text `Benchmark.citation` | None (report prose, disclosed — stays unfiled) |
| F9 could-not-grade semantics | Optional GAP | **Machinery exists** (`could-not-grade` journal terminal, `core/src/run/journal.ts:170`; unscorable-class machinery), but the binary-judgment spec declares `unscorable: []` (`evaluator-adapters/src/binary-judgment/adapter.ts:158`) | Ungradeable classes (P7) |

**Consequence:** the program is not a build-out of nine features. It is a bounded set of deltas on a shipped substrate, plus a report-shaped end-to-end proof, plus readiness work, plus one strategic record type. The originally filed child issues are reshaped accordingly (§10).

### 2.1 Queue reality (verified 2026-08-19)

The engineering lane is clear for this program. The substantive PR backlog resolved in the 2026-08-18 merge wave (suites locks #2787/#2789/#2790, TB 2.1 lock fix #2794, integrity providers #2786, test timing #2795 — all merged). What remains open: the merge-queue flip stack (#2821/#2823/#2827 awaiting bottom-up merge, then #2798/#2799 operational steps — operator-owned, does not gate this program), a handful of review-pending PRs, and a 20-PR dependabot pile (noise, batch separately).

Demo-1 does not compete with this program. It is stopped on a **measured** admissibility shortfall (6 admissible task-bundle units against a 21-unit floor, per PR #2729, which is itself conflicted and unreviewed), its remaining issues (#2611/#2613) target a deleted integration branch, and none of its seams (SkillsBench units, OCI grading, coding-agent arms) overlap this program's packets. The two efforts share the venue, statistics registry, and publication substrate — all already merged. Under the ruled publication order (first artifact ready goes live first), the judge report is now the leading artifact; demo-1 continues as its own program when its capacity question is answered.

## 3. What the experiment needs that the substrate does not yet express

Derived element-by-element from the posted design against the verified substrate:

1. **A dated judge-model snapshot.** The instrument contract hard-pins `model.adapter = "jinn-openai"`, `model.requested = "gpt-5.6-luna"` (`contracts.ts:228-229,266,328-329`) and a reasoning-model generation config with no sampling temperature (`contracts.ts:126-139`). The experiment pins `gpt-4o-mini-2024-07-18` at temperature 0.
2. **A per-item evidence channel.** One arm adds the dataset's own evidence passages to the judge input. The payload is a closed five-field object and the template may interpolate exactly `question`, `referenceAnswer`, `candidateAnswer` (`contracts.ts:92-105`). There is no channel for per-item auxiliary text, and adding one must not become a covert truth channel.
3. **Per-arm declared parsers.** Six as-found prompts imply more than one response-parsing behavior. Today one parser identity exists (`network.jinn.parser.binary-accept-reject@1.0.0`, `contracts.ts:142-146`).
4. **Category strata.** The bank is balanced across four source-question categories and the report slices by them. The stratum vocabulary is a hard `["core","stress"]` enum (`contracts.ts:360`).
5. **Cross-arm readouts.** Pairwise disagreement between judges is a headline question; the evidence-conditioned contrast is a paired comparison; the corrupt-key check reads verdict flips between paired cells. `binary-instrument@1` deliberately emits no comparative claim.
6. **Label admission that matches the posted protocol.** The posted design's labels are screening-model-proposed with flagged items plus a random sample hand-checked. The admission manifest supports `two-human-unanimous` or `operator-only` (`verify/src/admission/contracts.ts:167-177`) — the first is a heavier protocol than the design, the second brands the flagship bundle `operator-only-not-publication-grade`.
7. **Typed infrastructure failure.** The design counts parse failures as rejects (built: `parseValid=false` with deterministic REJECT) and treats a twice-failed call as a run-stopping outage. No ungradeable class is declared for the binary-judgment spec, so a provider outage currently has no accounted cell state.
8. **Corrupt-key pairing needs no new machinery**: two tasks per source question with differing `referenceAnswer` bytes, each sealed and digested, express the paired-key check today.
9. **The consistency gate needs no new machinery**: a second, small locked task set over the same frozen arms.

## 4. Lanes and packets

Four lanes. Lane 1 blocks the run; Lane 2 proves the run path; Lane 3 converges on the publish date; Lane 4 is strategic and never blocks the run.

| Lane | Scope | Packets |
|---|---|---|
| **L1 — Official-path deltas** | Product changes the confirmatory run requires | P0 → P1, P2, P3, P4, P6, P7 (parallel after P0) → P5 |
| **L2 — Run proof** | Report-shaped synthetic end-to-end + runbook + adversarial review | P8, P9 |
| **L3 — Readiness** | Site report template, standing-offer page, stranger dogfood | R1, R2, R3 |
| **L4 — Strategic records** | Disclosure-specification record (F7) | S1 (design), S2 (implementation) |

Research-side work (bank construction, screening, hand-check, admission, freeze, thread communication, the live run, report writing) is **out of scope for this repository** but appears in the gates (§6) as external dependencies with the operator as owner.

### P0 — `design`: judge-path delta contracts (blocks everything in L1)

One design session freezing every schema delta in a spec under `docs/superpowers/specs/`, so P1–P7 can proceed in parallel without contract drift. Must decide, with exact schema shapes:

- The generalized instrument/model contract: a closed set of judge-model profiles (the existing reasoning-model profile unchanged; a dated-snapshot sampling profile adding `temperature: 0` and a wider `maxOutputTokens`), how `model.requested` becomes a validated dated-snapshot literal set, and which digests bump.
- The evidence-channel field: name, optionality, the rule that an instrument sees the field only when its template declares it, and the leak-refusal rule (items carrying evidence refuse binding to arms whose declared input shape excludes it, and vice versa — decide direction and typing).
- Stratum vocabulary: hard enum → declared vocabulary sealed in the analysis plan; `["core","stress"]` banks stay byte-compatible.
- Parser identities: how many distinct parse behaviors the six as-found arms reduce to (inventory happens research-side; the spec fixes the parser **contracts** — id, version, normative behavior, adversarial cases — in original language).
- Ungradeable classes for binary judgment and their mapping from operational errors; retry-once semantics via the existing infrastructure-attempt policy (`core/src/domain/draft.ts:63-64` caps retries at 0 or 1, matching the design's retry-once rule).
- Cross-arm projection scope (ratifies operator decision D2, §9).
- Screening-model admission branch shape (ratifies operator decision D1, §9).

**Acceptance:** spec merged to `next`; every P1–P7 issue re-checked against it; the research-side bank schema is confirmed to compile to exactly the importer's three canonical manifests (external dependency, owner: operator).

### P1 — `feat`: pinned dated-snapshot judge models

Seams: `contracts.ts:126-139` (generation), `contracts.ts:228-229,266,328-329` (model literals), `core/src/runtime/inspect/binary-judge.ts:141-143` (provider profile), pinned runtime assets (worker/broker/provider digests re-verified at bind time, `core/src/operations/inspect-binary-judge.ts:99-106`).

**Acceptance:**
1. An instrument pinning `gpt-4o-mini-2024-07-18` with temperature 0 seals, binds, and executes in the contained runtime against a stubbed provider in tests; the observation's provider receipt records requested and resolved model.
2. Existing reasoning-model instruments and all existing fixtures remain byte-compatible; the 144-cell qualification lifecycle test is green unmodified.
3. The `mutable-model-alias` limitation is emitted only for models where it is true; a dated snapshot instead records the snapshot-identity check as evidence.
4. A pre-run snapshot-serving probe exists as a recorded, sealable preflight artifact (the design requires it as a lock input).
5. Negative tests: undeclared model id refuses at seal; resolved-model mismatch refuses at collect.

### P2 — `feat`: per-item evidence channel

Seams: payload schema (`contracts.ts:92-98`), template-field enum (`contracts.ts:101-105`), template validation (`contracts.ts:245-253`), profile document + digest (`profiles/src/documents/binary-judgment-1.0.ts`), importer (`core/src/intake/binary-item-bank.ts`), launcher message construction (`binary-judge.ts:171,238`).

**Acceptance:**
1. A bank whose items carry evidence text imports; an instrument declaring the evidence field receives exactly that item's evidence bytes in its constructed messages.
2. An instrument that does not declare the field can never receive evidence bytes (leak test asserts message-byte identity with an evidence-free bank).
3. Binding an evidence-declaring instrument to an evidence-free bank refuses, typed; the reverse combination follows the P0 rule.
4. Truth, class, and stratum remain evaluator-only; the digest join is extended to cover the evidence bytes; profile and parser-semantics digests are recomputed deliberately and called out in the PR body.
5. Fixtures are synthetic.

### P3 — `feat`: per-arm parser identities

Seams: `evaluator-adapters/src/binary-judgment/parse.ts`, parser allowlist (`evaluator-adapters/src/parser-identity.ts:42-57`), instrument parser identity (per-instrument `{id, version}` already in the contract).

**Acceptance:**
1. Each parser contract frozen in P0 is implemented as a pure, original function, registered and allowlisted.
2. Fixture coverage per parser: every verdict-token variant, label-in-prose, JSON-with-surroundings, casing, refusal text, empty output, over-length output; each maps deterministically to ACCEPT/REJECT/parse-invalid per the instrument's frozen invalid-output policy.
3. The umbrella evaluation parser identity is unchanged; existing parser fixtures green unmodified.
4. No task-supplied or arm-supplied executable parser code: identity selection from the allowlist only.

### P4 — `feat`: declared stratum vocabulary

Seams: `contracts.ts:360`, method vocabulary validation (`packages/benchmarking/aggregate/src/binary-instrument.ts:157-169`), admission/importer manifests.

**Acceptance:**
1. A bank declaring strata `category-1..category-4` imports, locks with the vocabulary sealed in the analysis plan, and `binary-instrument@1` emits one slice per declared stratum.
2. `["core","stress"]` banks and the 144-cell test remain byte-stable.
3. Undeclared stratum values refuse at import and at method compute; zero-denominator strata withhold intervals as today.

### P5 — `feat`: cross-arm projections (scope set by D2)

Recommended scope: (a) a registered `pairwise-disagreement` method over item-majority decisions per arm pair (counts, rate, interval, per class); (b) verify `paired-delta@1` (`registry.ts:249-259`) accepts item-level majority decisions for the evidence-conditioned contrast, adding an input adapter if it only consumes raw cells; (c) the corrupt-key readout (key-fidelity rate and verdict-flip-on-key-change over paired task cells) as either a small registered method or a sealed companion analysis explicitly disclosed as outside registry verification; (d) gate uniformity stays a sealed companion readout (12 probes; too small for intervals).

**Acceptance:** whichever registered methods land are deterministic and byte-stable on recompute, covered by the method-conformance suite, and emit no vendor ranking; the report's claim table can mark every number as registry-verified or sealed-companion with nothing unlabeled.

### P6 — `feat`: screening-model admission mode (run-blocking iff D1 = build)

Seams: admission manifest enum (`verify/src/admission/contracts.ts:167-177`), label-resolution discriminated union (`profiles/src/binary-judgment/label-resolution.ts:70-73`), human-review operations (`core/src/operations/human-review.ts`), importer admission closure (`binary-item-bank.ts:284-301`).

A third `truthAdmission` branch expressing the posted label protocol as data: screening model + screening prompt digests, per-item screening verdicts, the flagged set, the hand-checked sample with the operator's signed sample evaluations, the published sample agreement rate, and the exclusion/replacement ledger — so a bundle shows which items were model-screened, which were hand-checked, and which were excluded, as data rather than prose.

**Acceptance:**
1. The new branch admits a synthetic bank end-to-end; the importer's closure check accepts it; the standalone verifier recomputes it.
2. `two-human-unanimous` and `operator-only` branches are byte-unchanged.
3. The screening model can never be confused with a human verdict: distinct evidence class, distinct measurement names, asserted by fixture.
4. Fallback if D1 = defer: the run uses `operator-only` admission and the report discloses the label protocol in prose; this packet then lands post-run.

### P7 — `fix`: ungradeable classes for binary judgment

Seams: `evaluator-adapters/src/binary-judgment/adapter.ts:158` (`unscorable: []`), operational-error mapping (`adapter.ts:198-237`), journal `could-not-grade` terminal (`core/src/run/journal.ts:170`).

**Acceptance:**
1. The declared class list from P0 (at minimum: provider-unavailable, transport-timeout, broker-error) lands in the sealed spec; each has a fixture.
2. A first infrastructure failure consumes the single allowed infrastructure retry; a second lands an accounted unscorable cell — never a silent retry, never a scored REJECT.
3. A Matrix containing such a cell refuses full-claim closure unless the cell is disclosed in accounting (run-stop is visible in artifacts, not just operational discipline).

### P8 — `test`: report-shaped rehearsal (the run-readiness proof)

The 144-cell qualification proof, extended to this report's actual shape, fully synthetic: a main bank with 3 candidate classes × 4 category strata, 6 instrument arms (mixed parser identities, one evidence-declaring arm, dated-snapshot model profile) × `k = 3`; a separate 12-probe gate task set over the same frozen arms; corrupt-key paired tasks (same item, two reference variants); one seeded item marked excluded-and-replaced through the admission ledger; one injected infrastructure failure exercising P7.

**Acceptance:** the full lifecycle — import → admit → bind → quote → lock → launch (stubbed provider) → collect → report (`binary-instrument@1` + P5 methods) → publish bundle → delete workspace → cold standalone verification — passes; the tamper matrix (execution, truth, metric, claim, asset edges) fails deterministically; a license scan proves no third-party bytes; every headline the real report will publish has a synthetic analogue in the produced Report.

### P9 — `docs`: official-run runbook

Operator-facing runbook under `docs/runbooks/`: preflights (snapshot-serving probe, identity/plumbing check), credential and spend setup, freeze linkage (what must already be sealed before `lock`), the run-stop rule and its amendment path, collect/report/publish/verify order, and the go/no-go checklist from §6 reproduced as the operational surface. Follows the official-suite bar (script + runbook precedent).

### R1 — `feat`: site report template renders this report's shape

`packages/benchmark-product/web` renders a `binary-instrument@1` qualification report from P8's synthetic bundle: per-arm results with false-accept and false-reject side by side (never a blended headline), per-class and per-stratum tables, instability and parser-invalid rates, cross-arm section, registry-verified vs sealed-companion marking, license/attribution block. Spec update in the same PR per the frontend rules; no helper-text cruft.

### R2 — `feat`: standing-offer page

The site's standing-offer surface (copy owned research-side; engineering renders it). Required before any principal outreach send; not run-blocking.

### R3 — `test`/dogfood: stranger user-flow

Run the merged self-serve journey end to end as a stranger (from-source now; `npx` path once packages publish), plus a full dry-run of P9's runbook against the P8 fixture. Every friction point filed as an issue. Output is a filed issue list, not code.

### S1/S2 — `design` + `feat`: disclosure-specification record (F7)

S1: a spec generalizing the pinning surface to declared-but-not-executed variables — a sealed record listing the experiment's six variables with per-variable status (measured-here / disclosed-by-publisher / undisclosed), digest-bound into the bundle, verifier-checked for internal consistency (variables the venue ran must match actual pinning evidence; variables it did not run are marked as assertions). S2 implements it. Strategically load-bearing — it turns the report's deliverable into a record type others can publish against — but **never run-blocking**; target is publish-time if review bandwidth allows (D3).

## 5. Orchestration

House model, unchanged from the venue-glue program:

- **Program coordinator** — the execution session's main loop. Never implements. Dispatches lane coordinators, checks gates, shepherds PRs, escalates.
- **Lane coordinators** — one Opus agent per lane, long-lived. Each re-verifies its packet's seam facts against current `origin/next` (this document's citations were read at `7bf98816d`), writes the packet's task-level TDD plan, dispatches implementers, orchestrates review.
- **Implementers** — one agent per discrete task, TDD cycle, self-contained prompts with exact paths from the lane plan.
- **Reviewers** — independent agents per PR; never the implementing lane reviewing itself.
- **Worktrees** — each lane in its own worktree off current `origin/next` (`git worktree add ../jinn-mono_worktrees/<lane>`); all git via `git -C`; coordinator verifies lane worktrees clean after each dispatch. Two stale worktrees from the aborted 2026-08-18 dispatch (`claude/f3-verdict-label-adapter` and the packet-removal branch) are inspected (`git status --porcelain --ignored`) before any reuse or removal.
- **PRs** — one per packet, base `next`, conventional titles matching the packet shape. Handbook rule 4 governs review: every packet PR carries an independent agent review (never the implementing lane) plus an approving review from the operator credential set before it lands — no implementer merges its own unreviewed work. Until the merge-queue flip (#2799) completes, PRs land by the pre-queue ordinary-merge carve-out; after the flip, enqueue on green. `next` currently has zero required status checks, so **every packet PR body records local full-chain verification** (portal build order, affected package suites, architecture/catalog guards) — CI absence is never treated as green.
- **Adversarial pass** — because this program produces the validation artifact, G3 includes an independent adversarial review of the assembled official path (P1–P8 as a system, not per-PR): attack the digest chains, the truth-leak boundaries, the evidence channel, the admission branch, and the rehearsal's tamper matrix. Findings block the run gate until resolved or explicitly waived by the operator.
- **Escalation** — recon contradicting this document, or a packet exceeding its estimate by >50% → stop, report. No silent re-scoping.

## 6. Gates

| Gate | Meaning | Owner |
|---|---|---|
| **G0** | This document merged (docs PR to `next`) — program approved | Operator |
| **G1** | P0 spec merged; D1/D2 ratified inside it | Operator ratifies |
| **G2** | Minimum official path merged and green: P1, P2, P3, P4, P7 (+ P6 if D1 = build) | Coordinator |
| **G3** | P8 rehearsal green cold + adversarial review resolved; P5 landed or its companion-analysis fallback disclosed; P9 merged | Coordinator |
| **G4** | **Run-readiness go/no-go** (checklist below) | **Operator** |
| **G5** | Publish-readiness: R1 renders the real bundle; attribution wording resolved; license packaging (bundle LICENSE / NOTICE / attribution and modification table) approved; S2 if landed | Operator |

**G4 run-readiness checklist** (every box, then the operator calls it):

1. G2 and G3 green on `next`.
2. Research-side: bank built with reserve; screening pass complete; flagged items plus random sample hand-checked; agreement rate computed; exclusions listed; admission closure complete under the D1-chosen mode; seeded sampling script sealed; corrupt-key module (20 × 2) and gate probes (12) built.
3. Freeze manifest cut; the freeze post carries the manifest hashes and the explicit nothing-moves-once-judging-starts clause.
4. In-thread asks closed: missing-judges question (silence keeps the default), the Backboard prompt's provenance recorded per the license brief, per-prompt license register sealed.
5. Live preflights green and recorded as lock inputs: snapshot-serving probe immediately before the run; identity/plumbing preflight within the setup-call budget.
6. Spend authorized against the posted call budget (~5,300 calls); credential custody confirmed.
7. Zero pending design deltas — anything the engineering surfaced that changes the posted design has been posted as a dated amendment in the thread **before** the run.
8. Interpretation table already sealed (it is part of the posted design).

## 7. Timeline and thread cadence

Working estimate, not a promise: P0 ~1 day; P1/P2/P3/P4/P7 in parallel ~3–4 days wall-clock; P6 ~2–3 days parallel; P5 ~2–3 days; P8+P9 ~2 days; adversarial review ~1 day. **~1.5–2 weeks to G4**, with L3 converging in the same window; run, report writing, and publish in the following week. The thread counterpart is responsive on a days-scale cadence and the design post already commits to lock-before-run, so this pace is credible without further in-thread promises.

**Slip rule:** if G4 is not plausibly reachable by ~2026-09-05, the operator posts a short dated status note in the thread (drafted research-side in advance) — the public-amendment fallback, exercised early rather than late. No engineering shortcut ever substitutes for that post.

## 8. Standing prohibitions (restated as program law)

- No representing judge items under another task profile to dodge the importer.
- No unsealed script's output presented as part of the official claim; sealed companion analyses are labeled as such in the report.
- No LLM or manual analyst standing in for the deterministic adapter.
- No treating the three replicate calls of one item as three independent items in any denominator.
- No third-party prompt/dataset/annotation bytes in this repository.
- No fabricated evidence anywhere: every Matrix `match` traces to real admission and pinning evidence.

## 9. Operator decisions

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| **D1** | Label admission: build P6 (screening-model mode) before the run, or run `operator-only` + prose disclosure and land P6 after | Build P6 — it is the label protocol the posted design actually describes, and the flagship bundle should not carry `operator-only-not-publication-grade` | G1 |
| **D2** | Cross-arm projections: registered methods vs sealed companion analyses | Register `pairwise-disagreement`; reuse `paired-delta@1` for the evidence contrast; corrupt-key readout may stay companion in v1 | G1 |
| **D3** | S1/S2 (disclosure record) timing | Design now in parallel; implement post-run during report writing; publish-with if ready, fast-follow otherwise | G3 |
| **D4** | Run spend + credential custody | — | G4 |
| **D5** | Run date + the slip-rule trigger date | Confirm ~2026-09-05 | G0 |
| **D6** | External human-reviewer surface (the other half of F6) | Defer — this report's protocol does not need it | Recorded only |

## 10. Issue reshape (executed with this program)

Parent #2833 remains the umbrella; all children get native Issue Types, native sub-issue links, and project membership. The stale packet-path references are removed from every body.

| Issue | Action | Maps to |
|---|---|---|
| #2833 | Re-body → this document; native sub-issues attached | Program parent |
| #2834 (F3) | **Close** — shipped and registered on `next` (adapter + venue registration) | — |
| #2835 (F1) | **Close** — importer + CLI shipped; residuals are P2/P4 (new issues) | — |
| #2836 (F2) | Re-scope + re-title | P1 |
| #2837 (F4) | Re-scope + re-title | P5 |
| #2838 (F6) | Re-scope + re-title | P6 |
| #2839 (F7) | Keep; body updated with verified seams | S1/S2 |
| New | `design` P0; `feat` P2, P3, P4; `fix` P7; `test` P8; `docs` P9; `feat` R1, R2; `test` R3 | As named |

Adjacent hygiene surfaced by recon, parked for the operator (not this program's scope): demo-1 issues #2611/#2613 still target the deleted `integration/evidence-v1` branch; PR #2729 is conflicted and unreviewed; the merge-queue flip (#2798/#2799) operational steps remain open.
