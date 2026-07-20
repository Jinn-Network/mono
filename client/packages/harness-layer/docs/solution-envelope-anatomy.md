# Solution-envelope anatomy — where everything actually lives

One page for the question that cost a day (2026-07-08): **where is the solver's
decision path?** The raw harness transcript is in the `system_snapshot`
artifact. Current live capture also parses supported transcripts into the
solution's `trajectory`; historical solutions may have only packaging spans
there. This maps every part of a `role: 'solution'` `jinn.execution.v1`
envelope to what it actually holds.

## Top level

| Field | What it holds |
|---|---|
| `schemaVersion` | `jinn.execution.v1` |
| `role` | `solution` (closed enum: `solution` / `verdict` / `capture`) |
| `solverType` | e.g. `swe-rebench-v2.v1` |
| `task` | `{ cid, requestId, onchainCreationBlock/Tx }` — `task.cid` → the task doc (problem statement and authenticated task facts). A task `restorationRequestId`, when present, is only a consistency assertion; it never selects the verdict's solution. |
| `payload` | The typed SolverType payload. For swe-rebench: `{ patch, schemaVersion }` — **the coding diff, public** |
| `executor` | Provenance: `implName`/`implVersion` (which harness: `claude-code`, `codex`, `hermes-agent`), `model`, `codeDigest`, plugins, signing key |
| `participant` | `agentEoa` + `safeAddress` (publisher-written; the on-chain-derived identity is the discovery hit's `operator.agentId`) |
| `evidenceTier` / `attestation` | `committed` / `null` today (attested tier unwired — #1430) |
| `trajectory` | Ref to the `jinn.trajectory.v1` doc — **see the warning below** |
| `artifacts[]` | The uploaded artifacts — the raw harness transcript is in the `system_snapshot` entry |
| `signature` / `window` / `generatedAt` | Envelope signature + solve window |

## `trajectory`: historical versus current capture

The `jinn.trajectory.v1` doc is reachable via `trajectory.sources[0].cid` (a
donation wrapper), or directly via any artifact's
`metadata.producedBy.trajectoryCid`.

- **Historical / pre-#1473 solutions.** The live sample surveyed on 2026-07-08
  had exactly two `jinn.artifact.emit` spans: packaging bookkeeping for the two
  uploaded artifacts. Those trajectories did not contain the harness decision
  path.
- **Current live solutions.** #1473 is closed. During `pack()`, the engine calls
  `addTranscriptSpans()` before artifact upload. Supported Claude, Codex, and
  Hermes transcripts become typed `jinn.agent_turn` / `jinn.tool_call` spans,
  followed by the packaging spans in the same trajectory. Missing,
  unsupported, or unparseable transcripts degrade without failing publication,
  so consumers must still tolerate a trajectory with no transcript-derived
  spans.

The snapshot remains the raw transcript archive and the recovery source for
historical evidence; the trajectory is the scrubbed typed projection used by
current live capture.

## Where the raw transcript lives: `artifacts[]` → `system_snapshot`

Each `artifacts[]` entry: `{ artifactType, sha256, access, metadata,
sources: [{ kind: 'ipfs', cid, sha256, encoding: 'jinn.artifact.donation.v1' }] }`.
A solution carries two:

1. **`swe-rebench-v2_v1_solution`** — the typed solution payload again
   (donation-wrapped JSON; same patch as `payload.patch`).
2. **`system_snapshot`** — a scrubbed snapshot of the solve working dir:
   donation wrapper (JSON with base64 `data`) → **gzip** → **POSIX ustar tar**
   (hand-rolled writer, `client/src/harnesses/engine/packaging.ts`). Inside:

   | Entry | Content |
   |---|---|
   | `.claude-code/stdout.jsonl` | **The full claude-code session** — `--output-format stream-json` records (assistant text + tool_use + tool_result), the solve's actual decision path (~100KB+) |
   | `.codex-code/stdout.jsonl` | **The full codex session** — direct `codex exec --json` lifecycle records (`thread.started`, `turn.started`, `item.started` / `item.completed`, `turn.completed`); messages are `agent_message` items and shell activity is `command_execution` |
   | `.hermes-agent/session.json` | The finished Hermes session in OpenAI message/tool-call shape; current live capture parses it into typed trajectory spans |
   | `.hermes-agent/stdout.log` | Hermes process output; legacy snapshots may contain only this shallow log |
   | `.execute/solution-payload.json`, `task.json` | The payload + the task the agent was given |
   | (codex runs) `.agents/`, `plugins/` | Installed skills/plugins present in the workdir |

   Content is scrubbed at tar-build time (`scrubArtifactBytes` — identity,
   path → `/users/anon/…`, credential redaction), and dirs like `repo/`,
   `.git/`, `node_modules/` are excluded entirely.

## Reading it in code

`client/packages/harness-layer/src/snapshot-transcript.ts` — donation unwrap
(sha256-verified) + bomb-guarded gunzip + ustar reader +
`findSolveTranscript`. `parseSolveTranscript` feeds the transcript bytes to
the canonical Claude/Codex stdout parsers exported by
`@jinn-network/core/trajectory`, producing the same typed
`jinn.agent_turn` / `jinn.tool_call` spans used by the live path. The bridge's
evidence fetcher (`bridge-fetch-evidence.ts`, hop 4) wires them together;
evidence with no usable transcript is tagged `patch-only`.

## Secure verdict → solution selection

The bridge never selects a solution from a task document's
`restorationRequestId`. `bridge-fetch-evidence.ts` starts from the
chain-scoped verdict row, which authoritatively supplies
`(taskId, attemptIndex, evaluator)`, then reads the exact chain attempt row to
obtain the solve request ID. Only bounded solution metadata candidates bound
to that request, the historical operator, and the authenticated envelope hash
can be selected. Mutable and signed task copies may carry a
`restorationRequestId`; if present, it must equal the chain-derived solve
request ID or the bridge rejects the evidence. It is an assertion, never a
join key.

Note the format trap: the older parsers under
`@jinn-network/core/trajectory`'s `transcript-parsers/` directory target the
tools' **home-dir** session formats. In particular, timestamped
`response_item` envelopes are Codex home-session records, not current direct
`codex exec --json` stdout. The sibling `transcript-to-spans/` parsers target
captured stdout; the Codex parser also retains home-envelope compatibility for
older snapshots.
