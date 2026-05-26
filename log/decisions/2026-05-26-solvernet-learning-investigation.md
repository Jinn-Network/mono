---
id: DR-2026-05-26
title: SolverNet learning — corpus consumption works, but swe-rebench-v2's plan skill terminates the agent's loop before Improve/Memory; SolverType plugins must not own orchestration
date: 2026-05-26
verb: Find
status: ratified
authors: opus (spike on spike/659-investigate-solvernet-learning)
spike: issue #659
relates-to: issue #601 (parent epic), issue #666, #669, #670, #671, #672, #673 (sibling fixes filed during this spike), PRs #349 / #350 / #351 / #162 (donation production/consumption)
amends: this is the second draft; the first draft (committed earlier on this branch) reached outcome (b) but with the wrong root cause and a sibling-issue list that turned out to be obsolete. Both drafts retained in git history.
---

## Context

The Phase A.1 learning-curve telemetry on `/explorer/solvernet/<cid>` has
plateaued at a 60–70% resolved rate across all three production harnesses
(`claude-code`, `codex`, `hermes-agent`). Issue [#659](https://github.com/Jinn-Network/mono/issues/659)
asks whether the daemon's agents are actually consuming donated artifacts when
generating a solution, or whether donations are inert files that no agent ever
reads.

The cross-operator learning path, as designed in PRs #349/#350/#351/#162, is:

1. The daemon publishes envelopes with `ArtifactSource.encoding =
   'jinn.artifact.donation.v1'` to the IdentityRegistry. The Ponder indexer
   materialises a corpus view over those envelopes.
2. During a solve session, the harness's MCP subprocess exposes
   `search_records`, `inspect_record`, and `acquire_artifact` tools backed by
   the same indexer plus a local x402-payment-cached store
   (`client/src/mcp/server.ts`).
3. The agent inside the spawned model CLI (`claude`, `codex`, or `hermes`)
   is *expected* to call those tools, find prior successful solutions for the
   current `instance_id`, acquire the bytes, and consult them while generating
   its own solution.
4. The learner plugin's `learn` skill drives a 7-phase loop (Orient →
   Strategize → Plan → Execute → Debrief → Improve → Memory consolidation),
   with phases 6 and 7 mutating `implStateDir` so durable strategy notes
   accumulate across runs (`mode = train` gate).

The expected payoff: each operator's swe-rebench-v2 attempts get better over
time because (a) the agent reads donated artifacts from the network into its
solving context, and (b) phases 6–7 write durable improvement notes that the
next run starts from.

This DR replaces an earlier draft on the same branch that misdiagnosed the
gap as a corpus-read failure. The corrected picture is below.

## Finding — outcome (b), refined: the read-path works, but the agent's loop terminates before Improve/Memory because of SolverType plugin orchestration leakage

The corpus consumption path is operational. Agents DO call `search_records`,
DO call `acquire_artifact`, DO receive past patch bytes, and DO produce
patches that resemble the acquired prior work. What's broken is downstream:

1. The `swe-rebench-v2-runtime` plugin's `plan` skill explicitly tells the
   agent its work is done after `submit_typed_payload`. The agent obeys and
   never reaches phases 7–9 (Debrief / Improve / Memory).
2. No cross-session strategy notes accumulate for swe-rebench-v2 on any
   harness, on this operator, across 215 production runs.
3. The cross-operator corpus is also extremely sparse — only two operators
   are actively publishing donations today — so even if the read-path were
   more aggressive, there is very little cross-operator material to read.

The plateau is therefore consistent with: within-operator learning is
mechanically possible (the agent uses past local patches as context) but
nothing durable persists between runs, and cross-operator amplification has
no substrate to amplify from yet. Both must be fixed before Milestone #2's
+10pp gate is achievable.

### Architectural principle (the load-bearing decision)

