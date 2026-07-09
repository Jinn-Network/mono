# Local Trace Distiller — experimental skills from a user's own agent work

- **Version:** 0.1
- **Date:** 2026-07-09
- **Author:** Ritsu + Codex design session
- **Shape:** design spec. Implementation should land as a follow-on plan and PR.
- **Status:** accepted design for follow-on implementation planning
- **Related:** `spec/2026-07-06-distillation-v1.md`,
  `spec/2026-07-08-task-creator-v0.md`, `docs/learning-engine.md`

## 1. Summary

Local Trace Distiller is a user-invoked local distillation plugin that turns a
user's own agent traces into **experimental local skills**, then improves or
retires those skills from later use and explicit user feedback.

It is not only a prompt-only skill. The v0 package contains:

- a bundled `/distill` skill that tells the agent how to run the workflow;
- a local trace tool layer for bounded trace discovery, reading, indexing,
  clustering, and redaction;
- orchestration rules for cheap scanner subagents, a stronger distiller, and a
  reviewer before user-approved installation.

It deliberately does **not** turn traces into marketplace tasks in v0. The task
marketplace remains a future validation and distribution path. v0's job is
smaller and more useful immediately:

1. Safely source and narrow local traces through plugin tools.
2. Find reusable lessons in recent local agent work.
3. Draft a standard `SKILL.md`-style artifact with clear provenance.
4. Mark it experimental, not proven.
5. Track when it is used.
6. Ask for lightweight user feedback at session end.
7. Propose skill revisions for the user to approve.

The design borrows the current Jinn distillation methodology: successes produce
strategic patterns, failures produce failure lessons, success/failure pairs
produce contrastive lessons, distilled skills use a fixed skeleton, and every
skill carries evidence provenance and an honest evidence tier.

## 2. Product stance

The original trace-mining conversation considered this path:

```text
local trace -> marketplace task -> many attempts -> evaluator verdicts -> distilled skill
```

That path is still valuable, but it is too heavy for the first product surface.
Most users want:

```text
local trace -> local lesson -> cheaper/better future local work
```

So v0 optimizes for local usefulness, not network-grade verification. It accepts
weak evidence when drafting a skill, but represents it honestly and keeps the
user in the approval loop.

Because the useful source material is inside local traces, v0 must be packaged
as a plugin, not just a standalone skill file. The skill supplies the judgment
and workflow. The plugin tools supply controlled access to traces and skill
storage. This avoids asking the agent to scrape arbitrary local files, keeps
large trace reads bounded, and gives the system a stable place to add indexing,
redaction, and clustering.

## 3. User experience

The command surface is one command: `/distill`. With no argument, it defaults to
the current-session flow:

```text
/distill        # same as /distill this
/distill this
/distill recent
/distill all
/distill <candidate-id>
```

If implemented as a CLI rather than an in-agent slash command, the equivalent
surface is:

```bash
jinn distill
jinn distill this
jinn distill recent
jinn distill all
jinn distill <candidate-id>
```

The command runs inside the current agent host, but it is backed by local plugin
tools. The distillation skill should not discover traces by manually walking
trace directories or guessing vendor-specific file formats. It should call the
trace tools described below, which provide scoped summaries and explicit read
modes.

### 3.1 `/distill` and `/distill this`

This is the after-session flow. The user has just completed expensive or
frustrating work and wants the agent to learn from it.

Flow:

1. The distiller reads the current or most recent local trace.
2. It identifies whether the session contains a reusable workflow, pitfall, or
   troubleshooting pattern.
3. It proposes one to three candidate lessons.
4. The user selects one or declines all.
5. The distiller drafts an experimental skill.
6. The user approves installation.

Example user-facing result:

```text
I found one reusable lesson in this session:

SWE-rebench evaluator setup recovery
Evidence: single session, 4 failed setup commands before success
Likely reuse: when an evaluator run fails before test execution
Suggested artifact: troubleshooting skill
```

The command must not silently install or edit a skill. Every install or revision
is user-approved.

### 3.2 `/distill recent`

This is the bounded mining flow. It scans a recent window and returns candidate
clusters, not completed skills.

Default bounds:

- last 14 days;
- at most 50 sessions;
- cheap scan model or local heuristics first;
- at most 5 candidate clusters returned;
- expensive distillation only after the user selects a candidate.

Example output:

```text
Found 3 possible skills:

1. SWE-rebench evaluator setup recovery
   Evidence: 6 sessions, 3 repeated failure shapes, 4 repeated commands
   Evidence tier: recurring-pattern
   Estimated source tokens: 42k
   Distill cost estimate: medium

2. GitHub PR review response workflow
   Evidence: 4 sessions, repeated review-comment triage pattern
   Evidence tier: recurring-pattern
   Estimated source tokens: 18k
   Distill cost estimate: low
```

