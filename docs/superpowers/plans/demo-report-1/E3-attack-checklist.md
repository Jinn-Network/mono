# E3 — Red-Team Attack Checklist (pre-lock)

**Version:** 0.3 (weapons prepared; operator-ratified mitigations folded in; review findings applied; no verdicts issued)
**Date:** 2026-08-12
**Author:** E3 method-stream agent
**Program:** `docs/superpowers/plans/2026-08-11-demo-report-1-skill-ab-program.md` (Stage 2, packet E3)
**Object under attack:** `docs/superpowers/plans/demo-report-1/E1-comparison-frame.md`, pinned by content at blob `dd8a7244ec85ca6bfbac02145ef3f9ae49f055d0` (commit `6da31a636`, E1 v0.3, operator-approved frame). A version label is not a pin — E1 moved twice while this checklist was being written and will move again before lock. The digest names the object these attacks were actually written against; K3 asserts the frozen draft at lock is that object, or that the delta has been re-attacked.

At the pinned digest, E1 §2.8 records the pinning-asymmetry question as **withdrawn** — arm-A/arm-B symmetric enforcement treated as a settled finding, arm C's mechanics settled by pre-lock evidence rather than operator fiat (B5 is the evidence gate for that). One operator question remains open there, publication framing, tracked here at J7.

**Known in-flight delta at time of writing.** E1's independent review found the work-directory placement claim underlying that withdrawal unsupported at head, and §2.8's question is being restored in re-scoped form: not withdrawn, but *confirmed by P2's acceptance gate*. This checklist already treats placement as unsettled and attacks it directly (B4, B9), so the restore narrows the gap between the two documents rather than opening a new one. It is recorded here because it is exactly why the pin is a digest: when E1's head moves, K3 forces a re-read rather than letting a stale "withdrawn" propagate into the lock as if E3 had accepted it.

**Status:** All items `open`. This document is the attack surface enumeration and the executable check for each attack. It does not yet pass or fail the method. Thirteen items carry an operator-ratified mitigation, which changes what the check tests but does not close the item — a ratified plan is not a verified one.

---

## 0. What this document is and how it is used

The program's pristine bar: *every criticism a hostile evals-community reader could raise must have either a design answer or an explicit limitation line.* This checklist is the enumeration of those criticisms, written before the method is locked, with a concrete check attached to each so that closing an item is an act of verification rather than an act of judgement.

**Register discipline.** Every item terminates in exactly one of three dispositions, recorded in this file with evidence:

- `fixed` — the design or the code changed; the check now passes; the passing evidence is cited.
- `disclosed-limitation` — the defect is real and stays; the exact limitation sentence that will appear in the report is written into the item.
- `withdrawn` — the attack does not apply; the reason is written into the item.

`noted` is not a disposition. An item that is merely acknowledged is still `open`.

**One interim status.** `open — mitigation ratified, verification pending` marks an item where the operator has ratified a design decision that answers the attack, but the check has not yet been run against the built system. It is a form of `open`, not a disposition: a ratified mitigation is a plan, and a plan that is never verified is exactly the failure mode this register exists to prevent. These items still block lock.

**Lock gate.** No item may be `open` at lock, in either form. This is the program's verification gate 3 ("E3 red-team register closed"). The closed register ships in the report bundle, so the dispositions are public.

**Severity markers.** Most items are ordinary. Three markers exist:

- `blocker-candidate` — if this check fails, the design as drafted cannot be locked without a change; a limitation line is not sufficient because the primary contrast itself would be confounded.
- `hard-pre-lock` — must be resolved before lock; carried from E1's handoff.
- `standing-guard` — the check becomes a permanent automated assertion, not a one-time inspection.

**Origin markers.** `seeded` = surfaced by an earlier packet and carried here with its current disposition. `novel` = first surfaced by this checklist. The distinction exists so a reader can see which of the method's problems were found by the method's own authors and which by an adversary.

**Stages.** `design` = checkable now against documents. `pre-lock` = must be checked against the built system before the Run record seals. `post-run` = checked against the official run's records before publication.

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
- **Check:** confirm the description is the upstream artifact's own, verbatim, byte-for-byte (`diff` against the upstream file at its pinned commit); confirm its sha256 is in the Benchmark record before lock; confirm no commit touches it after the first preview cell executes (`git log --follow` on the frozen source, timestamps compared against the preview log).
- **Pass:** verbatim match, digest sealed pre-lock, zero post-first-cell edits, and the description reproduced verbatim in the report with the bounded claim ("the mechanism as delivered by its upstream description") present.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** seeded

