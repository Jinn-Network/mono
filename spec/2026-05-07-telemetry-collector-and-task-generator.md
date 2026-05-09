---
title: Telemetry collector + task-generator SolverNet — design
date: 2026-05-07
author: opus (drafted on jinn-mono-6m7t; Captain oaksprout)
status: ideas-level (Phase A.5+ candidate; pre-implementation; awaiting Phase A.1 land + jinn-mono-h43b)
version: 0.1
---

**Sibling specs (load-bearing pre-reads):**

- `spec/2026-04-30-phase-a-umbrella.md` — Phase A.1 substrate (corpus library, gating fix, manifest hygiene, cache, MCP rewiring). This spec sits at A.5+, layered on top.
- `spec/2026-04-30-plug-in-surface.md` — Phase A.2 plug-in shape. The collector is one concrete instantiation of the operator-app plug-in surface; the task-generator is a Path-2 launcher of a new SolverNet.
- `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` v0.1 — architectural sibling. Reuses the SolverNet contract + launched-instance vocabulary, the trust-stack pattern, and the "reference-don't-redistribute" principle (this spec deliberately departs from that principle; see §10).
- `client/src/types/envelope.ts` — `jinn.execution.v1` envelope schema. This spec adds one new role and one optional field; no schema break.
- `client/src/trajectory/schema.ts` — `jinn.trajectory.v1` schema (OTLP-shaped spans + signed `redactionManifest`). This spec extends the redaction story; the wire shape is unchanged.
- `client/src/trajectory/secret-scrub.ts` — V1 pattern-based credential scrub (the existing baseline). This spec replaces it with an OpenTelemetry SDK processor stack via beads `jinn-mono-h43b`.

**Discussion lineage:**