The user then runs `/distill 1` or selects the candidate through the host UI.

### 3.3 `/distill all`

This is an indexing command, not a full-history distillation command. It must not
send all traces to an expensive model.

Flow:

1. Build or update a compact local trace index.
2. Scan metadata, summaries, tool names, command names, filenames, errors, and
   short excerpts.
3. Surface candidate clusters and cost estimates.
4. Wait for the user to select what to distill.

Suggested controls:

```text
--budget <amount-or-token-cap>
--max-sessions <n>
--since <duration>
--cheap-model <model>
--distill-model <model>
```

The important invariant: discovery can be broad; expensive distillation is
selected and narrow.

## 4. Execution architecture

Local Trace Distiller ships as a plugin with a bundled skill. The skill explains
the judgment-heavy workflow. The plugin exposes local tools that make trace
access explicit, bounded, and host-independent.

Architecture:

```text
/distill command
  -> bundled distillation skill
  -> local trace tools
  -> compact trace index and scoped trace readers
  -> cheap scanner subagents or sequential scanner loop
  -> selected candidate cluster
  -> strong distiller
  -> reviewer
  -> user-approved local skill install or revision
```

The plugin has three layers:

1. **Command and skill layer.** Registers `/distill` and loads the bundled
   distillation instructions. This layer decides which workflow to run, how to
   ask the user for selection and approval, and how to write candidate skill
   drafts.
2. **Local trace tool layer.** Provides deterministic access to local traces:
   listing, searching, reading, indexing, clustering, usage recording, feedback
   recording, and redaction. This layer knows where each supported host stores
   traces and how to normalize them.
3. **Orchestration layer.** Uses cheap scanner agents for broad search when the
   host supports subagents, then routes only selected evidence to the stronger
   distiller and reviewer.

The core boundary is:

- the skill handles reasoning, synthesis, and user interaction;
- the tools handle local data access, indexing, redaction, and persistence.

The agent should not manually scrape trace directories in normal operation. A
manual fallback can exist for development, but the product contract is the local
trace tool API.

### 4.1 Plugin package

The plugin should include:

- `skills/distill/SKILL.md`, or the host-equivalent skill file, containing the
  `/distill` workflow;
- a local MCP server or equivalent tool provider for trace access;
- a small local index store for compact trace cards and candidate clusters;
- a generated-skill storage adapter, preferably reusing the host's existing
  skill manager when one exists;
- registration metadata that exposes `/distill`, `/distill this`,
  `/distill recent`, `/distill all`, and `/distill <candidate-id>`.

The same tool layer can also back a CLI:

```bash
jinn distill this
jinn distill recent
jinn distill all
```

The CLI should call the plugin tools rather than implementing separate trace
parsers.

### 4.2 Runtime flows

`/distill this`:

1. Resolve the current or most recent session through `trace.list`.
2. Read compact session material through `trace.read` in summary and event modes.
3. If the session looks distillable, read targeted excerpts only.
4. Draft candidate lessons.
5. Redact the proposed skill body.
6. Ask the user before installing the generated skill.

`/distill recent`:

1. Update the compact trace index for the bounded recent window.
2. Use trace search and clustering over cards, not full transcripts.
3. Optionally shard scanning across cheap scanner subagents.
4. Return candidate cards with evidence, estimated source tokens, and estimated
   distillation cost.
5. Wait for the user to select a candidate before reading supporting excerpts.

`/distill all`:

1. Update the index incrementally across the configured history cap.
2. Use metadata, summaries, and short excerpts for broad discovery.
3. Shard broad scanning when subagents are available.
4. Return candidate clusters only.
5. Require explicit user selection and budget confirmation before any strong
   distillation pass.

### 4.3 Subagent orchestration

Subagents are useful for broad trace discovery, but they are not required for
correctness. A host without subagents can run the same scanner jobs
sequentially.

Scanner subagents receive only compact cards or small excerpt bundles. They
return candidate cards with:

- candidate id;
- short title;
- evidence trace ids;
- repeated signals such as commands, errors, files, user intents, or outcomes;
- evidence tier estimate;
- estimated source tokens for strong distillation;
- risk notes such as "may contain secrets" or "single-tool-specific".

The strong distiller receives only the selected candidate and its supporting
evidence. It should not rescan global history. The reviewer receives the draft
skill plus provenance, redaction report, and evidence summary.

## 5. Trace tool contract