**SolverType plugins describe their domain; they do not override the
harness's loop.** The `learn` skill is the orchestration playbook and lives
in the `learner` plugin. Any SolverType-specific plugin
(`swe-rebench-v2-runtime`, future plugins for new task types) contains only
domain knowledge — the task input shape, the output contract, submission
tools and their use, success criteria. No "this cycle is complete," no
"after submission, the daemon will…", no instructions that imply the agent's
work is finished.

The same rule, applied to other layers:

- The `learner` plugin contains no SolverType references. Its prompts are
  generic; nothing about "if the task is swe-rebench, do X."
- The `network-tools` plugin is a pure MCP transport plugin with no
  agent-facing prose.
- The harness's TypeScript code (`client/src/harnesses/`) may need to know
  about SolverType-specific details for output harvesting (e.g.
  `maybeMaterializeSweRebenchPatchPayload` in `harvest.ts`), but that's a
  separate layering question (see Follow-ups below).

This DR ratifies the principle. Sibling issue [#673](https://github.com/Jinn-Network/mono/issues/673)
implements it for swe-rebench-v2-runtime; future SolverType plugins land
under the same rule.

### Detailed findings

#### F1 — Corpus tools ARE being called

Inspected `~/.codex/sessions/2026/` JSONL transcripts on this operator,
filtered to daemon-spawned sessions (cwd under `~/.jinn-client/engine/work/`),
323 sessions total:

| Step | Calls | Sessions reaching this step |
|---|---|---|
| `search_records` | 562 | 233 / 323 = 72% |
| `inspect_record` | 226 | 162 / 323 = 50% |
| `acquire_artifact` | 177 | 134 / 323 = 41% |
| Full search → inspect → acquire chain | — | 133 / 323 = 41% |

In a 50-session sample of acquire calls, 27 succeeded and 1 errored. The
bytes returned are full swe-rebench-v2-solution.v1 JSONs with the `patch`
field populated.

Patch-similarity verification: one sympy-27510 session on 2026-05-18 (full
chain, 2 acquires) was inspected. The acquired past patch and the produced
new patch both modify `sympy/printing/str.py`'s `_print_Mul` in essentially
identical ways (remove the early `prec = precedence(expr)` line, move it
after the early-return path). Not coincidence — the model used the acquired
content.

#### F2 — All 76 acquires hit this operator's own past work, not other operators'

`ownerSafe` fields across all `search_records` outputs in 323 sessions:

- 610 refs to `0x0e767...` (this operator's own published donations)
- 72 refs to `0x7828...` (Phase 0 fossil — manifest schema doesn't satisfy
  current consumer validator)
- 10 refs to `0x53d141...` (similar Phase 0 fossil)
- 2 refs to `0x26e9...` (5879 — the only other active publisher on the
  network today)

`ownerSafe` on all 76 `acquire_artifact` call args: 100% this operator's own
Safe. Zero cross-operator acquires. Plausibly because (a) instance_id
matching is local-tighter — the agent's own past work is more likely to
share the current instance_id than another operator's, and (b) the
cross-operator donation pool is so thin that for most instances there are no
matching donations available.

#### F3 — Cross-operator corpus is sparse: 2 active publishers

Indexer (`/explorer/network`) GraphQL across all envelopes:

| agentId | envelope count | notes |
|---|---|---|
| 5474 | 430 | this operator |
| 5879 | 235 | second active publisher; verified publishing with `jinn.artifact.donation.v1` encoding |
| 5277 / 5737 / 5941 / 5838 / 5945 / 5956 / 5914 | 24 / 23 / 15 / 5 / 3 / 2 / 2 | Phase 0 fossils — `kind: prediction.v0`, no `solverType`, missing the access blocks the current consumer schema requires |

Composition: codex 84% / hermes 13% / prediction baseline 2% / learner-prefix
harnesses combined <1%. By model: gpt-5.4-mini 59%. The Milestone #2 target
configuration (codex + gpt-5.4-mini on swe-rebench-v2.v1) is the dominant
production traffic.

#### F4 — swe-rebench-v2 plugin terminates the agent's loop

[`client/plugins/swe-rebench-v2-runtime/skills/plan/SKILL.md`](../../client/plugins/swe-rebench-v2-runtime/skills/plan/SKILL.md)
final paragraph, verbatim:

> "After a successful submission, **this Plan/Execute cycle is complete** —
> the daemon's harness picks up the persisted payload post-execution and
> assembles the on-chain envelope."

The agent picks this skill over the generic `learn` skill (description match
on "swe-rebench v2 task" is tighter), follows it to `submit_typed_payload`,
and exits. The `learn` skill's pre-execute / post-execute split design
([`client/plugins/learner/skills/learn/SKILL.md`](../../client/plugins/learner/skills/learn/SKILL.md) §2)
is documented but never invoked by the adapter — `LEARNER_PHASE_RANGE` is
read only by harvest-side code (`harvest.ts:379`); no adapter ever sets it.

#### F5 — Direct evidence: impl-state git histories

Inspected every harness's `implStateDir` under
`~/.jinn-client/engine/impl-state/`:

| Harness/SolverType | Commits | Status |
|---|---|---|
| `claude-code-learner/prediction_v1` | **9 commits** | Real improve/consolidate cycles firing. Sample: `improve: enhance consensus baseline strategy`, `consolidate: archive run 9c1a953fe92c8357`. |
| `codex-code-learner/swe-rebench-v2_v1` | 1 (init only) | No phase 6–7 writes. |
| `claude-code-learner/swe-rebench-v2_v1` | 1 (init only) | No phase 6–7 writes. |
| `hermes-agent/swe-rebench-v2_v1` | directory missing | Hermes runs its own internal memory loop, doesn't load the learner plugin (per its harness.ts comment). |
| `swe-rebench-v2-evaluator/upstream` | 1 (init only) | No phase 6–7 writes (expected — evaluators don't self-modify). |

Same operator, same harness for some rows (`claude-code-learner`),
different SolverTypes. Prediction loops fire all 7 phases. swe-rebench loops
stop after submit. The difference is the SolverType plugin, not the
harness or the operator.

#### F6 — Codex session post-submit doesn't reach Debrief/Improve/Memory

Direct inspection of one daemon-spawned codex session for sympy-27510 (May
18, full chain):

- 41 total function calls; ordering: `exec_command (26) → search_records (4)
  → inspect_record (2) → acquire_artifact (2) → submit_typed_payload (2) →
  write_stdin (2)`.
- After the second `submit_typed_payload`, session ended.
- Zero writes to `.debrief/`, `.improve/`, `.memory-consolidation/`.

#### F7 — Envelope-level evidence corroborates (per ritsuKai2000's #659 comment)

The envelope's `executor.plugins` array is populated from
`solverNet.runtimePlugins` ([`engine.ts:1153`](../../client/src/harnesses/engine/engine.ts#L1153)),
not from what the adapter materially loads. The swe-rebench-v2 SolverNet
manifest declares `network-tools` + `swe-rebench-v2-runtime` only — no
learner plugin. So envelopes signed by this operator across 241 swe-rebench
attempts list those two plugins and nothing else, even though the codex
adapter does materialise the learner plugin into the workspace at runtime.

Two interpretations:
- The learner plugin is harness-internal (loaded by the adapter, not
  attested in the SolverNet contract) — consistent with the architectural
  principle in §"Architectural principle" above.
- OR: the learner plugin should be in the SolverNet manifest so on-chain
  attestation proves the operator ran with self-improvement.

The current implementation chose the first; whether that should change is
an open architectural question for #601 / mainnet. This DR notes the
choice rather than ratifying it.

#### F8 — Side findings: launcher saturation/abandonment caps violated

While tracing why sympy-27510 had 22 verdicts (21 PASSED), discovered the
local generator state shows `posted: 16, successful: 8` for that
instance — both above the configured thresholds (`N_target_successes: 5`,
`N_max_postings_per_task: 10`). Two root causes:

- `recordSuccess` only counts verdicts this daemon's delivery-watcher
  observes, not on-chain truth (local 8 vs on-chain 21). Operator launchers
  see an undercount and over-post resolved instances.
- `selectNextPostingCandidates` reads counters at tick start, not per-post;
  a single tick with `post_batch_size: 25` can blow past `N_max_postings_per_task`
  for a single instance before any update fires.

Filed as [#669](https://github.com/Jinn-Network/mono/issues/669) and
[#670](https://github.com/Jinn-Network/mono/issues/670). Independent of the
main spike question but found while investigating it.

#### F9 — Side finding: daemon-side telemetry capture exists but isn't wired

`capture_spans` and `pending_captures` tables, the OTel OTLP receiver, the
processor stack (CredentialScrub / IdentityScrub / PathScrub /
TranscriptContentScrub / EnsurePendingCapture / SqliteExporter), and the
Path B `transcript-watcher.ts` with per-tool parsers (codex, claude-code,
gemini-cli, aider, continue) all exist as production code. But
`startTranscriptWatcher` has zero callers in `main.ts`, so Path B never runs.
And `CodexSessionParser` expects the flat pre-0.129.0 Codex format; current
Codex CLI emits `{timestamp, type, payload}` wrapped records that the parser
silently skips.

Net effect: 1,179 codex session JSONLs on this operator's disk go to waste
when they could be flowing into `capture_spans` for SQL-queryable
observability. Filed as [#671](https://github.com/Jinn-Network/mono/issues/671)
and [#672](https://github.com/Jinn-Network/mono/issues/672).

#### F10 — Side finding: Hermes corpus discovery completely broken

`HermesHarnessAdapter.corpusEnv` uses `ConfigBuilderEnv['corpusEnv']` which
declares `subgraphUrl?: string`, while the daemon supplies `discoveryUrl`.
`snippetToEnvFile()` and `buildJinnRuntimeEnv()` gate on
`env.corpusEnv.subgraphUrl` — always undefined — and write the wrong env
var name. The MCP server reads `JINN_DISCOVERY_URL`. Hermes operators get
local-only corpus results and no network donations ever reach them.

Filed as [#666](https://github.com/Jinn-Network/mono/issues/666). Smaller
blast radius than the main finding (one harness affected) but a clean fix.

## Decision

1. **Ratify the architectural principle:** SolverType plugins describe their
   domain only. They do not contain orchestration verbs ("this cycle is
   complete," "after submission, the daemon will…", "your work is done") and
   they do not override the harness's 7-phase loop. Phase orchestration is
   exclusively the learner plugin's `learn` skill.

2. **Implement the principle for swe-rebench-v2 in [#673](https://github.com/Jinn-Network/mono/issues/673):**
   delete `client/plugins/swe-rebench-v2-runtime/skills/orient/SKILL.md` and
   `.../plan/SKILL.md`. Replace with a single domain-only `contract` skill
   describing task input shape, repo handling, `FAIL_TO_PASS` / `PASS_TO_PASS`
   semantics, the `swe-rebench-v2-solution.v1` output schema, and use of
   `submit_typed_payload` for delivery — with no orchestration verbs.
   `network-tools` and the `learner` plugin remain untouched. Verify by
   running one codex session against a sympy-27510-class task and confirming
   `~/.jinn-client/engine/impl-state/codex-code-learner/swe-rebench-v2_v1/.git`
   accumulates commits beyond `init implStateDir`.

3. **`swe-rebench-v2-diffmin` cleanup is a follow-up sibling issue,** not a
   blocker for #673. The same layering rule applies; the file is
   `client/plugins/swe-rebench-v2-diffmin/skills/diffmin/SKILL.md:114` which
   currently mixes diffmin-technique guidance with `submit_typed_payload`
   prose.

4. **Defer the "should learner be in the SolverNet manifest?" question.**
   Today it isn't (harness-internal). This DR records the question (F7) but
   does not decide it. Surface for #601 / mainnet design.

## Consequences

- Once #673 lands, swe-rebench-v2 sessions complete the full 7-phase loop,
  Improve/Memory commits start appearing in
  `codex-code-learner/swe-rebench-v2_v1/.git`, and we get observable
  cross-session learning for the Milestone #2 dominant configuration. The
  +10pp gate becomes attainable.
- Cross-operator amplification remains thin until donation density grows.
  The 2-active-publishers picture doesn't change with #673 alone — it needs
  GTM / incentive work that's outside the engineering surface.
- The launcher fixes (#669, #670) compound the win: with accurate counters
  and respected caps, operators stop wasting budget on resolved instances
  and the learning-curve denominator stops being inflated.
- The TranscriptWatcher + parser fixes (#671, #672) unlock observability for
  the next round of investigation — any future "did the agent learn?" or
  "did this change help?" question becomes a SQL query, not a JSONL grep.
- Hermes (#666) becomes a real cross-operator corpus consumer once fixed;
  currently it's silently disabled.

## Caveats / things this spike did not check

1. **LLM trajectories on other operators' machines.** Only this operator's
   sessions were inspected. Whether agentId 5879's codex follows the same
   "stops after submit" pattern is presumed but not verified.
2. **The exact reason the agent picks `swe-rebench-v2-orient` over `learn`.**
   Skill-discovery / description-matching behaviour is LLM-specific.
   Post-fix, the absence of orient/plan should force the agent onto the
   `learn` skill, but if it doesn't, the test session will surface that.
3. **Window-pressure feasibility.** Whether adding Debrief / Improve /
   Memory to a swe-rebench session fits within the task window at scale is
   unverified. If sessions hit window-end before phase 7, partial outcomes
   (e.g. `.improve/` artifacts written before the cut) are still
   informative, but reliable consolidation may need window-budget tuning.
4. **`harvest.ts` SolverType-awareness** (`maybeMaterializeSweRebenchPatchPayload`)
   is a latent layering violation on the TypeScript side. The agreed
   principle says SolverType-specific logic should live in plugins, not in
   the daemon's TypeScript code. Out of scope for this spike — flag as a
   follow-up `refactor` issue.
5. **Prediction.v1's working loop is the reference**, but its specific
   prompts may not transfer directly to swe-rebench (e.g. "consensus
   baseline" vocabulary is prediction-specific). The Improve subagent's
   generic prompt may need SolverType-aware enrichment over time. Acceptable
   for v1 of the fix; revisit if Improve notes for swe-rebench come out
   low-quality.

## Status

Ratified as the spike finding for [#659](https://github.com/Jinn-Network/mono/issues/659).

This DR replaces the earlier draft on this branch (same path, earlier
commit) which incorrectly diagnosed the gap as "corpus read-path broken /
unenforced" and proposed sibling issues that have since been retired or
reshaped (see Decision §1 above for the architectural principle that
emerged; see the sibling-issue list in the front-matter for the
implementation tracking). The earlier draft remains in git history on this
branch as a record of the investigation arc.

Sibling implementation work tracked separately:

- [#666](https://github.com/Jinn-Network/mono/issues/666) — `fix`, Hermes corpus discovery
- [#669](https://github.com/Jinn-Network/mono/issues/669) — `fix`, launcher counter under-counts
- [#670](https://github.com/Jinn-Network/mono/issues/670) — `fix`, launcher cap overshoot
- [#671](https://github.com/Jinn-Network/mono/issues/671) — `feat`, TranscriptWatcher startup
- [#672](https://github.com/Jinn-Network/mono/issues/672) — `fix`, CodexSessionParser format drift
- [#673](https://github.com/Jinn-Network/mono/issues/673) — `spike` deliverable (this DR) plus the swe-rebench-v2-runtime refactor
