---
id: DR-2026-05-26
title: SolverNet learning — agents are not demonstrably learning; corpus read-path is broken in Hermes and unenforced in claude-code/codex
date: 2026-05-26
verb: Find
status: ratified
authors: opus (spike on spike/659-investigate-solvernet-learning)
spike: issue #659
relates-to: issue #601 (parent epic), PRs #349 / #350 / #351 / #162 (donation production/consumption)
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
   (`client/src/mcp/server.ts:82`, `client/src/mcp/search-records.ts:298`,
   `client/src/mcp/acquire-artifact.ts`).
3. The agent — the LLM running inside `claude`, `codex`, or `hermes` — is
   *expected* to call those tools, find prior successful solutions for the
   current `instance_id`, acquire the bytes, and consult them while generating
   its own solution.

There is no pre-fetch of donations into the prompt and no harness-level
"donations" parameter; the read-path is entirely MCP-tool-mediated and
LLM-driven. The harness implementations live in-tree under
`client/src/harnesses/impls/` (the issue's reference to `packages/*/` is
incorrect — there are no standalone `packages/codex/` or `packages/claude-code/`
packages).

## Finding — outcome (b): agents are not demonstrably learning

Agents are NOT demonstrably learning across operators. The cross-operator
read-path is **broken in `hermes-agent`** (concrete code defect) and **unenforced
in `claude-code` / `codex`** (LLM-instruction only; no harness-side guarantee
the donation is read before patch generation). The within-operator learning
path (`implStateDir` git-backed memory written by the learner plugin's
Improve/Memory phases) is wired but has not been verified to run in production.
The learning-curve metric on the explorer cannot distinguish "agents are not
consuming donations" from "agents are consuming and not improving" — it
measures resolved rate only, with no trajectory-level tool-call signal.

This means the observed 60–70% plateau is consistent with cross-operator
learning being effectively off across the network. We did not examine LLM
trajectories in production runs and cannot say what *fraction* of the gap is
the broken read-path vs. an LLM capability ceiling vs. metric smoothing.
Closing the read-path is the prerequisite to interpreting the metric.

### B1 — Hermes corpus discovery is broken (code defect)

`main.ts:1914` builds the daemon's `corpusEnv` with a `discoveryUrl` field
(matching `RunnerContext.corpusEnv` at `client/src/runner/runner.ts:28`) and
passes it through `buildHarnesses()` (`client/src/harnesses/impls/index.ts:278`)
into `HermesHarnessAdapter`.

`HermesHarnessAdapter` declares its `corpusEnv` as
`ConfigBuilderEnv['corpusEnv']` (`client/src/harnesses/impls/hermes-agent/adapter.ts:72`),
whose schema is `{ subgraphUrl?: string }`
(`client/src/harnesses/impls/hermes-agent/config-builder.ts:30`).

`snippetToEnvFile()` (`client/src/harnesses/impls/hermes-agent/bootstrap.ts:244`)
and `buildJinnRuntimeEnv()` (`client/src/harnesses/impls/hermes-agent/config-builder.ts:91`)
both gate on `env.corpusEnv.subgraphUrl` and write
`JINN_CORPUS_SUBGRAPH_URL` — but `subgraphUrl` is always undefined because
the daemon supplies `discoveryUrl`. The MCP server reads
`JINN_DISCOVERY_URL` (`client/src/mcp/server.ts:82`), not
`JINN_CORPUS_SUBGRAPH_URL`.

Therefore the Hermes MCP subprocess starts without `JINN_DISCOVERY_URL` set.
`buildReadOnlyCorpus()` returns null (`client/src/mcp/server.ts:92`:
`if (!ipfsGatewayUrl || (!hasDiscovery && !hasOnchainCorpus)) return null`),
and `handleSearchRecords()` falls back to local-only results with a corpus
warning. Hermes operators never see network donations.

Note that Hermes also does not load the Jinn-side `learner` plugin by design
(`client/src/harnesses/impls/hermes-agent/harness.ts:43-46`); it relies on its
own internal skill-self-improvement and FTS5 session search. The cross-operator
gap is the bug.