The trace tool layer is the part that makes this a plugin rather than a
prompt-only skill. It normalizes host-specific traces into a small set of
operations the distillation skill can trust.

Required tools:

| Tool | Purpose |
|---|---|
| `trace.index` | Build or update compact local trace cards for a bounded window. |
| `trace.list` | Return trace ids and metadata by time, repo, source tool, or status. |
| `trace.search` | Search indexed cards by query, command, file path, error, tool, skill, or outcome. |
| `trace.read` | Read one trace using explicit modes such as `summary`, `events`, `tool_calls`, `transcript_excerpt`, or `full_transcript`. |
| `trace.cluster` | Group trace cards into candidate clusters using repeated signals. |
| `trace.redact` | Scrub secrets and sensitive snippets from trace excerpts or draft skill text. |
| `trace.usage.record` | Record that a generated skill was loaded or used in a session. |
| `trace.feedback.record` | Record user feedback about a generated skill after use. |

Optional tools:

| Tool | Purpose |
|---|---|
| `skill.generated.list` | List generated local skills and their metadata. |
| `skill.generated.install` | Install a user-approved generated skill. |
| `skill.generated.diff` | Store or apply a user-approved revision diff. |
| `skill.generated.deprecate` | Mark a generated skill deprecated after user approval or repeated negative feedback. |

If the host already has skill-manager tools, the plugin should reuse those for
installation and mutation. The trace plugin still owns provenance, usage, and
feedback metadata for generated skills.

### 5.1 Trace read modes

`trace.read` must support scoped read modes so the agent can avoid pulling full
transcripts by default:

| Mode | Contents |
|---|---|
| `summary` | Existing or generated trace summary, title, repo, timing, and outcome. |
| `events` | User turns, assistant turns, major decisions, and completion signals. |
| `tool_calls` | Tool names, command names, file paths, statuses, and short outputs. |
| `transcript_excerpt` | Bounded excerpts around selected events, errors, or decisions. |
| `full_transcript` | Full transcript, gated by explicit budget/user approval for broad scans. |

The default for `/distill this` is `summary` plus `events`, escalating to
targeted `transcript_excerpt` only when a reusable lesson is plausible. The
default for `/distill recent` and `/distill all` is indexed cards plus short
excerpts.

### 5.2 Normalized trace card

Every supported trace source should normalize into this compact card shape:

```yaml
traceId: local-trace-abc123
sourceTool: codex
repo: Jinn-Network/mono
startedAt: "2026-07-09T10:00:00.000Z"
durationMs: 2400000
summary: "Debugged SWE-rebench evaluator setup and Docker image mismatch."
tools:
  - shell
  - apply_patch
commands:
  - "docker info"
  - "pytest ..."
filesTouched:
  - "client/src/harnesses/impls/swe-rebench-v2-evaluator/..."
errorSnippets:
  - "pytest: command not found"
outcome: completed
skillsUsed:
  - swe-rebench-evaluator-setup-recovery
redactionFlags:
  - possible-secret
```

The card is allowed to be lossy. Its job is candidate discovery, not final
distillation.

### 5.3 Candidate cluster shape

`trace.cluster` returns candidate clusters, not skills:

```yaml
candidateId: local-candidate-001
title: "SWE-rebench evaluator setup recovery"
traceIds:
  - local-trace-abc123
  - local-trace-def456
repeatedSignals:
  commands:
    - "docker info"
    - "pytest ..."
  errors:
    - "pytest: command not found"
  files:
    - "client/src/harnesses/impls/swe-rebench-v2-evaluator/..."
evidenceTierEstimate: recurring-pattern
estimatedSourceTokens: 42000
estimatedDistillCost: medium
privacyFlags:
  - possible-secret
```

The user selects a candidate before the strong distiller reads its supporting
trace excerpts.

## 6. Model strategy

The system uses two model roles.

### 6.1 Cheap scanner

The scanner reads compact trace material and produces candidate cards. It should
prefer metadata and summaries over raw transcripts:

- session title or user prompt;
- tool names;
- command names;
- file paths;
- error snippets;
- status and duration;
- whether a later session looked similar;
- whether a generated skill was used.

The scanner returns candidate clusters with enough information for a user to
decide whether spending a stronger model call is worthwhile.

### 6.2 Strong distiller

The distiller reads only the supporting traces for one selected candidate. It
produces a skill package using the fixed distilled-skill anatomy:

```text
## When to use
## Strategy
## Steps
## Pitfalls
## Verify
```

The distiller must include an anti-trigger in the retrieval surface, usually a
`Not for:` clause, so the skill does not overgeneralize from narrow evidence.

