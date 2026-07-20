# Layer-1 trace envelope — `jinn.trace-envelope.v0`

- **Status:** v0 — FROZEN on operator sign-off (spec Q1). Any change after
  sign-off is a spec amendment to `spec/2026-07-02-jinn-harness-network.md`.
- **Schema:** `client/packages/harness-layer/src/envelope.ts` (`TraceEnvelopeV0Schema`)
- **Spec:** `spec/2026-07-02-jinn-harness-network.md` §5 (the deal), §6.1 (earn),
  §7 (seeding)
- **Plan:** `docs/superpowers/plans/2026-07-02-jinn-harness-network-v0-plan.md` Task 2

## What this is

The layer-1 **evidence** envelope: the scrubbed task trace a harness publishes
to the corpus when a user completes (or fails) a task with contribution
consent on. It is what contributors emit; it is *not* what harnesses retrieve
(layer-2 consumables are distilled from these, SKILL.md-compatible, with
provenance links back here).

The schema is **closed**: unknown fields are rejected. This is deliberate —
the envelope freezes at v0 sign-off, and a closed schema means nothing can be
smuggled into published traces (or silently depended on by consumers) without
a spec amendment. Everything a downstream reader can see is on this page.

Three properties are enforced at the type level:

1. **No consent, no envelope.** The consent flags are literal `true` — an
   envelope object representing an unconsented or unscrubbed trace is not
   constructible. Fail-closed (spec §5).
2. **Bounded size.** Steps are capped in count and per-step payload size, so
   a single envelope cannot balloon the corpus or the anchor path.
3. **Scrub-aware steps.** Every step carries `redactedKeys` — the visible
   receipt of what the scrub pipeline removed, mirroring the capture-span
   shape in `client/src/store/captures.ts`.

## Who reads what

| Reader | Fields read | What breaks if the field is wrong |
|---|---|---|
| `ContributionActivityChecker` (v0.5 earn path) | `outcome.verifiabilityTier`, `consent`, `provenance` | Emissions eligibility counts the wrong contributions — the anti-farming line (spec §6.1) fails. Must filter `provenance !== 'imported'`: imported seeds are never emissions-eligible, else seed imports are farmable |
| Distribution signal surface (plan Task 7) | `task.distributionTags`, `provenance` | Deepening decisions steer toward noise; seeds pollute the demand signal (spec §7) |
| Layer-2 promotion / distillation (network task) | `outcome`, `steps`, `task.summary` | Bad evidence gets distilled into consumables; the corpus quality gate leaks |
| Capability gate (spec §8 v1 gate) | `cost`, `environment` | "Equal quality at lower cost" cannot be measured; config-diversity metadata lost |
| Contribution ledger UI (plan Task 4) | `session`, `task.summary`, `outcome`, `consent` | The operator cannot see what left their machine — legibility, the selling point, fails |
| Server-side tag clustering (spec §5, no fixed taxonomy) | `task.distributionTags` | Clusters fragment or merge wrongly; the signal view misleads |

## Field reference

All objects at every level are strict (closed). Timestamps: `capturedAt` is
ISO-8601; step times are unix-nanosecond strings (the OTel span convention,
matching `SpanRow` in `client/src/store/captures.ts`).

### Top level

| Field | Type | Why it exists | Who reads it |
|---|---|---|---|
| `schemaVersion` | literal `"jinn.trace-envelope.v0"` | Migration gate; v1 readers reject/route on this | Every consumer |
| `session` | object | Identifies the capture session this trace came from | Ledger UI; dedup |
| `task` | object | What the user was doing — the demand signal | Signal surface; layer-2 promotion |
| `environment` | object | Config-diversity fingerprint: which harness/model/tools produced this | Capability gate; layer-2 promotion (context for replaying) |
| `steps` | array (1–512) | The compressed trace body — the evidence itself | Layer-2 distillation; human inspection via preview |
| `outcome` | object | What happened and how verified | Checker; layer-2 promotion gate |
| `cost` | object | What the task cost to run | Capability gate ("lower total cost") |
| `consent` | object | The publish gate, made visible in the data | Checker (only consented envelopes count); ledger UI |
| `provenance` | `"contributed"` \| `"imported"` | Separates earned traces from seeds | Signal surface (excludes `imported`, spec §7) |

