# Solution-envelope anatomy — where everything actually lives

One page for the question that cost a day (2026-07-08): **where is the solver's
reasoning?** Answer: inside the `system_snapshot` artifact — NOT in the field
named `trajectory`. This maps every part of a `role: 'solution'`
`jinn.execution.v1` envelope to what it actually holds, so nobody has to
rediscover it by decompressing binary blobs.

## Top level

| Field | What it holds |
|---|---|
| `schemaVersion` | `jinn.execution.v1` |
| `role` | `solution` (closed enum: `solution` / `verdict` / `capture`) |
| `solverType` | e.g. `swe-rebench-v2.v1` |
| `task` | `{ cid, requestId, onchainCreationBlock/Tx }` — `task.cid` → the task doc (problem statement, `restorationRequestId` for the verdict→solution join) |
| `payload` | The typed SolverType payload. For swe-rebench: `{ patch, schemaVersion }` — **the coding diff, public** |
| `executor` | Provenance: `implName`/`implVersion` (which harness: `claude-code`, `codex`, `hermes-agent`), `model`, `codeDigest`, plugins, signing key |
| `participant` | `agentEoa` + `safeAddress` (publisher-written; the on-chain-derived identity is the discovery hit's `operator.agentId`) |
| `evidenceTier` / `attestation` | `committed` / `null` today (attested tier unwired — #1430) |
| `trajectory` | Ref to the `jinn.trajectory.v1` doc — **see the warning below** |
| `artifacts[]` | The uploaded artifacts — **the reasoning is in here** |
| `signature` / `window` / `generatedAt` | Envelope signature + solve window |

## ⚠️ `trajectory` does NOT contain the reasoning

The `jinn.trajectory.v1` doc (reachable via `trajectory.sources[0].cid` — a
donation *wrapper*; or directly via any artifact's
`metadata.producedBy.trajectoryCid`) contains exactly **2
`jinn.artifact.emit` spans** — the packaging step's bookkeeping for the two
uploaded artifacts. No harness routes its LLM/tool activity into the
collector, so no reasoning spans exist. This holds for every solution, every
coding harness (surveyed live 2026-07-08: claude-code, codex, hermes — all
2-span). Making the trajectory truthful at solve time is **#1473**.

## Where the reasoning actually lives: `artifacts[]` → `system_snapshot`

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
   | `.hermes-agent/stdout.log` | Hermes: ~1KB plain text — no decision path |
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

Note the format trap: the older parsers under
`@jinn-network/core/trajectory`'s `transcript-parsers/` directory target the
tools' **home-dir** session formats. In particular, timestamped
`response_item` envelopes are Codex home-session records, not current direct
`codex exec --json` stdout. The sibling `transcript-to-spans/` parsers target
captured stdout; the Codex parser also retains home-envelope compatibility for
older snapshots.