### 6.3 Reviewer

The reviewer proposes skill diffs after later use and user feedback. It can be
the same strong model as the distiller. It never applies revisions without user
approval.

## 7. Skill format and metadata

Generated output is a standard `SKILL.md`-style artifact plus local metadata. The
body should be tool-neutral unless the skill is explicitly tool-specific.

Required metadata:

```yaml
name: swe-rebench-evaluator-setup-recovery
status: experimental
evidenceTier: single-example
sourceTools:
  - codex
targetTools:
  - current
sourceTraceIds:
  - local-trace-abc123
uses: 0
positiveFeedback: 0
negativeFeedback: 0
createdAt: "2026-07-09T00:00:00.000Z"
updatedAt: "2026-07-09T00:00:00.000Z"
```

Evidence tiers:

| Tier | Meaning |
|---|---|
| `candidate` | Drafted from weak or ambiguous evidence; not installed by default. |
| `single-example` | One trace supports the skill. |
| `recurring-pattern` | Multiple traces show the same pattern. |
| `contrastive` | Failure and success traces show the relevant delta. |
| `user-confirmed` | The user later said the skill helped. |
| `stable` | Repeated positive use with no recent negative feedback. |
| `deprecated` | User feedback or later use says the skill is harmful or stale. |

The initial state for an installed generated skill is normally:

```yaml
status: experimental
evidenceTier: single-example
```

or:

```yaml
status: experimental
evidenceTier: recurring-pattern
```

The system should not create `stable` skills directly.

## 8. Feedback and revision loop

Whenever an experimental generated skill is used in a later session, the system
records a local usage event through `trace.usage.record`:

```yaml
skillName: swe-rebench-evaluator-setup-recovery
sessionId: local-session-123
loadedAt: "2026-07-09T12:34:56.000Z"
sourceTool: codex
taskSummary: "Debug SWE-rebench evaluator run"
roughDurationMs: 1800000
roughToolCalls: 42
completionSignal: completed
```

At session end, the agent asks one lightweight question:

```text
I used experimental skill `swe-rebench-evaluator-setup-recovery`.
Did it help, hurt, or need changes?
```

Accepted feedback classes, recorded through `trace.feedback.record`:

- `helped`;
- `hurt`;
- `not relevant`;
- freeform change request.

If the user gives feedback, the reviewer proposes a concrete patch:

```text
Proposed skill update:
- Narrow "When to use" to Docker image and test-runner setup failures.
- Add pitfall: do not assume pytest exists in the image.
- Remove the RPC-log check; it did not apply in this session.
```

The user approves or rejects the patch. The system may also recommend deprecation
when repeated feedback says a skill is irrelevant or harmful.

## 9. Trace index and candidate discovery

The trace index is local-only in v0 and is owned by the plugin tool layer. It
stores the normalized trace cards defined in section 5.2, not raw full-session
text. Source adapters can read host-specific trace stores, but the rest of the
distillation workflow sees only normalized cards, clusters, and scoped reads.

The index should be incremental. `/distill this` can index one session on demand.
`/distill recent` updates a bounded window. `/distill all` updates within an
explicit history or budget cap and then returns candidates rather than running a
full-history distillation pass.

Candidate clustering can use:

- repeated command sequences;
- repeated error snippets;
- repeated files or directories;
- repeated user intents;
- failed-then-successful trajectories;
- repeated tool usage patterns;
- repeated skill usage and feedback.

Candidate cards are not skills. They are invitations to spend a stronger model
call on one cluster. The plugin should cache candidate clusters long enough for
the user to select `/distill <candidate-id>` without rescanning the same trace
window.

## 10. Installation and portability

v0 installs into the current tool only. Installation should go through the
existing host skill manager if one exists, otherwise through the plugin's
generated-skill adapter. The distiller proposes the artifact; the tool layer
performs the user-approved install or revision.

The generated skill format should remain portable:

- body is standard `SKILL.md`;
- source traces are referenced by local trace ids;
- `sourceTools` records where the evidence came from;
- `targetTools` records where the skill is installed;
- tool-specific commands belong in a clearly marked tool-specific skill.

Future cross-tool support can add:

```text
/distill export --to cursor
/distill export --to codex
/distill export --to claude
/distill sync
```

That exporter is a separate adapter layer and is out of v0 scope.

## 11. Privacy and safety

All v0 operation is local by default.

- Raw traces stay local.
- Candidate cards stay local.
- Broad discovery uses normalized cards and short excerpts, not full transcripts.
- Full transcript reads are narrow, explicit, and budget-gated.
- Experimental skills stay local unless the user explicitly exports or publishes
  them in a future version.
