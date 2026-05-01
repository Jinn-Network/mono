# Path 1 slot reference

The plug-in surface inside `claude-code-learner` decomposes into six mechanical shapes. Each shape has a fixed material form (markdown vs MCP server vs shell), a fixed integration point in the seven-phase pipeline, and fixed inputs/outputs.

The taxonomy below is the canonical surface; see `spec/2026-04-30-plug-in-surface.md` §4.2 for the spec and §4.5 for a translation table mapping these shapes to the layer vocabulary used in #57.

## Summary table

| Slot | Material | Integration point |
|---|---|---|
| [phase-agent-override](#phase-agent-override) | `agents/<name>.md` | Replaces a bundled phase agent for declared kinds. |
| [topic-explorer](#topic-explorer) | `agents/<name>.md` | Adds a topic to Orient or Debrief. |
| [mcp-tool](#mcp-tool) | Standalone MCP server | Tools available to all phase agents. |
| [skill-bundle](#skill-bundle) | `skills/<name>/SKILL.md` files | Loaded into the harness's `Skill` tool. |
| [memory-backend](#memory-backend) | MCP server (memory protocol) | Augments the consolidator's storage. |
| [hook](#hook) | Shell script or Node executable | Runs at lifecycle events. |

## Cross-cutting constraints

Every slot inherits these constraints. These are the rules that make Path 1 trust the operator-only surface (see `spec/2026-04-30-plug-in-surface.md` §4.3):

- **No widening of the daemon's capability surface.** A slot cannot introduce a new RPC endpoint that bypasses `ctx.rpc`, a new signer, or a new filesystem-write target outside `implStateDir/**` and `workingDir/**`. Builders who need new daemon-level capabilities ship Path 2.
- **MCP tool slots are the documented exception** — an MCP server runs in its own process and exposes whatever surface the operator vouched for at install time.
- **No nesting of subagents from inside a spawned subagent.** The phase pattern is one-level-deep; slot agents inherit this constraint.
- **No mutation of the strategy artifact's frozen success criteria + timing posture mid-run.** The constitutional snapshot is immutable after Strategize.

---

## phase-agent-override

**Material shape.** A markdown agent file with frontmatter at `agents/<name>.md`.

**Integration point.** Replaces (or augments) one of the six bundled phase agents — `strategist`, `planner`, `step-worker`, `analyst`, `promoter`, `consolidator` — for declared kinds. The phase enum: `strategize`, `plan`, `execute`, `debrief`, `improve`, `memory-consolidation`.

**Inputs.** The phase-skill spawn prompt + a `RestorationContext` slice (the intent, working dir, impl state dir).

**Outputs.** A phase artifact under `workingDir/.<phase>/`. Schema is whatever the bundled agent for that role produces; overrides MUST conform.

**Capability constraints.** Frontmatter declares the tools the agent uses; the harness inherits its existing capability surface. No widening.

**Anchor example.** [`examples/learner-plug-ins/@jinn-examples/calibration-refiner`](../../../examples/learner-plug-ins/@jinn-examples/calibration-refiner) — isotonic-calibration step-worker for `prediction.v0`. Walkthrough at [examples/phase-agent-override.md](./examples/phase-agent-override.md).

---

## topic-explorer

**Material shape.** A markdown agent file at `agents/<name>.md`, plus a topic registration in `jinn-plugin.json`.

**Integration point.** Adds a new topic to Orient and/or Debrief's fan-out. Phase enum: `orient`, `debrief`.

**Inputs.** Topic name + scope predicate + the intent.

**Outputs.** `workingDir/.<phase>/<topic>.json` for the next phase to consume (Strategize for Orient topics; Improve for Debrief topics).

**Capability constraints.** Same as phase-agent-override. Topic explorers commonly compose with `mcp-tool` slots in the same package — bundle them via multiple `slots[]` entries.

**Anchor example.** [`examples/learner-plug-ins/@jinn-examples/news-context-topic`](../../../examples/learner-plug-ins/@jinn-examples/news-context-topic) — `news-context` topic in Orient for `prediction.v0`. Walkthrough at [examples/topic-explorer.md](./examples/topic-explorer.md).

---

## mcp-tool

**Material shape.** A standalone MCP server (any language; typically TypeScript + `@modelcontextprotocol/sdk`). The package declares the server's spawn command + args in `jinn-plugin.json`.

**Integration point.** The harness loads the MCP server at session start and registers its tools with all phase agents.

**Inputs.** MCP tool calls — JSON-RPC messages dispatched by the harness's MCP client.

**Outputs.** MCP tool responses.

**Capability constraints.** MCP tool slots are the explicit exception to the no-widening rule: the MCP server runs in its own process with whatever the OS grants it. The operator vouched by installing it. Operators with stricter requirements run an MCP allow-list at the harness's MCP-client level.

**Anchor example.** [`examples/learner-plug-ins/@jinn-examples/polymarket-mcp`](../../../examples/learner-plug-ins/@jinn-examples/polymarket-mcp) — Polymarket market-state + resolution tools. Walkthrough at [examples/mcp-tool.md](./examples/mcp-tool.md).

---

## skill-bundle

**Material shape.** A directory of `skills/<name>/SKILL.md` files with frontmatter and prompt bodies. The package declares the `skillsDir` in `jinn-plugin.json`.

**Integration point.** Skills register with the harness's `Skill` tool index at session start. Phase agents invoke a skill via `Skill <bundle-name>:<skill-name>`.

**Inputs.** A skill invocation prompt from any phase agent.

**Outputs.** The skill's response, returned in-session.

**Capability constraints.** Skills run in the calling agent's context; they inherit its tool surface and cannot add new tools.

**Anchor example.** [`examples/learner-plug-ins/@jinn-examples/forecasting-techniques`](../../../examples/learner-plug-ins/@jinn-examples/forecasting-techniques) — three skills (reference-class forecasting, base-rates, calibration). Walkthrough at [examples/skill-bundle.md](./examples/skill-bundle.md).

---

## memory-backend

**Material shape.** An MCP server implementing the memory-backend tool surface (embed / query / prune). The package declares the server's spawn command + args in `jinn-plugin.json`.

**Integration point.** The bundled consolidator agent calls the memory backend's tools when curating prior debrief artifacts and when retrieving analogous cases for future Orient passes.

**Inputs.** Per-attempt artifacts + curation policy from the consolidator.

**Outputs.** Mutations to `implStateDir/memory/<backend>/`. Index state owned by the backend.

**Capability constraints.** This is the slot category with the largest implicit capability surface — a hosted vector store needs network egress. The host-inheritance trust model still holds: the operator vouched by installing. Operators with stricter controls run a local backend (FAISS) instead.

**Anchor example.** [`examples/learner-plug-ins/@jinn-examples/vector-store-memory`](../../../examples/learner-plug-ins/@jinn-examples/vector-store-memory) — vector-store consolidator. Walkthrough at [examples/memory-backend.md](./examples/memory-backend.md).

---

## hook

**Material shape.** A shell script or Node executable. The package declares the event + (optional) phase + entry path in `jinn-plugin.json`.

**Integration point.** The harness invokes the hook at the declared event. Event enum: `session-start`, `pre-phase`, `post-phase`, `session-end`. For `pre-phase` and `post-phase`, the `phase` field narrows to one of the seven phases.

**Inputs.** Phase + context environment variables (working dir, impl state dir, intent ID).

**Outputs.** Side effects (filesystem writes under `workingDir/**`, network fetches) + an exit code. Non-zero exit codes log a warning but do not abort the session.

**Capability constraints.** Hooks run as separate processes with the daemon's user-level capabilities. Same trust posture as MCP tools — the operator vouched by installing.

**Anchor example.** [`examples/learner-plug-ins/@jinn-examples/prefetch-markets-hook`](../../../examples/learner-plug-ins/@jinn-examples/prefetch-markets-hook) — pre-orient market-state pre-fetch. Walkthrough at [examples/hook.md](./examples/hook.md).
