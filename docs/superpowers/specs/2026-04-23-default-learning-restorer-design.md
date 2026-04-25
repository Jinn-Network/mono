# Default learning restorer — design spec

**Version:** 1.1
**Date:** 2026-04-25
**Author:** adrianobradley + Claude
**Tracks:** `jinn-mono-2zk`
**Supersedes:** v1.0-alignment (2026-04-23) — same file; prior commits in git history.

**Related:**

- `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` — envelope + trajectory + TEE scope (cited throughout)
- `docs/research/2026-04-23-verifiability-traceability.md` — verifiability framing, executor provenance
- `client/src/restorer/types.ts` — `RestorerImpl`, `RestorationContext`
- `client/src/restorer/impls/index.ts` — `buildRestorerImpls` registry
- `client/src/restorer/engine/engine.ts` — engine driver, `runImpl` dispatch

---

## 1. Purpose

The default learning restorer is a `RestorerImpl` (per `client/src/restorer/types.ts:148`) that:

1. Runs as **one coordinated session** per `RestorerImpl.run(ctx)` — one intent, one window, one trajectory.
2. Decomposes the run into a fixed pipeline of phases, each implemented as a fresh-context subagent coordinated by the session (except `Execute`, which sits at session level — see §2.3).
3. Improves itself across runs by mutating its own state under `ctx.implStateDir` (git-backed) after each run completes.
4. Emits artifact types reserved by the execution-envelope scope doc (§3.1 K9: `skill_bundle`, `code_patch`, `mcp_config`, `promotion_record`, `design_document`, `research_note`, `session_transcript`) — its outputs are first-class corpus content, not bespoke shapes.
5. Is **harness-agnostic**: ships as a coordinator skill + phase-skill bundle + harness adapter. Different harnesses (Claude Code, Pi.dev, Codex, Gemini CLI) provide different self-modification capabilities; the coordinator runs on any of them.

**Non-goals (v0):**

- A separate "memory product" (vector DB, mandatory consolidation pipeline). Persistent state is the operator's git-backed `implStateDir`.
- Changing the protocol, on-chain artifacts, or engine state machines.
- Unrestricted self-modification beyond `implStateDir` and (for OSS-harness adapters) the harness install.
- Operator approval in-run. Access requests are **deferred artifacts only**.

---

## 2. Architecture

### 2.1 Session + coordinator skill

A learner run is **one session of the underlying agent harness**, loaded with a single **coordinator meta-skill** that names the phases, sequences them, propagates state between them, and codifies how the session should react when execution stalls.

The coordinator skill is to this learner what `using-superpowers` is to the superpowers plugin: a concise rule set for "given an intent, run these phases in this order, hand each phase these inputs, do these things if a phase reports a problem."

It is not a port of `using-superpowers`. The phases below are Jinn-native (mission-execution + retrospective improvement), not software-development workflow.

### 2.2 Phase pipeline

```
Session (loaded with coordinator meta-skill)
  Boot:
    - load self-state from implStateDir
    - propagate intent + window {startTs, endTs} + msUntilEndTs() to every subagent
    - expose wait() / monitor() as harness-adapter-provided tools (required)

  ├─ Orient     — intent + info + on-demand history; explorers decide what to gather
  ├─ Strategize — picks approach + commits success criteria + commits timing posture
  ├─ Plan       — concrete steps; entries may be time-anchored
  ├─ Execute    — session-level phase (not a subagent — most harnesses don't nest);
  │               uses subagent-driven-development for workers; session decides
  │               at runtime: continue, retry-step, replan, abort
  │               [Delivery handled by engine when run() returns; agent decides when]
  ├─ Debrief    — post-execution gather + analysis (own run, prior own runs,
  │               others' runs when accessible, fresh world-state)
  ├─ Improve    — edit/add skills/hooks/tools; emit operator-access requests; patch
  │               harness code when adapter permits; CHANGES TAKE EFFECT NEXT RUN
  └─ Memory     — curate durable (implStateDir) + ephemeral (workingDir public/private)
   consolidation
```

### 2.3 Subagent pattern

Phases are **fresh-context subagents** spawned by the session — except `Execute`, which runs at session level. Most harnesses (Claude Code's Agent tool, Pi.dev's session model) don't allow nested subagent spawning, so `Execute` itself spawns the per-step worker subagents from the session.

Each phase subagent receives:

- The intent + remaining window budget
- A relevant slice of self-state from `implStateDir`
- Phase-specific inputs (artifacts from prior phases that the orchestrator hands forward)

