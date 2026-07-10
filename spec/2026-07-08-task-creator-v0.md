# Task Creator v0 — mining execution traces into evaluable tasks

- **Version:** 0.4 (design draft — v0.1 synthesized from a four-agent design/adversarial
  panel, 2026-07-08, plus two correction passes: the usage-trace-mining reframe and
  the scrub-collision / lookup-contamination / gate-precision flags, 2026-07-09.
  **v0.2 locks decisions D1–D4**; **v0.3 adds the public/private boundary + D5
  (public-repo-only publication for v0)**, 2026-07-09; **v0.4 adds D6 and the
  generalized Task Capsule companion design**, 2026-07-10.)
- **Date:** 2026-07-08 (written 2026-07-09; amended 2026-07-10)
- **Author:** Ritsu (design session)
- **Shape:** `design` — output is this spec. Building any rung is a follow-on `feat`,
  gated per §5. Nothing in this document merges code.
- **Answers:** issue [#994](https://github.com/Jinn-Network/mono/issues/994)
  (SWE-smith spike). Finding, in one line: **fork the machinery, reject the dataset**
  — SWE-smith's value to Jinn is its transform components pointed at trace-derived
  targets, not its ~52k-instance synthetic pool (§5.3, §6).
- **Siblings:**
  - `spec/2026-07-06-distillation-v1.md` — the committed customer for this spec's
    output (verified pass/fail exemplar pairs).
  - `spec/2026-07-06-capability-eval-v0.md` (PR
    [#1416](https://github.com/Jinn-Network/mono/pull/1416)) — owns the held-out
    `cap-v0` boundary this spec must respect (§11).
  - `spec/2026-07-06-harness-network-roadmap-v0-v3.md` — the sequencing spine
    (§2).
  - `docs/superpowers/specs/2026-07-10-task-creator-generalized-task-capsules-design.md`
    — domain-neutral Task Capsule, ALE compatibility adapter, and automated dynamic
    task-creation roadmap (D6).

---

## 1. Summary

The Task Creator watches the work flowing through the marketplace, finds where the
hard and valuable work is, and manufactures new solvable-and-gradeable tasks around
it — so the network generates many verified attempts at that kind of work, and
distillation has rich data to learn from.

**The spine is usage-trace mining.** The destination is: any captured agent session
on real work — SolverNet execution or general harness usage — becomes a candidate
evaluable task. A trace supplies four things no static dataset has: *where* the work
happened (repo @ commit, the files touched), *what was hard* (verified failures,
contested instances), *a candidate gold* (the verified or accepted patch), and
*negative exemplars* (verified-failing attempts). The Task Creator turns those into
new tasks that flow through the existing admission → post → solve → grade → distill
machine unchanged.

**The honesty clause.** Today, the only execution data in the marketplace comes from
benchmark tasks our own generator posts (`nebius/SWE-rebench-leaderboard`, per
DR-2026-05-06-b). Mining those traces yields variations-of-the-benchmark — the wrong
distribution to amplify. Genuine off-benchmark usage exists today only as dogfood:
the team already runs agents on real non-benchmark work daily, and capture is
default-on (roadmap §v0). So this spec is a **component staircase**, not a single
build: each rung earns one component of the usage-trace miner on ground where it can
be proven cheaply, and the components compose into the destination when real
non-benchmark usage arrives at volume (§5.6).

This spec deliberately reuses the entire existing quality machine (§4) for work that
can compile to `swe-rebench-v2.v1`. General artifact-producing work uses the same
mine → admit → post → solve → grade → distill pipeline through the Task Capsule
boundary defined by the companion design. The Task Creator remains one way of
putting tasks in front of admission; task-family adapters own only the final
domain-specific materialization and grading shape.

## 2. Position in the program — sequencing, stated plainly

The roadmap's discipline is: do not advance until the prior gate has paid
(`spec/2026-07-06-harness-network-roadmap-v0-v3.md`). The prior gates here are:

- **v0 gate (cap-v0):** seeds beat stock — methodology at
  `spec/2026-07-06-capability-eval-v0.md` (PR #1416); the measurement has not run at
  full N (a pilot has: `gpt-5.4-mini` pin, Δ_quality = 0.0pp non-inferior at n=16).
- **v1 gate (three-arm):** distilled skills beat seeds and beat raw evidence —
  `spec/2026-07-06-distillation-v1.md` §11. **Unmeasured.**

This spec is written **ahead of both gates, by explicit choice**. Distillation is
the only committed customer for minted tasks; if the three-arm measurement returns
null, scaling task supply amplifies a loop that does not work. The design absorbs
that risk in three ways:

1. **The highest-leverage action in the program is running cap-v0 on a rented amd64
   host.** All four panel agents converged on this independently. This spec does not
   compete with that action for effort; it queues behind it.
2. **Only rung 0 is built ahead of the gates** (§5.1) — instruments and the
   mineable-trace contract, both cheap and valuable regardless of the measurement
   outcome. Rung 1+ is gated (§5).
3. **The "regardless vs. on-proof" line is explicit** (§8): rung 0 and the
   commit-echo *plumbing* produce verified verdicts every downstream consumer wants
   and proceed regardless; *scaling mint volume* has one customer today and pauses
   on a null three-arm result.

## 3. What a trace supplies, and what exists today

| Trace ingredient | SolverNet trace (today) | General-usage trace (destination) |
|---|---|---|
| Targeting (where work is hard) | Verified: verdict envelopes, contested instances | Session outcomes, retry patterns |
| Candidate gold | Evaluator-verified patch (strong) | User-accepted diff (weak — needs admission to upgrade) |
| Negative exemplars | Verified-failing attempts | Intermediate failed states in-session |
| Verifier seed | Inherited `test_cmd`/`log_parser` from the instance | Test commands the session actually ran |

Two structural facts shape the ladder:

- **Circularity.** Today's SolverNet traces are benchmark tasks; "mine the traces"
  currently reduces to re-targeting instances from the same dataset. The genuinely
  novel input — real user work — exists only as dogfood capture, which nothing yet
  consumes.
- **The verdict gap.** A SolverNet trace arrives as a `(task, solution, verdict)`
  triple — an evaluator already proved the patch. A general-usage trace has no gold,
  no test set, no image, no verdict. It is the richest demand signal and the poorest
  task substrate. Closing that gap is what rungs 2 and 4 build (empirical verifier
  derivation; environment construction), and what admission converts: "the user
  accepted this diff" is a weak verdict; `validatePoolInstances` + the
  discrimination check (§5.1) upgrades it to marketplace grade.

## 4. Architecture — one new source in front of the existing machine

### 4.1 Reuse map (verified against code)

Minted tasks are **ordinary `swe-rebench-v2.v1` tasks**. A new SolverType would fork
the evaluator, claim, and distillation surfaces for nothing. Everything after
admission runs untouched:

| Stage | Component | Reused unchanged? |
|---|---|---|
| Admission | `validatePoolInstances`, `EVAL_SEMANTICS_VERSION` (`client/src/solver-types/_swe-rebench-v2-validated-pool.ts`) | Interface unchanged; two deliberate forks (§4.3) + one addition (§5.1) |
| Row access | `HfFetcher` / `HfRow` (`client/src/harnesses/impls/swe-rebench-v2-evaluator/index.ts`), `HttpHfFetcher` (`hf-fetcher.ts`) | Extended with `ipfs://` routing (§4.2) |
| Posting | generator tick + `selectNextPostingCandidates` (`swe-rebench-v2.ts`, `swe-rebench-v2-auto.ts`), `CreatorLoop` | Pool union only (§4.2); contested-band comparator (§5.1) |
| Grading | `SweRebenchV2Evaluator`, `buildTestCommands`, `PythonEvalRunner` (`swe-rebench-v2-evaluator/`) | Yes — every operator grades minted instances with zero duplication |
| Held-out hygiene | `excludeHeldOutSlate` (`_swe-rebench-v2-held-out-slate.ts`), `assertNoOverlap` (`eval/train-sequence.ts`) | Extended: repo-keyed rule in the minting path (§11) |
| Statistics | `wilsonInterval`/`compareRates` (`eval/wilson.ts`), `mcnemarExact`/`comparePaired` (`eval/paired.ts`) | Yes (§5.1, §8) |
| Consumption | `runDistillationPipeline` (`client/packages/harness-layer/src/pipeline.ts`), bridge exclusion (`bridge.ts`) | Yes |

The adapter boundary is the **`PoolTask` shape** (`_swe-rebench-v2-pool.ts`) plus a
resolvable row behind the fetcher — *not* raw `HfRow[]`: `validatePoolInstances`
accepts `PoolTask[]` and fetches rows internally via the injected `HfFetcher`.

### 4.2 Minted-row plumbing

Minting is an **offline CLI pipeline** (`jinn solver-nets mint-tasks …`), mirroring
`validate-pool`: it does the heavy Docker work of proving each candidate sound on a
capable host, then the everyday generator merges the result. The flow:

1. A **miner** (per rung: commit walker, hunk-subset constructor, …) emits candidate
   instances as full row objects — `instance_id`, `repo`, `image_name`, gold
   `patch`, `test_patch`, `FAIL_TO_PASS`/`PASS_TO_PASS`,
   `install_config.{test_cmd,log_parser}`.
2. Candidates run through admission (gold must grade as resolving; known-bad must
   fail — hard-reject for minted instances per D3). Survivors persist to a
   **`MintedPoolStore`** (sibling of
   `ValidatedPoolStore`) and are published as a **minted-rows artifact on IPFS**.
3. The fetcher learns one trick: a **row-routing `HfFetcher`** — if
   `hf_dataset` starts with `ipfs://<cid>`, fetch the row from the minted-rows
   artifact instead of the HuggingFace datasets-server. `hf_dataset` is a plain
   string throughout the codebase; no schema change; `rowHash` (over row fields,
   `_swe-rebench-v2-substrate.ts`) works verbatim, so the evaluator's drift guard
   holds for minted rows.
4. The generator takes a **~10-line union**: minted pool ∪ benchmark pool, then the
   existing `filterToScorablePool` → `excludeHeldOutSlate` → selection path.

Any operator anywhere grades a minted task exactly like a benchmark one.

### 4.3 The two deliberate forks of admission (where the integrity bugs would live)

The panel falsified the comfortable claim that the admission gate is "unchanged."
It is unchanged in *interface*; two places must be forked deliberately, and both are
named here so they are reviewed as integrity surfaces:

1. **Row sourcing.** The gate is HF-welded today (`fetchTaskRow` against the
   datasets-server). The `ipfs://` routing of §4.2 is the fork; it must preserve
   `rowHash` semantics and the image-digest pin.
2. **Held-out exclusion keying.** Exclusion keys on `instance_id` in the train
   path; a freshly-minted ID derived from a slate repo would silently pass. The
   minting path must exclude by **repo**, not instance ID (§11).

One further gap the panel found, fixed at rung 0: admission never checks that
F2P tests *fail pre-patch* — it proves only the gold transition. Inherited-test-set
mints would admit vacuous instances. §5.1's discrimination check closes this.

### 4.4 Generalized Task Capsule boundary (D6)

The `PoolTask` + task-row boundary above remains correct for coding tasks and is not
replaced in the Task Creator v0 implementation. It is one task-family adapter.

For work that cannot compile to SWE-rebench, the domain-neutral boundary is
`jinn.task-capsule.v1`, specified in
`docs/superpowers/specs/2026-07-10-task-creator-generalized-task-capsules-design.md`.
It separates the public instruction, inputs, environment requirements, and Solution
projection from an evaluator-only reference bundle and a public admission receipt.
The existing `session-derived` contract family is the target for this generalized
family through a new `session-derived.v2` contract; the already-versioned v1 schemas
remain unchanged. Rebench-compatible mints stay in `swe-rebench-v2.v1`.

This distinction moves the environment **runtime contract** earlier without moving
automatic environment **synthesis** earlier. Docker/QEMU/cloud providers can run a
curated capsule before the Task Creator can infer a safe environment from an
arbitrary local session.

## 5. The ladder

| Rung | What | Gate to build it |
|---|---|---|
| 0 — Instruments + targeting + contract | Contested-band ranking; negative-exemplar discrimination on admission; exemplar-pair-yield metric; repo-keyed exclusion in the minting path; the mineable-trace contract | None — cheap, valuable regardless of measurement outcomes |
| 1 — Commit-echo | Generalize `jinn-repo-extract` to walk fresh upstream commits in repos with admitted images | The **three-arm distillation measurement** exists (distillation §11; cap-v0 is its prerequisite, PR #1416) — don't run a factory without its output sensor |
| 2 — Hunk-subset echo | Revert a hunk subset from a verified-solved state; empirical F2P/P2P; blinded provenance | Rung-1 yield proves mint→admit→harvest; dogfood capture producing mineable traces |
| 3 — Targeted perturbation (forked SWE-smith machinery) | AST/LM mutation aimed at trace-touched files; backtranslated problem statements | Echo supply exhausted **and** positive McNemar for synthetic-fed distillation |
| 4 — Automatic environment synthesis (REPOLAUNCH-class) | Build new testable environment recipes from real unsupported work; the provider/runtime seam already exists via D6 | Real non-benchmark users plus the generalized capsule pilot |
| ∞ — Composition | The usage-trace miner = rung-1 plumbing + rung-2 verifier derivation + rung-4 envs | All three components proven |

### 5.1 Rung 0 — instruments, targeting, and the contract

Built ahead of all gates, by explicit choice. Four deliverables:

- **Contested-band targeting.** Rank existing pool instances by informativeness —
  solve rate nearest ~50% carries maximum information per attempt (reuse
  `wilsonInterval`). This is a comparator on the existing posting selection
  (`selectNextPostingCandidates`), not a component: the generator already reposts
  hard instances indefinitely (the abandon cap was removed, #802), so "Mode A" from
  earlier drafts is vacuous as a build item and survives only as this ordering.
- **Negative-exemplar discrimination on admission.** Extend `validatePoolInstances`:
  a known-bad patch (empty patch; or a deliberately-broken variant) must score 0.
  A task that cannot tell right from wrong is worthless as a data source.
  Motivation: weak-suite rates reported for SWE-bench-family benchmarks (a ~28.5%
  figure surfaced in the design-session research pass — **reported, pending anchor
  to a primary source**, AC #3). **Policy (D3):** hard-reject all newly minted
  instances when known-bad passes; for the existing benchmark pool, flag failures
  and exclude flagged instances from distillation and Task Creator targeting, then
  re-publish a stricter vetted-pool artifact once impact is measured — new supply
  meets the higher bar immediately; legacy supply migrates deliberately so the
  current task flow is not mass-invalidated.
- **Exemplar-pair yield metric.** Count instances that end with **both** a verified
  pass and a verified fail — the pair is exactly what distillation feeds on
  (`bridge.ts` retains per-(instance, polarity) groups). This is the numerator of
  §8's one metric.
- **The mineable-trace contract** (§10) — the only deliverable with a real
  deadline: every day of capture without it is raw material lost.

### 5.2 Rung 1 — commit-echo (mint from real human commits)

**Role (D4):** commit-echo is the **plumbing proof** — it validates the
minted-row store, IPFS fetcher route, admission, and generator union with the least
novelty. It is **not** the final learning substrate: public upstream commits create
lookup contamination (below). Hunk-subset echo (§5.3) is the more trace-native rung
and follows once blinded provenance and dogfood trace capture are ready.

We already have admitted, image-pinned Docker environments for a set of repos. Real
developers keep committing real fixes to those repos after our dataset snapshot.
Walk the fresh upstream commits; for each one that fixes something testable, mint an
instance: repo @ parent-of-fix, problem statement from the commit/PR context, gold
patch = the human commit, F2P/P2P derived empirically (§5.3's mechanics apply here
too — never inherit a test set). These are genuinely new instances that exist in no
dataset, they are real work rather than synthetic mutations, and recency makes them
training-contamination-resistant (the LiveCodeBench trick).

Half the code exists: `client/src/solver-types/jinn-repo-extract.ts` already mines
merged PRs from this repo into evaluable pool items. Rung 1 generalizes it into a
commit-echo miner emitting into the §4.2 pipeline.

**Known limitation — the public answer key.** A commit-echo gold is a public
upstream commit; a solver can fetch the origin repo and read the fix at HEAD.
Blinded provenance (§7) does not help — our hashes don't hide GitHub. Two mitigating
facts: this is exactly the status quo exposure of the benchmark pool (nebius
instances are real public PRs), and a looked-up correct patch still yields a true
verdict. The real cost is downstream: a lookup trajectory is a poisonous
distillation input (it teaches lookup, not repair). Hence the lookup tripwire in §7
and the in-band restriction on §8's metric.

### 5.3 Rung 2 — hunk-subset echo (mint from the marketplace's own solved work)

The naive echo — revert the solver's whole patch — is dead (§6). The sound
construction, from the panel's architect:

- Let `base ⊕ S` be the verified-solved state (solver patch `S` applied at base,
  verified on-chain). Choose a hunk subset `H ⊂ S`. The minted broken state is
  **`B' = base ⊕ S ⊖ H`** — genuinely different from base, because the other fixes
  remain in place.
- **Gold = the forward re-diff of `H`**, provably correct: applying it restores a
  state the chain already verified.
- **F2P/P2P are derived empirically, never inherited:** run the suite at `B'` and at
  `B' ⊕ gold`; a test qualifies as F2P iff it fails at `B'` and passes after.
  **Reject dead mints** (no test flips). This same run doubles as the §5.1
  discrimination proof for the minted instance.
- Image and `install_config` are unchanged from the source instance — which is why
  this rung dodges the SWE-smith `test_patch`/`install_config` problem entirely.

Where it matters most: **non-benchmark work**, where the solver's (or user's)
verified patch is the only gold anyone has. This is the rung that turns dogfood and
future real usage into reusable, gradeable tasks — provenance blinded per §7,
because here (unlike rung 1) the answer key is ours to hide.

### 5.4 Rung 3 — targeted perturbation (fork SWE-smith machinery, not dataset)

LM- and AST-based bug injection (forked from SWE-smith's procedural mutation +
rewrite components; problem statements via R2E-Gym-style backtranslation), aimed at
the files and functions that traces show are hard — perturbation targeted at
demonstrated-difficulty regions, not random entities. The fork inherits SWE-smith's
repo-profile machinery, which is where `test_cmd`/`log_parser` generation lives.
Gated hard: echo supply exhausted **and** synthetic-fed distillation shows a
positive paired result. Synthetic-bug ecological validity is a known risk (skills
distilled from artificial bugs may not transfer; the null priors in distillation
§2.4 make this a doubly-unproven chain) — which is why this rung is last among the
minting rungs, not first as SWE-smith adoption would have implied.

### 5.5 Rung 4 — automatic environment synthesis

REPOLAUNCH-class agentic construction of testable Docker environments for arbitrary
user repos, followed by broader artifact and desktop environments. Activates only
when real non-benchmark usage arrives. This is the component that makes a trace from
an *unsupported* environment mintable; it is not the first point at which Jinn can
run a non-Rebench environment. D6 lands the versioned Task Capsule, provider seam,
submission projection, and ALE compatibility adapter earlier against curated
environment recipes.

This rung first meets private repos and proprietary workspace state in force. It is
gated behind the code-payload disclosure controls of §10.1 (D5) — until those exist,
only public or otherwise explicitly redistributable environment inputs are
publishable.

### 5.6 The destination — composition

The usage-trace miner is not a sixth build; it is the composition of three proven
components: take a captured session (starting state, accepted output, validation
signals, and intermediate failures — per §10 plus the D6 Source Capture extension),
materialize it through a task-family adapter, derive a discriminating evaluator, and
push the result through the same mint → admit → post pipeline. Coding uses rung-1
plumbing, rung-2 verifier derivation, and rung-4 synthesis when the repo has no
supported environment. General artifact work uses the companion design's capsule,
submission projection, and provider path. Admission is the trust converter
throughout. In v0 publication remains limited to public or otherwise explicitly
redistributable inputs (§10.1, D5); private-work publication waits on payload
disclosure controls.

## 6. Designs rejected (what the panel killed, kept on record)

- **Naive trace echo** — killed three ways independently. Geometrically: reverting
  the full solver patch from the solved state returns exactly to base — a duplicate
  task with a relabeled gold, invisible to solvers; reverting against any other
  state generally conflicts or yields an undefined test set. Economically:
  provenance publishes the answer key (the source solution envelope is public on
  IPFS), so under first-delivery-wins the dominant strategy is a lookup bot.
  Survives only as the hunk-subset construction (§5.3) with blinded provenance.
- **"Mode A" as a component** — vacuous. The shipped generator already reposts hard
  instances indefinitely (#802); the delta is a comparator (§5.1), not a build.
- **The "unchanged admission gate" claim** — false in practice; replaced by the two
  named forks + one addition (§4.3).
- **SWE-smith dataset adoption** — rejected. Their ~52k HF instances are a second
  static pool, structurally identical to the benchmark we already post; nothing
  about it derives from traces. The machinery forks per §5.3/§5.4. (This is the
  #994 finding.)
- **A dedicated SolverNet for SWE-rebench-compatible minted tasks** — rejected;
  forks the evaluator, claim eligibility, and distillation surfaces for no benefit
  (§4.1). This answers #994's (a)-vs-(b): **(b) augment `swe-rebench-v2`**. D6 does
  not reverse this decision: only work that cannot satisfy the Rebench Task/Solution
  contract uses `session-derived.v2` in the existing contract family.

## 7. Integrity guards

Checked against `contracts/src/tasks/TaskCoordinator.sol`: `creator == solver` is
on-chain-legal and any verdict credits activity — but liveness is a threshold, not a
multiplier, so farming displaces rather than amplifies. Guards, all off-chain at v0:

| Threat | Guard |
|---|---|
| Answer-key lookup (echo family) | **Blinded provenance:** manifest carries a hash-commitment to the source trace; reveal post-settlement. Plus `sourceSolver ≠ solver` claim filter. |
| Answer-key lookup (commit-echo) | Not blindable (public upstream, §5.2). **Lookup tripwire:** suspiciously-fast solves and byte-identical-to-upstream patches flagged in yield accounting; flagged trajectories excluded from distillation input. |
| Mint-and-solve farming | `synthetic: true` provenance in the manifest; minting earns no creation weight; `minter ≠ solver` claim filter. |
| Echo-of-echo chains | Mint only from non-synthetic sources at v0 (no second-generation echoes). |
| Crowding out real work | Synthetic quota ≤ 25% of postings. |
| Trivial/impossible mint families | **Informative-band stop:** rolling solve rate outside [10%, 90%] halts that mint family automatically. |
| Duplicate-evidence pollution of distillation | Echo instances carry source lineage; the distillation bridge collapses lineage when clustering (an echo and its source are not independent corroboration). |
| Exam leakage | Repo-keyed exclusion (§11). |

## 8. The one metric and the kill criteria

**Metric (two-week check):** distill-admissible verified trajectories per dollar,
minted vs. baseline — counted **only from instances in the informative band**, and
excluding lookup-flagged trajectories. "Distill-admissible" = contributes to an
exemplar pair per §5.1.

**Kill criteria** (any one triggers a stop-and-rethink for the affected rung):
admission yield < 30% of mint candidates; no minted family lands in the informative
band; cost > 3× baseline per admissible trajectory; or **the three-arm measurement
returns null** — in which case mint *scaling* pauses (distillation is the only
committed customer), while rung 0 and already-built plumbing stand (verified
verdicts have other consumers; the "regardless vs. on-proof" line of §2).

## 9. Economics (D1)

Minted tasks need a funded delivery-fee escrow like any other posting. **Decision
(D1): self-funded launcher escrow for v0.** The operator who runs the minting/posting
pipeline pays via the existing `computeEscrowWei`
(`client/src/solver-types/_swe-rebench-v2-escrow.ts`) path — same delivery-fee
semantics as live tasks, bounded by the ≤25% synthetic quota and the informative-band
stop. No protocol subsidy and no special synthetic pricing at v0: the point is to
learn whether minted supply creates useful verified trajectories per dollar, and
hiding the cost would corrupt that signal. Broader economics (who ultimately pays
for synthetic supply at scale, whether minted-task fees should differ) remain parked
for a later session.

## 10. The mineable-trace contract (rung-0 deliverable, with a deadline)

If the capture pipeline scrubs or drops the fields trace-mining needs, then by the
time the miner exists the traces will be unmineable and the data lost forever. The
contract defines what a capture envelope must **retain** for a session to be
mineable:

- repo identity + commit (the mint anchor),
- the final accepted diff (the candidate gold),
- test commands executed in-session and their outcomes (the verifier seed — and an
  honest mineability signal: sessions with no test execution will yield little;
  §5.6 sets expectations accordingly),
- intermediate failure states (negative exemplars),
- **skill-consumption events** — which skills were loaded and which were actually
  read/invoked. Not needed for minting; needed to keep second-layer utility
  evaluation possible at all (§12). Credit assignment without consumption data is
  confounded beyond rescue.

**Consent tier (D2) — the scrub collision.** This contract is in direct tension
with the scrub pipeline's fail-closed posture (`client/src/trajectory/scrub/` —
secretlint, PII stages, layer-2 scrub; and the #1409 over-redaction history). A
private repo's final diff is not metadata — it *is* the sensitive payload. **Decision
(D2):** mineability is an explicit opt-in consent tier in the capture envelope shape
(extending DR-2026-05-07-g), split into **two consents**:

1. **Retain locally for mining** — opting in allows the scrub pipeline to retain the
   contract fields (repo identity, commit, diff, test commands, skill-consumption
   events) for local trace-mining. Default capture remains scrubbed/non-mineable.
2. **Publish/admit as a task** — a separate gate. Even with mining consent, publishing
   a mined task still requires explicit approval, because the diff/test payload may
   expose private work.

This preserves today's privacy posture without losing option value: traces accumulate
only where consent is granted, and publication remains a second, deliberate step.
The envelope-shape extension still warrants a short implementation design pass at
rung-0 build time (field names, consent UX, scrub-stage wiring), but the policy is
locked.

### 10.1 Local operation and the public/private boundary (D5)

**Corpus participation and task-launching are independent axes.** An operator can run
the Task Creator entirely on local data — traces, repos, commit history on its own
disk — and launch tasks into the marketplace **without any local data ever entering
the corpus**. The corpus path (capture → scrub → publish → ledger) is a separate
pipeline that minting never invokes. Mining is a local read; admission
(`validatePoolInstances`) runs in local Docker. Concretely:

- **Stays local:** the full session transcript, prompts, intermediate failure states,
  skill-consumption events, and the source trace. Blinded provenance (§7) means a
  posted task carries only a hash-commitment to its source, so even the *link* back to
  the operator's trace is opaque until reveal.
- **The gold patch is never published.** It is consumed at admission time, which is
  local — the evaluator grades a solver's patch against the *tests*, not against the
  gold. So even the "answer" stays private.
- **Necessarily disclosed by posting** (a task must be solvable/gradeable by
  strangers): the problem statement, a Docker image containing the repo **at the mint
  commit**, and the test specification (`F2P`/`P2P`, `test_patch`, `install_config`).

The boundary that matters: **a posted task IS a snapshot of the repo's code at that
commit.** For public repos this discloses nothing new. For a private repo, posting
would ship the entire repo tree at that commit as an image — and **the scrub pipeline
protects trace *text*, not a built image** (`client/src/trajectory/scrub/` audits
envelopes for PII/secrets; nothing audits a code payload for proprietary logic). That
is unbuilt disclosure-control work, not a consent checkbox.

**Decision (D5): v0 publishes public-repo tasks only.** Task publication is gated to
repos that are already public. This costs nothing on the near rungs — rung 1
(commit-echo) targets repos with admitted images (the public benchmark repos), and
rung 2's SolverNet traces are public benchmark instances — so the gate only constrains
the destination (§5.6), which is rungs away regardless. **Local mining still runs on
private data** under D2 tier-1 consent, accumulating candidate instances that are
simply **not postable in v0**. Private-repo task publication is a deferred follow-on
that must first solve code-payload disclosure (auditing/scrubbing a built image, or
minting only a consented sub-tree). Its eventual value is real but narrow — a
*snapshot-scoped, unlinkable* disclosure (one commit + blinded provenance) is
genuinely less than going fully public (full history + attribution), which is why a
"private launcher" persona exists — but it earns its complexity only once the snapshot
can be made safe. Until then, the honest position is: if the repo is public, launch
freely; if it is private, we do not yet have the controls to let you launch safely.

**D6 extension for non-repository Tasks.** The equivalent rule is that every public
input and environment layer must already be public or carry explicit redistribution
rights. This permits the unlicensed ALE compatibility pilot without weakening D5:
private workspace state, proprietary inputs, and licensed software remain
non-postable until their separate disclosure controls exist.

## 11. Held-out hygiene — the repo-keyed extension

The exclusion rule is layered today: the train stream excludes by `instance_id`
(`excludeHeldOutSlate`, `assertNoOverlap`); the distillation bridge excludes by
instance **and** derived repo (`bridge.ts`); cap-eval §12 mandates both axes for
anything feeding its arms. The minting path adopts the strictest rule, stated as:

> **A minted instance inherits the denylist status of its source repo.** No
> instance may be minted from a repo on any active held-out slate (union of active
> slate versions plus the `cap-v0` repo denylist once frozen, per cap-eval §12) —
> checked at mint time, before admission spend, keyed on repo, never on the fresh
> `instance_id`.

## 12. Second-layer (utility) evaluation — deferred, with the option kept open

A verdict is a truth claim ("this patch passes these tests"); downstream utility
("did work that consumed this knowledge succeed more often") is a different axis and
gets a different mechanism: utility signals attach to traces/skills as separate
scores, and persistent negative downstream signal *impeaches* a verdict — evidence
for the Phase B.2 challenge mechanism, not a rewrite of anything anchored on-chain.
It is also the domain-agnostic layer that makes non-coding evaluation possible
(usage signal needs no test oracle) and the seed of Phase-3 knowledge pricing. All
of that is deliberately **out of scope here**; this spec's only obligation is the
skill-consumption clause of §10, which keeps the attribution data accumulating. The
design itself is its own session.

## 13. Acceptance criteria

1. **Gold-grade proof on an amd64 host.** Before any rung-1 mint posts to the
   network: a minted instance's gold patch grades as resolving through the
   *unmodified* evaluator path (row-routing fetcher + `rowHash` + image pin intact)
   on a proper amd64 host. Same pattern as cap-eval's "the rig is a follow-on
   `feat`" — this spec signs off methodology; the proof is the first build gate.
2. **Discrimination check live.** `validatePoolInstances` hard-rejects minted
   instances whose known-bad patch scores 1; flags (and excludes from distillation
   targeting) benchmark-pool failures per D3, with regression tests for both paths.
3. **Claims anchored.** The ~28.5% weak-suite figure cited to a primary source (or
   re-derived on our own pool and the number replaced); the SWE-smith spike findings
   written up as the #994 finding (a DR or issue comment) and the issue closed.
4. **Contract landed.** The mineable-trace contract fields defined in the capture
   envelope shape with the two-tier consent model (D2), so capture can begin
   retaining mineable material where opted in.
5. **Hygiene enforced.** Repo-keyed exclusion in the mint path with a test proving
   a fresh-ID instance from a slate repo is refused at mint time.
6. **Public-repo gate enforced (D5).** Publication refuses any task whose source repo
   is not public, with a test proving a private-repo candidate is blocked at the
   publish step (local mining of that candidate is still allowed under D2 tier-1).
7. **Generalized boundary specified (D6).** The companion design defines the public
   Task Capsule, evaluator-only bundle, portable Solution projection, admission
   receipt, task-family adapter, and provider lifecycle without changing the shipped
   Rebench semantics.

## 14. Decisions locked in this session

| # | Decision | Resolution |
|---|---|---|
| **D1** | Who escrows delivery fees for minted tasks (§9) | **Self-funded launcher escrow for v0** via `computeEscrowWei`, same fee semantics as live tasks, bounded by ≤25% quota + informative-band stop. No protocol subsidy or special synthetic pricing — cost signal must be honest. |
| **D2** | Mineable-trace consent tier vs. scrub posture (§10) | **Explicit opt-in consent tier**, split: (1) retain locally for mining, (2) publish/admit as a task. Default capture stays scrubbed/non-mineable. Envelope-shape implementation details deferred to rung-0 build. |
| **D3** | Discrimination failure: flag or hard-reject (§5.1) | **Hard-reject all newly minted instances** when known-bad passes. **Flag + exclude from distillation/targeting** for the existing benchmark pool initially; re-publish a stricter vetted-pool artifact once impact is measured. |
| **D4** | Commit-echo before hunk-subset echo (§5 ordering) | **Yes — commit-echo first** as plumbing proof (minted-row store, IPFS route, admission, generator union). Treat as yield validation, not final learning substrate (lookup contamination). Hunk-subset echo next once blinded provenance + dogfood traces are ready. |
| **D5** | Public vs. private inputs for task publication (§10.1) | **v0 coding Tasks publish public repos only; D6 generalized Tasks require every disclosed input/environment layer to be public or explicitly redistributable.** Corpus participation and task-launching are independent — mining runs locally with nothing entering the corpus, and the gold result is never published. Local mining still runs on private data (D2 tier-1) but its candidates are non-postable. Private-work publication is deferred to a follow-on that solves payload disclosure (scrub covers trace text, not code images or arbitrary artifacts). |
| **D6** | Where ALE-style task/environment/evaluator infrastructure enters the Task Creator | **At a domain-neutral Task Capsule boundary between mining and admission.** The existing Rebench path remains the coding adapter. Provider/runtime contracts and a portable artifact Solution land before rung 4; rung 4 becomes automatic environment synthesis. `session-derived.v2` in the existing contract family carries generalized capsule-backed work without mutating v1. |

## 15. References

- Issue [#994](https://github.com/Jinn-Network/mono/issues/994) — the SWE-smith
  spike this spec answers; [#802](https://github.com/Jinn-Network/mono/issues/802)
  — abandon-cap removal; [#1409](https://github.com/Jinn-Network/mono/issues/1409)
  — scrub over-redaction; [#1416](https://github.com/Jinn-Network/mono/pull/1416)
  — cap-eval v0 spec + rig plan.
- `spec/2026-07-06-distillation-v1.md` (§2.4 null priors, §11 three-arm, §12
  boundary consumption); `spec/2026-07-06-capability-eval-v0.md` §12 (held-out
  boundary); `spec/2026-07-06-harness-network-roadmap-v0-v3.md` (sequencing).
- DR-2026-06-02-b (`log/decisions/2026-06-02-held-out-efficacy-measurement-power.md`)
  — the underpowered-exam lineage; DR-2026-05-06-b (benchmark choice);
  DR-2026-05-07-g (capture envelope shape, extended by §10);
  DR-2026-05-14 (fail-closed admission).
- SWE-smith — https://github.com/SWE-bench/SWE-smith (MIT; machinery forked per
  §5.3/§5.4, dataset rejected per §6); R2E-Gym (backtranslation); REPOLAUNCH
  (agentic env construction); LiveCodeBench (recency-based contamination
  resistance).
- `docs/superpowers/specs/2026-07-10-task-creator-generalized-task-capsules-design.md`
  — D6 contract, ALE adapter mapping, admission policy, and automation roadmap.
- Agents' Last Exam — https://github.com/rdi-berkeley/agents-last-exam (Apache-2.0
  framework; task data/content CC-BY-4.0), inspected for D6 at commit
  `186691830cd6906a405cb997b39bc5f5ca82e2a4`.