### B2 — Byte provenance from one source is asserted, not audited
- **Attack:** the report claims both arms derive from one `source.md` via a deterministic transform. A reader has no way to check that the transform was actually run, or that it was run against the version that was sealed.
- **Check:** the transform is a committed script with no inputs other than `source.md` and the frontmatter block. Re-run it from a clean checkout in CI and assert the three digests (`source.md`, `SKILL.md`, `AGENTS.md`) equal the digests sealed in the Benchmark record. Assert the published `AGENTS.md` digest equals `sha256(source.md)` exactly — arm B is supposed to be the source bytes unchanged, so this is a strict equality, not a re-derivation.
- **Pass:** CI job green on a clean checkout; `sha256(AGENTS.md) === sha256(source.md)`; `SKILL.md` = frontmatter block ++ `source.md` byte-for-byte, provable by `tail -c` comparison.
- **Stage:** pre-lock `standing-guard`
- **Status:** open · **Origin:** novel

### B3 — Nobody verified the delivered text ever reached the model `blocker-candidate`
- **Attack:** the experiment can silently degenerate into empty-versus-empty. Arm A's body enters context only on model-initiated activation — Vercel reports the skill was never invoked in 56% of default-behavior cases. Arm B's `AGENTS.md` is only always-on if it sits where the agent looks for it. A null result under either failure is a null about our plumbing, not about the mechanism.
- **Check:** per-cell telemetry, logged and published in aggregate: for arm A, whether the skill body was read (activation event or the body's presence in the transcript); for arm B, whether the file's bytes appear in the model-visible context. Assert on a preview slate before the official run; keep the counters for the official run.
- **Pass:** arm B inclusion rate is 100% of judged cells. Arm A's activation rate is measured, published as a headline-adjacent number, and interpreted: the activation rate **is** part of the mechanism, so a low rate is a result, but an activation rate of 0% means the plumbing failed and the run is not informative.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

### B4 — File placement inside the graded working tree differs between arms `blocker-candidate`
- **Attack:** arm B's `AGENTS.md` goes at repository root; arm A's skill goes in a skills directory. Both are extra files in or near the graded tree, at different paths, written by `materializeAt` at mode `0o400` (`packages/task-execution/backend-local/workspace/src/materialize.ts:39`). Three distinct failure modes: (i) if the grader extracts the candidate patch with `git add -A`/`git diff HEAD`, an untracked root-level `AGENTS.md` enters arm B's patch and not arm A's; (ii) a read-only file inside the tree can break `git clean`, `git checkout`, or a container step running as a different UID; (iii) `materializeLoadout` writes at `join(inputDir, pin.name)` — if the repository is checked out into a subdirectory of the work dir, arm B's `AGENTS.md` is **not** at repository root and may never be loaded at all, silently nulling arm B.
- **Check:** (1) on a preview cell in each arm, diff the extracted candidate patch against a control run with no loadout; assert byte-identical. (2) Print the absolute materialized path and the absolute repository root; assert the parent-directory relationship the agent's loader actually requires. (3) Run one cell per arm with the container's non-root user configuration the official run will use and assert the file is readable.
- **Pass:** patches byte-identical to the no-loadout control in both arms; `AGENTS.md` provably at the repository root the agent loads from; no permission or cleanup failure in either arm.
- **Ratified mitigation:** the byte-identity condition is now a **P2 acceptance criterion** — the harvested patch must be byte-identical to the no-loadout control in both arms — so the engineering packet cannot land without it. That moves the check from a red-team inspection to a gate on the arm-wiring work itself; E3 still verifies it independently against the built system rather than accepting P2's own green as the answer.
- **Stage:** pre-lock
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### B5 — Arm C's "empty loadout" is a file, not nothing `blocker-candidate`
- **Attack:** E1 §2.4 pins arm C as a digest over a zero-byte file so all three arms reach `match` on the loadout axis. But `materializeLoadout` writes a file at `pin.name`. So arm C is not "no instruction file" — it is "an empty file named *something*". If that name is `SKILL.md`, arm C ships a malformed skill (no frontmatter, no description) whose loader behavior is undefined; if it is `AGENTS.md`, arm C ships an empty always-on context file. Either way the baseline is not the baseline the report describes, and the pursuit of `unverifiableAxisCounts.loadout = 0` has bought a cosmetic disclosure number at the cost of the control arm's meaning.
- **Check:** determine the exact `pin.name` arm C materializes and inspect the agent's startup behavior with that file present: does the loader warn, error, or index a nameless skill? Compare against a genuinely unpinned control on the preview slate — same tasks, no file — and test whether arm-C outcomes differ.
- **Pass:** either arm C's materialized artifact is demonstrably behaviorally identical to no file at all (preview evidence, not argument), or arm C runs unpinned and the report publishes `unverifiableAxisCounts.loadout = 1` with the reason. A cosmetically stronger disclosure number that misdescribes the control arm fails.
- **Ratified mitigation:** the arm-C baseline is an **empirical pre-lock decision, not a design preference** — E2's preview evidence chooses between the two branches. If the preview shows behavioral identity between the materialized empty file and no file at all, arm C keeps the pin; if it does not, arm C runs unpinned and the disclosed `unverifiableAxisCounts.loadout` count carries the reason. The pass criterion is therefore the preview evidence standard: a stated sample size and outcome comparison sufficient to distinguish the two, declared before the previews run. Neither branch may be selected by argument.
- **Stage:** pre-lock
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

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
- **Check:** extend B1's no-touch assertion from the description to the entire frozen source. `git log --follow` on `source.md`, `SKILL.md` and `AGENTS.md`; compare every commit timestamp against the first preview cell's dispatch timestamp from the preview log. Independently, assert the digests sealed in the Benchmark record match the files at HEAD at publication.
- **Pass:** **zero commits touching `source.md`, `SKILL.md`, or `AGENTS.md` at or after the first preview cell's dispatch** — official or preview, no exceptions for whitespace or typos. Sealed digests equal the published files. If an edit did occur, every cell executed before it is void and the run is a re-lock, disclosed as one.
- **Stage:** pre-lock, then post-run `standing-guard`
- **Status:** open · **Origin:** novel

### B9 — The instruction file leaks into the extracted patch
- **Attack:** arm B's `AGENTS.md` is placed inside the task's git working tree on a SWE slate, so it is visible to `git status` and `git diff` and can be swept into the extracted candidate patch — contaminating the very artifact that gets graded, and doing so asymmetrically between arms because arm A's file sits at a different path. A patch carrying an unrelated root-level markdown file can also fail to apply cleanly in the grader, converting a contamination bug into an arm-correlated infrastructure failure. B4 tests this at the preview level against a no-loadout control; this item is the census across the official run, because a control that passed once does not prove every cell was clean.
- **Check:** for **every judged cell in every arm**, parse the extracted candidate patch and assert zero hunks touch the instruction file path (`AGENTS.md`, the skill path, or arm C's materialized path). Publish the per-arm count of cells with any such hunk — expected zero, and published as zero rather than omitted. B4's byte-identity control covers the no-loadout comparison; this covers the population.
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
- **Stage:** design, then post-run
- **Status:** open · **Origin:** seeded

### C2 — Harness-config dominance dwarfs the effect under test
- **Attack:** Claw-SWE-Bench (arXiv 2606.12344) measured a 27.4pp pass@1 swing from harness configuration alone on a fixed model. Any mechanism effect we report is small relative to a knob we happened to set one way. A reviewer will say the result is a statement about our harness configuration, not about the mechanism.
- **Check:** publish the complete harness configuration (argv, environment allowlist, tool set, turn and time limits, model id, effort). State the effect-size context explicitly and cite the paper.
- **Pass:** configuration published in full; the report contains a sentence bounding generality to this configuration; the citation present. Not fixable by design — this is a disclosure item, and its absence is the failure.
- **Stage:** design, then post-run
- **Status:** open · **Origin:** seeded

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
- **Check:** record the full build fingerprint on every preview cell and every official cell — harness version, model identifier and provider fingerprint, grader program digest (D1), per-task image digests (D2), container runtime version. Assert the fingerprint set used by the previews that fed E2 and B5 is identical to the official run's.
- **Pass:** **identical fingerprints across MDE-feeding previews and the official run**, asserted field by field. Where a component legitimately changed after the previews, the affected previews are re-run on the official build before their numbers are used, or the MDE and the arm-C decision are recomputed and the earlier previews disclosed as superseded rehearsals under F3's count.
- **Stage:** pre-lock `standing-guard`
- **Status:** open · **Origin:** novel

---

## Surface D — Grader validity

### D1 — Per-instance grader images are built by the venue operator
- **Attack:** the venue operator both runs the arms and controls the grading environment. Nobody audits the bake. A grader image can differ from the upstream reference in ways that change which patches pass.
- **Check:** for every image used, record who built it, from what Dockerfile or upstream reference, and when. Prefer upstream-published images unmodified. Where the venue bakes, publish the build recipe and the resulting digest. **Additionally, per the ratified ruling:** assert the locked method document contains the frozen grader program's digest, and assert every official verdict carries that same digest value — a single distinct grader digest across all judged cells, equal to the one published at lock.
- **Pass:** image provenance published per task; any venue-baked image accompanied by its build inputs; the grader digest present in the locked method document and identical on every official verdict; the report states plainly that grading environments were produced by the run owner where that is true (§7.1 self-run posture extended to the grader).
- **Ratified mitigation:** C2's ruling freezes the grader program itself and publishes its digest **at lock, in the method document**. That converts "trust the venue's bake" into a pre-committed value a reader can compare against every verdict — the grader can no longer be changed mid-run or after results are seen without the digest mismatch being visible in the published records.
- **Stage:** pre-lock, then post-run `standing-guard`
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### D2 — Image descriptors need not carry a digest `blocker-candidate`
- **Attack:** the grader image is a `ResourceDescriptorLike`, and the schema requires only *one* of `uri`/`digest`/`content` (`packages/task-execution/profiles/src/resource-descriptor.ts:48-50`). A uri-only, tag-addressed image is mutable: the same sealed Task can grade differently next week, and two cells in the same run can pull different bytes.
- **Check:** for every task in the locked slate, assert `familyBlock.image.digest.sha256` is present in the sealed EvaluationSpec, and assert the container runtime is invoked with the `image@sha256:` form **and with `--pull never`**. Confirm the `--pull never` flag reaches the actual docker invocation, not just the config — a missing flag degrades silently to a registry pull. Re-pull one image after the run and confirm the digest is unchanged.
- **Pass:** 100% of slate tasks carry an image digest; runtime invocation is digest-addressed and carries `--pull never`; images pre-staged locally so the run cannot reach a registry mid-flight; post-run re-pull matches.
- **Ratified mitigation:** C2's ruling — task images are digest-pinned **and** run with `--pull never`. The digest pin makes the bytes nameable; `--pull never` makes a registry substitution mid-run impossible rather than merely detectable, and turns a missing image into a loud failure instead of a silent fetch of whatever the tag points at today.
- **Stage:** pre-lock `standing-guard`
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
- **Stage:** pre-lock (policy), post-run (counts)
- **Status:** open — mitigation ratified, verification pending · **Origin:** seeded

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
- **Check:** confirm the floor value is inside the sealed Run record before any cell executes; compare its timestamp to the first cell's dispatch.
- **Pass:** floor sealed pre-execution; value published; if the floor was ever changed, the run is a re-lock and is disclosed as one.
- **Stage:** pre-lock
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
- **Attack:** slate problem statements are attacker-controlled text from public issue trackers. Text inside them can instruct the agent, and if any of it references skills, `AGENTS.md`, or context files, the injection interacts *differently* with the two arms — a differential injection sensitivity that is indistinguishable from a mechanism effect.
- **Check:** grep every locked task's `problem_statement` and `instructions` for `AGENTS.md`, `SKILL.md`, `skill`, `system prompt`, `ignore previous`, `instruction`, and for imperative second-person directives addressed to a tool. Publish the hit list.
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
- **Attack:** the checked-out repository may already contain an `AGENTS.md`, a `CLAUDE.md`, a `.cursorrules`, or a skills directory. Arm B then writes over or alongside a pre-existing file; arm C is not actually instruction-free; arm A competes with a native context file.
- **Check:** for every locked task at its base commit, enumerate agent-instruction files in the tree. Publish the inventory.
- **Pass:** inventory empty, or a pre-declared, uniform handling rule (remove for all arms, or keep for all arms) applied identically and disclosed. Arm B overwriting a pre-existing `AGENTS.md` in some tasks and not others is a disqualifying inconsistency.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

---

## Surface H — Statistics

### H1 — Singleton clusters made the intervals ~3× too narrow
- **Attack:** the importer keys task provenance on `repo@base_commit` (`packages/benchmarking/interop/src/import/swebench.ts:70`), so every task is its own cluster — measured 100/100 singletons against 77 distinct repositories. A cluster bootstrap over singleton clusters is just an i.i.d. bootstrap, and the published interval understates uncertainty by roughly the square root of the design effect.
- **Check:** after the interop fix, assert over the sealed slate that `clusterCount < taskCount` and that cluster membership matches repository identity. The e2e gate carries the standing regression guard `draws === resamples × clusterCount` — `clusteredPairedRateDiffBca` increments `draws` once per cluster draw per replicate (`stats/noninferiority.ts:174-181`), so the identity is exact and a silent regression to singletons breaks it.
- **Pass:** clusterCount equals the distinct-repository count on the locked slate; the e2e assertion is present and green; the cluster manifest (keys and members) appears in the report's method disclosures.
- **Ratified mitigation:** the clustering-key fix lands in the interop packet pre-lock, and the `draws === resamples × clusterCount` assertion becomes a standing e2e guard so a regression to singleton clusters cannot pass CI silently.
- **Stage:** pre-lock `standing-guard`
- **Status:** open — mitigation ratified, verification pending · **Origin:** seeded

### H2 — Design effect and paired ICC assumed rather than measured
- **Attack:** the cluster-weighted multiplier Σm²/Σm ≈ 2.08 on the naive standard error at measured concentration is a *marginal* design effect. The paired delta likely has a much smaller ICC because repository difficulty cancels in the difference. Assuming either direction is a choice that moves the interval.
- **Check:** E2 computes the empirical ICC of the *paired delta* by repository from preview data, and reports the realized design effect from the clustered bootstrap (compare the clustered interval width against an unclustered one on the same data).
- **Pass:** measured ICC and realized design effect published; the power analysis uses the measured value; the report never states a design effect it did not compute.
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded

### H3 — The bootstrap seed is an unregistered researcher degree of freedom `hard-pre-lock`
- **Attack:** `seed` is an ordinary method parameter, an integer in `[1, 4294967295]` (`packages/benchmarking/aggregate/src/registry.ts:234`), and the report author chooses it. Nothing stops trying seeds until the interval excludes zero. With 10,000 resamples the seed-to-seed wobble is small but not zero, and near a boundary it decides the verdict. A hostile reader will ask how the seed was chosen and there is currently no answer.
- **Check:** assert the seed is bound in the locked method document before any official cell executes, and assert the seed sealed in the Run record equals the pre-registered value exactly. Then demonstrate stability: recompute the primary interval across at least 20 seeds and publish the min/max endpoints and the resulting verdict for each.
- **Pass:** the pre-registered seed and the sealed Run seed are equal, both published; the seed-sensitivity table published; the verdict is invariant across all tested seeds, or the instability is the headline finding rather than a footnote.
- **Ratified mitigation:** the seed is **bound pre-lock in the method document**. It is no longer a report-time choice, so "which seed did you use" has a pre-committed answer a reader can check against the sealed Run record. The equality check is the whole mitigation: a seed published at lock that does not match the seed the run actually used is the same defect wearing a disclosure.
- **Stage:** pre-lock, then post-run
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
- **Check:** the pre-registration names exactly one primary contrast, one secondary, and states that any other cut is exploratory and reported without inference. Post-run, count every interval that appears in the report and confirm each is labeled primary, secondary, or exploratory.
- **Pass:** counts match the pre-registration; exploratory cuts carry no confidence claims; no subgroup result appears in a headline or a derived asset.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

### H9 — MDE gaming
- **Attack:** the minimum detectable effect is declared after variance is known, at whatever value the design happens to achieve, and then presented as a design target. Or a null is reported as "no effect."
- **Check:** the MDE is written into the sealed Run record before the official run. Post-run, confirm the report prints it, and that any null is phrased "we cannot detect effects smaller than X" with X equal to the sealed value.
- **Pass:** sealed pre-run, printed post-run, identical value, correct phrasing; every derived asset that mentions a null carries the MDE or links directly to it.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** seeded

### H10 — Interval misreporting
- **Attack:** a 95% interval described as "95% probability the true effect lies in this range," or a one-sided bound presented as a two-sided interval, or a bound whose sign convention is flipped.
- **Check:** the sign convention is fixed in code as `delta = pB - pA` (`stats/noninferiority.ts:169`), so the report must state which arm is `baseline` and which is `candidate` and confirm the published sign matches the parameters actually passed. Read the report's interval sentence against this template, declared here so the check is a comparison rather than a judgement: *"The estimated difference in per-task pass rate (arm X minus arm Y) is D. A 95% bias-corrected and accelerated bootstrap interval, clustered on task provenance source, runs from L to U. Under repeated application of this procedure, 95% of such intervals would contain the true difference."* Assert the report contains no probability statement about the parameter — grep for `probability that the true`, `95% chance`, `we are 95% confident that the effect is`.
- **Pass:** arm-to-parameter mapping published; sign of the published estimate reproducible by hand from the per-arm rates; the interval sentence matches the template's claim structure; zero grep hits for the forbidden phrasings.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### H11 — The estimator was built by the party publishing the result
- **Attack:** `paired-delta@1` does not exist in `BENCHMARKING_METHOD_IDS` today (`packages/benchmarking/records/src/identifiers.ts:34-43` lists wilson, avg-at-k, pass-at-k, paired-mcnemar, provenance-cluster-sign, noninferiority-iut, clean-subset, bradley-terry). It is being built for this eval, by us, in the same program that publishes the number. That is the structural definition of a researcher degree of freedom at the estimator level.
- **Check:** the method must be merged, versioned, and released *before* lock, with its own review and its own conformance fixtures (H4). Assert the method id and version recorded in the Report record match a released artifact whose commit predates the Run record seal. Assert no commit touches the method's numerics between lock and publication.
- **Pass:** method released pre-lock; version pinned in the Report; zero numerics commits in the lock-to-publication window; oracle fixtures public so a reader can re-derive the interval independently.
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
- **Check:** the aggregation rule is named in the locked method document and asserted equal to the rule the sealed method parameters actually invoke. Post-run, recompute the primary contrast under all three rules and publish the sensitivity table.
- **Pass:** rule pre-declared and matching the sealed method parameters exactly; **the sensitivity table published regardless of whether the rules agree**, and if they disagree in sign or verdict, that disagreement appears next to the headline rather than in an appendix. The pre-declared rule is the headline whatever the others say.
- **Stage:** pre-lock, then post-run
- **Status:** open · **Origin:** novel

---

## Surface I — Venue self-trust and integrity tiers

### I1 — Self-run venue disclosure
- **Attack:** the run is graded by its own owner and the report reads as if pre-registration made it trustworthy.
- **Check:** §7.1's sentence — a local run's pre-registration is a discipline, not a proof against its own owner — appears in the product surface and in the report. Confirm the venue label is `self-run`.
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
- **Check:** obtain an external ordering witness for the lock — publish the sealed Run record digest to a surface with an independent timestamp (E4's public pre-registration is exactly this) before the first official cell dispatches. Assert the external publication timestamp precedes the first cell's dispatch timestamp.
- **Pass:** external witness exists and precedes execution, or the report states that the ordering guarantee is local-only and the owner could in principle have retro-registered. One of the two, explicitly.
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

### I4 — Run-owner key custody
- **Attack:** the Report is DSSE-signed under a run-owner key held by the same party as everything else. A reader cannot distinguish "signed by the run owner" from "signed by whoever had the key," and key rotation mid-program would go unnoticed.
- **Check:** publish the run-owner and publisher key identifiers; assert the same key signs the Run record and the Report; record custody in the report bundle.
- **Pass:** key identifiers published; single key across the run; custody stated.
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
- **Check:** assert the public pre-registration's publication timestamp — on a surface whose timestamp the run owner does not control — precedes the first official cell's dispatch timestamp. Compare the published Run record digest against the sealed Run record byte-for-byte: the pre-registration must commit to the same record the run executed, not a summary of it.
- **Pass:** external publication timestamp strictly precedes first-cell dispatch; published digest equals the sealed Run digest; both timestamps and the digest printed in the report. If the operator declines E4, the report drops every "pre-registered" claim and states that ordering rests on local append order alone (I3's second branch).
- **Ratified mitigation:** E4 public pre-registration is **committed, conditional on the e2e gate being green**. The conditionality is the honest part — the program will not publicly commit to a run it cannot yet execute — but it also means the trigger must be checked rather than assumed, and the fallback wording must exist before it is needed.
- **Stage:** pre-lock, then post-run
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

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
- **Stage:** pre-lock
- **Status:** open · **Origin:** seeded (E1 §1.7 handoff)

### J7 — Naming Vercel raises the bar on our own arithmetic
- **Attack:** if the report frames itself as the controlled version of a named company's comparison, every number we publish gets read adversarially by that company's readers, and any arithmetic slip becomes the story.
- **Check:** if the operator takes the named framing at E5, a full independent recomputation of every published number from the sealed records by a second agent, plus a fact-check of every attributed figure against the source post.
- **Pass:** independent recomputation matches; every attributed figure quoted accurately with its source; no characterization of the other work beyond what its own text supports.
- **Stage:** post-run
- **Status:** open · **Origin:** novel

### J8 — Third-party recomputability is claimed but never exercised
- **Attack:** the report says a reader can verify the numbers independently, and nobody has ever tried. The failure modes are mundane and fatal: the verifier is not actually published, the bundle omits an input the recompute needs, the method package is unreleased or version-drifted, a fixture is referenced but not shipped, or the recompute needs a credential only the run owner has. "Verifiable in principle" published as "verifiable" is the same overclaim §8.1 forbids everywhere else, and it is the one a hostile reader will test first because it is the cheapest to test.
- **Check:** a clean-environment rehearsal, performed by someone who did not build the run. Fetch only the published artifacts, install only published package versions, run the published verifier, and recompute every number the report states. Compare byte-for-byte against the published report values. Record anything the recompute needed that was not in the published bundle.
- **Pass:** clean-environment recompute reproduces every published number byte-for-byte, from published artifacts alone, with no private input and no credential. Any gap is closed before publication or the recomputability claim is removed from the report — not softened, removed.
- **Scope, and why it stops where it does:** this is **statistical recomputation from published outcome bits** — the Matrix's per-cell outcomes, the Report record, the sealed Run parameters, and the released method package — not re-execution of the tasks. Re-execution is foreclosed by A3's license posture: the report deliberately does not redistribute upstream problem statements or test material, so a third party cannot re-run the slate from our bundle and this item must not imply they can. The two items are consistent by construction and the report states the boundary: *the arithmetic is independently checkable; the agent runs are not independently repeatable from this bundle.*
- **Ratified mitigation:** a **clean-environment third-party recompute from published artifacts alone**, performed by someone who did not build the run, is a required pre-publication step rather than an assurance offered in prose.
- **Stage:** post-run
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### J9 — No conflict-of-interest statement
- **Attack:** the report is produced by a party that built the venue, wrote the estimator, chose the slate, selected the content artifact, ran both arms, graded the results, and stands to benefit from the benchmark product gaining credibility. Each of those facts is disclosed somewhere in the bundle; none of them is collected in one place where a reader meets them before the numbers. A reviewer who assembles that list themselves will present it as something we concealed, and the diffuse disclosure will not read as a defense.
- **Check:** the limitations section contains an explicit conflict-of-interest statement naming, at minimum: the venue is self-run by the report's author; the estimator was built by the same program that publishes the result (H11); the grading environment was produced by the run owner (D1); and the report's purpose includes demonstrating the product it runs on. Confirm it appears in the report and in any derived asset long enough to carry it.
- **Pass:** the statement is present, in one place, stated plainly rather than distributed across footnotes, and positioned so a reader encounters it with the result rather than after it.
- **Ratified mitigation:** a **conflict-of-interest statement is required in the report's limitations**. The disclosures it collects already exist across the bundle; the ratified decision is that they must appear together, as a statement, rather than being reconstructable by a determined reader.
- **Stage:** post-run
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

### J10 — Post-publication data availability
- **Attack:** the report links artifacts that later move, expire, or sit behind a service the run owner stops paying for, and the verification path rots. A published benchmark whose evidence is unresolvable in a year is a claim, not a record — and this program's own charter puts evidence outliving the product at the center. The subtler version: a reader cannot tell *what* is guaranteed to remain resolvable, so they assume everything is, and discover otherwise at the worst moment.
- **Check:** state explicitly in the report that **sealed Task records are self-contained** — the sealed bytes carry the instructions, payload, inputs and the EvaluationSpec digest, so a Task is interpretable from its own content without a live upstream fetch. Then enumerate what is *not* self-contained and depends on an external host staying up: the grader container images, the upstream repositories at their base commits, and the dataset rows. For each, state the retention posture and where a copy lives. Re-resolve every published link from a clean environment at publication time.
- **Pass:** the self-containment statement present and accurate; the not-self-contained list published with a retention posture for each; every published link resolves from a clean environment at publication. Nothing is described as permanently available that the run owner does not control or has not archived.
- **Ratified mitigation:** post-publication data availability is addressed explicitly rather than left implicit, and the report **states that sealed Tasks are self-contained** so the boundary between what survives independently and what depends on a host is legible to a reader instead of assumed.
- **Stage:** post-run
- **Status:** open — mitigation ratified, verification pending · **Origin:** novel

---

## Surface K — Process integrity of the red team itself

### K1 — Every item terminates
- **Attack:** the register ships with items marked "noted" or "acknowledged," which is a fig leaf.
- **Check:** assert every item in this file carries `fixed`, `disclosed-limitation`, or `withdrawn`, each with evidence or an exact limitation sentence.
- **Pass:** zero `open`, zero `noted`.
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
- **Check:** the sign-off references this file at a specific commit digest. **Additionally, assert that the E1 blob digest pinned in this document's header equals the digest of the frozen draft at lock.** If they differ, diff the two versions and re-attack every changed section before the register may close; record the diff and the re-attack outcome in this item.
- **Pass:** sign-off recorded with this file's digest, matching the version that ships in the report bundle; **the header's pinned E1 digest equals the frozen-draft digest at lock, or a recorded re-attack of the delta exists and the header pin has been updated to the frozen draft.**
- **Stage:** pre-lock
- **Status:** open · **Origin:** novel

---

## Register summary

All figures below are recounted programmatically from this file's own headings and status lines, not incremented by hand.

| Surface | Items | Seeded | Novel |
|---|---|---|---|
| A — Contamination and leakage | 7 | 3 | 4 |
| B — Skill-content confounds and arm identity | 9 | 1 | 8 |
| C — Harness, version, environment drift | 8 | 2 | 6 |
| D — Grader validity | 6 | 0 | 6 |
| E — Denominator games and attrition | 5 | 2 | 3 |
| F — Stopping rules, exclusions, Goodharting | 6 | 1 | 5 |
| G — Prompt injection and task content | 3 | 1 | 2 |
| H — Statistics | 13 | 5 | 8 |
| I — Venue self-trust and integrity tiers | 6 | 2 | 4 |
| J — Publication-surface honesty | 10 | 4 | 6 |
| K — Red-team process integrity | 3 | 0 | 3 |
| **Total** | **76** | **21** | **55** |

**Markers:** 5 `blocker-candidate` (A2, B3, B4, B5, D2) — each one, if it fails, confounds the primary contrast itself and cannot be discharged by a limitation line. 2 `hard-pre-lock` (H3, J4). 9 `standing-guard` (B2, B8, C3, C5, C8, D1, D2, H1, I5) — checks that become permanent automated assertions rather than one-time inspections.

**By stage:** design 4, pre-lock 52, post-run 20 (items checked at two stages are counted at the earlier one).

**Status:** 76 open, 0 closed — 63 plain `open`, 13 `open — mitigation ratified, verification pending`. This is still the pre-attack state; no check in this file has been executed.

**Ratified mitigations folded in (v0.2–v0.3), by the item they answer:**

| Item | Ratified decision |
|---|---|
| A2 | P0-interop threads real per-task `created_at`; declared fallback is dropping `clean-subset@1` for a slate-level attestation, recorded in that PR |
| B4 | Byte-identity of the harvested patch against a no-loadout control becomes a P2 acceptance criterion |
| B5 | Arm-C baseline decided empirically from E2 preview evidence, not by design preference |
| B9 | Zero instruction-file hunks in the extracted patch — a P2 acceptance criterion alongside B4 |
| D1 | Grader program frozen; its digest published at lock in the method document and asserted equal on every official verdict |
| D2 | Task images digest-pinned and run with `--pull never` |
| E1 | Timeout = FAIL declared pre-lock; per-arm timeout counts join per-arm retry counts as published disclosures |
| H1 | Clustering-key fix lands pre-lock; `draws === resamples × clusterCount` becomes a standing e2e guard |
| H3 | Bootstrap seed bound pre-lock in the method document; sealed Run seed must equal it |
| I6 | E4 public pre-registration committed, conditional on the e2e gate |
| J8 | Clean-environment third-party recompute from published artifacts alone |
| J9 | Conflict-of-interest statement required in the limitations |
| J10 | Post-publication data availability addressed explicitly; sealed Tasks stated to be self-contained |

None of these closes an item. Each one changes what the pre-lock check tests, and every one of them still has to pass.

**Items added in v0.3, after independent review:** B8 (frozen source drifted after cells executed), B9 (instruction file leaks into the extracted patch), C8 (preview and official runs used different builds), F6 (content-artifact selection is an unregistered forking path), H13 (replicate-aggregation rule unstated and outcome-changing), J10 (post-publication data availability). Five of the six are forking paths or freeze failures — the class of defect that leaves no trace in the published record unless something asserts against it beforehand, which is why they belong in a pre-lock register rather than a post-run review.
