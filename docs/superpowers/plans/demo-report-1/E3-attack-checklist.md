# E3 — Red-Team Attack Checklist (pre-lock)

**Version:** 0.5 (E1 v0.7 re-attack and closure preparation)
**Date:** 2026-08-13
**Author:** E3 method-stream agent
**Program:** `docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md` (Stage 2, packet E3)
**Objects under attack:** `docs/superpowers/plans/demo-report-1/E1-comparison-frame.md` at Git blob `dedc157d39933742d97c8e088ce744f1a1cc050b` / SHA-256 `fb691b45329aa980ac87958feb0a0b916c95339e186f0022888e204f8f553090` (E1 v0.7 plus exact-head review correction), and `docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md` at Git blob `baf5e4369080c6c0ac8563c615ab54c262189412` / SHA-256 `9e418331965e9f38d6fcbde4bdae0f2710fce5aab85c494c213374e721eb2593`. A version label is not a pin. K3 asserts the frozen drafts at lock equal these objects, or that every later delta has been re-attacked and new pins recorded.

**Recorded re-attack of the E1 v0.3 → v0.7 delta.** The changed surfaces are: native root `CLAUDE.md` replaces the unsupported `AGENTS.md` arm; P2 supplies deterministic source/Skill/CLAUDE construction and symmetric patch exclusion; P2b preserves the true-no-file arm's unverifiable loadout axis; C1 is withdrawn and the C2 repository source is fixed; report framing names Vercel/Hacker News respectfully; network publication is separated from the sealed handoff; the conflict-of-interest and self-run sentences are strengthened. Those changes are attacked by B1–B9, C1–C2, I1–I6, J3, J6–J10, and K3 below. They close no item merely by existing; only the five evidence-backed dispositions recorded in this version are terminal.

**Historical placement seam.** E1's earlier independent review found its work-directory placement claim unsupported and restored placement as a P2 acceptance gate. P2 has since landed, but B4 and B9 deliberately retain independent preview/population checks rather than treating the packet's own green tests as complete experimental evidence.

**2026-08-13 operator amendment.** Baseline B is native root-level `CLAUDE.md`, not the motivating public benchmark's `AGENTS.md` compatibility shim. The amendment preserves the registered question—conditional skill delivery versus always-on native instruction delivery—while removing a loader-semantics ambiguity. Checks below use `CLAUDE.md`; references to `AGENTS.md` survive only when describing the motivating public result or a repository-content exclusion.

**Engineering evidence state at this re-attack.** P1, P2, P2b, P3a, P3b, P4, and P4b are merged. P5 is not: draft PR #2626 at head `8affc469d05e33d9619834bfa4b1ddfb4424d44b` records a pre-P3b fixture, no legal real Docker/Claude execution, and failing required checks. Its PR body still names the now-merged P4 draw correction as a prerequisite. P5 supplies no closure evidence until it reconciles, re-mints, runs the 12-cell path, and passes its required checks.

**Status:** 71 items `open`; 5 have terminal pre-lock dispositions (2 `fixed`, 2 `disclosed-limitation`, 1 `withdrawn`). Eleven open items carry an operator-ratified mitigation. A terminal item may still carry a separately named post-run guard; the disposition is not permission to skip that guard.

---

## 0. What this document is and how it is used

The program's pristine bar: *every criticism a hostile evals-community reader could raise must have either a design answer or an explicit limitation line.* This checklist is the enumeration of those criticisms, written before the method is locked, with a concrete check attached to each so that closing an item is an act of verification rather than an act of judgement.

**Register discipline.** Every item terminates in exactly one of three dispositions, recorded in this file with evidence:

- `fixed` — the design or the code changed; the check now passes; the passing evidence is cited.
- `disclosed-limitation` — the defect is real and stays; the exact limitation sentence that will appear in the report is written into the item.
- `withdrawn` — the attack does not apply; the reason is written into the item.

`noted` is not a disposition. An item that is merely acknowledged is still `open`.

**Guard discipline.** Where an attack has both a design/pre-lock branch and evidence that can exist only after sealing or execution, this file records them separately:

- `Disposition` is the pre-lock answer: `fixed`, `disclosed-limitation`, or `withdrawn`.
- `Guard` is a later equality, ordering, census, or report-copy assertion: `pending`, `passed`, or `failed`.

A terminal disposition with a pending guard counts as closed for the pre-lock design gate, but it does **not** authorize dispatch or final handoff when that guard's stage has arrived. All post-lock/pre-dispatch guards must pass before the first official dispatch; all post-run guards must pass or produce their precommitted limitation before the final bundle seals. A failed guard forces the registered stop/re-lock/abandonment behavior; it never silently reopens researcher choice.

**One interim status.** `open — mitigation ratified, verification pending` marks an item where the operator has ratified a design decision that answers the attack, but the check has not yet been run against the built system. It is a form of `open`, not a disposition: a ratified mitigation is a plan, and a plan that is never verified is exactly the failure mode this register exists to prevent. These items still block lock.

**Lock gate.** No design/pre-lock disposition may be `open` at lock, in either form. After the Benchmark and Run seal, the separate sealed-record equality and E4 ordering guards run; no official cell may dispatch while any post-lock/pre-dispatch guard is pending or failed. This is the program's verification gates 3–4. The final register ships in the report bundle with zero open/noted dispositions and zero pending/failed guards.

**Severity markers.** Most items are ordinary. Three markers exist:

- `blocker-candidate` — if this check fails, the design as drafted cannot be locked without a change; a limitation line is not sufficient because the primary contrast itself would be confounded.
- `hard-pre-lock` — must be resolved before lock; carried from E1's handoff.
- `standing-guard` — the check becomes a permanent automated assertion, not a one-time inspection.

**Origin markers.** `seeded` = surfaced by an earlier packet and carried here with its current disposition. `novel` = first surfaced by this checklist. The distinction exists so a reader can see which of the method's problems were found by the method's own authors and which by an adversary.

**Stages.** `design` = checkable now against documents. `pre-lock` = design or built-system evidence available before sealing. `post-lock/pre-dispatch` = equality or external-ordering evidence that requires the exact sealed Benchmark/Run but must pass before any official cell starts. `post-run` = checked against the official records before the sealed publication handoff.

---

## Surface A — Contamination and leakage

### A1 — "Post-cutoff" is a marking, not decontamination
- **Attack:** the report implies the slate is decontaminated because the tasks postdate the model's training cutoff. It is not; `created_at` on a leaderboard row is an upstream self-declaration, and post-cutoff issue text can still describe a fix that existed in the repository before the cutoff.
- **Check:** grep the report and every derived asset for `decontaminated`, `unseen`, `held out`, `not in training data`. Confirm the only claim made is the narrow one: the fix was published after the stated cutoff, by the upstream row's own marking.
- **Pass:** zero occurrences of the stronger vocabulary; the narrow sentence present verbatim in the limitations; `clean-subset@1`'s `results.basis` published as `self-declared` (never `announcement-anchored`) — `packages/benchmarking/aggregate/src/clean-subset.ts` defines both bases and does not weigh them.
- **Stage:** design, then post-run
- **Status:** open · **Origin:** seeded

### A2 — The cutoff filter runs on an importer-chosen constant, not per-task dates `blocker-candidate`
- **Attack:** the report presents a per-task contamination filter that does not exist. `importSweBench` stamps **one** `provenanceTimestamp` onto every task in the slate (`packages/benchmarking/interop/src/import/swebench.ts:120-121`, default `"2026-07-29T00:00:00Z"`), and `SweRebenchRow` (`packages/task-execution/profiles/src/documents/swe-rebench.ts:13-24`) carries **no** `created_at` field at all. `filterByCutoff` therefore compares every task against the same caller-supplied instant: the filter is all-or-nothing for the whole slate, and its value is chosen by the run owner. On a self-run venue this is a contamination-claim forgery surface, not merely a coarse filter.
- **Check:** (1) `node -e` over the sealed Task bytes for the slate: extract `payload.provenance.timestamp` for every task and assert the number of distinct values. (2) Inspect whether the demo's import path supplies per-row dates or the default. (3) If `clean-subset@1` appears anywhere in the report's method chain, trace the timestamp each task contributes.
- **Pass:** either (a) the importer is extended pre-lock so each task carries its own upstream `created_at`, and distinct-timestamp count > 1 with each value matching the upstream row; or (b) `clean-subset@1` is **not used**, and the report states plainly that the slate's provenance timestamps are a single slate-level attestation set by the run owner, with the value and its justification published.
- **Ratified mitigation:** the P0-interop packet threads the real per-task `created_at` through the importer — branch (a). The declared fallback, if threading proves infeasible, is branch (b): drop `clean-subset@1` and publish the slate-level attestation, with that choice and its reason recorded in the P0-interop PR rather than settled silently.
- **Stage:** pre-lock
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### A3 — Dataset license grants no affirmative right to publish per-task results
- **Attack:** the report publishes per-task outcomes for a CC-BY-4.0 dataset whose terms grant no affirmative permission for that specific use, on rows whose upstream repository licenses are unresolved.
- **Check:** for the locked slate, enumerate every row's upstream repository and record its license. Record the dataset license text and the attribution string actually used. Confirm what is published per task (outcome bit only vs problem text vs patch bytes).
- **Pass:** the report publishes the minimum per-task surface that supports verification (instance id, outcome, cell key) and does not redistribute upstream problem statements or test material; attribution present; the "absence of restriction, not affirmative grant" position stated in the limitations rather than implied as clearance.
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded

### A4 — The instruction content itself may be memorized
- **Attack:** the chosen skill is a widely-published public artifact (Anthropic's skills repository is the C2 default). The model may reproduce its guidance from parametric memory whether or not the file is delivered. That compresses both arms toward the same behavior and, worse, compresses arm C toward them — collapsing the manipulation check by construction.
- **Check:** on the preview slate, run a no-file probe that asks the model to reproduce the content's distinctive procedural steps without the file present. **Metric, declared before the probe runs:** extract from `source.md` a fixed list of *k* distinctive procedural claims (the extraction is done once, committed, and published alongside the probe); recall = fraction of those *k* claims present in the probe output, scored by exact-match on a pre-committed key phrase per claim, not by judgement. Run the probe *n* = 20 times and report mean recall with its Wilson interval.
- **Pass:** **mean recall < 0.25** (the pre-declared cutoff) — the content is not effectively always-on, and arm C is a usable baseline. **Recall ≥ 0.25** does not fail the run; it fails silently *reporting* the run, so the measured recall is published as a limitation on the manipulation check's power and the arm-C contrast is interpreted against it. Both the cutoff and *k* are fixed before the probe runs; adjusting either after seeing recall is the failure this item exists to prevent.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### A5 — Task-specific hints inside the instruction content
- **Attack:** the skill body names a library, a file, or an idiom that happens to be the answer to some slate items, so arm A and arm B both beat arm C for a leakage reason rather than a procedural one.
- **Check:** mechanical cross-reference — tokenize `source.md`; for each slate task, intersect against the gold patch's changed file paths, changed symbol names, and the `failToPass` test identifiers from the sealed EvaluationSpec. Publish the intersection table.
- **Pass:** the intersection is empty, or every non-empty intersection is a generic term justified in writing before any results are seen. The table is published either way.
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded (E1 §2.3 requirement 4) — check newly specified here

### A6 — The `description` string is also a leakage surface
- **Attack:** A5 audits the body. The frontmatter `description` is separate text that only arm A receives, and it is exactly the text most likely to name the task domain. If it names slate-relevant terms, arm A gets a hint arm B does not.
- **Check:** run the A5 intersection procedure separately against the frozen `description` string, and publish that intersection separately from the body's.
- **Pass:** empty intersection, or the overlap is published in the report next to the verbatim description.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### A7 — Grader test identifiers reachable from the agent's workspace
- **Attack:** the agent can read the tests it will be graded on, so the measured quantity is "can it read the tests," and any arm-level difference in how much file exploration the instructions encourage becomes a confound.
- **Check:** inspect the sealed `deterministic-process` familyBlock: where does `testMaterial` land relative to the agent's working directory, and when? Then, on a preview cell, snapshot the agent's working tree at spawn and grep it for the `failToPass` identifiers.
- **Pass:** the `failToPass` identifiers are absent from the agent's workspace at spawn in both arms, or their presence is identical across arms and disclosed.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

---

## Surface B — Skill-content confounds and arm identity

### B1 — The `description` is an un-mirrored routing prompt
- **Attack:** "byte-identical content" is false of the total delivered text. Arm A delivers frontmatter always plus body sometimes; arm B delivers body always. Vercel's own numbers moved 53% → 79% on trigger wording alone, so description quality is a researcher degree of freedom that can decide the headline.
- **Check:** pre-lock, confirm the description is the upstream artifact's own, verbatim, byte-for-byte (`diff` against the upstream file at its pinned commit), and freeze its sha256 as the Benchmark input. Post-lock/pre-dispatch, confirm the sealed Benchmark carries that exact digest. Post-run, confirm no commit touches it after the first preview cell executes (`git log --follow` on the frozen source, timestamps compared against the preview log).
- **Pass:** verbatim match, digest sealed pre-lock, zero post-first-cell edits, and the description reproduced verbatim in the report with the bounded claim ("the mechanism as delivered by its upstream description") present.
- **Stage:** pre-lock disposition; post-lock/pre-dispatch Benchmark equality guard; post-run drift/copy guard
- **Status:** open · **Origin:** seeded

### B2 — Byte provenance from one source is asserted, not audited
- **Attack:** the report claims both arms derive from one `source.md` via a deterministic transform. A reader has no way to check that the transform was actually run, or that it was run against the version that was sealed.
- **Check:** pre-lock, re-run the committed transform from a clean checkout and derive the three expected digests (`source.md`, `SKILL.md`, `CLAUDE.md`). Post-lock/pre-dispatch, assert those values equal the digests in the sealed Benchmark. At handoff, assert the supplied `CLAUDE.md` digest equals `sha256(source.md)` exactly — arm B is the source bytes unchanged, so this is a strict equality, not a re-derivation — and reproduce the Skill byte-slice proof from handoff-only artifacts.
- **Pass:** CI job green on a clean checkout; `sha256(CLAUDE.md) === sha256(source.md)`; `SKILL.md` = frontmatter block ++ `source.md` byte-for-byte, provable by a byte-slice comparison; the cold verifier repeats both equalities from the handoff packet.
- **Stage:** pre-lock transform disposition; post-lock/pre-dispatch Benchmark equality `standing-guard`; handoff/cold-verification guard
- **Status:** open · **Origin:** novel

### B3 — Nobody verified the delivered text ever reached the model `blocker-candidate`
- **Attack:** the experiment can silently degenerate into empty-versus-empty. Arm A's body enters context only on model-initiated activation — Vercel reports the skill was never invoked in 56% of default-behavior cases. Arm B's native `CLAUDE.md` is only always-on if it sits at the repository root Claude Code loads. A null result under either failure is a null about our plumbing, not about the mechanism.
- **Check:** per-cell telemetry, logged and published in aggregate: for arm A, whether the skill body was read (activation event or the body's presence in the transcript); for arm B, whether the file's bytes appear in the model-visible context. Assert on a preview slate before the official run; keep the counters for the official run.
- **Pass:** arm B inclusion rate is 100% of judged cells. Arm A's activation rate is measured, published as a headline-adjacent number, and interpreted: the activation rate **is** part of the mechanism, so a low rate is a result, but an activation rate of 0% means the plumbing failed and the run is not informative.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

### B4 — File placement inside the graded working tree differs between arms `blocker-candidate`
- **Attack:** arm B's `CLAUDE.md` goes at repository root; arm A's skill goes in an isolated Claude Code plugin directory. Both are experiment-created files in or near the graded tree, at different paths. Three distinct failure modes: (i) if patch extraction sweeps untracked files, root `CLAUDE.md` enters arm B's patch and not arm A's; (ii) a read-only file can break cleanup or a container step running as a different UID; (iii) copying a digest-verified input to the wrong directory can leave `CLAUDE.md` outside the repository root Claude Code actually loads, silently nulling arm B.
- **Check:** (1) on a preview cell in each arm, diff the extracted candidate patch against a control run with no loadout; assert byte-identical. (2) Print the absolute materialized path and the absolute repository root; assert the parent-directory relationship the agent's loader actually requires. (3) Run one cell per arm with the container's non-root user configuration the official run will use and assert the file is readable.
- **Pass:** normalized patches byte-identical to the true-no-file control in both arms; `CLAUDE.md` provably at the repository root the agent loads from; the skill provably in a valid isolated plugin layout; no permission or cleanup failure in either arm.
- **Ratified mitigation:** the byte-identity condition is now a **P2 acceptance criterion** — the harvested patch must be byte-identical to the no-loadout control in both arms — so the engineering packet cannot land without it. That moves the check from a red-team inspection to a gate on the arm-wiring work itself; E3 still verifies it independently against the built system rather than accepting P2's own green as the answer.
- **Stage:** pre-lock
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### B5 — Arm C's "empty loadout" is a file, not nothing `blocker-candidate`
- **Attack:** a synthetic empty loadout would create a file and make arm C something other than the true no-file control the report describes. Pursuing a cosmetic pinning `match` must not change the control's meaning.
- **Check:** inspect arm C's resolved requirements, launcher arguments, and prepared working tree. Assert there is no loadout requirement, no plugin flag, no experiment-created `CLAUDE.md`, and no experiment-created plugin path.
- **Pass:** arm C is true no-file, and its loadout axis remains truthfully `unverifiable`; no assembly or report path upgrades it to `match` without evidence.
- **Ratified mitigation:** the operator fixed arm C as the **true no-file control**. It carries no loadout pin, and the loadout axis remains unverifiable. An empty-file equivalence condition may be studied in E2, but it cannot silently replace C or rewrite its evidence state.
- **Evidence:** merged P2 commit `018d13bb9` makes `demo1ClaudeArmRequirements(..., "no-file")` omit `loadout`, removes the plugin argument unless the registered Skill is present, and tests all three plans (`packages/benchmark-product/core/src/venue/demo1-claude.ts:238-286`; `demo1-claude.test.ts:134-150`). Merged P2b commit `bc6b020e3` keeps missing cell evidence `unverifiable` on every axis and affirmative contradiction `mismatch` (`packages/benchmark-product/core/src/run/assembly-ports.test.ts:188-208`).
- **Stage:** pre-lock
- **Status:** fixed · **Origin:** novel

### B6 — The launcher wrapper changes more than one thing
- **Attack:** E1 §2.4 has arm B's launcher drop `--plugin-dir`. That flag does not only remove one skill — it can disable a whole discovery path, so arm A may carry other skills, plugins, or defaults that arm B lacks. The measured delta then includes "plugins on vs plugins off."
- **Check:** capture the full argv and resolved environment for one cell per arm and diff them. Enumerate every skill and plugin discoverable in arm A's plugin dir. Assert the plugin dir contains exactly the one skill under test and nothing else.
- **Pass:** argv diff is exactly the documented flag delta and nothing more; plugin dir inventory is a single skill; both published in the report's configuration appendix.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### B7 — Context-position and token-budget asymmetry
- **Attack:** arm B's body sits in the always-on context from turn one and consumes budget every turn; arm A's body enters mid-conversation, at a different position, and only sometimes. On a long agentic trajectory, an always-on block can crowd out working context or trigger compaction earlier. That is arguably part of the mechanism — but if the report says "identical content" without saying "different context economics," a reader will call it a hidden confound.
- **Check:** log per-cell input-token totals, turn counts, and any compaction or truncation events, per arm. Publish the distributions.
- **Pass:** the token and compaction distributions are published alongside the pass rates, and the report names context economics as part of what the mechanism contrast includes.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### B8 — The frozen source drifted after cells executed
- **Attack:** B1 freezes the `description`. Nothing yet freezes the **body**. If `source.md` is edited mid-program — a typo fix, a clarification, a "small improvement" after a disappointing preview — then cells executed before and after the edit ran different content, and the arms are no longer comparing packagings of one artifact. This is the most tempting edit in the whole program precisely because it feels harmless, and it is the one a digest makes impossible to hide.
- **Check:** extend B1's no-touch assertion from the description to the entire frozen source. Pre-lock, freeze the expected source/artifact digests and start one continuous preview log. Post-lock/pre-dispatch, assert the sealed Benchmark carries those values. Post-run, run `git log --follow` on `source.md`, `SKILL.md` and `CLAUDE.md`, compare every commit timestamp against the first preview dispatch, and assert the handoff files still match the sealed digests.
- **Pass:** **zero commits touching `source.md`, `SKILL.md`, or `CLAUDE.md` at or after the first preview cell's dispatch** — official or preview, no exceptions for whitespace or typos. Sealed digests equal the published files. If an edit did occur, every cell executed before it is void and the run is a re-lock, disclosed as one.
- **Stage:** pre-lock disposition; post-lock/pre-dispatch Benchmark equality; post-run no-touch `standing-guard`
- **Status:** open · **Origin:** novel

### B9 — The instruction file leaks into the extracted patch
- **Attack:** arm B's `CLAUDE.md` and arm A's plugin tree are visible to git status and can be swept into the extracted candidate patch — contaminating the artifact that gets graded asymmetrically. A patch carrying either instruction surface can also fail to apply cleanly in the grader, converting contamination into an arm-correlated infrastructure failure. B4 tests this at the preview level against a no-loadout control; this item is the census across the official run.
- **Check:** for **every judged cell in every arm**, parse the extracted candidate patch and assert zero hunks touch root `CLAUDE.md` or the experiment-created plugin path. Publish the per-arm count of cells with any such hunk — expected zero, and published as zero rather than omitted. B4's byte-identity control covers the no-loadout comparison; this covers the population.
- **Pass:** zero instruction-file hunks across all judged cells in all arms, asserted programmatically over the sealed records rather than sampled; the per-arm count published in the report's disclosures.
- **Ratified mitigation:** this is now a **P2 acceptance criterion** alongside B4's byte-identity condition, so the arm-wiring packet cannot land while the leak is possible. E3 verifies independently against the built system rather than accepting P2's own green — same pattern as B4.
- **Stage:** pre-lock (P2 acceptance), then post-run spot-verification
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

---

## Surface C — Harness, version, and environment drift between arms

### C1 — `effort` is attested, not graded
- **Attack:** the report implies every runtime property was enforced. `effort` is not in pinning verification and is not a Matrix axis.
- **Check:** confirm `effort` is absent from the per-axis pinning verification output; confirm the report's §8.1 block carries the "not a claim that every configured runtime property was independently enforced" line; confirm the held value is published.
- **Pass:** value published, status published as attested, no enforcement implied.
- **Exact limitation sentence:** “Effort was configured and dispatch-gated at `high`, but it is not a graded Matrix axis and run-pinning verification does not independently establish the reasoning depth the model applied; that property is attested only.”
- **Stage:** design, then post-run
- **Status:** disclosed-limitation · **Guard:** pending — post-run exact-sentence/value/status copy check · **Origin:** seeded

### C2 — Harness-config dominance dwarfs the effect under test
- **Attack:** Claw-SWE-Bench (arXiv 2606.12344) measured a 27.4pp pass@1 swing from harness configuration alone on a fixed model. Any mechanism effect we report is small relative to a knob we happened to set one way. A reviewer will say the result is a statement about our harness configuration, not about the mechanism.
- **Check:** publish the complete harness configuration (argv, environment allowlist, tool set, turn and time limits, model id, effort). State the effect-size context explicitly and cite the paper.
- **Pass:** configuration published in full; the report contains a sentence bounding generality to this configuration; the citation present. Not fixable by design — this is a disclosure item, and its absence is the failure.
- **Exact limitation sentence:** “Every cell used one Claude Code harness configuration; generalization to other harnesses or configurations is unknown, and prior work's 27.4 percentage-point harness-choice swing is why this result is bounded to the exact configuration sealed here.”
- **Stage:** design, then post-run
- **Status:** disclosed-limitation · **Guard:** pending — post-run configuration/citation/exact-sentence copy check · **Origin:** seeded

### C3 — Hosted-model drift across a multi-day run
- **Attack:** "same model id" is not "same weights." A hosted endpoint can change behind a stable identifier between the first cell and the last. If arms are run in blocks rather than interleaved, drift aliases directly onto the arm contrast.
- **Check:** record the provider-reported model identifier and any version or system fingerprint on **every** cell, not once per run; assert a single distinct value across the run, or partition the analysis and disclose.
- **Pass:** one distinct fingerprint across all judged cells, or the change is disclosed with its cell boundary and the primary contrast re-checked within the stable block.
- **Stage:** pre-lock (instrumentation), post-run (assertion) `standing-guard`
- **Status:** open · **Origin:** novel

### C4 — Run order aliases onto arm
- **Attack:** if all arm-A cells run before all arm-B cells, then any time-varying nuisance — provider load, container cache warmth, disk pressure, rate limiting — is confounded with the arm.
- **Check:** the execution schedule is a pre-declared, seeded interleave of `(task, arm, replicate)` triples committed before lock. Post-run, assert the realized dispatch timestamps show no arm-by-time separation: **a two-sample Kolmogorov–Smirnov test on the per-arm dispatch-time distributions, plus the difference in per-arm median dispatch time expressed as a fraction of total run duration.**
- **Pass:** schedule committed pre-lock; **KS test does not reject at α = 0.05, and the per-arm median dispatch times differ by less than 10% of total run duration**; any forced re-ordering (a retry, a resume) is logged and reported. Both thresholds declared pre-lock.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

### C5 — Harness auto-update mid-run
- **Attack:** the coding agent updates itself, or its container base image is a mutable tag, and the version changes between cells. This repo has already been bitten by mutable-tag staleness on operator images.
- **Check:** pin the harness by exact version and record the resolved version per cell; assert one distinct value across all judged cells. Disable auto-update explicitly in the run environment and prove it in the captured environment.
- **Pass:** one distinct harness version across the run; auto-update provably disabled; both published.
- **Stage:** pre-lock `standing-guard`
- **Status:** open · **Origin:** novel

### C6 — Replicate independence: shared caches and state bleed
- **Attack:** replicates are treated as independent draws, but they may share a warm package cache, a persisted harness state directory, a resumed session, or a Docker layer cache mutated by an earlier replicate. Correlated replicates inflate apparent precision exactly the way singleton clustering did.
- **Check:** enumerate every path shared across replicates (harness state root, working-dir root, container volumes, HTTP or package caches). For each, decide isolate-or-declare. Then test empirically on **at least 10 tasks × 5 replicates** in both forward and reversed order, and test for a position effect: **Cochran's Q across replicate positions** on the paired outcome bits (the correct test for correlated binary outcomes at k > 2 positions; McNemar's is its k = 2 special case).
- **Pass:** every shared path either isolated per cell or declared in the report; **Cochran's Q does not reject at α = 0.05 across replicate positions**; if state is intentionally shared, replicates are treated as within-cluster and the statistics account for it. Test, sample size, and α declared pre-lock.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### C7 — Clock and budget asymmetry: does loading count against the agent?
- **Attack:** if the agent operates under a wall-clock or turn budget, arm B spends part of its first turn ingesting an always-on block while arm A may spend a whole turn deciding to load and then loading. Whichever way it falls, one arm has less budget left for the actual task, and the reported effect is partly a budget effect.
- **Check:** record per cell: wall time to first tool call, total turns, total wall time, and whether any budget limit was hit. Compare distributions across arms. Separately, confirm the grader's own per-task `timeout` (sealed in the familyBlock) is identical across arms — it derives from the task, so this should hold by construction; assert it rather than assume it.
- **Pass:** budget-limit-hit rate published per arm; **if the per-arm rates differ by more than 2 percentage points, or a two-proportion test on them rejects at α = 0.05**, the report says the contrast includes a budget-consumption component; grader timeouts identical across arms by assertion. The threshold is declared here, before the counts exist.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### C8 — Preview and official runs used different builds
- **Attack:** E2's power analysis, the MDE, and B5's arm-C decision all rest on preview evidence. If the previews ran on a different harness version, model, grader image, or container runtime than the official run, then the variance estimate calibrates a system that never executed, and the declared MDE is a number about a different experiment. This is a silent failure — previews happen early, while the stack is still being built, which is exactly when drift is most likely and least noticed.
- **Check:** record the full build fingerprint on every preview cell — harness version, model identifier and provider fingerprint, grader program digest (D1), per-task image digests (D2), container runtime version. Freeze the official expected fingerprint pre-lock; after Run sealing and before dispatch, assert its sealed values equal that expectation. Record and compare the same fingerprint on every official cell.
- **Pass:** **identical fingerprints across MDE-feeding previews and the official run**, asserted field by field. Where a component legitimately changed after the previews, the affected previews are re-run on the official build before their numbers are used, or the MDE and the arm-C decision are recomputed and the earlier previews disclosed as superseded rehearsals under F3's count.
- **Stage:** pre-lock instrumentation/disposition; post-lock/pre-dispatch sealed-fingerprint equality; post-run census `standing-guard`
- **Status:** open · **Origin:** novel

---

## Surface D — Grader validity

### D1 — Per-instance grader images are built by the venue operator
- **Attack:** the venue operator both runs the arms and controls the grading environment. Nobody audits the bake. A grader image can differ from the upstream reference in ways that change which patches pass.
- **Check:** pre-lock, record who built every candidate image, from what Dockerfile or upstream reference, and when; freeze the selected image provenance and grader-program digest in the method. Post-lock/pre-dispatch, assert the sealed Benchmark/Run/Task material carries those exact values. Post-run, assert every official verdict carries one distinct grader digest equal to the precommitted value.
- **Pass:** image provenance published per task; any venue-baked image accompanied by its build inputs; the grader digest present in the locked method document and identical on every official verdict; the report states plainly that grading environments were produced by the run owner where that is true (§7.1 self-run posture extended to the grader).
- **Ratified mitigation:** C2's ruling freezes the grader program itself and publishes its digest **at lock, in the method document**. That converts "trust the venue's bake" into a pre-committed value a reader can compare against every verdict — the grader can no longer be changed mid-run or after results are seen without the digest mismatch being visible in the published records.
- **Stage:** pre-lock provenance/disposition; post-lock/pre-dispatch sealed-record equality; post-run verdict census `standing-guard`
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### D2 — Image descriptors need not carry a digest `blocker-candidate`
- **Attack:** the grader image is a `ResourceDescriptorLike`, and the schema requires only *one* of `uri`/`digest`/`content` (`packages/task-execution/profiles/src/resource-descriptor.ts:48-50`). A uri-only, tag-addressed image is mutable: the same sealed Task can grade differently next week, and two cells in the same run can pull different bytes.
- **Check:** pre-lock, freeze a 100%-digest-addressed image inventory and prove the actual container invocation uses `image@sha256:` with **`--pull never`**. Post-lock/pre-dispatch, assert every sealed EvaluationSpec carries its selected digest and pre-stage all exact images locally. Post-run, re-pull one image and confirm the digest is unchanged.
- **Pass:** 100% of slate tasks carry an image digest; runtime invocation is digest-addressed and carries `--pull never`; images pre-staged locally so the run cannot reach a registry mid-flight; post-run re-pull matches.
- **Ratified mitigation:** C2's ruling — task images are digest-pinned **and** run with `--pull never`. The digest pin makes the bytes nameable; `--pull never` makes a registry substitution mid-run impossible rather than merely detectable, and turns a missing image into a loud failure instead of a silent fetch of whatever the tag points at today.
- **Stage:** pre-lock implementation/disposition; post-lock/pre-dispatch sealed-spec equality and prestage; post-run repull `standing-guard`
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### D3 — Fail-to-pass / pass-to-pass transitions are inherited, not verified
- **Attack:** the verdict rests on `transitions.failToPass` and `passToPass` from the upstream row. If a listed test is flaky, already passing at base commit, or absent, the grader's `passed` bit is not measuring what the report says.
- **Check:** a gold-patch validation pass over the locked slate: for each task, run the grader on the empty patch (expect fail-to-pass tests failing, pass-to-pass tests passing) and on the gold patch (expect all passing). Record every task that violates either expectation.
- **Pass:** every locked task passes both legs, or violating tasks are excluded by a rule declared before any arm result is seen and the exclusion count is published.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### D4 — Grader nondeterminism
- **Attack:** the same patch graded twice yields different verdicts — network-dependent test suites, timing-sensitive tests, ordering-sensitive suites. Nondeterministic grading adds variance that the paired design cannot cancel and that the interval does not model.
- **Check:** re-grade a sample of stored candidate patches a second time and compute the disagreement rate. Separately, confirm the container runs with networking disabled or explicitly declared.
- **Pass:** disagreement rate measured and published; if non-zero, it feeds E2's variance model rather than being ignored; network posture declared.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### D5 — `unscorable` is grader-declared and one-sided
- **Attack:** the sealed spec declares `unscorable: [{ name: "environment-setup-failure", disposition: "retryable-infrastructure" }]`. Whether a failure is "environment setup" versus "the agent broke the environment" is a judgement made by the grading path, and it decides whether the cell is retried or scored. A systematically different rate of that judgement between arms is a denominator game the venue commits against itself without intending to.
- **Check:** publish `unscorable` counts per arm from the Report's `attrition.perArm` block (the record schema already carries `unscorable`, `unjudged`, `expired`, `invalidated`, `excluded`, `replacements` per arm). Test whether the arm difference in unscorable rate is larger than chance.
- **Pass:** per-arm unscorable counts published; **an asymmetry exceeding 2 percentage points of the per-arm expected-cell count, or rejecting at α = 0.05 under a two-proportion test**, is investigated and disclosed, never silently absorbed by retries. Threshold declared pre-lock.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### D6 — Parser identity is pinned but not validated
- **Attack:** `parser.digest` pins the test-output parser, but a pinned parser can still mis-parse a suite it was not written for, producing false negatives concentrated in whichever arm produces unusual output.
- **Check:** on the gold-patch validation pass (D3), assert the parser reports full pass on every task. Then hand-confirm the parse on a sample of failing official cells: **30 cells, drawn by the pre-registered bootstrap seed, stratified to at least 10 per arm** so a parser failure concentrated in one arm is detectable rather than averaged away.
- **Pass:** gold-patch parse is clean on 100% of the slate; **all 30 sampled failure parses hand-confirmed correct — any single mis-parse escalates to a full-slate re-parse rather than being recorded as an acceptable rate.** Sample size, stratification and draw procedure declared pre-lock.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

---

## Surface E — Denominator games and attrition

### E1 — Asymmetric infra retries and timeouts between arms
- **Attack:** one arm got more attempts, or one arm hit the wall clock more often. Neither is visible in a pass rate. Timeouts are the sharper version: if a timeout is silently retried, the slower arm gets extra attempts; if it is silently dropped, the slower arm gets a smaller denominator. Either way the arm that the mechanism makes slower is scored on different terms.
- **Check:** log retry count per cell with its trigger, and timeout count per cell, separately. Publish both totals per arm. Assert the retry policy text and the timeout scoring rule were frozen pre-lock and applied identically. Assert no timed-out cell was retried or excluded.
- **Pass:** per-arm retry counts **and** per-arm timeout counts both published as disclosures; policies identical and pre-declared; **an asymmetry in either exceeding 2 percentage points of the per-arm expected-cell count, or rejecting at α = 0.05 under a two-proportion test**, disclosed and discussed rather than netted out. Same threshold as D5, declared pre-lock.
- **Ratified mitigation:** **timeout = FAIL, declared pre-lock.** A timed-out cell scores as a failure; it is not retried and not excluded. This removes the discretion that made the timeout path a denominator game, and makes the slower arm's slowness show up in the result rather than in the accounting. Per-arm timeout counts join per-arm retry counts as required published disclosures, so a reader can see how much of any effect is timeout-driven.
- **Evidence:** the exact suitability policy is frozen in the program at `docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md:22`, and the official policy is frozen at §E5: timeouts and post-dispatch agent failures count as FAIL; only pre-dispatch infrastructure failures receive at most one recorded retry under the same identity; no task replacement or added cell is permitted. E1 v0.7 §2.7 requires both per-arm counts in the sealed report.
- **Stage:** pre-lock (policy), post-run (counts)
- **Status:** fixed · **Guard:** pending — post-run per-arm retry/timeout counts and asymmetry check · **Origin:** seeded

### E2 — Selective attrition via the both-arms-judged rule
- **Attack:** a paired analysis needs both arms judged for a task to contribute. If a task drops out because *one* arm failed to produce a judged cell, and dropout is correlated with difficulty, the surviving pairs are a biased subsample — and the bias runs against whichever arm fails more often. The pairing rule that makes the statistics clean is the same rule that creates the selection.
- **Check:** count tasks dropped for one-arm-unjudged, broken down by which arm was missing. Compare the dropped tasks' characteristics (repository, patch size, test count) against the retained ones. Run the primary contrast a second time on an intention-to-treat basis where an unjudged cell counts as a failure, and publish both numbers.
- **Pass:** dropout counts published per arm; the intention-to-treat sensitivity analysis published alongside the primary result; the primary and sensitivity results agree in sign, or the disagreement is the headline.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### E3 — Only `judged` cells enter any score
- **Attack:** the denominator is the set of cells that happened to work, which flatters the run.
- **Check:** `selectScorableCells` admits `outcome === "judged"` only (`packages/benchmarking/aggregate/src/exclusion.ts`); everything else lands in `excluded` with its cell keys. Assert `expected`, `judged`, and the full `attrition.perArm` block appear in the published report, and that `runOutcome` is consistent with the declared completeness floor (the records layer enforces this in `completeness.ts`, so assert the published values rather than trusting the label).
- **Pass:** expected and judged counts published; excluded cell keys published; `runOutcome` matches the floor arithmetic; no headline stated without its denominator adjacent.
- **Stage:** post-run
- **Status:** open · **Origin:** seeded (design §9.3) — assertion newly specified

### E4 — The completeness floor is chosen to make the run look complete
- **Attack:** `runOutcome: "complete"` requires the declared floor to pass. If the floor is declared late or loosely, "complete" is a label the owner granted itself.
- **Check:** choose and freeze the floor value in the method before lock. Post-lock/pre-dispatch, assert the sealed Run carries that exact value and record its relationship to the first dispatch. Post-run, assert the sealed Report and handoff method disclose the frozen value and any re-lock.
- **Pass:** floor sealed pre-execution; value present in the sealed Report and handoff packet; if the floor was ever changed, the run is a re-lock and is disclosed as one.
- **Stage:** pre-lock disposition; post-lock/pre-dispatch sealed-Run equality guard; post-run report/handoff guard
- **Status:** open · **Origin:** novel

### E5 — `replacements` quietly restores the denominator
- **Attack:** the attrition block carries a `replacements` count. Replacing a failed cell with a fresh attempt is a retry by another name, and if replacement is available it can be applied unevenly.
- **Check:** publish `replacements` per arm; assert the replacement rule was pre-declared; assert replacement never re-draws a *task* (which would be a slate change post-lock), only a cell.
- **Pass:** counts published, rule pre-declared, slate membership provably unchanged from the sealed Benchmark digest.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

---

## Surface F — Stopping rules, exclusions, and Goodharting

### F1 — Stopping-rule ambiguity
- **Attack:** the run stopped when the numbers looked good. Without a pre-declared stopping rule, every interval is optimistic.
- **Check:** the Run record's declared cell count (`arms × tasks × replicates`) is fixed at lock. Post-run, assert judged + excluded = expected exactly, and that no cell exists outside the sealed plan.
- **Pass:** exact accounting; no top-ups; the program's "no replicate top-up after lock" constraint provably honored.
- **Stage:** post-run
- **Status:** open · **Origin:** seeded

### F2 — Pre-declared exclusion rules can still be Goodharted
- **Attack:** an exclusion predicate that is legitimate in the abstract ("exclude tasks whose container fails to build") can be outcome-correlated in practice, and it was written by people who had already run previews. Pre-declaration proves timing, not innocence.
- **Check:** for every exclusion rule, state whether it can be evaluated **without** looking at any arm's outcome. Classify each as outcome-blind or outcome-aware. For each outcome-blind rule, evaluate it against the slate *before* lock and publish the resulting exclusion list as part of the locked slate rather than applying it later.
- **Pass:** every exclusion rule classified; outcome-blind rules applied pre-lock so the locked slate is the final slate; outcome-aware rules either eliminated or their exclusions published with per-arm counts.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### F3 — Previews are peeks, and the preview log is scoped to a draft id
- **Attack:** §7.2 makes previews honest by disclosing them. But the preview log lives at `previews/<draftId>/log.json` (`packages/benchmark-product/core/src/workspace/layout.ts:128-138`) and the bundle emits the rehearsal block only when `previewCount > 0` on **that draft** (`bundle/materialize.ts:370-378`, `previewCount` typed `.positive()`). Rehearsals performed under a discarded or differently-named draft are structurally invisible to the disclosure. The mechanism discloses the previews you kept.
- **Check:** enumerate every draft id created during the program (`ls` the workspace `previews/` root, plus the audit journal) and reconcile against the single draft that reaches lock. Publish the total across all drafts, not the surviving draft's count.
- **Pass:** one continuous draft id from first preview to lock, or a manually-authored total covering all drafts published in the limitations with the discarded drafts named.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

### F4 — The permitted re-lock is a legal peek
- **Attack:** the program permits one re-lock before any official cell executes. An adversary reads that as one free look at a locked design followed by a revision.
- **Check:** if a re-lock occurs, assert from the audit journal that zero official cells executed between the first seal and the re-lock, and record the reason for the re-lock in the report.
- **Pass:** zero official cells between seals, provable from timestamps; re-lock and its reason disclosed in the report whether or not anyone asks.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### F5 — Preview-derived power analysis is reused as evidence
- **Attack:** E2 estimates variance from previews. If the preview slate overlaps the official slate, the MDE and the design were tuned on the same tasks the run scores.
- **Check:** assert the preview slate and the official slate are disjoint by instance id, and disjoint by repository if clustering is at repository level. Publish both id lists.
- **Pass:** empty intersection at the clustering unit, published.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### F6 — Content-artifact selection is an unregistered forking path
- **Attack:** E1 §2.3 narrows the content candidates but does not name one. The viable set is explicitly "narrow and must be named before lock" — which means somebody chooses, and the choice can be made after preview effect sizes are visible. Selecting the skill that previewed best is the garden of forking paths in its purest form: every individual step defensible, the aggregate a guarantee of an inflated effect. It is more dangerous than the exclusion-rule version (F2) because it never appears in any record — an unchosen candidate leaves no trace.
- **Check:** the selection procedure is written and committed **before any preview effect size exists**: the candidate set enumerated, the selection criteria stated (domain compatibility with the slate, license, upstream description present, non-triviality), and the decision rule fixed. Post-hoc, assert from commit timestamps that the artifact was named before the first preview cell dispatched. Publish the full candidate set and the reason each non-selected candidate was rejected.
- **Pass:** selection procedure and chosen artifact committed **before the first preview cell's dispatch timestamp**; the full candidate list published with rejection reasons, so a reader can see what was not chosen; zero changes of artifact after any effect size is visible. A change after that point is a re-lock, disclosed as one — not a re-selection.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

---

## Surface G — Prompt injection and task content

### G1 — Injection surface in `problem_statement`
- **Attack:** slate problem statements are attacker-controlled text from public issue trackers. Text inside them can instruct the agent, and if any of it references skills, `CLAUDE.md`, `AGENTS.md`, or context files, the injection interacts *differently* with the two arms — a differential injection sensitivity that is indistinguishable from a mechanism effect.
- **Check:** grep every locked task's `problem_statement` and `instructions` for `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, `skill`, `system prompt`, `ignore previous`, `instruction`, and for imperative second-person directives addressed to a tool. Publish the hit list.
- **Pass:** hits reviewed individually; any task whose text addresses an agent or names either mechanism is excluded by a rule declared before results are seen; the hit list published.
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded (program E3 scope) — check newly specified

### G2 — The issue text contains the fix
- **Attack:** some upstream issues include the patch, a link to the fixing commit, or a maintainer's exact instruction. Those tasks measure transcription, not engineering, and they compress the arm difference toward zero.
- **Check:** for each task, test whether the problem statement contains a diff hunk, a commit URL, or the changed file paths from the gold patch. Publish counts.
- **Pass:** counts published; **if the share exceeds 10% of the locked slate**, the affected tasks are either excluded by a pre-declared rule or the share is named as a limitation on the slate's discriminative power. Threshold declared here, before the slate is scanned.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### G3 — Repository content can carry its own instructions
- **Attack:** the checked-out repository may already contain an `AGENTS.md`, a `CLAUDE.md`, a `.cursorrules`, or a skills directory. Arm B would then overwrite or coexist with a native instruction file; arm C would not actually be instruction-free; arm A could compete with repository instructions.
- **Check:** for every locked task at its base commit, enumerate agent-instruction files in the tree. Publish the inventory.
- **Pass:** inventory empty, or a pre-declared, uniform handling rule applied identically and disclosed. P2 must fail closed rather than overwrite an existing root `CLAUDE.md` or its reserved experiment plugin path; task eligibility must exclude any other pre-existing instruction surface that would violate the true-no-file control.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

---

## Surface H — Statistics

### H1 — Singleton clusters made the intervals ~3× too narrow
- **Attack:** the importer keys task provenance on `repo@base_commit` (`packages/benchmarking/interop/src/import/swebench.ts:70`), so every task is its own cluster — measured 100/100 singletons against 77 distinct repositories. A cluster bootstrap over singleton clusters is just an i.i.d. bootstrap, and the published interval understates uncertainty by roughly the square root of the design effect.
- **Check:** after the interop fix, derive the candidate slate's ordered repository cluster manifest pre-lock and assert `clusterCount < taskCount`. Post-lock/pre-dispatch, assert it equals the sealed Benchmark/Run task set. The e2e gate carries the standing regression guard `draws === resamples × clusterCount` — the identity is exact and a silent regression to singletons breaks it. Post-run, compare the sealed Report disclosure byte-for-byte with the locked manifest.
- **Pass:** clusterCount equals the distinct-repository count on the locked slate; the e2e assertion is present and green; the cluster manifest (keys and members) appears unchanged in the sealed Report's method disclosures and handoff packet.
- **Ratified mitigation:** the clustering-key fix lands in the interop packet pre-lock, and the `draws === resamples × clusterCount` assertion becomes a standing e2e guard so a regression to singleton clusters cannot pass CI silently.
- **Stage:** pre-lock manifest/disposition; post-lock/pre-dispatch sealed-slate equality `standing-guard`; post-run report/handoff guard
- **Status:** open — mitigation ratified, verification pending · **Origin:** seeded

### H2 — Design effect and paired ICC assumed rather than measured
- **Attack:** the cluster-weighted multiplier Σm²/Σm ≈ 2.08 on the naive standard error at measured concentration is a *marginal* design effect. The paired delta likely has a much smaller ICC because repository difficulty cancels in the difference. Assuming either direction is a choice that moves the interval.
- **Check:** E2 computes the empirical ICC of the *paired delta* by repository from preview data, and reports the realized design effect from the clustered bootstrap (compare the clustered interval width against an unclustered one on the same data).
- **Pass:** measured ICC and realized design effect published; the power analysis uses the measured value; the report never states a design effect it did not compute.
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded

### H3 — The bootstrap seed is an unregistered researcher degree of freedom `hard-pre-lock`
- **Attack:** `seed` is an ordinary method parameter, an integer in `[1, 4294967295]` (`packages/benchmarking/aggregate/src/registry.ts:234`), and the report author chooses it. Nothing stops trying seeds until the interval excludes zero. With 10,000 resamples the seed-to-seed wobble is small but not zero, and near a boundary it decides the verdict. A hostile reader will ask how the seed was chosen and there is currently no answer.
- **Check:** bind the resolved integer seed in the method before lock. Post-lock/pre-dispatch, assert the sealed Run seed equals that precommitted value exactly. Post-run, recompute the primary interval across at least 20 seeds and include the min/max endpoints and resulting verdicts in the handoff report.
- **Pass:** the pre-registered seed and the sealed Run seed are equal, both published; the seed-sensitivity table published; the verdict is invariant across all tested seeds, or the instability is the headline finding rather than a footnote.
- **Ratified mitigation:** the seed is **bound pre-lock in the method document**. It is no longer a report-time choice, so "which seed did you use" has a pre-committed answer a reader can check against the sealed Run record. The equality check is the whole mitigation: a seed published at lock that does not match the seed the run actually used is the same defect wearing a disclosure.
- **Stage:** pre-lock seed disposition; post-lock/pre-dispatch sealed-Run equality; post-run sensitivity guard
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### H4 — Two-sided interval built from two one-sided calls
- **Attack:** `clusteredPairedRateDiffBca` returns a `lowerBound` only. A two-sided interval assembled by calling it at α and at 1−α is a legitimate BCa construction, but three details make it auditable rather than obvious: both endpoints use `Math.floor(adjustedQuantile * resamples)` (`stats/noninferiority.ts:198`), so the upper endpoint is taken from the floor-indexed order statistic where convention takes the ceiling — the two endpoints are not constructed symmetrically; both calls must use the same seed and the same resample set or the endpoints come from different bootstrap distributions; and the returned field is named `lowerBound` in both calls, so a mislabeled endpoint is an easy and invisible bug.
- **Check:** conformance fixtures for `paired-delta@1` compared against an independent oracle (R `boot::boot.ci(type="bca")` or an independently written Python implementation) on at least three synthetic datasets with known structure, including one with unequal cluster sizes. Assert both endpoints match the oracle, and assert the two calls share a seed.
- **Pass:** **each endpoint agrees with the oracle to within 1 order statistic of the sorted resample vector, and within 0.002 in absolute rate units**, on every fixture. Both bounds are declared here, pre-lock: the order-statistic bound is what a floor-versus-ceiling index rule can legitimately cost, and the absolute bound keeps that from being a licence for arbitrary drift. Construction (two calls, α and 1−α, shared seed, index rule) documented in the method's published description; endpoint labels correct.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### H5 — Bias correction under a coarsely discrete statistic
- **Attack:** `z0` is computed from `below = means.filter(v => v < observed).length` — a strict inequality (`stats/noninferiority.ts:185`). The paired-delta statistic is discrete: with N tasks and R replicates its values are multiples of 1/(N·R). Bootstrap means therefore tie with the observed value at non-trivial mass, and strict `<` assigns all tie mass to the upper side, biasing `z0` low and shifting the whole interval.
- **Check:** report the tie mass `#{means === observed} / resamples` alongside the interval. Recompute the interval under the mid-p convention (`below + ties/2`) and compare endpoints.
- **Pass:** tie mass published; **endpoints under the strict-`<` and mid-p conventions differ by less than 0.005 in absolute rate units and the verdict is identical under both** — or, where they differ by more, the convention is declared pre-lock and the size of its effect published next to the interval. Bound declared here, pre-lock.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### H6 — The `1e-6` clamp turns a degenerate case into a plausible number
- **Attack:** `below/resamples` is clamped into `[1e-6, 1-1e-6]` before `invNorm` (`stats/noninferiority.ts:186`). When the observed statistic sits at or beyond the edge of the bootstrap distribution — which happens with few clusters or a near-deterministic outcome — the clamp produces `z0 ≈ ±4.75` and the function returns a confident-looking bound instead of refusing. A degenerate case is indistinguishable from a real one in the output.
- **Check:** assert `below/resamples` lands inside a declared non-degenerate band (e.g. `[0.001, 0.999]`) for the published interval; if it does not, the report says the bootstrap was degenerate and reports the point estimate with an explicit no-interval statement.
- **Pass:** the realized `below/resamples` value published in the method disclosures; inside the band, or the degeneracy disclosed rather than papered over.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### H7 — Estimand weighting: point estimate vs bootstrap statistic
- **Attack:** the point estimate is the unweighted mean over tasks (`mean(ordered)`), but each bootstrap replicate draws whole clusters and averages over the drawn *members*, so with unequal cluster sizes the resample statistic is a size-weighted ratio whose expectation is not the observed task-mean. The interval is then centered on a slightly different estimand than the point estimate. The BCa bias correction absorbs some of this, which is exactly why it is easy to miss.
- **Check:** on the locked slate's cluster-size profile, simulate: draw from a known-truth generator, compute the observed statistic and the bootstrap distribution, and measure the offset between the bootstrap mean and the observed value. Declare which estimand the report claims — mean over tasks, or mean over repositories — and confirm the point estimate and the resampling scheme agree with it.
- **Pass:** the estimand named in one sentence in the report; **the simulated offset between the bootstrap mean and the observed statistic is below 0.005 in absolute rate units, and below 10% of the reported interval's half-width** — or the report uses the cluster-mean estimand consistently in both the point estimate and the resampling scheme. Both bounds declared here, pre-lock; the half-width-relative bound is the load-bearing one, since a fixed absolute bound means little against a wide interval.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### H8 — Multiple comparisons across primary, secondary, and any subgroup
- **Attack:** the design has a primary contrast (A vs B), a secondary manipulation check ((A ∪ B) vs C), and an obvious temptation to look at per-repository or per-language breakdowns. Each additional look inflates the false-positive rate, and reporting the best one is the classic abuse.
- **Check:** pre-lock, freeze exactly one primary contrast, one secondary contrast, and the rule that any other cut is exploratory without inference. Post-lock/pre-dispatch, assert the E4 witness commits to that exact sealed Run/method. Post-run, count every interval in the report and confirm each is labeled primary, secondary, or exploratory.
- **Pass:** counts match the pre-registration; exploratory cuts carry no confidence claims; no subgroup result appears in a headline or a derived asset.
- **Stage:** pre-lock comparison disposition; post-lock/pre-dispatch preregistration equality; post-run interval census
- **Status:** open · **Origin:** novel

### H9 — MDE gaming
- **Attack:** the minimum detectable effect is declared after variance is known, at whatever value the design happens to achieve, and then presented as a design target. Or a null is reported as "no effect."
- **Check:** freeze the achieved E2 MDE and its interpretation in the method before lock. Post-lock/pre-dispatch, assert the sealed Run carries that exact value. Post-run, confirm the report prints it and that any null is phrased "we cannot detect effects smaller than X" with X equal to the sealed value.
- **Pass:** sealed pre-run, printed post-run, identical value, correct phrasing; every derived asset that mentions a null carries the MDE or links directly to it.
- **Stage:** pre-lock MDE disposition; post-lock/pre-dispatch sealed-Run equality; post-run copy guard
- **Status:** open · **Origin:** seeded

### H10 — Interval misreporting
- **Attack:** a 95% interval described as "95% probability the true effect lies in this range," or a one-sided bound presented as a two-sided interval, or a bound whose sign convention is flipped.
- **Check:** the sign convention is fixed in code as `delta = pB - pA` (`stats/noninferiority.ts:169`), so the report must state which arm is `baseline` and which is `candidate` and confirm the published sign matches the parameters actually passed. Read the report's interval sentence against this template, declared here so the check is a comparison rather than a judgement: *"The estimated difference in per-task pass rate (arm X minus arm Y) is D. A 95% bias-corrected and accelerated bootstrap interval, clustered on task provenance source, runs from L to U. Under repeated application of this procedure, 95% of such intervals would contain the true difference."* Assert the report contains no probability statement about the parameter — grep for `probability that the true`, `95% chance`, `we are 95% confident that the effect is`.
- **Pass:** arm-to-parameter mapping published; sign of the published estimate reproducible by hand from the per-arm rates; the interval sentence matches the template's claim structure; zero grep hits for the forbidden phrasings.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### H11 — The estimator was built by the party publishing the result
- **Attack:** `paired-delta@1` was built for this eval by the same program that will emit the result. It is merged and versioned, including the shared-draw correction at integration commit `834f3436d`, but same-party authorship remains the structural definition of an estimator-level researcher degree of freedom. At this re-attack, `npm view @jinn-network/benchmarking-aggregate version` returns E404, and H4's independent three-fixture oracle is still absent.
- **Check:** the method must be released as an exact canary/package artifact *before* lock, with its independent review and H4 conformance evidence. Assert the method id and version recorded in the Report match the handoff-supplied artifact whose commit predates the Run seal. Assert no commit touches the method's numerics between lock and handoff.
- **Pass:** exact method artifact released pre-lock and pinned in the Report; zero numerics commits in the lock-to-handoff window; independent oracle fixtures included so a reader can re-derive the interval.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** seeded (C3 scope) — audit procedure newly specified

### H12 — The slate may not discriminate
- **Attack:** the source leaderboard's top-5 models sit within 2.2 points, inside 2×SEM. A slate that cannot separate frontier models is unlikely to separate two packagings of the same instructions. Reporting a null on such a slate as informative is the denominator game one level up.
- **Check:** state the slate's demonstrated discriminative range from public leaderboard spread, next to the declared MDE. Test whether the MDE is smaller than the spread the slate has historically resolved.
- **Pass:** both numbers printed together; if the MDE exceeds what the slate has ever resolved, the report says so in the limitations before it reports any result.
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded

### H13 — The replicate-aggregation rule is unstated and outcome-changing
- **Attack:** each `(task, arm)` pair has R replicates, and how they collapse to one per-task rate decides the headline. Three defensible rules give three different answers: **mean-rate** (`c/n`, what `avgAtOne` computes — `packages/benchmarking/aggregate/src/stats/pass-at-k.ts`), **any-pass** (`passAtK` at k = n, which scores a task solved if any replicate solved it), and **majority**. Any-pass systematically favors the higher-variance arm, because variance alone buys you a pass; mean-rate does not. If the mechanism under test changes variance rather than mean — entirely plausible, since arm A's activation is itself a stochastic event (B3) — then the choice of rule can flip the sign of the reported effect. The registry offers both estimators, so this is a live fork, not a hypothetical.
- **Check:** name the aggregation rule in the method before lock. Post-lock/pre-dispatch, assert it equals the sealed method parameters exactly. Post-run, recompute the primary contrast under all three rules and include the sensitivity table in the handoff report.
- **Pass:** rule pre-declared and matching the sealed method parameters exactly; **the sensitivity table published regardless of whether the rules agree**, and if they disagree in sign or verdict, that disagreement appears next to the headline rather than in an appendix. The pre-declared rule is the headline whatever the others say.
- **Stage:** pre-lock aggregation disposition; post-lock/pre-dispatch sealed-parameter equality; post-run sensitivity guard
- **Status:** open · **Origin:** novel

---

## Surface I — Venue self-trust and integrity tiers

### I1 — Self-run venue disclosure
- **Attack:** the run is graded by its own owner and the report reads as if pre-registration made it trustworthy.
- **Check:** the product's exact sentence appears verbatim in the report: “Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.” Confirm the venue label is `self-run`.
- **Pass:** sentence present verbatim in both places; label correct.
- **Stage:** design, then post-run
- **Status:** open · **Origin:** seeded

### I2 — Matrix integrity tier is `attested-only`
- **Attack:** the report implies a re-derivable result. SWE-shaped tasks mint no admission receipts, so the tier cannot be `re-derivable` for demo 1.
- **Check:** assert the published tier on the Matrix is `attested-only`; grep the report and derived assets for `reproducible`, `re-derivable`, `verified independently`.
- **Pass:** tier published as `attested-only`; stronger vocabulary absent; the limitation states it is disclosed, not fixed.
- **Stage:** post-run
- **Status:** open · **Origin:** seeded

### I3 — Pre-registration ordering rests on local append order and a local clock
- **Attack:** on the local venue, pre-registration is structural plus append-order only. The lock timestamp is the run owner's wall clock, which the run owner controls. "Pre-registered" therefore means "appears earlier in a file the owner writes."
- **Check:** pre-lock, freeze the mandatory E4 procedure and fallback sentence. After the Run seals and before dispatch, anchor the exact Run digest to an externally timestamped surface, read it back, and assert that timestamp precedes the first official dispatch. Post-run, require the Report and handoff packet to carry the exact witness facts or the exact frozen local-only fallback sentence.
- **Pass:** external witness exists and precedes execution, with its CID/transaction/timestamp reproduced in the handoff, or the sealed Report and handoff state that the ordering guarantee is local-only and the owner could in principle have retro-registered. One of the two, explicitly.
- **Stage:** pre-lock procedure disposition; post-lock/pre-dispatch external-ordering guard; post-run report/handoff guard
- **Status:** open — post-lock/pre-dispatch evidence pending · **Origin:** novel

### I4 — Run-owner key custody
- **Attack:** the Report is DSSE-signed under a run-owner key held by the same party as everything else. A reader cannot distinguish "signed by the run owner" from "signed by whoever had the key," and key rotation mid-program would go unnoticed.
- **Check:** include the run-owner and report-signing key identifiers in the sealed handoff; assert the expected key relationship across the Run and Report; state the custody facts that are actually known. List long-term publication key custody as an explicitly unresolved publication decision rather than implying this program selected a policy.
- **Pass:** exact key identifiers and observed signer relationship included in the handoff; present custody facts stated; no long-term publication-custody claim made; the unresolved publication decision listed explicitly.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### I5 — Method registry version resolved at report time
- **Attack:** the Report resolves methods from `BENCHMARKING_METHOD_REGISTRY` at report time. If the registry version differs between lock and report, the numbers come from a method the lock did not commit to.
- **Check:** record the resolved method id and version in the sealed Run record at lock; assert the Report's method version equals it.
- **Pass:** exact equality, asserted programmatically, both values published.
- **Stage:** post-run `standing-guard`
- **Status:** open · **Origin:** novel

### I6 — Public pre-registration silently skipped or post-dated
- **Attack:** E4's public pre-registration is the strongest thing this program has against I3's local-clock weakness, and it is also the easiest step to quietly drop when the schedule tightens. Two failure shapes: it never happens and the report still describes itself as pre-registered; or it happens *after* cells have run and is presented as if it preceded them. On a self-run venue the run owner controls both timestamps, so "we pre-registered" is unfalsifiable without an external witness.
- **Check:** pre-lock, freeze the mandatory E4 adapter/read-back procedure and fallback wording. Post-lock/pre-dispatch, assert the external anchor timestamp — on a surface whose timestamp the run owner does not control — precedes the first official dispatch, and compare the anchored Run digest against the sealed Run bytes exactly rather than against a summary.
- **Pass:** external anchor timestamp strictly precedes first-cell dispatch; anchored digest equals the sealed Run digest; both timestamps and the digest printed in the report. If E4 cannot be completed, no official cell dispatches under the committed branch; any operator decision to abandon E4 requires a new disposition and removal of every “pre-registered” claim before execution.
- **Ratified mitigation:** E4 public pre-registration is **committed, conditional on the e2e gate being green**. The conditionality is the honest part — the program will not publicly commit to a run it cannot yet execute — but it also means the trigger must be checked rather than assumed, and the fallback wording must exist before it is needed.
- **Stage:** pre-lock procedure disposition; post-lock/pre-dispatch digest/ordering guard; post-run report-copy guard
- **Status:** open — mitigation ratified, post-lock/pre-dispatch evidence pending · **Origin:** novel

---

## Surface J — Publication-surface honesty

### J1 — §8.1 must-not-imply pass over the report
- **Attack:** the report implies one of the eight prohibited things: distinct identities prove distinct parties; an evaluator majority is correct; local execution proves owner honesty; every runtime property was enforced; network execution is confidential; every benchmark is cheaper on the network; the report is a certification or universal ranking; the branded product is required to verify the result.
- **Check:** line-by-line pass over the report against the eight-item list, recorded as an eight-row table with the report line that discharges each.
- **Pass:** all eight discharged with a cited line; guarantees, observations, estimates, attestations and unverifiable claims **visually, linguistically, and structurally** distinct — §8.1 requires all three, and structural distinctness (separate blocks or fields, not merely different wording in the same paragraph) is the one most easily lost in edit passes.
- **Stage:** post-run
- **Status:** open · **Origin:** seeded

### J2 — §8.2 pass over every derived asset
- **Attack:** the report is careful and the social card is not. A headline, badge, README snippet or machine-readable claim states a materially broader claim than the run supports, or drops the limitations.
- **Check:** enumerate every derived asset produced (the claim package is the mechanical form) and check each for: scope statement present, limitations preserved or directly linked, canonical report linked, adverse results not hidden, report digest attributed.
- **Pass:** every asset passes all five; assets that cannot carry the scope statement are not published.
- **Stage:** post-run
- **Status:** open · **Origin:** seeded

### J3 — "Identical content" overclaims
- **Attack:** the headline says the arms had identical content. B1 establishes that this is true of the body and false of the total delivered text.
- **Check:** grep for "identical" across the report and all derived assets; confirm every occurrence is qualified to the instruction *body*.
- **Pass:** zero unqualified occurrences.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### J4 — The novelty claim is conditional and the condition may fail `hard-pre-lock`
- **Attack:** the report claims to be first to hold bytes fixed while varying delivery. SkillJuror (arXiv 2606.11543) compares progressive disclosure against a "normalized flat baseline" and the mechanical definition of that baseline is unresolved. If it is an always-on context file, this report is a replication and the novelty claim is false.
- **Check:** obtain the SkillJuror PDF or an authoritative description and extract the exact construction of the flat baseline — is the flattened variant still routed through skill activation, or is it loaded unconditionally? Record the quoted passage and its location.
- **Pass:** definition extracted and quoted; the report's framing set accordingly — novel contrast, or explicitly a replication with the differences named. An unresolved item at lock blocks lock.
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded (E1 §1.5 handoff)

### J5 — Cited-adjacent literature published between draft and lock
- **Attack:** a paper appears in the weeks between E1's citation sweep (2026-08-11) and lock that runs this exact contrast, and the report's motivation is stale on publication day.
- **Check:** repeat the literature sweep within 72 hours of lock, covering at minimum the works E1 saw but did not fetch (HANDBOOK.md 2607.25398, MalSkillBench 2606.07131, Skill-to-LoRA 2606.16769, SkillGenBench 2605.18693, SKT 2608.02287) plus a fresh search. Record the sweep date in the report.
- **Pass:** sweep performed and dated; any newly relevant work cited; the gap statement in §1.6 still true or amended.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### J6 — SWE-Skills-Bench artifact availability, if the C1 content upgrade is pursued
- **Attack:** the report cites a 49-skill set whose artifact repository returned 404 at E1's verification. Adopting content from an unavailable artifact on the strength of a paper is exactly the sourcing failure the report criticizes elsewhere.
- **Check:** re-fetch the artifact repository; if reachable, record its license and the exact commit; if not, C1 stays blocked and C2 is used.
- **Pass:** either verified availability plus license recorded, or C1 formally withdrawn in writing.
- **Evidence:** E1 v0.7 §2.3 formally withdraws C1 for Demo-1 and fixes the source repository to C2 (`anthropics/skills`); the program's outcome-blind C2 selection rule at §E1 permits no late source switch.
- **Stage:** pre-lock
- **Status:** withdrawn · **Origin:** seeded (E1 §1.7 handoff)

### J7 — Naming Vercel raises the bar on our own arithmetic
- **Attack:** if the report frames itself as the controlled version of a named company's comparison, every number we publish gets read adversarially by that company's readers, and any arithmetic slip becomes the story.
- **Check:** because the operator selected named respectful framing, require a full independent recomputation of every reported number from the sealed records by a second agent, plus a fact-check of every attributed figure against the source post.
- **Pass:** independent recomputation matches; every attributed figure quoted accurately with its source; no characterization of the other work beyond what its own text supports.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### J8 — Third-party recomputability is claimed but never exercised
- **Attack:** the report says a reader can verify the numbers independently, and nobody has ever tried. The failure modes are mundane and fatal: the verifier is missing from the handoff, the bundle omits an input, an exact package artifact is absent or version-drifted, a fixture is referenced but not shipped, or recomputation needs a credential only the run owner has. “Verifiable in principle” stated as “verified independently” is the same overclaim §8.1 forbids elsewhere.
- **Check:** a clean-environment rehearsal performed by someone who did not build the run. Give that verifier only the sealed bundle, exact handoff-supplied canary/package artifacts, public keys, and one-command verifier. Recompute every number and displayed claim byte-for-byte. Record anything needed that was not in the handoff packet. Do not require a network package registry, public report URL, builder worktree, private state, or execution credential.
- **Pass:** clean-environment recomputation reproduces every reported number and displayed claim byte-for-byte from handoff-supplied exact artifacts, with no private input or credential. Any gap is closed before handoff or the recomputability claim is removed — not softened, removed. Whether those artifacts later resolve through public distribution is a publication-only check explicitly left in the handoff.
- **Scope, and why it stops where it does:** this is **statistical recomputation from sealed outcome bits** — the Matrix's per-cell outcomes, Report, sealed Run parameters, and exact method artifact — not task re-execution. A3's license posture deliberately withholds upstream problem statements and test material, so the report states: *the arithmetic is independently checkable; the agent runs are not independently repeatable from this bundle.*
- **Ratified mitigation:** a **clean-environment third-party recompute from handoff-supplied exact artifacts**, performed by someone who did not build the run, is required before the publication handoff closes.
- **Stage:** post-run
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### J9 — No conflict-of-interest statement
- **Attack:** the report is produced by a party that built the venue, wrote the estimator, chose the slate, selected the content artifact, ran both arms, graded the results, and stands to benefit from the benchmark product gaining credibility. Each of those facts is disclosed somewhere in the bundle; none of them is collected in one place where a reader meets them before the numbers. A reviewer who assembles that list themselves will present it as something we concealed, and the diffuse disclosure will not read as a defense.
- **Check:** the limitations section contains an explicit conflict-of-interest statement naming, at minimum: the venue is self-run by the report's author; the estimator was built by the same program that publishes the result (H11); the grading environment was produced by the run owner (D1); and the report's purpose includes demonstrating the product it runs on. Confirm it appears in the report and in any derived asset long enough to carry it.
- **Pass:** the statement is present, in one place, stated plainly rather than distributed across footnotes, and positioned so a reader encounters it with the result rather than after it.
- **Ratified mitigation:** a **conflict-of-interest statement is required in the report's limitations**. The disclosures it collects already exist across the bundle; the ratified decision is that they must appear together, as a statement, rather than being reconstructable by a determined reader.
- **Stage:** post-run
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### J10 — Data availability at handoff and after publication
- **Attack:** the report links artifacts that later move, expire, or sit behind a service the run owner stops paying for, and the verification path rots. A published benchmark whose evidence is unresolvable in a year is a claim, not a record — and this program's own charter puts evidence outliving the product at the center. The subtler version: a reader cannot tell *what* is guaranteed to remain resolvable, so they assume everything is, and discover otherwise at the worst moment.
- **Check:** state explicitly in the report that **sealed Task records are self-contained** — the sealed bytes carry the instructions, payload, inputs and EvaluationSpec digest, so a Task is interpretable from its own content without a live upstream fetch. Enumerate what is *not* self-contained: grader images, upstream repositories at base commits, dataset rows, package distribution, and any future report/discovery origins. For each, state the current retention dependency and whether a handoff copy exists. List clean-environment public-link resolution as a remaining publication-only check rather than pretending a not-yet-created URL was tested.
- **Pass:** the self-containment statement is present and accurate; the dependency inventory and current retention posture are in the handoff; no permanence claim exceeds actual custody; all not-yet-created origins are explicitly unresolved publication decisions. The later publication program owns public-link resolution and retention-policy acceptance.
- **Ratified mitigation:** data availability is addressed explicitly at the handoff boundary, and the report **states that sealed Tasks are self-contained** so the boundary between bundle-contained evidence and externally retained dependencies is legible.
- **Stage:** post-run
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

---

## Surface K — Process integrity of the red team itself

### K1 — Every item terminates
- **Attack:** the register ships with items marked "noted" or "acknowledged," which is a fig leaf.
- **Check:** before lock, assert every design/pre-lock disposition carries `fixed`, `disclosed-limitation`, or `withdrawn`, each with evidence or an exact limitation sentence. Before dispatch, assert zero pending/failed post-lock guards. Before final handoff, assert every one of the 76 items is terminal and every guard has passed or produced its precommitted limitation.
- **Pass:** at the final handoff, zero `open`, zero `noted`, zero pending/failed guards.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### K2 — Limitation sentences are written before the results are known
- **Attack:** a limitation drafted after seeing the numbers is written to protect the result.
- **Check:** every `disclosed-limitation` disposition carries its exact sentence in this file, committed before lock; post-run, diff the report's limitations against those sentences.
- **Pass:** the report's limitations are a superset of the pre-lock sentences, with any additions themselves justified.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

### K3 — Sign-off, and the attacked object, are both pinned by digest
- **Attack:** two versions of the same failure. (i) Sign-off happens on a one-paragraph summary and the operator never sees the open items. (ii) **The register was written against a draft that has since moved.** E1 has already changed twice during this packet's authoring — including a `withdrawn` disposition on placement that its own review then found unsupported. A register that attacks digest X and is signed against a frozen draft at digest Y is a register that certifies nothing, and the gap is invisible unless someone asserts it.
- **Check:** the sign-off references the method, E1, program, and this register at exact content digests. Assert the E1/program pins in this header equal the frozen drafts at lock. The register cannot contain its own digest without a circular mutation, so the closure packet and operator sign-off record the final register Git blob and SHA-256 externally. If any value differs, diff the versions and re-attack every changed section before lock; record that delta and outcome.
- **Pass:** sign-off records all exact content digests, including this register's externally recorded final digest; the signed files equal the bundle files; every post-pin delta has a recorded re-attack and replacement pin.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

---

## Register summary

All figures below are recounted programmatically from this file's own headings and status lines, not incremented by hand.

| Surface | Items | Open | Fixed | Disclosed | Withdrawn | Seeded | Novel |
|---|---:|---:|---:|---:|---:|---:|---:|
| A — Contamination and leakage | 7 | 7 | 0 | 0 | 0 | 3 | 4 |
| B — Skill-content confounds and arm identity | 9 | 8 | 1 | 0 | 0 | 1 | 8 |
| C — Harness, version, environment drift | 8 | 6 | 0 | 2 | 0 | 2 | 6 |
| D — Grader validity | 6 | 6 | 0 | 0 | 0 | 0 | 6 |
| E — Denominator games and attrition | 5 | 4 | 1 | 0 | 0 | 2 | 3 |
| F — Stopping rules, exclusions, Goodharting | 6 | 6 | 0 | 0 | 0 | 1 | 5 |
| G — Prompt injection and task content | 3 | 3 | 0 | 0 | 0 | 1 | 2 |
| H — Statistics | 13 | 13 | 0 | 0 | 0 | 5 | 8 |
| I — Venue self-trust and integrity tiers | 6 | 6 | 0 | 0 | 0 | 2 | 4 |
| J — Publication-surface honesty | 10 | 9 | 0 | 0 | 1 | 4 | 6 |
| K — Red-team process integrity | 3 | 3 | 0 | 0 | 0 | 0 | 3 |
| **Total** | **76** | **71** | **2** | **2** | **1** | **21** | **55** |

**Markers:** 5 `blocker-candidate` (A2, B3, B4, B5, D2): B5 is fixed; the other four remain open and cannot be discharged by a limitation line. 2 `hard-pre-lock` (H3, J4), both open. 9 `standing-guard` (B2, B8, C3, C5, C8, D1, D2, H1, I5) — checks that become permanent automated assertions rather than one-time inspections.

**By earliest stage:** design 4, pre-lock 52, post-run 20 (unchanged; items with multiple stages count at the earliest). Fourteen items now name a separate post-lock/pre-dispatch sealed-record or ordering guard: B1, B2, B8, C8, D1, D2, E4, H1, H3, H8, H9, H13, I3, I6.

**Status:** 71 open, 5 terminal — 59 literal plain `open` statuses and 12 qualified `open — …` statuses (11 mitigation-ratified qualifications plus I3's post-lock/pre-dispatch evidence-pending qualification); 2 `fixed` (B5, E1), 2 `disclosed-limitation` (C1, C2), and 1 `withdrawn` (J6). C1, C2, and E1 retain named post-run guards. This is closure preparation, not a claim that the method is ready to lock.

**Ratified mitigations folded in (v0.2–v0.3), by the item they answer:**

| Item | Ratified decision |
|---|---|
| A2 | P0-interop threads real per-task `created_at`; declared fallback is dropping `clean-subset@1` for a slate-level attestation, recorded in that PR |
| B4 | Byte-identity of the harvested patch against a no-loadout control becomes a P2 acceptance criterion |
| B5 | 2026-08-13 operator decision fixes arm C as true no-file with its loadout axis truthfully `unverifiable`; E2's empty-loadout condition remains diagnostic only and cannot replace C |
| B9 | Zero instruction-file hunks in the extracted patch — a P2 acceptance criterion alongside B4 |
| D1 | Grader program frozen; its digest published at lock in the method document and asserted equal on every official verdict |
| D2 | Task images digest-pinned and run with `--pull never` |
| E1 | Timeout = FAIL declared pre-lock; per-arm timeout counts join per-arm retry counts as published disclosures |
| H1 | Clustering-key fix lands pre-lock; `draws === resamples × clusterCount` becomes a standing e2e guard |
| H3 | Bootstrap seed bound pre-lock in the method document; sealed Run seed must equal it |
| I6 | E4 public pre-registration committed, conditional on the e2e gate |
| J8 | Clean-environment third-party recompute from handoff-supplied exact artifacts |
| J9 | Conflict-of-interest statement required in the limitations |
| J10 | Handoff dependency/retention inventory required; sealed Tasks stated to be self-contained; public-link resolution deferred to publication |

Repository evidence closes B5 and the pre-lock policy leg of E1 in this version. C1 and C2 close as disclosed limitations with exact sentences and pending post-run copy guards; J6 closes by formal withdrawal. Every other ratified mitigation remains open until its stated evidence passes.

**Items added in v0.3, after independent review:** B8 (frozen source drifted after cells executed), B9 (instruction file leaks into the extracted patch), C8 (preview and official runs used different builds), F6 (content-artifact selection is an unregistered forking path), H13 (replicate-aggregation rule unstated and outcome-changing), J10 (post-publication data availability). Five of the six are forking paths or freeze failures — the class of defect that leaves no trace in the published record unless something asserts against it beforehand, which is why they belong in a pre-lock register rather than a post-run review.