### `session`

| Field | Type | Why / who reads it |
|---|---|---|
| `sessionId` | string (1–128) | Correlates the envelope with the local capture session; dedup key for the ledger. Wrong ⇒ double-count or orphaned ledger rows. |
| `capturedAt` | ISO-8601 datetime | When the trace was captured. Signal freshness; ledger ordering. |

### `task`

| Field | Type | Why / who reads it |
|---|---|---|
| `summary` | string (1–500) | Scrubbed one-line descriptor of what the user asked. Read by the signal view (human-readable cluster labels), layer-2 promotion, and the ledger. Wrong ⇒ the operator can't recognise their own contribution; clustering labels mislead. |
| `distributionTags` | string[] (1–16 tags, each 1–64 chars, no surrounding whitespace) | **Freeform** — no fixed taxonomy (spec §5); clustering is inferred server-side. The demand signal reads these. Wrong ⇒ deepening decisions point at the wrong distributions. At least one tag is required: an untagged envelope is invisible to the signal, and the signal is the point of contribution. |

### `environment` — the config-diversity fingerprint (spec §5)

| Field | Type | Why / who reads it |
|---|---|---|
| `harness.name` | string (1+) | Which harness produced this (e.g. `jinn-hermes`). Capability comparisons are per-harness. |
| `harness.version` | string (1+) | Reproducibility; upstream-drift analysis. |
| `model` | string (1+) | The LLM behind the trace. Capability gate compares corpus-connected vs stock *at the same model*. Wrong ⇒ the §8 capability number is meaningless. |
| `tools` | string[] (0–64, names only, each 1–128 chars) | Tool surface available during the task — names only, never tool configs or arguments (those live in steps, scrubbed). |

### `steps[]` — compressed trace steps

Mirrors the capture-span shape (`SpanRow`, `client/src/store/captures.ts`)
minus session/trace IDs (hoisted to `session`). Bounded: max **512 steps**,
max **16 KiB** of JSON-serialised `attributes` per step.

| Field | Type | Why / who reads it |
|---|---|---|
| `spanId` | string (1+) | Step identity within the trace. |
| `parentSpanId` | string \| null | Tree structure — which step spawned this one. Distillation reads the shape of the work. |
| `name` | string (1+) | What the step did (`tool:edit_file`, `llm:completion`, …). |
| `startTimeUnixNano` | digit-string | Step timing (OTel convention). |
| `endTimeUnixNano` | digit-string | Step timing. |
| `attributes` | JSON object (≤16 KiB serialised) | The scrubbed step payload — prompts, tool args, results *after* the fail-closed scrub pipeline. This is the field the scrub pipeline operates on; anything sensitive that survives here is a scrub gap, not a schema question. |
| `redactedKeys` | string[] | Which attribute keys the scrub redacted — the visible receipt. The preview UI (plan Task 3) renders these; an operator auditing "what left my machine" reads them. |
| `truncatedKeys` | string[] (optional) | Which attribute keys the pipeline truncated to fit the 16 KiB cap; the visible receipt, sibling to `redactedKeys`. The preview UI renders these; an operator auditing "what left my machine" reads them. |

### `outcome`

| Field | Type | Why / who reads it |
|---|---|---|
| `status` | `"completed"` \| `"failed"` \| `"abandoned"` | What happened. Failed traces are contributions too — negative evidence has distillation value. Layer-2 promotion reads this. |
| `verifiabilityTier` | `"user-accepted"` \| `"tests-passed"` \| `"evaluator-verified"` | **How the status was established**, in increasing strength (spec §5). The `ContributionActivityChecker` counts against this tier — it is the anti-farming line: only sufficiently-verified contributions become emissions-eligible. Wrong ⇒ farmable emissions. The tier qualifies the *status*, so a failed task still carries a tier (e.g. `user-accepted`: the user confirmed it failed). |
| `summary` | string (≤500, optional) | Human-readable outcome note for the ledger and promotion review. |

Tier ordering is exported as `VERIFIABILITY_TIERS` (weakest → strongest) so
the checker and promotion gate compare tiers consistently.

### `cost`