Each phase subagent produces:

- A **structured summary** returned to the session (the typed handoff)
- Detailed **artifacts** written under `workingDir/.<phase>/` — these are the corpus signal

The session is the message bus. Phases never read each other's contexts directly; they read artifacts and the typed summary the orchestrator hands forward.

**Parallelism is a design-time choice, not a principle.** `Orient` typically fans out (multiple explorer subagents); `Debrief` may too. Synthesis phases (`Strategize`, `Plan`, `Improve`) typically run as a single subagent because the work benefits from coherent reasoning.

---

## 3. Inputs (`RestorationContext`)

The engine hands the learner exactly what `RestorationContext` (`client/src/restorer/types.ts:12`) carries:

| Field | Use |
|---|---|
| `intent: DesiredState` | The goal: `{id, description, type, window, spec?{kind,...}, eligibility?}` |
| `intentCid?` | Provenance anchor for trajectory binding |
| `implStateDir` | Path to git-backed durable self (§6.2) |
| `workingDir` | Path to ephemeral episode workspace (engine harvests per `walkArtifacts`) |
| `log` | Logger callback |
| `abort: AbortSignal` | Fires at `window.endTs` |
| `msUntilEndTs()` | Remaining time budget |

Everything else (prior history, current world-state) is fetched on-demand by phases that need it.

---

## 4. Phase contracts

### 4.1 Orient

**Inputs:** `intent` + relevant self-state slice from `implStateDir`.

**Pattern:** Multi-subagent fan-out. Explorer subagents decide for themselves what to gather (no prescribed shopping list).

**What they typically gather:** intent parse (kind, goal, constraints, window), world-state relevant to the kind (market data, venue state, on-chain state), own run history (on-demand pull from knowledge tree / `implStateDir`), others' run history when accessible.

**Output:** structured findings bundle for Strategize. Each explorer's raw output lands as an artifact under `workingDir/.orient/<explorer-id>/`; the bundle the orchestrator hands forward is the distillation.

### 4.2 Strategize