### B2 — claude-code / codex: corpus consumption is possible but unenforced

`ClaudeCodeHarnessAdapter` (`client/src/harnesses/impls/learner/adapters/claude-code.ts:207`)
and `CodexCodeHarnessAdapter` (`client/src/harnesses/impls/learner/adapters/codex-code.ts:179`)
correctly forward `JINN_DISCOVERY_URL` from `corpusEnv.discoveryUrl` into the
MCP subprocess. The same `LearnerHarness` class
(`client/src/harnesses/impls/learner/harness.ts:26`) backs both.

The initial prompt (`buildInitialPrompt()` at
`client/src/harnesses/impls/learner/adapters/claude-code.ts:108`) contains the
task body only — no donation data, no prior runs, no corpus artifacts. The
`swe-rebench-v2-runtime` orient skill
(`client/plugins/swe-rebench-v2-runtime/skills/orient/SKILL.md:22-25`)
instructs the agent in prose to "search for records with
`solverType: 'swe-rebench-v2.v1'`, `role: 'restoration'`, and
`artifactType: 'swe-rebench-v2_v1_solution'`" and to acquire promising
artifacts. The learner plugin's `learn` skill (`client/plugins/learner/skills/learn/SKILL.md`
§3) instructs the agent to dispatch an `others-history` explorer subagent.

These are LLM-readable instructions, not code. The harness does not enforce
that `search_records` is called, does not pre-inject corpus results, and does
not check that any `acquire_artifact` call occurred before the patch is
emitted. Whether donations influence the solution is entirely LLM-behaviour-
dependent. We did not examine production trajectories to measure how often
the model follows the instruction.

### B3 — No harness-side mechanism injects donations into per-run state

The learner plugin's `implStateDir` (git-backed, `client/plugins/learner/hooks/session-start`)
is the within-operator memory surface. Its Improve and Memory phases
(SKILL.md §8–§9, gated on `mode === 'train'`) commit skill edits and strategy
notes after a successful run. The session-start hook initialises the git repo
but does *not* read corpus state or pre-populate any donated content.
Cross-operator learning routes exclusively through B2's MCP path; if B2 does
not fire, nothing else closes the gap.

### B4 — The donation-consumption gate confirms acquisition, not influence

`scripts/donation-consumption-acceptance.ts:1227-1229` asserts
`lastUsedAt >= acquisitionStartedAt` against the SQLite network-cache row. The
`lastUsedAt` column is bumped whenever `acquire_artifact` returns bytes. The
gate proves the cache was hit during the session. It does not prove the bytes
were read by the model, included in its context, or influenced the patch. The
gate is necessary but not sufficient evidence of learning.

### B5 — The learning-curve metric cannot distinguish "not consuming" from "not benefiting"

`packages/indexer/src/api/explorer.ts:781` returns `bucketResolvedRate`
(`packages/indexer/src/api/metrics.ts:116`, default 7200-block buckets ≈ 1 day
on Base at 12s/block) and `rollingResolvedRate`
(`packages/indexer/src/api/metrics.ts:159`, k=50 trailing window over verdict
booleans). Both summarise the *output* of solve attempts. Neither indexes the
MCP tool-call log from each session, so a 60–70% plateau is consistent with
any combination of: corpus calls never made (B1, B2), corpus calls made but
content not used by the LLM, content used but capability ceiling reached, or
metric smoothing hiding a real trend. Distinguishing these requires
trajectory-level signal the indexer does not currently surface.

## Caveats / things this spike did not check

1. We did not examine LLM trajectories from production runs to confirm whether
   the `claude-code` / `codex` model actually calls `search_records` in
   practice.
2. We did not verify, on a real operator's machine, that
   `~/.jinn-client/engine/impl-state/claude-code-learner/.git` has commits
   beyond `init implStateDir` — i.e. that the Improve/Memory phases run in
   production and `mode` is ever `train` rather than `frozen`.