| Field | Type | Why / who reads it |
|---|---|---|
| `durationMs` | int ≥ 0 | Wall-clock task duration. Capability gate. |
| `tokens` | `{ input: int ≥ 0, output: int ≥ 0 }` (optional) | Token spend when the harness can report it. Optional because not every harness/model surfaces counts. |
| `usdEstimate` | decimal string, optional | Estimated spend. String, not float — money is never IEEE-754. Optional: an estimate, clearly named as such. |

### `consent` — the publish gate (spec §5)

Both flags are **literal `true`**. A trace without consent, or that skipped
the scrub, does not fail politely — the envelope cannot be constructed. This
is the fail-closed rule made structural.

| Field | Type | Why / who reads it |
|---|---|---|
| `contributionConsent` | `true` | First-run consent given AND no per-task veto on this trace. The checker and any auditor can see, in the published data, that consent was asserted. |
| `scrubCompleted` | `true` | The mandatory scrub pipeline (key-policy → openredaction → secretlint → ML PII) completed on this trace. No scrub, no publish. |

### `provenance`

`"contributed"` (a real user trace) or `"imported"` (a seed, e.g. skills.sh —
spec §7). Seeds provide day-one usefulness but are **excluded from the demand
signal**; the signal surface filters on this field. Wrong ⇒ deepening
decisions read imports as demand.

The `ContributionActivityChecker` must **also** filter on this field:
`provenance !== 'imported'`. Imported seeds are never emissions-eligible —
otherwise seed imports are emissions-farmable (anti-farming, 2026-07-02
schema review, Q1).

## Size limits (exported constants)

| Constant | Value | Rejects |
|---|---|---|
| `MAX_STEPS` | 512 | Envelopes with more steps |
| `MAX_STEP_ATTRIBUTES_BYTES` | 16 384 | Any step whose serialised `attributes` exceed 16 KiB |
| `MAX_DISTRIBUTION_TAGS` | 16 | Tag spam |

**Fitting rule.** The caps bound the *output* of the capture→envelope
conversion, not raw captures. The pipeline (plan Task 3) MUST produce fitting
envelopes: oversized `attributes` are truncated with the cut keys listed in
`truncatedKeys`, and over-long sessions are summarised or head/tail-sampled
rather than dropped — silent truncation is forbidden. Measured against 3,302
real captured sessions (2026-07-02), 45% contain at least one span over
16 KiB and 0.6% exceed 512 steps, so construct-or-reject on raw spans was
untenable.

## Example envelopes