**Inputs:** Orient findings + relevant self-state (prior strategies that worked / didn't for this kind).

**Pattern:** Single synthesis subagent. Borrows the diverge-converge structure of the brainstorming pattern: generate multiple candidate strategies, pick one with explicit rationale.

**Output:** strategy artifact carrying:

- Chosen approach + rationale (why this over alternatives)
- **Success criteria** for this run — the "we'll judge this attempt a success if X" statement, frozen here so Debrief can't move the goalposts
- **Timing posture** — `early-return` / `hold-and-revise` / `continuous-observation` (see §5)
- Acknowledged constraints + trade-offs

The frozen success criteria + timing posture are recorded as a run-start `jinn.state_transition` span (per envelope scope §3.1 K6) so they're cryptographically bound into the trajectory. See §10.

### 4.3 Plan

**Inputs:** strategy artifact + Orient findings + relevant self-state.

**Pattern:** Single synthesis subagent. Borrows the decompose-into-checkpointed-steps structure of the writing-plans pattern.

**Output:** plan artifact carrying:

- Ordered steps, with sequential vs parallelizable marked
- What each step needs (tools, MCPs, inputs, expected outputs)
- Per-step success signals
- Abort/recovery conditions
- **Time-anchored entries** when the strategy calls for them — e.g. "wait until `endTs - 2h`", "monitor event E or 4h whichever first"

### 4.4 Execute

**Pattern:** Session-level phase, NOT a subagent. Most harnesses don't permit nested subagent spawning, so Execute drives directly from the session.

**What the session does:**

- Walks the plan step-by-step, respecting sequential vs parallel markings
- Spawns one execution worker subagent per step (or parallel batch); each worker gets only its step spec + relevant prior context
- Collects worker outputs, advances
- Honors per-step success signals to continue vs retry
- Honors time-anchored steps via `wait()` / `monitor()` (§5)
- Writes real outputs to `workingDir` as it goes
- **Decides at runtime when stuck**: `continue` / `retry-step` / `replan` (loop back to Plan) / `abort`. The coordinator skill names the options + judgment criteria; the session picks. No hardcoded escape hatch.

**Time budget:** Most of `ctx.msUntilEndTs()` is consumed here.

**Delivery:** Engine handles delivery via the existing `walkArtifacts` → `manifest-assembly` → `deliverToMarketplace` pipeline once `run()` returns. The agent decides when to return — early if work is done, late if observation is needed, abort-triggered if the window expires. Delivery never blocks inside Execute.

### 4.5 Debrief

**Mirrors Orient — gather + sense-make in hindsight.** Not "self-assess" — Debrief reads beyond the current run.

**Inputs:** just-completed run's artifacts in `workingDir` (trajectory, outputs, session transcripts) + strategy artifact (with frozen success criteria) + plan artifact + relevant self-state slice + on-demand reads of own run history, others' run history when accessible, and fresh world-state for outcome signals.

**Pattern:** Can fan out (own-run reader, others' reader, world-state prober) with a synthesizer at the end. Design-time call.

**Output:** analysis artifact(s) for Improve, covering:

- Whether this run met the success criteria Strategize committed to
- Where execution diverged from plan and why
- Relevant signals from others' runs
- Trend across prior runs ("am I improving at this kind?")

### 4.6 Improve

**Inputs:** Debrief analysis + current self-state (`implStateDir`) + operator-configured policy on what Improve may touch.

**Action surface:**

- Edit existing skills / hooks / tools / configs under `implStateDir`
- Add new skills / tools / hooks
- Create new tools from scratch (code + register)
- Emit `request_for_access` artifacts under `workingDir/.operator-requests/` for things the operator needs to provide (deferred, never blocks)
- In OSS-harness adapters (e.g. Pi.dev): patch harness code; no-op on closed-harness adapters (Claude Code)

**Outputs:**

- Mutations to `implStateDir` (and to harness install when adapter permits)
- One git commit per logical change with a message tying the change back to the run that caused it (see §6.2)
- `promotion_record` artifact per change (what, why, source diagnosis from Debrief)
- `request_for_access` artifacts aggregated for the operator

**Effect timing:** changes take effect **next run**. The current run already happened under the old state; Strategize's frozen criteria were judged under it; mid-run mutation invalidates the causal chain Debrief just produced.

### 4.7 Memory consolidation

**Inputs:** Debrief analysis + Improve's just-committed mutations + full `implStateDir` + full `workingDir` + operator retention policy + run history.

**Two workstreams:**

**(1) Curate durable self.** Now that Improve added/edited stuff, what's stale on the other end?

- Skills / hooks / tools unused for N runs — prune or archive
- Promoted changes that the cross-run trend says made things worse — revert
- Accumulated notes / records that have become noise — compact
- Conflicts between recently promoted artifacts — resolve

Writes are a separate git commit on `implStateDir`, distinct from Improve's commit. Same repo, two intents in the audit trail.

**(2) Curate ephemeral run.** Decide what's harvestable vs operator-private before delivery:

- Some artifacts are declared outputs of the kind (must go in delivery)
- Some are intermediate or contain operator-private reasoning (move to `workingDir/.private/` or migrate to `implStateDir`)
- Sets the public/private boundary the engine respects when calling `walkArtifacts`

**Output:** `consolidation_record` artifact summarizing what was pruned, archived, kept-but-flagged, moved.

---

## 5. Timing model

The intent's `window = {startTs, endTs}` is a **first-class design input**, not a pure deadline.

- Boot propagates `intent.window` and `msUntilEndTs()` to every subagent so each phase plans inside its budget.
- Strategize commits a **timing posture** as part of the frozen criteria:
  - **`early-return`** — finish work and return `run()` before window end. Default for kinds where late information doesn't help.
  - **`hold-and-revise`** — do work, wait until late in the window, optionally re-Execute / Improve based on world-state evolution, return.
  - **`continuous-observation`** — submit something early, monitor across the window, occasionally adjust, return at end.
- Plan emits time-anchored steps where the strategy calls for them.
- Execute honors them via `wait(durationMs|untilTs)` and `monitor(condition, {timeoutMs, untilTs})` — both **required primitives** in the harness-adapter contract (§8).
- Delivery happens when `run()` returns. The agent decides when. Engine has no opinion on early vs late return.

**Optional kind-spec field:** `minimumObservationMs` — a kind asserts "no matter what, don't deliver before X elapsed since `startTs`." Useful for kinds where buyers want real time-evolution rather than panicked early submission. Out of scope to specify here; flagged for kind-spec authors.

---

## 6. Public/private boundary

### 6.1 The split

`workingDir` and `implStateDir` are already in `RestorationContext` (`client/src/restorer/types.ts:22-24`). The learner uses them as:

| | `workingDir` | `implStateDir` |
|---|---|---|
| **Lifetime** | Ephemeral per attempt | Persistent across attempts |
| **Audience** | Public — engine harvests for delivery | Operator-private — never shipped to the network |
| **Purpose** | Episode work product + corpus signal | Durable self (skills, prompts, tools, configs, memory) |
| **Self-mod target** | No (ephemeral) | **Yes** — primary; git-backed (§6.2) |

Memory consolidation §4.7 sets the boundary by moving artifacts between them.

### 6.2 `implStateDir` is git-backed

Each operator's `implStateDir` is initialized as a git repository on first run. Improve and Memory consolidation each commit changes with messages tying the commit to the run that caused it.

**Why git:**

- Atomic promotion (commit succeeds or it doesn't)
- Free rollback if Debrief detects a regression across runs (`git revert`)
- Full audit trail tied to `requestId` per commit
- Commit SHA is a natural pin for `RestorerImpl.version` / executor-provenance — solves the TEE-scope provenance issue (research doc §220-230, scope doc §3.2 K3) without a schema change.

### 6.3 Mapping to TEE scope §3.2 operator-secrets categories

The TEE scope's three operator-secrets categories cover this learner's `implStateDir` content:

| Category | Learner equivalent |
|---|---|
| (a) Runtime credentials — sealed, never in source | `implStateDir/env/`, API wallets, keystores |
| (b) Proprietary IP — operator choice: publish for attested, or run at lower tier | Promoted skills / prompts / harness patches |
| (c) Environmental context — local config, not source | Operator config (Safe address, RPC, venue accounts) |

Public/private inheritance is automatic — no learner-specific vocabulary needed.

### 6.4 Mid-run mutation rule (TEE scope §4 item 12)

The TEE scope deliberately generalized the mid-run-mutation rule to be executor-agnostic. It gives two options for a learning-style executor:

- **(a) Log every mutation** as a span event / `promotion_record` artifact. Attested claim narrows to "measured code ran AND mutations were logged."
- **(b) Mutable region lives outside the measured surface.** Attested claim covers only invariant code; mutations not claimed trustworthy. Lowers effective tier.

**This learner picks default (a).** Improve emits `promotion_record` per change; the trajectory carries every mutation as `jinn.state_transition` span events. Operators who want full `implStateDir` privacy at attested tier can opt into (b) via the harness adapter (sets `implStateDir` outside the measured enclave surface) — accepting the lower-tier consequence.

---

## 7. Self-modification scope

Improve's action surface is **scoped, not unrestricted**:

| Target | Allowed by | Notes |
|---|---|---|
| `implStateDir/**` | Always | Primary self-mod target; git-backed |
| `workingDir/**` | During the run | Anything intended to survive must be promoted to `implStateDir` |
| Harness install | Only when adapter permits | Pi.dev / Codex etc.; no-op on Claude Code |
| Anything else | Never | Engine, contracts, monorepo paths outside `implStateDir`, system toolchain |

The harness adapter is the **enforcer** — closed-harness adapters report no-op for harness-mod actions Improve attempts; OSS-harness adapters apply them. Operator policy (loaded from `implStateDir/policy.json` or equivalent) further narrows what Improve may touch within these defaults.

---

## 8. Harness adapter contract

A harness adapter is a thin shim that lets the coordinator skill + phase subagents run on a specific agent harness. Each adapter must provide:

| Capability | Why required |
|---|---|
| **Spawn bounded subagent with fresh context** | Phase pattern (§2.3) |
| **`wait(durationMs|untilTs)`** | Time-anchored Plan steps (§5) |
| **`monitor(condition, {timeoutMs, untilTs})`** | Event-driven Plan steps (§5) |
| **Read/write `implStateDir`** | Self-mod target (§7) |
| **Read/write `workingDir`** | Episode work product (§6.1) |
| **OTel span emission** | Trajectory (TEE scope §3.1 K6) |
| **Optional: harness self-modification** | Improve's harness-patch path (§7); enables OSS-harness paths only |

If a harness can't expose the first six, it can't host the learner. The seventh is graceful-degradation.

**v0 ships:** Claude Code adapter (closed-harness, no harness-mod) + Pi.dev adapter (OSS-harness, full self-mod).

---

## 9. Artifacts emitted (mapping to TEE scope §3.1 K9)

Every learner output maps to a reserved `artifactType`:

| Learner output | `artifactType` |
|---|---|
| Loaded skill set at run start | `skill_bundle` |
| Patches from Improve | `code_patch` |
| MCP tool config | `mcp_config` |
| Each promotion event | `promotion_record` |
| Strategy artifact (success criteria + timing posture) | `design_document` |
| Debrief analysis | `research_note` |
| Raw LLM session transcripts | `session_transcript` |
| Trajectory (OTLP-JSON spans) | `trajectory` (required) |
| Memory consolidation report | `consolidation_record` (proposed addition to §3.1 K9) |

The learner is a **producer** of the corpus's reserved types. No bespoke vocabulary required — except `consolidation_record`, which we propose adding to the TEE scope's reserved list (trivial PR).

---

## 10. Constitutional snapshot

Strategize's frozen success criteria + timing posture (§4.2) become a **run-start `jinn.state_transition` span** with attributes:

- `jinn.constitution.successCriteriaCid` — content hash of the criteria
- `jinn.constitution.timingPosture` — `early-return | hold-and-revise | continuous-observation`
- `jinn.constitution.skillBundleCid` — CID of the loaded `skill_bundle` artifact at run start
- `jinn.constitution.implStateDirSha` — git SHA of `implStateDir` at run start
- `jinn.constitution.editableScope[]` — paths the learner may write to (always `implStateDir/**` + `workingDir/**`; harness install when adapter permits)

The TEE scope's per-span hash chain (§3.1 K6, `jinn.prevSpanHash`) makes mid-run rewrites tamper-evident: any later span that contradicts the constitution is detectable by the buyer.

---

## 11. v0 acceptance criteria

- [ ] One `RestorerImpl.run(ctx)` = one session = one coordinated phase pipeline.
- [ ] All six subagent phases plus session-level Execute implemented with the contracts in §4.
- [ ] `wait()` / `monitor()` exposed via the harness-adapter contract; Plan can emit time-anchored steps; Execute respects them.
- [ ] `implStateDir` is git-backed; Improve and Memory consolidation each commit per logical change with traceable messages; `git revert` rollback works.
- [ ] Run-start `jinn.state_transition` span carries the §10 constitution attributes.
- [ ] Improve emits `promotion_record` per mutation per TEE scope §4 item 12 default (a).
- [ ] All durable self-edits confined to `implStateDir`; harness-mod attempts no-op on closed-harness adapter.
- [ ] Per-phase artifacts land under `workingDir/.<phase>/` with the §9 `artifactType` values.
- [ ] Acceptance test: a synthetic Execute step that tries to write outside `implStateDir`/`workingDir` is blocked by the adapter.
- [ ] Acceptance test: portfolio.v0 intent end-to-end on Anvil fork — Orient through Memory consolidation, with non-trivial Improve mutation surviving into the next run.
- [ ] Acceptance test: a failing Execute step exercises the runtime-judgment branch (replan path).
- [ ] No protocol or engine state-machine changes.

---

## 12. Open questions

1. **Registry precedence** in `buildRestorerImpls` (`client/src/restorer/impls/index.ts:56`):
   - **(i) Last-match** — runs only when no specialist impl matches a kind. Safe; under-exercises learning signal.
   - **(ii) First-match wrapper** — wins for every kind, delegates internally to specialist impl while wrapping in the learning envelope. Most invasive; most valuable.
   - **(iii) Replace specialists** — retire `claude-mcp-*` impls.

   My lean: **(ii) first-match wrapper** for v0. Preserves battle-tested specialists inside the learning envelope; if the envelope regresses we strip it without losing functionality.

2. **Partitioning `implStateDir`.** Per-kind tree (`implStateDir/<kind>/…`) is safer for v0 (a regression in portfolio-learning doesn't cross-contaminate prediction-learning). Unified is a later optimization. Lock per-kind for v0.

3. **First-kind acceptance target.** `portfolio.v0` is the most mature and has an evaluator; recommended.

4. **Coexistence vs replacement of `claude-mcp-*` impls** during v0 rollout — tied to (1).

5. **`consolidation_record` artifact type** — propose adding to TEE scope §3.1 K9 reserved list.

---

## 13. What this spec does NOT cover

- Phase-skill content (the actual prompts + rules each phase subagent loads). Out of scope; lives in the package implementation.
- Specific harness-adapter implementations (Claude Code, Pi.dev). Out of scope; downstream design docs.
- Cross-operator artifact access protocols (when explorers can read others' runs). Deferred — depends on access/gating sibling epic of TEE scope §5.
- Operator UI for reviewing `request_for_access` artifacts. Out of scope.
- Concrete schema for `RestorationOutput` payloads per kind. Already kind-specific; unchanged.

---

*End of v1.1.*