- [#103](https://github.com/Jinn-Network/mono/discussions/103) — pooled-shadow-eval-sidecar writeup. This spec is one concrete shape of the proposal; it locks Q1 (outcome-spec ergonomics), Q2 (privacy surface), Q4 (intermediation form), and explicitly leaves Q3 (create-vs-route heuristics) and Q5 (collapse-launcher-role) open.
- [#59](https://github.com/Jinn-Network/mono/discussions/59) — knowledge-market roadmap. The "open population producing a richer base than any one shop can match" claim extends to local sessions: every operator's local work becomes substrate material when they choose to publish.
- [#57](https://github.com/Jinn-Network/mono/discussions/57) — paired GTM. The collector is the "literal product form of the §3 bridge angle" (per #103 framing) for the AI-builders cluster — minimal-friction onboarding into the substrate.

**Bead lineage:**

- `jinn-mono-6m7t` — the design session this spec is the output of.
- `jinn-mono-h43b` — proper anonymization tool (precondition for ship; replaces the V1 pattern scrub with an OpenTelemetry SDK processor stack).
- `jinn-mono-ns8n` — agentic-CLI Stop-hook coverage research (closed 2026-05-07; outputs feed §4.2 path D).
- `jinn-mono-0922` — prior-art survey of agent-telemetry collection patterns (closed 2026-05-07; outputs are §2.4 and the §4.2 four-path taxonomy).
- `jinn-mono-lmcq` — Aider + Continue v0.1 fallback work (filed 2026-05-07; reframed by this revision — Aider and Continue now ship in v0 via §4.2 path B / transcript-tail, so this issue is reduced to OTel-emit upgrade work and remains low priority).

---

## TL;DR

Two coupled-but-separable components.

1. A **telemetry collector** integrated into the existing jinn-client daemon. Embeds an OpenTelemetry OTLP receiver (HTTP + gRPC on a local port). Tools (Claude Code, Codex, Gemini CLI, Cursor, Aider — any OTel emitter) export traces to it. The receiver pipes through an OTel SDK processor stack (identity scrub, path scrub, credential scrub, redaction-manifest builder), into a pending-captures queue. Operator app gains a **Captures tab** for batch review (drill-in to redaction diff per session, batch-approve, per-repo "trust this repo" auto-approve toggle). On approve, the daemon assembles a `role: 'capture'` envelope — a third role on the existing `jinn.execution.v1` envelope alongside `restoration` and `verdict` — signs it, publishes to the corpus. The capture envelope is a signed self-attestation, not a Solution; **no on-chain Task is required, no evaluator runs over it**, no Verdict.

2. A **`session-derived.v0` SolverNet contract** + accompanying task-generator. The contract lives in `packages/sdk/src/contracts.ts` next to `SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT`. The launcher's task-generator polls the corpus for new `role='capture'` envelopes, runs an LLM-mediated decomposition pass over each (problem statement, repo+commit, expected artifacts, signal hints), and posts atomic Tasks to JinnRouter. Generated Tasks carry `sourceCaptureCid` for provenance back to the originating capture. The SolverNet's evaluator is composite (test-suite re-run where reproducible + structural similarity to the capture's final patch where present + LLM-judge always); it grades claimant Solutions normally. Launcher economics is launcher-private (out of spec scope, per the `2026-05-05-solvernet-creation-and-launch.md` model).

**The headline finding:** *the jinn-client daemon already has every primitive this design needs.* The only protocol-level addition is one new envelope role + one optional field. Everything else is operator-app integration + an embedded OpenTelemetry pipeline that subsumes the existing bespoke `client/src/trajectory/collector.ts`. Captures are signed self-attestations published into the corpus; the network's "training itself on the work people are doing locally" property emerges from the downstream task-generator turning that data into ordinary network supply.

---

## 1. Purpose and scope

### 1.1 What this spec commits

1. **A `role: 'capture'` envelope type.** Additive to `jinn.execution.v1`; no schema break. Optional `sessionProvenance` field present only when `role === 'capture'`; `taskProvenance` becomes optional in the same conditional. Capture envelopes mirror solver-Solution envelope shape exactly — same `executor` provenance depth (`implName`, `codeDigest`, `runtimeBundleDigest`, `plugins[]`, `signingKey`, `mode`), same artifact-bundle structure, same trust-tier stack — see §3.1 and DR-g. The only difference is the role discriminator and the `taskProvenance` ↔ `sessionProvenance` swap.
2. **A `captureManifest` extension** to the existing signed `redactionManifest` (in `jinn.trajectory.v1`). Records identity/path scrubs alongside today's credential scrubs; carries the operator's review-time attestation; covers the harness-bundle (which files published vs. redacted) and the capture path (A/B/C/D).
2a. **A `harness-bundle.v1` artifact** in the capture envelope's `artifacts[]`, containing the operator's resolved harness configuration (CLAUDE.md, settings, skills, plugins manifest, MCP config — per-tool list in §3.2). `executor.codeDigest` matches the bundle's sha256. Operator-controlled at coarse granularity: `captures.harnessBundle.enabled` toggle + `captures.harnessBundle.allowedDirectories` config (default: per-tool defaults from §3.2). Per-capture include/skip toggle in the Captures tab. No per-file curation in v0. This is what makes a capture *replayable*: another operator can fetch the bundle CID and reconstitute the harness exactly.
3. **A four-path capture surface in the jinn-client daemon** (§4.2): path A embedded OpenTelemetry OTLP receiver (gRPC `:4317` / HTTP `:4318`); path B transcript-file tail with per-tool parsers (`~/.<tool>/`-format aware); path C opt-in LLM-API proxy as universal-coverage backstop; path D Stop / SessionEnd hook trigger. All four paths feed a single off-the-shelf OTel SDK processor stack that handles scrubbing.
4. **Migration of `client/src/trajectory/collector.ts` onto the embedded receiver.** Existing harnesses (claude-code-learner, prediction-v0-baseline, prediction-v1-baseline, etc.) emit OTel to the same receiver as captures. One scrubbing pipeline for both streams.
5. **A pending-captures queue + Captures-tab UI** in the operator app. Batch review, drill-in to redaction diff + trajectory preview, per-repo "trust this repo" toggle.
6. **A `session-derived` v1.0.0 SolverNet contract** in `packages/sdk/src/contracts.ts`. Schemas for Task, Solution, Verdict; composite evaluator; rolling aggregation.
7. **A task-generator** that LLM-distils `role='capture'` envelopes from the corpus into atomic Tasks posted via JinnRouter. Provenance back-link via `sourceCaptureCid`.

### 1.2 In scope

- The capture envelope wire shape and the `captureManifest` extension.
- Embedded OTLP receiver design + processor stack.
- **v0 tool coverage** via the four-path taxonomy in §4.2 (path A native OTel; path B transcript-file tail; path C LLM-API proxy; path D Stop hook as trigger). v0 ships at least one tool covered via each of paths A, B, and D — a deliberate forcing function so all three capture paths are exercised on day one and don't silently bit-rot. Confirmed v0 integrations: **Claude Code** (A primary + D trigger), **Codex** (A primary + D trigger), **Gemini CLI** (A primary + D trigger), **Cursor** (D trigger + B fallback for content), **Aider** (B primary via `.aider.chat.history.md` + opt-in `--analytics-log` JSONL), **Continue** (B primary via `.continue/dev_data/`). Path C (LLM-API proxy backstop) ships behind a feature flag in v0; the default `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` posture is opt-in per operator. Generic `jinn capture import <trace.json>` CLI remains the long-tail fallback for any tool not in the table. Embedded OTLP receiver listens on standard OTel ports (gRPC `:4317`, HTTP `:4318`) so operators can enable path A with the default `OTEL_EXPORTER_OTLP_ENDPOINT` value with no further config.
- The operator-app Captures tab: pending queue, drill-in, batch approve, per-repo trust toggle.
- The `session-derived.v0` SolverNet contract + composite evaluator + aggregation function.
- The launcher's task-generator pipeline and distillation prompt design.
- Subgraph indexing for `role='capture'` envelopes as a parallel corpus stream.

### 1.3 Out of scope

- **LLM-mediated NL anonymization.** v0 ships pattern-based identity + path scrubs only. Natural-language prompts and outputs are kept verbatim; the operator carries the burden via the review step. LLM-mediated scrubbing is filed as v0.5+.
- **Cross-SolverNet routing for distilled Tasks.** v0 posts every distilled Task into `session-derived.v0`. Routing into thematic SolverNets (coding → swe-rebench-v2-shaped, prediction → prediction.v1, etc.) is filed as v0.5+; see #103 Q3.
- **Bonded "capture-auditor" evaluator role.** Sample-checking anonymization compliance with bond + slashing is filed as v0.5+.
- **Dynamic SolverNet summoning per capture-cluster.** Filed as v1+; see #103 Q5.
- **Launcher economics for `session-derived.v0` instances.** Per the launch model in `2026-05-05-solvernet-creation-and-launch.md`, this is launcher-private. The spec defines the contract and the generator; it does not prescribe who funds the escrow pool.
- **Phase B.1 attested-tier capture.** TEE-attested anonymization is the future cryptographic enforcement; v0 is self-signed with batch operator review as the trust gate.

### 1.4 Non-goals

- **This is not a benchmark SolverNet.** The collector produces unverified data; only the downstream task-generator's Tasks get evaluator scrutiny. The `session-derived.v0` SolverNet's leaderboard is meaningful but is not the spec's headline metric.
- **This is not a license-compliance gate.** Operators carry the legal liability for what they publish; the protocol facilitates. License is operator-asserted and surfaced in the UI as detected metadata, not enforced as a publishing precondition.
- **This is not a substrate redesign.** Reuses corpus + x402 + SolverNet + Task + envelope as-is. The single protocol delta is the additive `role: 'capture'` envelope role and the optional `sessionProvenance` field.

---

## 2. Design summary — what we discovered

### 2.1 What the brief asked

Design a telemetry collector that captures local agent telemetry/traces/session logs, anonymizes them client-side, and publishes them to the Jinn corpus as a new paid artifact kind. Then design the first SolverNet that consumes these artifacts — a task generator that distills session logs into Tasks and posts them via JinnRouter using the existing pattern.

The implicit framing assumed the captured-session was a new kind of artifact requiring new wire shapes and a new artifact type, with a SolverNet whose evaluator runs over those captures.

### 2.2 What the design discovered

Five findings, each strictly stronger than the prior assumption.

1. **The captured-session is structurally a self-attestation, not a Solution.** Locally-captured sessions don't respond to a Task — there is no Task. Synthesising on-chain Tasks per session ("self-create + self-claim") is artificial: it requires gas-per-session, creates a closed 1:1 loop that doesn't reflect what's happening, and conflates two distinct semantic stances. Adding a third envelope role — `role: 'capture'` — is a smaller protocol delta and a more honest signal.

2. **The existing trajectory collection pipeline is already OpenTelemetry-shaped, but bespoke.** `client/src/trajectory/collector.ts` accepts spans with attributes, scrubs them, signs a `redactionManifest` — same shape as the OpenTelemetry SDK's processor pipeline, just custom code. Replacing it with `@opentelemetry/sdk-node` plus the official redaction/transform processors is mechanical (the existing code is span-shaped) and unlocks vendor-neutral capture from any OTel emitter.

3. **Captures are not evaluated. Generated Tasks are.** Running an evaluator on capture envelopes makes them Tasks-in-disguise — and Tasks need to be created via JinnRouter, which puts the collector back in the cycle the design was trying to avoid. The clean separation: capture envelopes are unverified data published into the corpus ("these are my sessions; do with them what you will"); the task-generator step turns them into Tasks downstream, and **those** get the normal evaluator + Verdict + reputation flow. Network operators claiming Tasks generated from captures have no idea they're working from captured seeds — the upstream is invisible to them.

4. **OSS gating is unnecessary protocol surface.** The instinct to require an OSS license at capture time mirrors the SWE-rebench-v2 spec's "reference-don't-redistribute" principle (§4.3 of the sibling spec). But captures are inherently a redistribution model — there's no canonical external source to reference. Operator-asserted licensing (parallel to how x402 itself works: protocol facilitates the transaction; seller carries liability for what they sell) is a strictly simpler posture and aligns with how operators already think about their own work. License detection becomes a UI hint, not a gate.

5. **The "sidecar" of #103 is two components, not one.** A publisher (the collector) and a consumer (the task-generator's launcher) compose to give #103's user story — local work flows into the substrate; other operators' attempts flow back into corpus. v0 ships them as separable but coupled. v0.5+ can address #103 Q3 (create-vs-route heuristics), Q5 (collapse-launcher-role), and reward-back-to-capturer attribution as independent workstreams.

### 2.3 The headline finding

> **Local agent sessions are signed self-attestations into the corpus, not Solutions to Tasks. The task-generator step turns capture envelopes into Tasks downstream — which the network claims and evaluates normally.**

This is the spec's organising thesis. The two-stream structure (capture stream + Task stream) is what every concrete commitment that follows operationalises.

### 2.4 Prior art and standard practice

This spec does not invent agent-telemetry collection. The pattern has been built six times in five years, and the design here is a deliberate composition of known approaches into one operator-controlled boundary. Locating Jinn's collector in the prior-art landscape clarifies which paths it inherits, where it departs, and what the universe of reviewers will already understand.

Six layers, oldest to newest:

1. **LLM-API proxy interception (2022→).** Sit between the agent and the LLM API; the operator points `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` at the proxy. The proxy logs all model I/O. Canonical OSS: **LiteLLM proxy**, **Helicone**, **Portkey**. Strength: works for any tool that hits an LLM API; the tool needs no awareness. Limit: only model I/O — no local tool calls, file edits, shell.
2. **SDK instrumentation (2023→).** Wrap the LLM SDK call site in the agent's process. Canonical OSS: **OpenLLMetry / Traceloop** auto-instruments 15+ LLM SDKs and emits OpenTelemetry. **Langfuse SDK**, **Phoenix (Arize)**, **LangSmith** (proprietary) parallel. Strength: captures more than I/O (callbacks, vector-DB calls). Limit: must run in-process; closed-source coding CLIs participate only if the vendor builds it in.
3. **Framework callbacks (2023→).** `BaseCallbackHandler` (LangChain), `BaseInstrumentor` (LlamaIndex). Where "trace tree" and "session" became standard concepts in LLM observability. Phoenix, Langfuse, Traceloop, LangSmith all consume these.
4. **Trajectory JSON files (2024→).** **SWE-agent** writes `<instance_id>.traj` — an array of (thought, action, observation) turns. **SWE-bench** accepts this as its canonical submission format; **METR**, **OpenHands**, **AutoGPT** emit similar shapes. The de-facto format for agent submission to benchmarks. SWE-rebench-v2 (which Jinn's growth canon pins on) consumes trajectories shaped this way.
5. **Per-tool transcript files (always-on).** The universal disk-based pattern that long predates Stop hooks: **Aider** writes `.aider.chat.history.md`, `.aider.input.history`, `.aider.llm.history`, plus opt-in `--analytics-log <path>.jsonl`; **Continue** writes `.continue/dev_data/<event-kind>/<schema>.jsonl` events for chat, autocomplete, edit, configurable to HTTP-forward via the `data:` block in `config.yaml`; **Claude Code** writes `~/.claude/projects/<project>/<session>.jsonl`; **Cursor** writes workspace-local SQLite (`state.vscdb`); **Codex** writes `~/.codex/sessions/`. Every coding agent ships with one of these — it is the universal fallback that works whether or not the tool emits OTel and whether or not it has Stop hooks.
6. **Session-end hooks (2025→).** **Claude Code** Stop/SessionEnd/SubagentStop, **Cursor 1.7+** stop/sessionEnd, **Gemini CLI** SessionEnd, **Codex** per-turn Stop. Convenient session-boundary signals — not a capture path on their own; useful as triggers and to attach `transcript_path` metadata that the OTel stream lacks.

Plus the standards track. **OpenTelemetry GenAI semantic conventions** (`gen_ai.system`, `gen_ai.request.model`, model spans, agent spans) are still in *Development* (experimental) status as of v1.36.0; no canonical "session" abstraction is stable yet. Anthropic, Codex, Gemini CLI emit conforming OTel today regardless. The conventions are the future standard, not today's standard.

**Where Jinn's collector sits.** The daemon embeds *layer 1, 2, 5, and 6* concurrently, and chooses per tool which path to use:

- Layer 6 (Stop hooks) is the *trigger* for tools that have one (clean session boundary).
- Layer 2 (OTel-via-SDK / OpenLLMetry-shaped) is the *primary capture stream* for tools that emit OTel.
- Layer 5 (transcript-file tail) is the *universal fallback* for tools that don't emit OTel — and a safety-net for tools that do.
- Layer 1 (LLM-API proxy) is the *backstop* for closed-source tools that emit nothing useful but route through configurable LLM endpoints.

The capture envelope itself sits at layer 4 — it carries a trajectory that maps cleanly onto SWE-agent's `.traj` shape (thought-action-observation as OTel spans), so capture-derived Tasks plug into the SWE-bench-shaped evaluator ecosystem with no translation tooling. §3 documents the mapping; §13 references SWE-agent's trajectory docs.

**What's novel here, then.** Not the capture mechanism (every layer is borrowed). What is novel is the *output stance*: rather than a private observability dashboard (Langfuse, Phoenix, LangSmith) or a benchmark submission (SWE-agent .traj), the output is a signed self-attestation published into a corpus where downstream task-generators turn it into network supply. The collector is a tier-0 emitter onto a public substrate. That is the genuinely new shape.

---

## 3. The capture envelope

### 3.1 Wire shape

A capture envelope is a `jinn.execution.v1` envelope with one new role and one new field. The full schema delta:

```ts
// client/src/types/envelope.ts — additive
export const RoleSchema = z.enum(['restoration', 'verdict', 'capture']); // + 'capture'

const SessionProvenanceSchema = z.object({
  sessionId: z.string().min(1),               // UUID per captured session
  capturedAt: z.string().datetime(),          // ISO timestamp at session end
  originatingTool: z.object({                 // Which tool emitted the OTel
    name: z.string(),                         // 'claude-code' | 'codex' | 'gemini-cli' | 'cursor' | ...
    version: z.string().optional(),
  }),
  repo: z.object({                            // git context if detectable, optional otherwise
    remoteUrl: z.string().optional(),
    commitHash: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    branch: z.string().optional(),
  }).optional(),
  license: z.object({
    spdxId: z.string().optional(),            // detected; falls through to operator-asserted
    operatorAssertion: z.enum(['asserted', 'unspecified']),
  }),
});

// On the envelope:
//  - taskProvenance becomes optional (required iff role !== 'capture')
//  - sessionProvenance is optional (required iff role === 'capture')
```

The envelope's other fields (`participant`, `executor`, `attestation`, `trajectoryRef`, `artifacts[]`, `signature`) are unchanged.

**Capture envelopes mirror solver-Solution envelope shape exactly — same `executor` provenance depth, same artifact-bundle structure, same trust-tier stack.** The only difference is the role discriminator and the `taskProvenance` ↔ `sessionProvenance` swap. This is a deliberate design commitment: a capture envelope is what a solver Solution would look like if there were no Task driving it. Same fields, same hashes, same signature, same access controls. (See DR-2026-05-07-g.)

Each `executor` field is populated for captures as follows:

| Executor field | Populated for captures from |
|---|---|
| `implName` | The originating tool's identity — `'claude-code'`, `'codex'`, `'gemini-cli'`, `'cursor'`, `'aider'`, `'continue'`, or the operator's custom harness name. Mirrors how solvers carry e.g. `'claude-code-learner'`. |
| `implVersion` | The tool's version string at session-start (Claude Code CLI version, Codex CLI version, etc.). |
| `clientGitSha` | jinn-client's git SHA at capture time (the daemon assembled the envelope; the field reflects which daemon version did the assembly). For captures, this is the *daemon's* SHA, not the upstream tool's. |
| `codeDigest` | sha256 of the operator's resolved **harness-config bundle** at session time — see §3.2. The same digest a solver would produce if their harness's resolved config matched this operator's. |
| `runtimeBundleDigest` | sha256 of the resolved runtime environment — the LLM model + provider + any runtime-relevant env (Node version for the daemon, container image SHA if applicable). For path-A and path-B captures, this is read from OTel resource attributes or the harness snapshot; for path-C, only model name is reliably available. |
| `plugins[]` | Every active skill, plugin, MCP server, and tool extension during the captured session, each with `name`, `version`, optional `cid`, and `sha256`. For Claude Code: every skill in `~/.claude/skills/` + every MCP server in `~/.claude/.mcp.json` + every plugin under `~/.claude/plugins/`. For Cursor: every rule in `.cursor/rules/`. For Aider: edit format + model + any custom prompts. The list is the operator's actual harness composition at session time, hashed. |
| `signingKey` | Operator's agent EOA pubkey (`kind: 'agent-eoa'` in v0; `kind: 'enclave-bound'` reserved for Phase B.1 attested-tier captures). Same shape as the solver flow. |
| `source` | Optional, only present at `evidenceTier: 'attested'`. v0 captures are `evidenceTier: 'self-signed'`; the SourceBundle (Dockerfile / Nix / Bazel build recipe + measurement) becomes mandatory only at the attested tier in Phase B.1. |
| `mode` | `'train' | 'frozen'` per the freeze contract in `2026-05-06-agent-harness-solvernet-design.md` §6. Most captures are `'train'` (operator's local harness is normally state-mutating — Skills self-improving, Memory accumulating). Frozen-mode captures are valid and meaningful: "I ran a checkpoint on this local task" is the natural producer of a frozen capture. |

The headline equivalence: **`executor.codeDigest + plugins[]` is the harness identity hash a third party can use to ask "could I reproduce this with the same harness configuration?"** — the same way they would for any solver Solution they're considering replicating. This makes captures meaningful substrate, not just trajectory dumps.

`artifacts[]` typically contains:

- A `jinn.trajectory.v1` artifact (the OTel spans + redactionManifest, IPFS-pinned, x402-priced)
- A `final-patch.v1` artifact (the diff at session end, if any, IPFS-pinned)
- A `final-state.v1` artifact (a tarball of the working directory's tracked changes, IPFS-pinned, optional and operator-controlled)
- A **`harness-bundle.v1` artifact** — the operator's resolved harness-config bundle (see §3.2). IPFS-pinned; `sha256` matches `executor.codeDigest`. This is what makes the capture replayable: another operator can fetch this bundle, reconstitute the harness exactly, and attempt to reproduce the result.

Each artifact's `access` field carries the operator's chosen `priceUsdc` per the existing manifest-hygiene rule (Phase A.1). v0 defaults: `priceUsdc: '0'` for the trajectory, final-patch, and harness-bundle (reads are free); operators who want to monetise can override per-repo or per-artifact-kind in their config. The harness-bundle's price is independent of the trajectory's price — operators may choose to publish trajectories free + harness-bundles paid (the harness is the higher-value reusable asset), or vice versa.

**The x402 access price is the capturer's reward mechanism.** The task-generator (§6) — and any other corpus consumer — pays the operator's chosen `priceUsdc` to fetch each capture artifact via x402. This makes the capture stream economically self-sustaining at the artifact level: operators publishing high-quality captures earn from downstream consumers without any protocol-level reward routing. v0 default of zero is a launch-time concession to friction (no friction to publish, no friction to consume), not a commitment. Operators who want to monetise set their price per-repo or per-artifact and start earning the moment any consumer (including the foundation's `session-derived.v0` task-generator) reads their captures. Per-launcher pricing strategies, sliding-scale by reputation, "pay-only-if-distilled-Task-settles" conditional pricing, and similar variants are all launcher-side experiments rather than protocol commitments.

### 3.2 Harness-bundle assembly

The harness-bundle is the operator's resolved agent configuration at session time, hashed to a single sha256 that becomes `executor.codeDigest`. This makes a capture envelope's `executor` shape isomorphic to a solver-Solution envelope's `executor` — the same provenance question ("what configuration produced this work?") has the same answer-shape.

The daemon assembles the bundle differently per capture path:

**Path A (native OTel).** Many OTel emitters set resource attributes describing their configuration (e.g., `service.name`, `agent.harness.config_path`, custom `gen_ai.agent.*` attributes). The receiver reads these and resolves the referenced files into the bundle. For tools whose OTel emitter doesn't publish harness identity in resource attributes, path A falls through to the path-B snapshot described below.

**Path B (transcript tail).** At session-start (or first-event for tools without explicit start markers), the daemon snapshots known harness-config file paths into a content-addressed bundle:

| Tool | Files snapshotted into harness-bundle |
|---|---|
| **Claude Code** | `~/.claude/CLAUDE.md` (global) + `<repo>/CLAUDE.md` (project) + relevant subset of `~/.claude/settings.json` (model, hooks list, mcpServers) + every skill under `~/.claude/skills/` and `~/.claude/plugins/<plugin>/skills/` + every MCP server config |
| **Codex** | `~/.codex/config.toml` + any custom prompt / instruction files referenced |
| **Gemini CLI** | `~/.gemini/settings.json` + custom prompt files |
| **Cursor** | `.cursor/rules/` + `.cursorrules` (legacy) + `.cursorignore` + Cursor's stored model selection |
| **Aider** | `.aider.conf.yml` + `~/.aider.conf.yml` + Aider's resolved model + edit-format choice |
| **Continue** | `~/.continue/config.yaml` (or workspace-local override) + every model definition + every prompt under `~/.continue/prompts/` + the active assistant config |

Each file is read, normalised (line-ending, trailing-whitespace), and added to the bundle. The bundle is built deterministically (sorted file list; canonical JSON for any structured-data files) so the same harness configuration produces the same `codeDigest` regardless of capture host.

**Path C (LLM-API proxy).** The proxy only sees model I/O; no harness config is recoverable from the proxy stream alone. Path-C-only captures populate `executor` with reduced fidelity:
- `implName` = `'unknown-tool-via-proxy'`
- `codeDigest` = sha256 of an empty bundle (well-known value)
- `plugins[]` = `[]`
- `runtimeBundleDigest` = sha256 of `{ model: <observed-model> }` only

This is a deliberate quality penalty: path-C captures are signal-only, not reproducible. The Captures-tab UI surfaces this with a "minimal harness metadata" badge so operators understand the limitation. Operators who want full harness provenance compose path C with path B: enable both, and the path-B snapshot fills in what the proxy can't see.

**Path D (Stop hook).** Triggers the path-B snapshot at session-end if the harness wasn't already snapshotted at session-start (e.g., when path A's resource attributes didn't reference identifiable harness files).

**Privacy posture — coarse opt-in / opt-out.** Harness-config files often contain user-specific or org-specific context. v0 keeps the operator-facing surface coarse rather than per-file:

- **Operator config toggle** — `captures.harnessBundle.enabled: boolean` (default `true`). When `false`, no harness-bundle is assembled or published; the capture envelope's `artifacts[]` omits `harness-bundle.v1`; `executor.codeDigest` falls back to a well-known sentinel value (sha256 of an empty bundle) and the `captureManifest.harnessBundle.included = false` flag records the operator's choice.
- **Directory allowlist** — `captures.harnessBundle.allowedDirectories: string[]` (defaults to the per-tool default paths from the §3.2 table). Files outside the allowlist are never read into the bundle, regardless of per-capture decisions. This is the "max it can collect from" lever — operators tighten the surface at config time once and forget about it.
- **Per-capture include/skip toggle in Captures-tab** — single boolean during review: include the bundle as assembled, or skip the bundle and publish the rest of the envelope. No per-file UI.

The deliberate design choice is that per-file curation does not exist as a v0 operator surface. The per-file telemetry that could justify such curation isn't available yet, and per-file toggles in every review create review friction that turns the Captures tab into a chore. Operators who need finer-grained control either (a) tighten `allowedDirectories` at config time, (b) flip the per-capture skip toggle when a session ran with sensitive harness state, or (c) edit their harness-config files to remove sensitive content before capturing. v0.5+ revisits per-file curation if observed operator demand justifies the friction.

The harness-bundle is published as a separate artifact (`harness-bundle.v1`) in the envelope's `artifacts[]`. Its `priceUsdc` is independent of the trajectory's — see §3.1.

### 3.3 captureManifest extension

The existing `RedactionManifestSchema` (in `client/src/trajectory/schema.ts`) records which attribute keys got dropped per span. Capture envelopes extend this with a top-level `captureManifest` carrying the operator's review-time attestation:

```ts
// client/src/trajectory/schema.ts — additive
export const CaptureManifestSchema = z.object({
  // Inherits redactionManifest.spans[] semantics; lives alongside, not inside, redactionManifest.
  scrubProcessors: z.array(z.object({
    name: z.string(),                         // '@opentelemetry/processor-redaction', custom names
    version: z.string(),
    config: z.record(z.unknown()).optional(), // Pattern set, keyword set, etc.
  })),
  reviewedBy: z.object({
    safeAddress: z.string(),                  // Operator's Safe at review time
    reviewedAt: z.string().datetime(),
  }),
  trustedRepoToggle: z.boolean(),             // Was this published via 'trust this repo' auto-approve?
  harnessBundle: z.object({
    included: z.boolean(),                               // False if operator opted out via captures.harnessBundle.enabled
    sha256: z.string().regex(/^[0-9a-f]{64}$/),         // Matches harness-bundle.v1 artifact's sha256; or the well-known empty-bundle sentinel when included=false
    allowedDirectoriesHash: z.string().regex(/^[0-9a-f]{64}$/), // sha256 of the canonicalised allowedDirectories config at capture time
    capturePath: z.enum(['A', 'B', 'C', 'D']),          // Which capture path was used to assemble the bundle
  }),
});
```

`captureManifest` is signed alongside the trajectory's existing `redactionManifest` and embedded in the trajectory artifact (not the envelope itself; envelope-level fields stay generic across roles). The `harnessBundle` section records the coarse operator decision (`included`) and the directory-allowlist hash that bounded what *could* have been collected; this is the audit surface for "what did the operator authorise the daemon to read?" — not a per-file inventory of what the daemon ultimately read. The `capturePath` field documents the path-A/B/C/D source and lets readers calibrate the harness metadata's completeness (path-C captures carry minimal harness data per §3.2). Future bonded-auditor work (v0.5+) reads `captureManifest.scrubProcessors[]` to verify the operator's claimed scrub posture matches what's actually visible in the trajectory, and `harnessBundle.sha256 + allowedDirectoriesHash` to verify the published bundle is consistent with the operator's stated config.

### 3.4 Trajectory interop with SWE-agent / SWE-bench

Per §2.4 layer 4, **SWE-agent** writes `<instance_id>.traj` JSON — an array of (thought, action, observation) turns — and **SWE-bench** accepts this as its canonical submission format. The capture envelope's `jinn.trajectory.v1` artifact is structured to map cleanly onto this shape:

| SWE-agent `.traj` field | `jinn.trajectory.v1` equivalent |
|---|---|
| `trajectory[].thought` | OTel span with `kind: 'reasoning'`, content in `gen_ai.completion.content` |
| `trajectory[].action` | OTel span with `kind: 'tool-call'`, tool name + args in attributes |
| `trajectory[].observation` | OTel span with `kind: 'tool-result'`, result content in attributes |
| `info.exit_status` | Trajectory-level metadata (mapped from session-end status) |
| `info.submission` | `final-patch.v1` artifact CID |

A small `client/src/trajectory/swe-agent-export.ts` adapter renders any `jinn.trajectory.v1` to SWE-agent `.traj` JSON. This is tested as part of the v0 acceptance: a captured session can be exported as a SWE-bench submission with no impedance mismatch. The same adapter runs server-side on the task-generator — when a Task is decomposed from a capture (§6), its `expected_artifacts.gold_patch_cid` and `signal_hints` ship as `.traj`-shaped reference material so SWE-bench-style evaluators consume them with no translation.

**Rationale.** The growth canon (`GROWTH.md` §7) currently pins on SWE-rebench-v2 metrics; the broader benchmark ecosystem (SWE-bench, METR, OpenHands) speaks the same `.traj` shape. Capture envelopes that interop with this format compose with the eval ecosystem on day one rather than forcing the ecosystem to learn a Jinn-specific format.

### 3.5 Subgraph indexing

The subgraph indexes `role='capture'` envelopes as a parallel stream alongside `role='restoration'` and `role='verdict'`. New entities:

- `CaptureEnvelope` — id (envelope CID), participant.safeAddress, executor.implName, executor.codeDigest, sessionProvenance fields, artifacts[]'s sha256s + accesses.
- `CapturesByRepo` — aggregation by `sessionProvenance.repo.remoteUrl + commitHash`. Powers dedup at task-generator time and per-repo activity views in the operator app.
- `CapturesByOperator` — aggregation by `participant.safeAddress`. Powers per-operator capture activity, rate-limit visibility, and (future) reward attribution back to the capturing operator.

No on-chain settlement events for capture envelopes; the subgraph entity is derived from the envelope CID's `IdentityRegistry.setMetadata` anchor (same path as today's envelope publication).

---

## 4. The telemetry collector

### 4.1 Architectural shape

The collector lives **inside the existing jinn-client daemon**. It is not a separate process. Operators install jinn-client today; the collector ships in the same binary.

```
                             ┌────────────────────────────────────────────────────┐
                             │              jinn-client daemon                     │
                             │                                                     │
  ┌──────────────┐ A: OTLP  │  ┌──────────────────────────────────────────────┐  │
  │  Claude Code │ ─────────►│  │  Path A: Embedded OTLP receiver               │  │
  │  Codex       │           │  │  gRPC :4317   HTTP :4318                      │  │
  │  Gemini CLI  │           │  └─────────────────────┬────────────────────────┘  │
  └──────────────┘           │                        │                           │
                             │  ┌──────────────────────▼────────────────────────┐  │
  ┌──────────────┐ B: tail  │  │  Path B: Transcript watchers + parsers         │  │
  │ Aider        │ ◄────────►│  │   - per-tool TranscriptParser                  │  │
  │ Continue     │           │  │   - synthetic-span builder                     │  │
  │ Cursor       │           │  │   - emits same span shape as path A            │  │
  │ Claude Code* │           │  └─────────────────────┬────────────────────────┘  │
  └──────────────┘           │                        │                           │
   (* safety-net)            │  ┌──────────────────────▼────────────────────────┐  │
                             │  │  Path C: LLM-API proxy (opt-in, off by default)│  │
  ┌──────────────┐ C: proxy │  │   ANTHROPIC_BASE_URL / OPENAI_BASE_URL         │  │
  │  any tool    │ ─────────►│  │   forwards + emits synthetic spans              │  │
  └──────────────┘           │  └─────────────────────┬────────────────────────┘  │
                             │                        │                           │
  ┌──────────────┐ D: hook  │  ┌──────────────────────▼────────────────────────┐  │
  │  any tool    │ ─────────►│  │  Path D: jinn-stop-hook (trigger only)         │  │
  │  with hook   │           │  │   - normalises StopHookPayload                  │  │
  └──────────────┘           │  │   - triggers path-B full-transcript ingest      │  │
                             │  │   - attaches transcript_path                    │  │
                             │  └─────────────────────┬────────────────────────┘  │
                             │                        │                           │
                             │  ┌──────────────────────▼────────────────────────┐  │
                             │  │  OTel SDK processor stack                      │  │
                             │  │   - identity-scrub processor                    │  │
                             │  │   - path-scrub processor                        │  │
                             │  │   - credential-scrub processor (V1)             │  │
                             │  │   - batch processor                             │  │
                             │  └─────────────────────┬────────────────────────┘  │
                             │                        │                           │
                             │  ┌──────────────────────▼────────────────────────┐  │
                             │  │  Pending captures queue (SQLite)                │  │
                             │  │  + signed redactionManifest + captureManifest   │  │
                             │  └─────────────────────┬────────────────────────┘  │
                             │                        │                           │
                             │  ┌──────────────────────▼────────────────────────┐  │
                             │  │  Operator app: Captures tab                     │  │
                             │  │   - pending queue list                          │  │
                             │  │   - drill-in (redaction diff)                   │  │
                             │  │   - batch approve / reject                      │  │
                             │  │   - "trust this repo" toggle                    │  │
                             │  └─────────────────────┬────────────────────────┘  │
                             │                        │ (on approve)              │
                             │  ┌──────────────────────▼────────────────────────┐  │
                             │  │  Existing publish path:                         │  │
                             │  │   IPFS-pin trajectory + final-patch             │  │
                             │  │   + assemble jinn.execution.v1 role='capture'   │  │
                             │  │   + IdentityRegistry.setMetadata                │  │
                             │  │   + corpus index (subgraph)                     │  │
                             │  └────────────────────────────────────────────────┘  │
                             └────────────────────────────────────────────────────┘
```

Tools talk to the daemon via standard OTLP. The daemon is the operator's existing trusted boundary; nothing in the architecture requires a new install or process.

### 4.2 Capture surface — four paths

The daemon supports four parallel capture paths, drawn from the prior-art layers in §2.4. Each tool is integrated via the highest-quality path it supports; lower paths backstop. The four paths:

**Path A — Native OTel (primary, standards-track).** The tool emits OpenTelemetry traces directly to the embedded OTLP receiver on `localhost:4317` (gRPC) / `:4318` (HTTP). The receiver detects session boundaries from root-span-end + idle window (default 60s). This is the highest-fidelity path; it captures the agent's full reasoning + tool-use tree as the tool itself models it.

**Path B — Transcript-file tail (universal fallback).** Every coding agent already writes a session transcript to disk — typically a JSONL or markdown file in `~/.<tool>/` or `<workspace>/.<tool>/`. The daemon tails these files with `chokidar`-style file watchers; on a write event, it parses the new lines into a normalised `TranscriptEvent` shape and feeds them through the same OTel processor stack as path A (translated into synthetic spans on the fly). Session boundaries come from idle-window detection or, for tools that mark explicit boundaries in their transcript format, from the marker. **This path works for any coding tool with a documented disk transcript, regardless of OTel or hook support.** It is the load-bearing universal fallback — most tools in the ecosystem ship one of these and have for years.

**Path C — LLM-API proxy (backstop, opt-in).** The daemon embeds a tiny HTTP proxy on a configurable local port. Operators set `ANTHROPIC_BASE_URL=http://localhost:<port>/anthropic` (or `OPENAI_BASE_URL` equivalent) on tools that emit nothing else useful; the proxy forwards traffic to the upstream API and logs request/response pairs. Captures only model I/O — no local tool calls, file edits, or shell. v0 ships this behind a feature flag (`captures.llmProxy.enabled: false` by default); it exists for operators running niche tools whose transcript format isn't documented or for which path B would be too brittle. Mirrors LiteLLM-proxy and Helicone-proxy patterns from §2.4 layer 1.

**Path D — Stop / SessionEnd hook (trigger, not capture).** Modern coding CLIs (Claude Code, Codex, Cursor 1.7+, Gemini CLI) ship explicit session-end hooks that spawn a shell command at session boundaries. A small `jinn-stop-hook` binary in `client/bin/` reads stdin (session id, transcript path, exit reason), normalises the per-tool payload via a `StopHookPayload` Zod schema, and POSTs to the daemon's local API. Path D is **not a capture path on its own** — it carries no trajectory content. It serves two roles: (i) clean session-boundary signals when path A's idle-window heuristic would be sloppy, and (ii) attaching the tool's `transcript_path` to the assembled capture envelope, letting path B run a one-shot full-transcript ingest at session end as a safety-net to path A.

**Per-tool integration matrix (v0):**

| Tool | A — OTel | B — Transcript tail | C — LLM proxy | D — Stop hook | v0 integration |
|---|---|---|---|---|---|
| **Claude Code** | yes (metrics+logs GA, traces beta; `CLAUDE_CODE_ENABLE_TELEMETRY=1`) | `~/.claude/projects/<project>/<session>.jsonl` | n/a (Anthropic-direct) | `Stop` / `SessionEnd` / `SubagentStop` in `~/.claude/settings.json` | A primary + D trigger + B safety-net |
| **Codex** (OpenAI CLI) | yes (`otel.exporter` in `~/.codex/config.toml`) | `~/.codex/sessions/` | yes (configurable `OPENAI_BASE_URL`) | `Stop` per-turn (collector coalesces turns via idle window) | A primary + D trigger + B safety-net |
| **Gemini CLI** | yes (`GEMINI_TELEMETRY_TRACES_ENABLED` + standard OTLP env vars) | `~/.gemini/sessions/` | yes (configurable Gemini endpoint) | `SessionEnd` in `~/.gemini/settings.json` | A primary + D trigger + B safety-net |
| **Cursor** | no | workspace-local SQLite (`state.vscdb`) — read-only tail via SQLite WAL | yes (when configured to local Anthropic-compatible endpoint) | `stop` / `sessionEnd` in `~/.cursor/hooks.json` (Cursor 1.7+, since 2025-09) | D trigger + B primary for content |
| **Aider** | no (PostHog only via `--analytics-log`, not OTel) | `.aider.chat.history.md` + `.aider.input.history` + `.aider.llm.history`; opt-in `--analytics-log <path>.jsonl` (richer, JSONL) | yes (Aider supports `--openai-api-base`) | no | B primary (with `--analytics-log` recommended for richer signal) |
| **Continue** | no | `.continue/dev_data/<event-kind>/<schema>.jsonl` (chat, autocomplete, edit) — also configurable HTTP-forward via `data:` block in `config.yaml`, which the daemon receives at a known endpoint | n/a (per-provider configured) | no | B primary (file tail or HTTP-forward; operator's choice) |

**Path A's zero-config promise.** For tools in the path-A column, the operator sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317` (or relies on the OTel default) plus the per-tool enable flag — and the daemon picks up sessions automatically. The receiver listens on the canonical OpenTelemetry ports (gRPC `:4317`, HTTP `:4318`) so any conforming exporter wires up with no further config.

**Path B's normalisation layer.** Each tool has its own transcript format. The daemon ships a `TranscriptParser` per tool (under `client/src/trajectory/transcript-parsers/`) that emits a common `TranscriptEvent` shape — `{ kind: 'user-message' | 'assistant-message' | 'tool-call' | 'tool-result' | 'edit', timestamp, content }`. The events feed a synthetic-span builder that translates them into OTel spans for the same processor stack as path A. Per-tool parsers in v0:
- `claude-code-jsonl.ts` — `~/.claude/projects/`
- `codex-session.ts` — `~/.codex/sessions/`
- `gemini-session.ts` — `~/.gemini/sessions/`
- `cursor-sqlite.ts` — `state.vscdb` (read-only WAL tail)
- `aider-history.ts` — `.aider.chat.history.md` + analytics-log JSONL
- `continue-devdata.ts` — `.continue/dev_data/` JSONL events

Adding support for a new tool's path B is "write a parser." This is intentional: path B is the long-tail extension surface.

**Path C's commercial sensitivity.** Routing model I/O through a local proxy means the daemon sees the operator's prompts and the upstream API responses. v0 ships path C off by default and the UI surfaces it as an explicit privacy-implicating choice; the proxy reuses the OTel processor stack so scrubbing applies the same way. v0.5+ work: optional outbound mTLS to upstream APIs to protect the operator's API key from local processes other than the daemon.

**Generic long-tail fallback**

```bash
jinn capture import path/to/otel-trace.json [--repo .] [--license MIT]
jinn capture import path/to/transcript.jsonl --tool aider [--repo .]
```

Operator manually exports a trace from any OTel-emitting tool, or hands the daemon a known-format transcript file. Lowest UX quality but unblocks any tool not in the table above.

### 4.3 OpenTelemetry pipeline unification

The existing `client/src/trajectory/collector.ts` pipeline migrates onto the embedded OTLP receiver. Existing harnesses (claude-code-learner, prediction-v0-baseline, prediction-v1-baseline, prediction-apy-v0-baseline, portfolio-v0-evaluator, etc.) emit OTel spans to the same receiver as captures.

The benefits:

- **One scrubbing pipeline for both streams.** A new redaction processor lands in one place and applies to capture envelopes and to ordinary task-execution envelopes alike. No drift.
- **Off-the-shelf processors.** The OpenTelemetry ecosystem ships first-class processors (`@opentelemetry/processor-batch`, the redaction processor, the transform processor) that the bespoke collector reimplements informally.
- **Vendor-neutral capture surface.** Any tool that emits OTel can participate, including non-Jinn-aware tools (the operator can capture a Cursor session without Cursor being aware of Jinn).

Migration cost is mechanical: the existing collector's `scrubAttributes` function becomes a thin wrapper around the OTel SDK's redaction processor, and the existing in-process call sites become OTel exporter calls. v1 commits to landing this as part of the ship; the existing `collector.ts` removes once all harnesses have migrated.

The OTel processor stack at v0 ship:

| Processor | What it does |
|---|---|
| `@opentelemetry/processor-batch` | Batches spans before downstream handling |
| Identity scrub (custom) | Pattern-replaces username, hostname, machine ID, git author name/email, env-vars beyond credential set, IP addresses |
| Path scrub (custom) | Pattern-replaces `$HOME` paths with `/users/anon/`; absolute paths under known user-dirs become relative; custom-named directory tokens |
| Credential scrub | Today's V1 pattern set: `authorization`, `apiKey`, `bearer`, `password`, `secret`, `token`, `privateKey` |
| Manifest builder (custom) | Produces the signed `redactionManifest` + `captureManifest` |
| SQLite exporter (custom) | Writes to pending-captures store |

The custom processors are small (each ~100 LOC) and live under `client/src/trajectory/processors/`. The processor versions appear in `captureManifest.scrubProcessors[]` so future bonded-auditor work can verify what version produced the published artifact.

### 4.4 Operator UX — Captures tab

The operator app gains a new top-level tab: **Captures**. Sibling to existing tabs (Overview, Configuration, Tasks, etc.).

**Pending queue view:** a list of capture envelopes in pending state, sorted by `capturedAt` descending. Each row shows:

- Repo + branch + commit (truncated if long)
- License (detected SPDX-id badge or "unspecified")
- Originating tool
- Span count + duration
- Number of redactions applied (clickable to drill in)
- Per-row "approve" + "skip" actions

**Drill-in view (per capture):** clicking a row opens a detail pane with:

- The full sessionProvenance metadata
- The full executor metadata: `implName`, `implVersion`, `codeDigest`, `runtimeBundleDigest`, `plugins[]` (with name + version + sha256 per plugin), `mode`. Same display shape as solver-Solution envelopes already use elsewhere in the operator app — this is the harness-identity card.
- The redaction diff: side-by-side "before scrub / after scrub" for each redacted span attribute (only the *keys* and a placeholder are shown; the raw values are kept locally and never displayed by default — the operator can opt in to see them)
- The **harness-bundle summary**: a single line — "Harness bundle included from `<allowedDirectories>` (N files, M KB, sha256 prefix)" with one boolean toggle: **include bundle | skip bundle**. No per-file UI. Operators who want finer control adjust `captures.harnessBundle.allowedDirectories` in config (§3.2) or skip the bundle for this capture.
- A trajectory-tree preview (compact, collapsible)
- A "view final patch" link if the capture has one
- An "approve & publish" button + "skip / delete" button + "edit license / repo metadata" edit-in-place
- A "trust this repo" toggle (per-repo); when set, future captures from this repo skip the queue and auto-publish (using the per-repo's previously-confirmed include-bundle / skip-bundle choice as the default, operator-revocable any time)

**Batch approve:** select N rows from the pending queue, click "Approve & Publish All". The daemon publishes them sequentially (rate-limited per §4.5).

**Skip:** removes from the pending queue without publishing; deletes the local artifact bytes after a 7-day grace period (operator can review skipped captures during the grace window).

**Trust this repo toggle (per-repo, persisted to operator config):**

- Settings: `captures.trustedRepos: string[]` (list of remoteUrl values)
- When a capture's `sessionProvenance.repo.remoteUrl` matches an entry, auto-approve and publish without UI gate
- Operator can revoke per-repo at any time

### 4.5 Rate limits + dedup

**Rate-limiting** applies at publish time, not capture time. The daemon allows unlimited captures into the pending queue (an operator with verbose sessions doesn't lose data); publishing is rate-limited:

- Per-operator publish rate: default 10 captures/hour, burstable to 30. Configurable in operator config.
- Per-repo publish rate: default 5 captures/hour. Prevents single-repo spam.

When rate limits are hit, additional approvals are queued and published as the rate budget allows; the Captures tab shows queued + delayed counts.

**Dedup** is a corpus-consumer concern, not a publisher concern. The collector does not refuse to publish a capture that overlaps with an existing one; the task-generator (§6) dedups at distillation time using `sessionProvenance.repo.commitHash + sessionProvenance.sessionId` as the dedup key, falling back to trajectory-content hash for sessions without a clean repo provenance.

---

## 5. The `session-derived.v0` SolverNet

### 5.1 Identity

Per `spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 §2 principle 5, SolverNet contracts are identified by `{contract.id, contract.version}`; launched-instance authority is `manifestCid`. The contract `session-derived` v1.0.0 lives in `packages/sdk/src/contracts.ts` next to `SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT` and `PREDICTION_V1_SOLVER_NET_CONTRACT`.

A launcher creates a launched instance from the contract template, signs the manifest, anchors via `IdentityRegistry.setMetadata`, IPFS-pins, and starts the launcher-owned task-generator (§6). Operators discover the launched manifest from the registry (subgraph-indexed) and participate as `solving` or `evaluating` per `openRoles`.

The launcher's manifest carries `solutionPriceWei`, `verdictPriceWei`, and `openRoles` per the existing pattern. Multiple launchers can launch independent `session-derived.v0` SolverNets with different price/role/coverage configs (e.g., one launcher only distils captures from React-flavored repos; another only Python ML ones). They are discoverable side-by-side; no canonical instance.

### 5.2 Contract definition

```ts
// packages/sdk/src/contracts.ts
export const SESSION_DERIVED_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  id: 'session-derived',
  version: '1.0.0',

  schemas: {
    task:     SESSION_DERIVED_TASK_SCHEMA,      // problem_statement, repo, base_commit, language, expected_artifacts, sourceCaptureCid, deadline_unix
    solution: SESSION_DERIVED_SOLUTION_SCHEMA,  // patch, trajectory_cid, cost?
    verdict:  SESSION_DERIVED_VERDICT_SCHEMA,   // composite_score, signal_breakdown, evaluator_cost_usd
  },

  claimPolicyDefaults: {
    maxConcurrentClaimsPerOperator: 5,
    claimTimeoutMs: 4 * 60 * 60 * 1000, // 4 hours per Task (longer than swe-rebench-v2's 1h; sessions can be larger)
  },

  credentialRequirements: {
    solving:    { minReputation: 0 },
    evaluating: { minReputation: 0, requiresBond: true, bondAmountUsdc: '50' },
  },

  evaluationFunction: {
    id: '@jinn-network/session-derived-evaluator',
    version: '1.0.0',
    deterministic: false, // composite uses LLM-judge component → non-deterministic
  },

  aggregationFunction: {
    id: 'session-derived-rolling-mean',
    version: '1.0.0',
    windowing: { kind: 'rolling-days', days: 30 },
  },

  defaultRuntimePlugins: [
    'bundled:network-tools',
    'bundled:session-derived-runtime',
  ],
};
```

Schemas, evaluator, and aggregation are protocol authority; operator config does not redeclare them.

### 5.3 Task schema

```ts
export const SessionDerivedTaskSchema = z.object({
  schemaVersion: z.literal('session-derived.v1'),

  problem_statement: z.string().min(1),       // LLM-distilled, 1-3 sentences
  repo: z.object({                            // From source capture's sessionProvenance
    remoteUrl: z.string(),
    commitHash: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z.string().optional(),
  }),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  language: z.string().optional(),

  expected_artifacts: z.object({
    test_suite_ref: z.object({                // If reproducible
      kind: z.enum(['docker', 'shell', 'none']),
      reference: z.string().optional(),       // Docker image / shell-command spec
    }),
    gold_patch_cid: z.string().optional(),    // CID of capture's final patch (gold reference if present)
    signal_hints: z.record(z.unknown()).optional(), // LLM-distilled hints for evaluator
  }),

  recommended_harness: z.object({             // Inherited from sourceCapture's executor; informational
    bundleCid: z.string().min(1),             // CID of the source capture's harness-bundle.v1 artifact
    implName: z.string(),                     // Originating tool: 'claude-code' | ...
    implVersion: z.string(),
    plugins: z.array(z.object({               // Active plugins/skills at capture time
      name: z.string(),
      version: z.string(),
    })),
  }).optional(),

  sourceCaptureCid: z.string().min(1),        // Provenance back to the originating capture envelope
  deadline_unix: z.number().int(),
});
```

### 5.4 The composite evaluator

`@jinn-network/session-derived-evaluator` runs a weighted composite over multiple signals. Each signal contributes only if its inputs are available; missing signals contribute zero weight (and the evaluator renormalises across present signals).

| Signal | Weight | When available |
|---|---|---|
| Test-suite re-run | 0.5 | `expected_artifacts.test_suite_ref.kind !== 'none'` and the runner can reproduce the test environment |
| Structural similarity to gold patch | 0.3 | `expected_artifacts.gold_patch_cid` present (capture had a final patch) |
| LLM-judge solution quality | 0.2 | Always |

The Verdict carries the composite score plus the per-signal breakdown:

```ts
export const SessionDerivedVerdictSchema = z.object({
  composite_score: z.number().min(0).max(1),
  signal_breakdown: z.object({
    test_suite: z.object({ score: z.number(), weight: z.number(), present: z.boolean() }),
    structural_similarity: z.object({ score: z.number(), weight: z.number(), present: z.boolean() }),
    llm_judge: z.object({ score: z.number(), weight: z.number(), present: z.boolean(), reasoning: z.string() }),
  }),
  evaluator_cost_usd: z.string(),
});
```

`signal_breakdown` is published alongside the score so consumers can interrogate which signals carried the verdict — important for trust during the v0/v0.5 phases when the evaluator's calibration is still being tuned.

### 5.5 Aggregation

A 30-day rolling-window aggregator emits a `session-derived-network-result`:

```ts
interface SessionDerivedNetworkResult {
  schemaVersion: 'session-derived.network.v1';
  windowStart: string; windowEnd: string;
  verdictCount: number; uniqueOperators: number; uniqueCaptures: number;

  meanCompositeScore: number;
  testSuiteCoverage:  number;  // fraction of Tasks where test_suite_ref was reproducible
  goldPatchCoverage:  number;  // fraction of Tasks with a gold_patch_cid
  llmJudgeOnlyRate:   number;  // fraction of Verdicts that ran on LLM-judge alone (no test, no gold)
  byLanguage:         Record<string, { mean: number; n: number }>;
  byOriginatingTool:  Record<string, { mean: number; n: number }>; // claude-code | codex | gemini-cli | ...
}
```

Surface metrics chosen for trust + diagnostics:
- `meanCompositeScore` — headline.
- `testSuiteCoverage`, `goldPatchCoverage`, `llmJudgeOnlyRate` — show how much of the evaluation depended on the higher-trust signals vs. LLM-only. As capture volume grows and tooling improves, these shift toward higher-trust majority.
- `byLanguage` and `byOriginatingTool` — slicing surfaces specialisation and helps operators choose where to run.

---

## 6. The task-generator

### 6.1 Pipeline

```
Corpus (capture envelopes)
        │
        ▼
┌────────────────────────────────────────────┐
│  Polling loop                              │
│   - polls subgraph for new role='capture'  │
│   - applies filters (license, freshness)   │
│   - applies dedup (commitHash + sessionId) │
└──────────────┬─────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────┐
│  Distillation pass (per capture)           │
│   - fetches trajectory + final-patch       │
│     (paid via x402 if launcher's config    │
│     allows)                                │
│   - LLM call: decompose into N atomic      │
│     Task drafts                            │
│   - quality gate: confidence > threshold   │
└──────────────┬─────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────┐
│  Posting loop                              │
│   - for each Task draft:                   │
│     - constructs SessionDerivedTask        │
│     - signs manifest                       │
│     - calls JinnRouter.createTask via      │
│       launcher's MechAdapter               │
└────────────────────────────────────────────┘
```

The pipeline is a TaskGenerator in the existing `client/src/solver-types/` pattern, mirroring `client/src/solver-types/swe-rebench-v2.ts`'s `_swe-rebench-v2-pool.ts` + state store + selection helpers. Files (proposed):

- `packages/sdk/src/contracts.ts` — `SESSION_DERIVED_V1_SOLVER_NET_CONTRACT` + schemas
- `packages/sdk/src/payloads/session-derived.ts` — Zod schemas for Task / Solution / Verdict
- `client/src/solver-types/session-derived.ts` — `SolverTypeDefinition<SessionDerivedAutoConfig>` (parseSpec, buildGenerator, getTestnetAutoConfig, ui)
- `client/src/solver-types/_session-derived-pool.ts` — corpus polling + dedup
- `client/src/solver-types/_session-derived-distill.ts` — LLM distillation pass + quality gate
- `client/src/solver-types/_session-derived-state.ts` — generator state store (which captures have been distilled, which Tasks were posted, dedup counters)

### 6.2 Distillation prompt design

The LLM distillation pass runs on the launcher's chosen LLM (Anthropic Claude or any provider; configurable in the launched manifest). The prompt is content-addressable (a known sha256 stored in the launcher's manifest) so consumers can audit which version was used for which Tasks.

Sketch of the system prompt:

```
You are decomposing a captured agent session into atomic Tasks for a SolverNet.

INPUT: a session trajectory (OTel spans), a final patch (if present), session
provenance (repo, commit, language), and the originating harness identity
(executor.implName + plugins[]: which tool, which skills, which plugins, which
model). The harness identity is informational — use it to calibrate how much
context the resulting Task can assume the claimant has access to.

OUTPUT: one or more atomic Task drafts. Each Task should be solvable by an
agent who has not seen this trajectory, given only the problem statement,
repo, and base commit. The Task may optionally include a 'recommended_harness'
hint pointing at the originating harness-bundle CID for claimants who want to
attempt the Task with a comparable setup.

For each Task, emit:
  - problem_statement: 1-3 sentences. Must be self-contained.
  - expected_artifacts.test_suite_ref: if the trajectory shows tests being run, capture
    the runner kind (docker/shell) and the reference. Otherwise 'none'.
  - expected_artifacts.signal_hints: extracted hints (file paths likely to be edited,
    test names that should pass, etc.)
  - confidence: 0-1. Use < 0.5 if the trajectory is ambiguous, multi-purpose, or
    too short to support a clean Task.

Reject (return empty array) if:
  - The session contains content the operator opted out of publishing
  - The session is fundamentally exploratory and has no atomic Task structure
  - The session is < N spans or < M total LLM calls (too thin to distil)
```

The prompt evolves; versioning is via the launcher's manifest. v0.5+ work: few-shot examples drawn from a curated set of high-quality past captures.

**Foundation reference prompt.** v0 ships a foundation-published reference prompt at `packages/sdk/src/session-derived/distill-prompt-v1.ts` with a known sha256. The foundation's launched `session-derived.v0` manifest references this prompt by hash. **This is one option, deliberately not canonical** — launchers may substitute, extend, or fork. The expectation is that launchers compete on prompt quality and the network discovers what works through observed `session-derived-network-result` aggregations (§5.5) rather than by foundation mandate. Audit story: every distilled Task carries (via the launched manifest indirection) a content-addressable pointer to the prompt that produced it; "this Task was distilled by prompt-hash X from capture-CID Y" is reconstructible.

### 6.3 Quality gates

Three gates between the LLM output and a posted Task:

1. **Confidence threshold.** Tasks with `confidence < 0.5` are dropped.
2. **Reproducibility check.** If `expected_artifacts.test_suite_ref.kind !== 'none'`, the launcher attempts to spin up the test environment locally before posting. If reproduction fails, the Task is downgraded to `kind: 'none'` (LLM-judge-only verifier path) and re-evaluated against the confidence threshold.
3. **Dedup.** The generator's state store tracks `(repo.commitHash, problem_statement_hash)` keys; duplicates are not posted twice.

Task drafts that fail any gate are logged in the launcher's state store with a rejection reason; they are not published or retried unless the gate parameters change in a future generator version.

### 6.4 Cost model

The launcher pays:
- LLM distillation costs (per-capture, ~$0.10–$1 depending on session size and chosen model)
- Reproducibility-check costs (Docker pulls + test runs at gate 2)
- Task escrow per JinnRouter.createTask (the Solution + Verdict reward pool)

Out of scope (per `2026-05-05-solvernet-creation-and-launch.md`): how the launcher recovers these costs. v0 candidates: foundation grant; sponsor partnership; capture-revenue-back-to-launcher (a fraction of the x402-paid corpus revenue from captures auto-routes to the launcher's escrow, if the operator opts in). These are launcher-private commercial decisions, not protocol commitments.

### 6.5 Provenance back-link

Every generated Task carries `sourceCaptureCid` pointing to the originating capture envelope's CID. The subgraph indexes this as a `Task.sourceCaptureCid` field, enabling:

- "Show me Tasks generated from my captures" — operator's perspective
- "Show me which capture seeded this Task I'm working on" — claimant's perspective (if visible per launcher's privacy policy)
- Future reward attribution (v0.5+): when a Task settles, a fraction of the reward pool can be routed back to the originating capture's operator. This is the operator-pool funding model in nascent form.

---

## 7. Reference-don't-redistribute revisited

The SWE-rebench-v2 spec §4.3 commits a principle: *Task payloads reference benchmark content (HuggingFace URI, instance_id, etc.); they do not embed it.* Operators fetch from canonical sources at solve time.

This spec **does not follow that principle for capture envelopes**, and that departure is deliberate.

The reference-don't-redistribute principle requires a canonical external source. SWE-rebench-v2 has one (the `nebius/SWE-rebench-leaderboard` HuggingFace dataset + the `swerebenchv2` Docker namespace). Captures don't: a session is bound to a specific operator's specific machine at a specific time. The trajectory is the canonical artifact only because the operator captured it; there's no external authority to defer to.

Captures redistribute (anonymized) trajectory + final-state content. The license posture (DR-2026-05-07-c) is operator-asserted: protocol facilitates the transaction; operator carries the legal liability, parallel to how x402 itself works.

This is called out so future SolverNet designs can choose the right model:
- **Benchmark-shaped SolverNets** (swe-rebench-v2, future GDPval / apex-agents / LiveBench instances): reference canonical sources.
- **Capture-shaped SolverNets** (this spec): redistribute operator-asserted-licensed content.
- **Mixed-shape SolverNets** (future): reference for the test/gold material; redistribute for operator-contributed deltas. The principles compose when needed.

The departure is not a weakening of the principle; it is the principle correctly scoped to the case where it applies.

---

## 8. Implementation surface and engineering scope

### 8.1 Component breakdown

| Component | Files / scope | Lift |
|---|---|---|
| **Envelope schema additions** | `client/src/types/envelope.ts` — `'capture'` role; conditional `taskProvenance` / `sessionProvenance` | ~half-day |
| **captureManifest schema** | `client/src/trajectory/schema.ts` — additive; signature integration; harness-bundle file-list coverage | ~1 day |
| **Harness-bundle assembler** | `client/src/trajectory/harness-bundle.ts` — per-tool snapshot logic, deterministic hashing, redaction-aware bundle build, sha256 → `executor.codeDigest` wiring | ~3-4 days |
| **Per-tool harness-bundle snapshot rules** | Path-A resource-attribute readers + path-B file-snapshot rules per tool (Claude Code, Codex, Gemini CLI, Cursor, Aider, Continue) — tracked alongside the per-tool transcript parsers | ~3-4 days (~0.5 day per tool) |
| **Path A: embedded OTLP receiver** | `client/src/trajectory/receiver.ts` — gRPC + HTTP listener; SDK wiring | ~3-4 days |
| **Path B: transcript-tail watchers** | `client/src/trajectory/transcript-watcher.ts` — chokidar-style file watchers; SQLite WAL tail for Cursor; HTTP receiver for Continue's `data:` mode | ~3-4 days |
| **Path B: per-tool transcript parsers** | `client/src/trajectory/transcript-parsers/{claude-code-jsonl,codex-session,gemini-session,cursor-sqlite,aider-history,continue-devdata}.ts` — each parses native format → common `TranscriptEvent` shape; synthetic-span builder | ~6-8 days for all six parsers (~1-1.5 days each) |
| **Path C: LLM-API proxy** | `client/src/trajectory/llm-proxy.ts` — Anthropic + OpenAI shape forward proxy; emits synthetic spans into same processor stack; opt-in feature flag | ~3-4 days |
| **Path D: `jinn-stop-hook` binary + per-tool config** | `client/bin/jinn-stop-hook.ts` (stdin reader + normaliser); `client/scripts/install-hooks/` for Claude Code, Codex, Gemini CLI, Cursor (per §4.2) | ~2 days for the binary; ~1 day per per-tool config recipe |
| **OTel processor stack (shared by all four paths)** | `client/src/trajectory/processors/` — identity, path, manifest-builder, exporter | ~3-4 days |
| **Migration of existing collector** | `client/src/trajectory/collector.ts` → thin SDK shim; harness call-site updates | ~3 days |
| **Pending captures store** | `client/src/store/captures.ts` — SQLite schema + queue API | ~1-2 days |
| **Captures tab (UI)** | `client/src/dashboard/spa/src/captures/*` — pending list, drill-in, batch approve, per-path indicator badge | ~5-6 days |
| **Generic import CLI** | `client/src/cli/commands/capture.ts` — `jinn capture import <file> [--tool <name>]` | ~1 day |
| **`session-derived` SolverNet contract** | `packages/sdk/src/contracts.ts`; payload schemas; defaults | ~1 day |
| **Composite evaluator** | `@jinn-network/session-derived-evaluator` — test-suite runner + structural-similarity + LLM-judge | ~5-6 days |
| **`bundled:session-derived-runtime` plugin** | Tools the solver harness needs (Docker, test runners, etc.) | ~2-3 days |
| **Task-generator** | `client/src/solver-types/session-derived.ts` + `_session-derived-{pool,distill,state}.ts` | ~5-6 days |
| **Subgraph** | New `CaptureEnvelope` + aggregation entities; `Task.sourceCaptureCid` | ~2 days |
| **Tests** | Receiver e2e, scrub processor unit tests, capture-envelope assembly e2e, Captures-tab Playwright, Task-generator e2e on Anvil | ~5-6 days |
| **Total** | | **~58-70 days, ~12-14 weeks** (added ~6-8 days for harness-bundle assembler + per-tool snapshot rules; added ~12 days for path-B parsers + path-C proxy vs. the v0 with path A + D only) |

### 8.2 v0 acceptance criteria

The v0 ships when:

1. `jinn-mono-h43b` has landed: the OTel SDK processor stack is in place; `secret-scrub.ts`'s pattern set is preserved as a processor under the new architecture.
2. `'capture'` role + `sessionProvenance` field + `captureManifest` extension (with `harnessBundle` coverage) land in `client/src/types/envelope.ts` and `client/src/trajectory/schema.ts`. The `harness-bundle.v1` artifact type is registered. Existing harnesses unaffected (back-compat preserved).
2a. **Capture envelopes mirror solver-Solution envelope shape.** Every executor field (`implName`, `implVersion`, `clientGitSha`, `codeDigest`, `runtimeBundleDigest`, `plugins[]`, `signingKey`, `mode`) populates for v0 captures with the same depth a solver Solution carries. v0 acceptance includes a snapshot test asserting that a captured Claude Code session and a `claude-code-learner` solver Solution from the same operator have isomorphic envelope shapes (modulo the role discriminator and provenance swap).
3. The embedded OTLP receiver listens on `localhost:7332` (configurable). Migrating one harness (e.g., claude-code-learner) onto it is the proof-of-migration acceptance.
4. v0 ships end-to-end-tested integrations exercising **all of paths A, B, C, and D** per §4.2:
   - Path A: Claude Code, Codex, Gemini CLI (OTel-native).
   - Path B: Aider (`.aider.chat.history.md` + `--analytics-log`), Continue (`.continue/dev_data/`), Cursor (workspace SQLite WAL tail), plus path-B safety-net for the path-A tools.
   - Path C: at least one tool wired via the LLM-API proxy with the feature flag explicitly enabled (recommended: Aider via `--openai-api-base`).
   - Path D: Stop-hook trigger wired for Claude Code, Codex, Gemini CLI, Cursor; verified to attach `transcript_path` and trigger path-B safety-net ingest on session end.
   Each tool's primary path produces a `role='capture'` envelope that survives the Captures-tab review and publishes successfully on testnet. The forcing function is deliberate: if path B or C silently break, downstream tool support stops working — testing all four paths on v0 prevents bit-rot.
5. Captures tab in the operator app: pending queue + drill-in + batch approve + per-repo trust toggle. Playwright covers golden path + edge cases.
6. End-to-end test: a Claude Code session emits OTel; daemon assembles a `role='capture'` envelope; operator approves; envelope IPFS-pinned + anchored via `IdentityRegistry.setMetadata`; subgraph indexes it.
7. `session-derived` v1.0.0 SolverNet contract registered in `packages/sdk/src/contracts.ts`.
8. A launched `session-derived.v0` SolverNet manifest exists on testnet; task-generator runs against the testnet corpus's capture envelopes; posts at least one Task to JinnRouter.
9. `@jinn-network/session-derived-evaluator` runs on bonded evaluator daemons; produces composite Verdicts on Solver submissions.
10. Documentation: SDK JSDoc covers the `'capture'` role + `sessionProvenance`; recruit-grade docs for an AI-builder cluster member to set up the OTLP exporter for their tool.

### 8.3 v0.5 / v1 future work

- **LLM-mediated NL anonymization** as an opt-in scrubber.
- **Bonded `capture-auditor` evaluator role.** Sample-checking anonymization compliance with bond + slashing on detected violations. Mirrors the freeze-mode trust stack (DR-d in the sibling spec).
- **Reward attribution back to capturer.** A fraction of generated-Task settlements routes back to the originating capture's operator. The first economic loop that closes capture-side incentives.
- **Cross-SolverNet routing.** Generator classifies captures and routes into thematic SolverNets (coding → swe-rebench-v2-shaped, prediction → prediction.v1) instead of always into `session-derived.v0`. Addresses #103 Q3.
- **Dynamic SolverNet summoning.** Generator detects coherent capture clusters and summons a new SolverNet on demand. Addresses #103 Q5.
- **Phase B.1 attested-tier captures.** TEE-attested anonymization closes the residual gap on the trust stack.
- **OTel-emit upgrades for Aider + Continue.** Both tools ship in v0 via path B (transcript tail). v0.5+ work tracks their progress toward emitting native OTel (path A) — Aider has open issues asking for OpenTelemetry support; Continue has a partial `data:` HTTP destination already. When either lands, the per-tool integration moves up from path B to path A automatically (the parser becomes a safety-net rather than the primary).
- **Capture-revenue routing.** The operator's x402-paid corpus revenue from captures can be auto-routed (configurable) back into a launcher's escrow pool — bootstrapping launcher economics from the substrate's own activity.

---

## 9. Phase placement and acceptance — Phase A.5+

Per `spec/2026-04-30-phase-a-umbrella.md`, Phase A is the operational-loop substrate around `prediction.v1`. Phase A.5 (per the sibling spec's DR-h) is `swe-rebench-v2`, post-A.4 campaign launch.

This SolverNet ships as **Phase A.5+** — concurrent with or sequential to swe-rebench-v2, depending on resourcing. Sequencing rationale:

- **A.1 must land first.** The collector depends on the corpus library for cross-operator artifact access; the task-generator depends on it for reading capture envelopes.
- **`jinn-mono-h43b` must land first or co-ship.** The proper anonymization tool replaces the V1 pattern scrub; capture envelopes' trust posture depends on it.
- **swe-rebench-v2 (A.5) depends only on A.1.** This spec depends on A.1 + h43b. There is no ordering constraint between this and A.5; they can ship in parallel if engineering capacity allows.
- **A.6 candidate name** (if sequential after A.5).

A.5+ acceptance is the §8.2 criteria above plus: at least 3 operators publishing capture envelopes on testnet across at least 2 distinct repos; at least one Task generated and successfully solved from a capture; Captures-tab UX validated against ≥3 operator workflows.

---

## 10. Open questions

Four questions called out as deliberately unresolved in this design. (Q4 — capturer reward — and Q7 — harness-bundle file curation — were closed in spec revision review on 2026-05-07. Q4 resolved: the x402 access price on capture artifacts *is* the capturer's reward mechanism; v0 default zero, operator-set, no protocol-level routing needed; see §3.1. Q7 resolved: coarse opt-in/opt-out + directory allowlist replaces per-file curation; see §3.2.)

1. **GH#103 Q3 — create-vs-route heuristics.** v0 always posts to `session-derived.v0`. v0.5+ work: classify captures (coding / prediction / portfolio / ...) and route into existing SolverNets where the capture's outcome shape matches an existing schema. Open: classification approach (LLM, heuristic, embedding-similarity); confidence thresholds; operator-controlled overrides; what happens when classification is wrong (Task posts into the wrong SolverNet and gets bad evaluation). Filed as a tracked workstream pre-v0.5. *(Note: substrate framing — capture envelopes are in the corpus and any consumer can build alternative task-generators that classify and route differently; the question here is only whether the foundation's `session-derived.v0` task-generator does it itself.)*

2. **GH#103 Q5 — does this collapse the launcher role?** This v0 doesn't address it directly. Captures + auto-distillation reduce launcher-friction (the launcher doesn't need to write outcome specs per Task; the LLM derives them) but the role still exists for who-funds-the-escrow-pool and who-runs-the-distiller. Open: whether the foundation eventually becomes the default launcher of `session-derived.v0` instances on behalf of capture-publishing operators (collapses the role); whether vendor-sponsored launchers become the dominant pattern (preserves the role); whether operator-pool self-funding works at scale (collapses it differently). Empirical question, not a v0 design question — revisit at v0.5+ retro after observing actual launcher behaviour.

3. **Whose LLM, how strict the prompt, how content-addressable.** Locked: the launcher chooses the LLM provider + model; the prompt is sha256-hashed and embedded in the launched manifest; v0 ships a foundation-published reference prompt (§6.2) that is *one option, not canonical*. Remaining open: whether the network develops norms around prompt quality as launchers compete (this is a market-discovery question, not a spec question — leaderboard aggregations in §5.5 surface what works).

4. **What "session" means for tools without natural session boundaries.** Claude Code has `Stop`. Cursor's editing flow doesn't have a clean session boundary. For tools that emit OTel continuously without session events, the daemon's idle-window heuristic (root-span-end + 60s idle) is a workable v0 default but produces low-quality boundaries. The four-path taxonomy in §4.2 helps: when path D (Stop hook) is available, it provides clean boundaries; when only path B (transcript tail) is available, the per-tool transcript format sometimes carries explicit session markers that the parser surfaces. But the open question persists for tools where all paths are heuristic. Open: tool-by-tool calibration; operator-controlled "split here" markers; UI surface for the operator to retroactively split or merge captured sessions; whether the OpenTelemetry GenAI semconv (§2.4) eventually defines a stable "session" abstraction that lets us remove the heuristic.

---

## 11. Vocabulary alignment

This spec uses the current vocabulary throughout, matching `spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 and the sibling `2026-05-06-agent-harness-solvernet-design.md`.

- **SolverNet contract** identity is `{contract.id, contract.version}`; **launched-instance** authority is `manifestCid`. No `solverType` references.
- **Harness, HarnessContext, Solver, Task, Solution, Verdict, Evaluator** — unchanged from existing usage.
- **Mode**: `'train' | 'frozen'` (per sibling spec). Most captures will be `'train'`-mode envelopes, but frozen-mode captures are valid (a checkpoint run on a local task is a meaningful capture).
- **`role`**: extending the existing `'restoration' | 'verdict'` with `'capture'` as the third member. Same naming register (nominalized verb describing what the envelope claims).
- **`sessionProvenance`**: chosen to parallel `taskProvenance` in shape and naming; mutually exclusive with it via the role discriminator.
- **`captureManifest`**: lives alongside `redactionManifest` in the trajectory artifact, not as a top-level envelope field. Extends the redaction-manifest pattern; adds operator review attestation.

---

## 12. Decision records

The following DRs are filed alongside this spec at `log/decisions/2026-05-07-…`:

- **DR-2026-05-07-a — Capture as a third envelope role; sessionProvenance replaces taskProvenance.** Selects: same `jinn.execution.v1` envelope shape, additive `'capture'` role, conditional optional fields. Rejects: synthetic on-chain Task per session; new envelope kind; raw trajectory without an envelope wrapper.
- **DR-2026-05-07-b — Anonymization scope: identity + path scrub on top of credential scrub; batch UI review; trust-this-repo per-repo; auditor tier deferred.** Selects: pattern-based scrubbing via OpenTelemetry SDK processors; signed `captureManifest`; pending queue + Captures-tab review; per-repo auto-approve toggle. Rejects: LLM-mediated NL scrub at v0; daemon self-publish without UI gate; bonded auditor at v0.
- **DR-2026-05-07-c — No protocol-level OSS gate; license is operator-asserted.** Selects: best-effort SPDX detection as UI hint; `sessionProvenance.license.operatorAssertion` carries the canonical signal; protocol facilitates redistribution; operator carries legal liability. Rejects: SPDX-file-parse hard gate; GitHub API license probe; user-attestation gate.
- **DR-2026-05-07-d — Generated Tasks post to own SolverNet `session-derived.v0`.** Selects: launcher posts every distilled Task into one SolverNet contract. Rejects: classification + routing into existing SolverNets at v0; dynamic SolverNet summoning per capture-cluster.
- **DR-2026-05-07-e — Embedded OpenTelemetry pipeline unifies capture and task-execution trajectories.** Selects: `client/src/trajectory/collector.ts` migrates onto an embedded OTLP receiver; one scrubbing processor stack for both streams; off-the-shelf OTel SDK processors. Rejects: separate pipelines per stream; bespoke collector retained; v0.5+ deferral of unification.
- **DR-2026-05-07-f — Four-path capture surface; path B (transcript tail) is universal-coverage v0, not v0.1.** Selects: the daemon embeds path A (native OTel) + path B (per-tool transcript file watchers + parsers) + path C (opt-in LLM-API proxy) + path D (Stop hook trigger), with all four exercised on v0; per-tool integration chooses the highest-quality path that tool supports, with lower paths as backstop. Rejects: OTel-only v0 with transcript-tail deferred to v0.1 (the previous draft's posture); proxy-only universal capture (loses local tool detail); transcript-tail as a "best-effort" workstream rather than a primary capture path. Rationale: transcript files have been the universal disk-based agent-telemetry pattern since before OTel adoption; treating path B as the load-bearing fallback aligns Jinn's collector with the actual prior-art landscape (§2.4) rather than the 2025 Stop-hook layer alone.
- **DR-2026-05-07-g — Capture envelopes mirror solver-Solution envelope shape exactly; same `executor` provenance depth + `harness-bundle.v1` artifact.** Selects: every executor field (`implName`, `implVersion`, `clientGitSha`, `codeDigest`, `runtimeBundleDigest`, `plugins[]`, `signingKey`, `source?`, `mode`) populates for captures with the same depth a solver Solution carries; the operator's resolved harness-config bundle (CLAUDE.md + skills + plugins + MCP config + per-tool config files, per §3.2) is published as a `harness-bundle.v1` artifact whose sha256 is `executor.codeDigest`; operator control over the bundle is *coarse* (opt-in/opt-out toggle + directory allowlist at config; per-capture include/skip toggle in Captures-tab; no per-file curation in v0); the Captures-tab UI surfaces the harness-identity card and a single include-bundle/skip-bundle toggle. Rejects: minimal `executor` for captures (only `mode`, treating the rest as solver-only); harness-config encoded only in `sessionProvenance.originatingTool.name + version` without per-plugin / per-skill detail; harness-bundle published only as opaque metadata rather than a fetchable, replayable artifact; per-file publish/redact UI in v0 (rejected for review-friction reasons — see §3.2 v0 posture; v0.5+ revisits if observed operator demand justifies it). Rationale: the substrate value of captures is *replayability* — third-party operators can fetch the harness-bundle CID, reconstitute the harness exactly, and either reproduce the result or use it as a starting point. A capture envelope without harness-bundle artifact is a trajectory dump, not substrate. Mirroring solver-Solution shape also collapses cognitive load: the network has one envelope shape, not two; the same UI / SDK / verification code paths handle both streams. The only legitimate difference between a capture and a solver Solution is the role discriminator and the `taskProvenance` ↔ `sessionProvenance` swap.

---

## 13. References

- `client/src/types/envelope.ts` — `jinn.execution.v1` envelope schema (the wire shape this spec extends).
- `client/src/trajectory/schema.ts` — `jinn.trajectory.v1` schema; `RedactionManifestSchema` (the manifest pattern this spec extends).
- `client/src/trajectory/secret-scrub.ts` — V1 credential pattern scrub; baseline preserved as a processor under the new architecture.
- `client/src/trajectory/collector.ts` — bespoke trajectory collector; migrated to OTel SDK shim per DR-e.
- `client/src/solver-types/swe-rebench-v2.ts` + `_swe-rebench-v2-pool.ts` + `_swe-rebench-v2-state.ts` — the SolverTypeDefinition pattern this spec mirrors for the `session-derived.v0` task-generator.
- `packages/sdk/src/contracts.ts` — registry of SolverNet contracts; `SESSION_DERIVED_V1_SOLVER_NET_CONTRACT` lands here.
- `client/ARCHITECTURE.md` — task lifecycle and extension points (the integrating narrative).
- `spec/2026-04-30-phase-a-umbrella.md` — Phase A.1 substrate; precondition.
- `spec/2026-04-30-plug-in-surface.md` — Phase A.2 plug-in shape; the collector is one concrete instantiation.
- `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` v0.1 — architectural sibling.
- `spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 §2 (core principles), §10 (launch state machine), §11 (generator-launcher boundary).
- GH#103 — pooled-shadow-eval-sidecar; this spec locks Q1, Q2, Q4 and explicitly defers Q3, Q5.
- GH#59 — knowledge-market roadmap.
- GH#57 — paired GTM.
- OpenTelemetry SDK Node: <https://github.com/open-telemetry/opentelemetry-js> — the receiver + processor stack this spec embeds.
- OpenTelemetry GenAI semantic conventions (Development): <https://opentelemetry.io/docs/specs/semconv/gen-ai/> — the standards-track attributes (`gen_ai.system`, `gen_ai.request.model`, model + agent spans) this spec aligns to. Status: experimental as of 2026-05; canonical "session" abstraction not yet stable.
- OpenLLMetry / Traceloop: <https://github.com/traceloop/openllmetry> — closest prior-art shape (OTel-shaped agent telemetry across 15+ LLM SDKs + LangChain / LlamaIndex / LangGraph / CrewAI / Haystack frameworks). Cited in §2.4 layer 2.
- SWE-agent trajectory format: <https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/trajectories.md> — the de-facto agent submission format that `jinn.trajectory.v1` interops with per §3.3.
- SWE-bench experiments repo: <https://github.com/swe-bench/experiments> — predictions, execution logs, trajectories from inference + evaluation runs. Reference for the eval-side trajectory consumption pattern.
- LiteLLM observability: <https://docs.litellm.ai/docs/observability> — proxy-based LLM-API capture pattern (§2.4 layer 1; §4.2 path C precedent).
- Aider analytics + history files: <https://aider.chat/docs/more/analytics.html> — `--analytics-log <path>.jsonl` and `.aider.{chat.history.md,input.history,llm.history}` (§4.2 path B for Aider).
- Continue dev_data: <https://docs.continue.dev/customize/deep-dives/development-data> — `.continue/dev_data/` JSONL events; configurable HTTP forward via `data:` block (§4.2 path B for Continue).
- Cursor hooks (1.7+): `~/.cursor/hooks.json` — `stop` / `sessionEnd` triggers (§4.2 path D for Cursor).