Three realistic examples. Each is validated against the schema in CI
(`test/envelope.test.ts` extracts every ` ```json ` block from this document
and parses it), so the doc cannot drift from the code. All three are scrubbed:
no usernames in paths, no keys, no PII — this is what an operator should be
comfortable seeing published from their own machine.

### 1. A coding task (completed, tests-passed)

```json
{
  "schemaVersion": "jinn.trace-envelope.v0",
  "session": {
    "sessionId": "9f2c1e4a-7b3d-4e8f-a1c2-d5e6f7a8b9c0",
    "capturedAt": "2026-07-02T10:41:22.000Z"
  },
  "task": {
    "summary": "Fix failing vitest suite after zod v4 upgrade: strict object rejections in config loader tests",
    "distributionTags": ["typescript", "testing", "vitest", "dependency-upgrade"]
  },
  "environment": {
    "harness": { "name": "jinn-hermes", "version": "0.3.1" },
    "model": "claude-sonnet-4-6",
    "tools": ["read_file", "edit_file", "run_command", "corpus_search"]
  },
  "steps": [
    {
      "spanId": "s-001",
      "parentSpanId": null,
      "name": "llm:plan",
      "startTimeUnixNano": "1751452882000000000",
      "endTimeUnixNano": "1751452889000000000",
      "attributes": {
        "prompt.summary": "Diagnose 3 failing tests in config.test.ts after zod 3->4 bump",
        "response.summary": "Failures are strictObject unknown-key rejections; plan: align fixtures with new schema defaults"
      },
      "redactedKeys": []
    },
    {
      "spanId": "s-002",
      "parentSpanId": "s-001",
      "name": "tool:run_command",
      "startTimeUnixNano": "1751452890000000000",
      "endTimeUnixNano": "1751452905000000000",
      "attributes": {
        "command": "yarn vitest run test/config.test.ts",
        "exitCode": 1,
        "stdout.tail": "3 failed | 41 passed",
        "cwd": "[REDACTED]"
      },
      "redactedKeys": ["cwd"]
    },
    {
      "spanId": "s-003",
      "parentSpanId": "s-001",
      "name": "tool:edit_file",
      "startTimeUnixNano": "1751452906000000000",
      "endTimeUnixNano": "1751452911000000000",
      "attributes": {
        "file": "test/config.test.ts",
        "diff.summary": "Removed legacy passthrough keys from three fixtures; added explicit defaults"
      },
      "redactedKeys": []
    },
    {
      "spanId": "s-004",
      "parentSpanId": "s-001",
      "name": "tool:run_command",
      "startTimeUnixNano": "1751452912000000000",
      "endTimeUnixNano": "1751452930000000000",
      "attributes": {
        "command": "yarn vitest run test/config.test.ts",
        "exitCode": 0,
        "stdout.tail": "44 passed",
        "cwd": "[REDACTED]"
      },
      "redactedKeys": ["cwd"]
    }
  ],
  "outcome": {
    "status": "completed",
    "verifiabilityTier": "tests-passed",
    "summary": "All 44 tests pass after fixture alignment"
  },
  "cost": {
    "durationMs": 48000,
    "tokens": { "input": 18432, "output": 2210 },
    "usdEstimate": "0.09"
  },
  "consent": {
    "contributionConsent": true,
    "scrubCompleted": true
  },
  "provenance": "contributed"
}
```

### 2. A research task (completed, user-accepted)

```json
{
  "schemaVersion": "jinn.trace-envelope.v0",
  "session": {
    "sessionId": "3a8b0d5e-2c4f-4a6b-8d0e-1f2a3b4c5d6e",
    "capturedAt": "2026-07-02T14:07:03.000Z"
  },
  "task": {
    "summary": "Compare free Base Sepolia RPC providers on getLogs block-range limits and rate limits; produce a ranked table",
    "distributionTags": ["research", "blockchain-infra", "rpc-providers", "base"]
  },
  "environment": {
    "harness": { "name": "jinn-hermes", "version": "0.3.1" },
    "model": "claude-haiku-4-5-20251001",
    "tools": ["web_search", "web_fetch", "corpus_search"]
  },
  "steps": [
    {
      "spanId": "s-001",
      "parentSpanId": null,
      "name": "tool:corpus_search",
      "startTimeUnixNano": "1751465223000000000",
      "endTimeUnixNano": "1751465226000000000",
      "attributes": {
        "query": "base sepolia rpc getLogs limits",
        "hits": 2
      },
      "redactedKeys": []
    },
    {
      "spanId": "s-002",
      "parentSpanId": null,
      "name": "tool:web_search",
      "startTimeUnixNano": "1751465227000000000",
      "endTimeUnixNano": "1751465241000000000",
      "attributes": {
        "query": "publicnode base sepolia eth_getLogs block range limit",
        "results.count": 8
      },
      "redactedKeys": []
    },
    {
      "spanId": "s-003",
      "parentSpanId": null,
      "name": "llm:synthesis",
      "startTimeUnixNano": "1751465242000000000",
      "endTimeUnixNano": "1751465260000000000",
      "attributes": {
        "response.summary": "Ranked 5 providers: publicnode (50k blocks, no auth) first; sepolia.base.org (2k blocks) last-resort; table with limits and caveats delivered"
      },
      "redactedKeys": []
    }
  ],
  "outcome": {
    "status": "completed",
    "verifiabilityTier": "user-accepted",
    "summary": "User accepted the comparison table"
  },
  "cost": {
    "durationMs": 37000,
    "tokens": { "input": 9120, "output": 1480 }
  },
  "consent": {
    "contributionConsent": true,
    "scrubCompleted": true
  },
  "provenance": "contributed"
}
```

### 3. A failed task (failed, user-accepted)

```json
{
  "schemaVersion": "jinn.trace-envelope.v0",
  "session": {
    "sessionId": "b7c8d9e0-1a2b-4c3d-9e5f-6a7b8c9d0e1f",
    "capturedAt": "2026-07-02T16:33:47.000Z"
  },
  "task": {
    "summary": "Migrate a Hardhat deploy script to viem; blocked by an ethers v5 peer-dependency conflict in a plugin",
    "distributionTags": ["typescript", "solidity-tooling", "migration", "viem"]
  },
  "environment": {
    "harness": { "name": "jinn-hermes", "version": "0.3.1" },
    "model": "claude-sonnet-4-6",
    "tools": ["read_file", "edit_file", "run_command"]
  },
  "steps": [
    {
      "spanId": "s-001",
      "parentSpanId": null,
      "name": "tool:run_command",
      "startTimeUnixNano": "1751474027000000000",
      "endTimeUnixNano": "1751474049000000000",
      "attributes": {
        "command": "yarn add viem && yarn hardhat compile",
        "exitCode": 1,
        "stderr.tail": "error hardhat-deploy@0.11.x requires ethers@^5; found ethers@6",
        "cwd": "[REDACTED]"
      },
      "redactedKeys": ["cwd"]
    },
    {
      "spanId": "s-002",
      "parentSpanId": null,
      "name": "llm:diagnosis",
      "startTimeUnixNano": "1751474050000000000",
      "endTimeUnixNano": "1751474061000000000",
      "attributes": {
        "response.summary": "hardhat-deploy pins ethers v5; migration needs plugin replacement or resolutions override — both out of scope for this task"
      },
      "redactedKeys": []
    }
  ],
  "outcome": {
    "status": "failed",
    "verifiabilityTier": "user-accepted",
    "summary": "User confirmed failure: peer-dependency conflict makes the direct migration path unviable without plugin replacement"
  },
  "cost": {
    "durationMs": 41000,
    "tokens": { "input": 12050, "output": 980 }
  },
  "consent": {
    "contributionConsent": true,
    "scrubCompleted": true
  },
  "provenance": "contributed"
}
```

## Judgement calls made at v0 (review these)

Fields where the plan/spec left room and a decision was made — exactly what
sign-off should confirm or overturn:

1. **`provenance` lives on the layer-1 envelope** (`contributed` | `imported`).
   Spec §5 says seeds land directly at layer 2, which would make this field
   redundant here — but plan Task 6 routes seed imports through the Task-4
   publish path, and Task 7's seed-exclusion test needs a field to filter on.
   Carrying it at layer 1 keeps one publish path and one filter.
2. **`distributionTags` requires ≥ 1 tag.** An untagged envelope is invisible
   to the demand signal, and the signal is the point of contribution. Risk:
   forcing tags can produce junk tags; the harness auto-infers them, so the
   floor seemed safe.
3. **Consent flags are literal `true`**, not booleans. Fail-closed made
   structural: a `consent: { contributionConsent: false }` envelope is a
   contradiction (vetoed traces never publish), so the type forbids it.
4. **Step shape mirrors `SpanRow`** (unix-nano strings, `attributes` +
   `redactedKeys`) rather than inventing a new step format — the capture
   pipeline already emits this shape, so Task 3 wraps rather than translates.
5. **Size caps:** 512 steps / 16 KiB per-step attributes / 16 tags. Chosen to
   comfortably hold real agent sessions while keeping envelopes anchorable and
   cheap to fetch; no empirical basis yet — revisit with contribution data
   (as a spec amendment, post-freeze).
6. **`cost.tokens` and `cost.usdEstimate` are optional**; `durationMs` is
   required. Not every harness can report token counts; every harness can
   report wall-clock.
7. **`outcome.status` enum is `completed | failed | abandoned`.** The spec
   says "outcome with a verifiability tier" without enumerating statuses;
   `abandoned` (user walked away mid-task) is distinguished from `failed`
   (task ran to a negative result) because they distill differently.

**2026-07-02 schema review:** calls 1–7 were reviewed and confirmed, with #5
amended — the caps now bound the compressed *output* of the capture→envelope
pipeline (see Fitting rule above), with `truncatedKeys` as the visible
truncation receipt. Two consequences of #1 are recorded above: the
`ContributionActivityChecker` must exclude `provenance: 'imported'` from
emissions counting, and spec §5 notes that seeds transit layer 1 with
`provenance: imported` rather than landing directly at layer 2.