- Generated skills should not quote secrets, personal data, or large proprietary
  snippets.
- The distiller should summarize patterns, not preserve full transcript content.
- User approval is required for install, revision, deprecation, export, or
  publication.

Generated skill output should pass through `trace.redact` or an equivalent
secret-only scrub before installation. If the scrub changes the generated body,
the skill is not installed automatically; the agent shows the issue and asks the
user to revise or discard it.

## 12. Future marketplace path

Marketplace publishing is not part of v0, but the lifecycle should leave room for
it.

Future lifecycle:

```text
experimental -> user-confirmed -> stable -> publishable -> marketplace-listed
```

A skill may become publishable only after:

- repeated positive local use;
- no recent negative feedback;
- a scrub/privacy review;
- tool-neutral packaging or explicit target-tool declaration;
- local provenance summarized without leaking raw traces;
- explicit user approval.

Future command:

```text
/distill publish <skill>
```

or:

```text
/distill list <skill>
```

Publishing packages a scrubbed `SKILL.md` artifact for others to install. A later
marketplace can attach payment, usage reporting, ratings, or downstream feedback.
This public marketplace feedback becomes a stronger reward signal than local
feedback, but it is not required for v0.

## 13. Relationship to Task Creator and network distillation

Task Creator remains a later validation path, not the primary local product.

Local Trace Distiller v0:

```text
local trace -> experimental skill -> feedback -> revision
```

Task Creator / marketplace validation, later:

```text
stable local skill or trace cluster -> evaluable task -> attempts/verdicts -> stronger evidence
```

Network distillation methodology still informs the local distiller:

- both success and failure evidence matter;
- contrastive evidence is better than success-only summaries;
- raw evidence retrieval is a baseline a distilled skill should justify over
  time;
- provenance and prompt/model identity should be recorded;
- skills should be compressed, structured, and explicit about when not to use
  them.

## 14. Acceptance criteria

The first implementation is successful if:

1. Local Trace Distiller ships as a plugin with a bundled distillation skill and
   local trace tools.
2. The trace tool layer supports bounded indexing, listing, search, scoped read
   modes, clustering, redaction, usage recording, and feedback recording.
3. `/distill` defaults to `/distill this`.
4. `/distill this` can draft an experimental skill from a recent trace and ask
   for user approval before installation.
5. `/distill recent` scans a bounded trace window and returns candidate cards
   without running a full expensive distillation pass.
6. `/distill all` builds or updates an index within explicit caps and returns
   candidate clusters, not completed skills.
7. Selecting a candidate runs strong-model distillation only over that candidate's
   supporting traces.
8. Broad discovery uses compact trace cards and scoped excerpts rather than full
   transcripts.
9. Scanner subagents are supported where the host provides them, with a
   sequential scanner fallback for hosts that do not.
10. Generated skills carry status, evidence tier, source tools, target tools, and
   source trace ids.
11. Generated skills use the fixed five-section anatomy and include a "Not for" or
   equivalent anti-trigger.
12. When an experimental skill is used later, the system records a local usage
   event and asks for small session-end feedback.
13. Feedback produces a proposed skill diff that the user must approve before any
   mutation.
14. The system can mark a skill `deprecated` when the user says it hurt or is not
   relevant repeatedly.
15. No v0 flow publishes traces, skills, or metadata externally without explicit
    user action.

## 15. Out of scope for v0

- Marketplace task creation.
- Marketplace skill listing and payment.
- Cross-tool export or sync.
- Cross-tool trace ingestion beyond source adapters explicitly supported by the
  plugin.
- Full-history expensive model analysis.
- Manual agent scraping of trace directories as the normal product path.
- Production-grade semantic clustering infrastructure.
- Silent skill installation or mutation.
- Formal held-out evaluation.
- Claims that a generated skill is objectively better than raw trace retrieval.
- Private trace publication.

## 16. Decisions

| Decision | Resolution |
|---|---|
| Command with no argument | Defaults to `/distill this`. |
| Implementation shape | Plugin with bundled skill plus local trace tools. |
| Trace sourcing | Through explicit trace tool API, not normal agent filesystem scraping. |
| Subagents | Used for broad discovery when available; sequential fallback required. |
| Product center | Local experimental skills, not marketplace tasks. |
| Batch mode | Discovery first, distillation only after user selection. |
| Evidence posture | Honest tiers; one trace can draft a skill but not prove one. |
| Skill mutation | User-approved diffs only. |
| Tool portability | Keep format portable; export/sync deferred. |
| Marketplace | Future path for stable skills; not v0. |