3. The `network-tools` plugin is required to expose corpus MCP tools to the
   session; we did not confirm it is loaded against production SolverNet
   manifests.
4. PRs #349/#350/#351/#162 were read from current code state; we did not
   inspect their merge-time intent for divergence.
5. Hermes' internal learning (skill self-improvement, FTS5 session search) is
   external code and not analysed here. B1 is about the Jinn cross-operator
   path, not Hermes' internal memory.
6. We did not evaluate the gpt-5.4-mini / current model versions for
   instruction-following quality on the orient skill.

## Candidate sibling issues (under #601)

These are the concrete repair tracks implied by B1–B5. File them separately
under the #601 epic; this DR is the finding, not the implementation plan.

1. **`fix(harnesses): Hermes MCP server missing JINN_DISCOVERY_URL — subgraphUrl/discoveryUrl field-name mismatch`**
   Fix the field-name mismatch in `HermesHarnessAdapter.corpusEnv`. Add a
   `discoveryUrl` field to `ConfigBuilderEnv.corpusEnv` and write
   `JINN_DISCOVERY_URL` from both `snippetToEnvFile()`
   (`client/src/harnesses/impls/hermes-agent/bootstrap.ts:244`) and
   `buildJinnRuntimeEnv()`
   (`client/src/harnesses/impls/hermes-agent/config-builder.ts:91`).
   Acceptance: the Hermes MCP subprocess receives `JINN_DISCOVERY_URL`
   matching the daemon's `discovery.url`; `handleSearchRecords` returns
   network corpus results. Shape: `fix`.

2. **`feat(harnesses): enforce corpus pre-scan before patch generation for swe-rebench-v2 in LearnerHarness`**
   Replace the soft orient-skill instruction with a harness-side pre-run step
   that executes `search_records` for the current `instance_id` and either
   injects the structured result into the task prompt or writes
   `workingDir/.orient/injected-corpus-context.json` for the orient skill to
   read. Files: `client/src/harnesses/impls/learner/harness.ts`,
   `client/plugins/swe-rebench-v2-runtime/`. Acceptance: when donations exist
   for the `instance_id`, a corpus-context artifact appears under the working
   directory before the model is invoked; transcripts show the model
   references it. Shape: `feat`.

3. **`feat(indexer): surface corpus tool-call evidence in per-attempt trajectory`**
   Extract from the trajectory bundle attached to each envelope: whether
   `search_records` was called, how many `acquire_artifact` calls succeeded,
   and the `instance_id` those queries targeted. Index this and expose a
   `corpusConsumptionRate` on the SolverNet detail endpoint. Files:
   `packages/indexer/src/handlers.ts`,
   `packages/indexer/src/api/explorer.ts`, `packages/indexer/ponder.schema.ts`.
   Acceptance: `/explorer/solvernet/:cid` returns
   `corpusConsumptionRate: number | null` alongside `resolvedRate`. Shape:
   `feat`.

4. **`spike: controlled A/B — does corpus consumption improve resolved rate on swe-rebench-v2?`**
   For instances with at least one donated prior solution, run N attempts
   with corpus consumption enabled and N with it disabled (e.g. via a
   `JINN_CORPUS_SKIP_ORIENT` flag). Compare resolved rates. Output: a
   finding with measured effect size and confidence interval. Sequence: do
   issue 1 (B1 fix) and issue 3 (trajectory signal) first so the experiment
   has a working baseline and a way to verify which arm actually consumed.
   Shape: `spike`.

5. **`spike: verify Improve/Memory consolidation runs in production — is implStateDir growing?`**
   Inspect a production operator's
   `~/.jinn-client/engine/impl-state/claude-code-learner/` git history. If
   only `init implStateDir` appears, the Improve/Memory phases are not
   executing (probable cause: `mode` is `frozen`, or earlier phases fail
   first). Output: a written finding with a real `git log` excerpt or a code
   reference explaining the absence. Shape: `spike`.

## Status

Ratified as the spike finding for issue #659. No code changes land under this
DR; the five candidate sibling issues above are filed separately under #601 as
follow-up work.
