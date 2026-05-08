# Telemetry collector + session-derived SolverNet implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the telemetry collector (four-path capture surface: native OTel + transcript-file tail + LLM-API proxy + Stop-hook trigger) producing `role='capture'` envelopes signed and published to the corpus, plus the `session-derived.v0` SolverNet contract + task-generator that distils captures into atomic Tasks. Acceptance: a captured Claude Code session traverses the daemon → operator review → IPFS pin → corpus index → distilled-Task post on testnet.

**Architecture:** One `jinn-client` daemon embedding (a) an OpenTelemetry OTLP receiver on `:4317`/`:4318`, (b) per-tool transcript-file watchers with parsers translating to synthetic OTel spans, (c) an opt-in LLM-API proxy on a configurable port, (d) a `jinn-stop-hook` binary as session-end trigger. All four feed one OTel SDK processor stack (identity scrub, path scrub, credential scrub, manifest builder, SQLite exporter) into a pending-captures queue. Operator approves in a new Captures tab; daemon assembles a `jinn.execution.v1` envelope with `role='capture'`, full `executor` provenance (mirroring solver Solutions), and a `harness-bundle.v1` artifact. The `session-derived` SolverNet is one consumer: a launcher polls the corpus, LLM-distils captures into Tasks via JinnRouter, evaluators score Solutions with a composite (test-suite + structural-similarity + LLM-judge) verdict.

**Tech Stack:** TypeScript / Node 22, vitest, better-sqlite3, hono, viem, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/exporter-trace-otlp-http`, chokidar (file watchers), zod, the existing trajectory/scrub/envelope/x402/corpus stack from Phase A.1. Tests run via `yarn test` from `client/`. Typecheck via `yarn typecheck`. End-to-end on Anvil fork via a new `yarn e2e:capture` and the existing `yarn e2e`.

**Source spec:** [`spec/2026-05-07-telemetry-collector-and-task-generator.md`](../../../spec/2026-05-07-telemetry-collector-and-task-generator.md). Read §1, §3, §4, §5, §6, §8.2 before starting — every phase's exit criteria trace back to the §8.2 acceptance list.

**Preconditions (must be true before Phase 0 starts):**

- **Phase A.1 has landed.** The corpus library (`client/src/corpus/`), x402 dynamic-price handler, and `served_artifacts` / `network_artifacts` Store tables exist. Verify with `ls client/src/corpus/index.ts && grep -q 'served_artifacts' client/src/store/store.ts` — both must pass.
- **`jinn-mono-h43b` has landed or co-ships.** The OpenTelemetry SDK processor stack (replacing `client/src/trajectory/secret-scrub.ts`'s pattern set with a processor) must be the in-place architecture before this plan's Phase 1 migration. Verify by reading `client/src/trajectory/collector.ts` — if it still has bespoke span scrubbing rather than `@opentelemetry/sdk-node` processors, halt and land h43b first.
- **Existing tests pass.** From `client/`: `yarn typecheck` zero errors; `yarn test` all pass; `yarn e2e` passes against an Anvil fork. If any precondition fails, this plan does not start.

**Phase boundaries = PR boundaries.** Each phase is one PR. Within a phase, commit after every passing test. Each phase has explicit exit criteria; the next phase does not start until the prior phase's PR has merged to main and CI is green.

---

## File map

This plan creates and modifies:

```
# ── Phase 0: schema + scaffolding ──────────────────────────────────
client/src/types/envelope.ts                             (MODIFY) +'capture' role; conditional taskProvenance/sessionProvenance
client/src/types/session-provenance.ts                   (NEW) SessionProvenanceSchema
client/src/trajectory/schema.ts                          (MODIFY) +CaptureManifestSchema
client/src/trajectory/harness-bundle-schema.ts           (NEW) harness-bundle.v1 artifact schema
packages/sdk/src/contracts.ts                            (MODIFY) +SESSION_DERIVED_V1_SOLVER_NET_CONTRACT scaffold (schemas filled in Phase 9)
client/test/types/envelope-capture-role.test.ts          (NEW)
client/test/trajectory/capture-manifest.test.ts          (NEW)

# ── Phase 1: embedded OTLP receiver + processor stack ──────────────
client/src/trajectory/receiver.ts                        (NEW) gRPC + HTTP listener; SDK wiring
client/src/trajectory/processors/index.ts                (NEW)
client/src/trajectory/processors/identity-scrub.ts       (NEW) username, hostname, machine ID, git author, IP scrubs
client/src/trajectory/processors/path-scrub.ts           (NEW) $HOME → /users/anon/; absolute → relative
client/src/trajectory/processors/credential-scrub.ts     (NEW) wraps the existing secret-scrub patterns as a processor
client/src/trajectory/processors/manifest-builder.ts     (NEW) emits CaptureManifest + RedactionManifest
client/src/trajectory/processors/sqlite-exporter.ts      (NEW) writes spans into pending-captures store
client/src/trajectory/collector.ts                       (MODIFY) thin shim over the SDK
client/src/restorer/engine/engine.ts                     (MODIFY) call-site update to use SDK exporter
client/test/trajectory/receiver.test.ts                  (NEW)
client/test/trajectory/processors/*.test.ts              (NEW; one per processor)

# ── Phase 2: pending-captures store ────────────────────────────────
client/src/store/captures.ts                             (NEW) SQLite schema + queue API
client/src/store/store.ts                                (MODIFY) +pending_captures table migration
client/test/store/captures.test.ts                       (NEW)

# ── Phase 3: path B transcript watchers + parsers ──────────────────
client/src/trajectory/transcript-watcher.ts              (NEW) chokidar + SQLite WAL tail dispatcher
client/src/trajectory/synthetic-span-builder.ts          (NEW) TranscriptEvent → OTel span
client/src/trajectory/transcript-parsers/types.ts        (NEW) TranscriptEvent + TranscriptParser interface
client/src/trajectory/transcript-parsers/claude-code-jsonl.ts  (NEW)
client/src/trajectory/transcript-parsers/codex-session.ts      (NEW)
client/src/trajectory/transcript-parsers/gemini-session.ts     (NEW)
client/src/trajectory/transcript-parsers/cursor-sqlite.ts      (NEW) WAL tail
client/src/trajectory/transcript-parsers/aider-history.ts      (NEW)
client/src/trajectory/transcript-parsers/continue-devdata.ts   (NEW)
client/test/trajectory/transcript-parsers/*.test.ts            (NEW; one per parser; goldens under fixtures/)
client/test/trajectory/transcript-watcher.test.ts        (NEW)

# ── Phase 4: harness-bundle assembler ──────────────────────────────
client/src/trajectory/harness-bundle.ts                  (NEW) deterministic snapshot + hash
client/src/trajectory/harness-bundle-rules/types.ts      (NEW) SnapshotRule interface + per-tool rule registry
client/src/trajectory/harness-bundle-rules/claude-code.ts(NEW)
client/src/trajectory/harness-bundle-rules/codex.ts      (NEW)
client/src/trajectory/harness-bundle-rules/gemini.ts     (NEW)
client/src/trajectory/harness-bundle-rules/cursor.ts     (NEW)
client/src/trajectory/harness-bundle-rules/aider.ts      (NEW)
client/src/trajectory/harness-bundle-rules/continue.ts   (NEW)
client/test/trajectory/harness-bundle.test.ts            (NEW)
client/test/trajectory/harness-bundle-rules/*.test.ts    (NEW)

# ── Phase 5: path C LLM-API proxy ──────────────────────────────────
client/src/trajectory/llm-proxy.ts                       (NEW) Anthropic + OpenAI shape forward proxy
client/src/trajectory/llm-proxy-spans.ts                 (NEW) request/response → synthetic spans
client/src/config.ts                                     (MODIFY) +captures.llmProxy.{enabled,port}
client/test/trajectory/llm-proxy.test.ts                 (NEW)

# ── Phase 6: path D Stop hook ──────────────────────────────────────
client/bin/jinn-stop-hook.ts                             (NEW) stdin reader + normaliser
client/src/api/stop-hook.ts                              (NEW) daemon endpoint
client/scripts/install-hooks/claude-code.ts              (NEW) idempotent settings.json patch
client/scripts/install-hooks/codex.ts                    (NEW)
client/scripts/install-hooks/gemini-cli.ts               (NEW)
client/scripts/install-hooks/cursor.ts                   (NEW) hooks.json patch
client/test/api/stop-hook.test.ts                        (NEW)
client/test/bin/jinn-stop-hook.test.ts                   (NEW)

# ── Phase 7: Captures tab UI ───────────────────────────────────────
client/src/api/captures.ts                               (NEW) HTTP endpoints (list/approve/skip/trustRepo)
client/src/dashboard/spa/src/captures/CapturesTab.tsx    (NEW)
client/src/dashboard/spa/src/captures/CapturesList.tsx   (NEW)
client/src/dashboard/spa/src/captures/CaptureDrillIn.tsx (NEW)
client/src/dashboard/spa/src/captures/RedactionDiff.tsx  (NEW)
client/src/dashboard/spa/src/captures/HarnessIdCard.tsx  (NEW)
client/src/dashboard/spa/src/App.routing.tsx             (MODIFY) /captures route
client/src/dashboard/spa/src/App.tsx                     (MODIFY) Captures nav entry
client/src/dashboard/spa/test/captures-flow.spec.ts      (NEW Playwright)
client/test/api/captures-endpoints.test.ts               (NEW)

# ── Phase 8: capture publish path ──────────────────────────────────
client/src/captures/publish.ts                           (NEW) approve → IPFS pin + envelope assemble + setMetadata
client/src/captures/dedup.ts                             (NEW) idle-window + transcript-marker session-boundary detector
client/src/captures/rate-limit.ts                        (NEW) per-operator + per-repo rate limit
client/test/captures/publish.test.ts                     (NEW)
client/test/captures/dedup.test.ts                       (NEW)
client/test/captures/rate-limit.test.ts                  (NEW)

# ── Phase 9: subgraph indexing for captures ────────────────────────
subgraph/schema.graphql                                  (MODIFY) +CaptureEnvelope, CapturesByRepo, CapturesByOperator entities; Task.sourceCaptureCid field
subgraph/src/mappings.ts                                 (MODIFY) handleSetMetadata branch on role='capture'
subgraph/test/capture-envelope.test.ts                   (NEW)

# ── Phase 10: session-derived SolverNet contract + payloads ────────
packages/sdk/src/contracts.ts                            (MODIFY) fill SESSION_DERIVED_V1_SOLVER_NET_CONTRACT
packages/sdk/src/payloads/session-derived.ts             (NEW) Task / Solution / Verdict zod schemas
packages/sdk/src/session-derived/distill-prompt-v1.ts    (NEW) foundation reference prompt
packages/sdk/test/payloads/session-derived.test.ts       (NEW)
packages/sdk/test/session-derived/distill-prompt-v1.test.ts (NEW)

# ── Phase 11: composite evaluator ──────────────────────────────────
packages/session-derived-evaluator/package.json          (NEW)
packages/session-derived-evaluator/src/index.ts          (NEW)
packages/session-derived-evaluator/src/test-suite-rerun.ts (NEW)
packages/session-derived-evaluator/src/structural-similarity.ts (NEW)
packages/session-derived-evaluator/src/llm-judge.ts      (NEW)
packages/session-derived-evaluator/src/composite.ts      (NEW)
packages/session-derived-evaluator/test/*.test.ts        (NEW)

# ── Phase 12: task-generator ───────────────────────────────────────
client/src/solver-types/session-derived.ts               (NEW) SolverTypeDefinition
client/src/solver-types/_session-derived-pool.ts         (NEW) corpus poll + dedup
client/src/solver-types/_session-derived-distill.ts      (NEW) LLM distillation + quality gates
client/src/solver-types/_session-derived-state.ts        (NEW) generator state store
client/src/solver-types/index.ts                         (MODIFY) register session-derived
client/test/solver-types/session-derived/*.test.ts       (NEW)

# ── Phase 13: e2e + acceptance ─────────────────────────────────────
client/scripts/e2e-capture-validate.ts                   (NEW) full path: capture → publish → distil → settle
client/test/captures/full-loop.e2e.test.ts               (NEW)
client/src/cli/commands/capture.ts                       (NEW) `jinn capture import <file> [--tool <name>]`
```

---

## Phase 0 — Envelope schema additions + scaffolding

Lay down the protocol-level deltas. This phase ships independently — no daemon behaviour changes; existing solver flows (claude-code-learner, prediction-v0-baseline, etc.) untouched. Existing test suite must still pass.

**Dependencies:** Preconditions only (Phase A.1 + h43b).

**Exit criteria:**
- `jinn.execution.v1` accepts `role: 'capture'` and the `taskProvenance ↔ sessionProvenance` swap rule.
- `harness-bundle.v1` artifact type registered.
- `CaptureManifestSchema` exported from `client/src/trajectory/schema.ts`.
- `SESSION_DERIVED_V1_SOLVER_NET_CONTRACT` scaffold exported from `packages/sdk/src/contracts.ts` (schemas to be filled in Phase 10; this phase only adds the contract identity + defaults).
- `yarn typecheck` zero errors; `yarn test` all pass.

### Task 0.1: Add `'capture'` role and `sessionProvenance` to envelope schema

**Files:**
- Modify: `client/src/types/envelope.ts`
- Create: `client/src/types/session-provenance.ts`
- Test: `client/test/types/envelope-capture-role.test.ts`

- [ ] **Step 1: Write failing test for `role: 'capture'` acceptance**

Create `client/test/types/envelope-capture-role.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { UnsignedEnvelopeSchema } from '../../src/types/envelope.js';

const baseFields = {
  schemaVersion: 'jinn.execution.v1' as const,
  solverType: 'capture',
  role: 'capture' as const,
  generatedAt: 1714694400,
  participant: {
    safeAddress: '0xabc' + 'd'.repeat(37),
    agentEoa: '0xabc' + 'd'.repeat(37),
  },
  window: { startBlock: 1, endBlock: 100 },
  executor: {
    implName: 'claude-code',
    implVersion: '1.0.42',
    clientGitSha: 'abc1234',
    codeDigest: 'sha256:' + 'a'.repeat(64),
    runtimeBundleDigest: 'sha256:' + 'b'.repeat(64),
    plugins: [],
    signingKey: { kind: 'agent-eoa' as const, pubkey: '0xdead' + 'b'.repeat(36) },
    mode: 'train' as const,
  },
  evidenceTier: 'self-signed' as const,
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {},
};

describe('envelope: role=capture', () => {
  it('accepts role=capture with sessionProvenance and no task', () => {
    const env = {
      ...baseFields,
      sessionProvenance: {
        sessionId: '11111111-1111-4111-9111-111111111111',
        capturedAt: '2026-05-07T00:00:00.000Z',
        originatingTool: { name: 'claude-code', version: '1.0.42' },
        license: { operatorAssertion: 'unspecified' as const },
      },
    };
    const result = UnsignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('rejects role=capture if sessionProvenance is missing', () => {
    const env = { ...baseFields };
    const result = UnsignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(false);
  });

  it('rejects role=capture if both task and sessionProvenance are present', () => {
    const env = {
      ...baseFields,
      task: {
        cid: 'bafyreiabc',
        onchainCreationTx: '0x' + 'a'.repeat(64),
        onchainCreationBlock: 1,
        requestId: '0x' + 'b'.repeat(64),
      },
      sessionProvenance: {
        sessionId: '11111111-1111-4111-9111-111111111111',
        capturedAt: '2026-05-07T00:00:00.000Z',
        originatingTool: { name: 'claude-code' },
        license: { operatorAssertion: 'unspecified' as const },
      },
    };
    const result = UnsignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — should fail**

Run: `cd client && yarn test test/types/envelope-capture-role.test.ts -t 'role=capture'`
Expected: FAIL — schema doesn't accept `role: 'capture'`.

- [ ] **Step 3: Create `session-provenance.ts`**

Create `client/src/types/session-provenance.ts`:

```typescript
import { z } from 'zod';

export const SessionProvenanceSchema = z.object({
  sessionId: z.string().min(1),
  capturedAt: z.string().datetime(),
  originatingTool: z.object({
    name: z.string(),
    version: z.string().optional(),
  }),
  repo: z.object({
    remoteUrl: z.string().optional(),
    commitHash: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    branch: z.string().optional(),
  }).optional(),
  license: z.object({
    spdxId: z.string().optional(),
    operatorAssertion: z.enum(['asserted', 'unspecified']),
  }),
});

export type SessionProvenance = z.infer<typeof SessionProvenanceSchema>;
```

- [ ] **Step 4: Modify envelope.ts to add capture role + conditional fields**

Open `client/src/types/envelope.ts`. Replace `RoleSchema` line:

```typescript
export const RoleSchema = z.enum(['restoration', 'verdict', 'capture']);
```

Add import at top:

```typescript
import { SessionProvenanceSchema } from './session-provenance.js';
```

Replace `BaseEnvelopeFields` to make `task` optional and add `sessionProvenance`:

```typescript
const BaseEnvelopeFields = {
  schemaVersion: z.literal('jinn.execution.v1'),
  solverType: z.string().min(1),
  role: RoleSchema,
  generatedAt: z.number().int(),
  task: TaskProvenanceSchema.optional(),
  sessionProvenance: SessionProvenanceSchema.optional(),
  participant: ParticipantSchema,
  window: WindowSchema,
  executor: ExecutorSchema,
  evidenceTier: EvidenceTierSchema,
  attestation: AttestationSchema.nullable(),
  trajectory: TrajectoryRefSchema.nullable(),
  artifacts: z.array(ArtifactSchema),
  payload: z.record(z.unknown()),
};
```

Add a refine to `UnsignedEnvelopeSchema` and `SignedEnvelopeSchema` for the capture/non-capture XOR:

```typescript
.refine(
  (e) => (e.role === 'capture'
    ? e.sessionProvenance !== undefined && e.task === undefined
    : e.task !== undefined && e.sessionProvenance === undefined),
  { message: 'role=capture requires sessionProvenance and no task; other roles require task and no sessionProvenance' },
)
```

Add the same refine to `SignedEnvelopeSchema`.

- [ ] **Step 5: Run test — should pass**

Run: `cd client && yarn test test/types/envelope-capture-role.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 6: Run typecheck — zero errors**

Run: `cd client && yarn typecheck`
Expected: zero errors. If callers were assuming `task` always present, they need to be guarded; usually `task!` works at known-non-capture call sites.

- [ ] **Step 7: Run full test suite — should still pass**

Run: `cd client && yarn test`
Expected: all tests pass; the role-XOR refine doesn't break existing envelopes (they all have role='restoration' or 'verdict' and `task` set).

- [ ] **Step 8: Commit**

```bash
git add client/src/types/envelope.ts client/src/types/session-provenance.ts client/test/types/envelope-capture-role.test.ts
git commit -m "envelope: add 'capture' role + sessionProvenance with mutual-exclusion refine

Role-XOR refine: role=capture requires sessionProvenance and no task;
other roles require task and no sessionProvenance. Additive change;
no schema break for existing 'restoration' / 'verdict' envelopes.

Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §3.1, DR-a"
```

### Task 0.2: Add `CaptureManifestSchema` to trajectory schema

**Files:**
- Modify: `client/src/trajectory/schema.ts`
- Test: `client/test/trajectory/capture-manifest.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/trajectory/capture-manifest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CaptureManifestSchema } from '../../src/trajectory/schema.js';

describe('CaptureManifestSchema', () => {
  it('accepts a complete capture manifest', () => {
    const manifest = {
      scrubProcessors: [
        { name: '@opentelemetry/processor-redaction', version: '0.1.0' },
        { name: 'identity-scrub', version: '1.0.0', config: { patterns: ['username', 'hostname'] } },
      ],
      reviewedBy: {
        safeAddress: '0xabc' + 'd'.repeat(37),
        reviewedAt: '2026-05-07T01:00:00.000Z',
      },
      trustedRepoToggle: false,
      harnessBundle: {
        included: true,
        sha256: 'a'.repeat(64),
        allowedDirectoriesHash: 'b'.repeat(64),
        capturePath: 'A' as const,
      },
    };
    const result = CaptureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('accepts opted-out harness bundle', () => {
    const manifest = {
      scrubProcessors: [{ name: 'identity-scrub', version: '1.0.0' }],
      reviewedBy: {
        safeAddress: '0xabc' + 'd'.repeat(37),
        reviewedAt: '2026-05-07T01:00:00.000Z',
      },
      trustedRepoToggle: true,
      harnessBundle: {
        included: false,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // empty bundle sentinel
        allowedDirectoriesHash: 'b'.repeat(64),
        capturePath: 'C' as const,
      },
    };
    const result = CaptureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects missing capturePath', () => {
    const manifest = {
      scrubProcessors: [],
      reviewedBy: { safeAddress: '0xabc' + 'd'.repeat(37), reviewedAt: '2026-05-07T01:00:00.000Z' },
      trustedRepoToggle: false,
      harnessBundle: { included: true, sha256: 'a'.repeat(64), allowedDirectoriesHash: 'b'.repeat(64) },
    };
    const result = CaptureManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — should fail (CaptureManifestSchema doesn't exist)**

Run: `cd client && yarn test test/trajectory/capture-manifest.test.ts`
Expected: FAIL — import error.

- [ ] **Step 3: Add `CaptureManifestSchema` to `client/src/trajectory/schema.ts`**

Add to the bottom of the file:

```typescript
export const CaptureManifestSchema = z.object({
  scrubProcessors: z.array(z.object({
    name: z.string(),
    version: z.string(),
    config: z.record(z.unknown()).optional(),
  })),
  reviewedBy: z.object({
    safeAddress: z.string(),
    reviewedAt: z.string().datetime(),
  }),
  trustedRepoToggle: z.boolean(),
  harnessBundle: z.object({
    included: z.boolean(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    allowedDirectoriesHash: z.string().regex(/^[0-9a-f]{64}$/),
    capturePath: z.enum(['A', 'B', 'C', 'D']),
  }),
});

export type CaptureManifest = z.infer<typeof CaptureManifestSchema>;

/** sha256 of an empty (no-files) bundle. */
export const EMPTY_BUNDLE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
```

- [ ] **Step 4: Run test — should pass**

Run: `cd client && yarn test test/trajectory/capture-manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/schema.ts client/test/trajectory/capture-manifest.test.ts
git commit -m "trajectory: add CaptureManifestSchema (per §3.3)

Records scrub processors, operator review attestation, trust-this-repo
flag, and coarse harness-bundle metadata (included, sha256,
allowedDirectoriesHash, capturePath). No per-file curation in v0;
operator control is at the bundle level (DR-g).

Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §3.3"
```

### Task 0.3: Add `harness-bundle.v1` artifact-type registration

**Files:**
- Create: `client/src/trajectory/harness-bundle-schema.ts`
- Test: `client/test/trajectory/harness-bundle-schema.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/trajectory/harness-bundle-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HarnessBundleManifestSchema, HARNESS_BUNDLE_ARTIFACT_TYPE } from '../../src/trajectory/harness-bundle-schema.js';

describe('harness-bundle.v1', () => {
  it('exports artifact-type literal', () => {
    expect(HARNESS_BUNDLE_ARTIFACT_TYPE).toBe('harness-bundle.v1');
  });

  it('parses a minimal manifest', () => {
    const manifest = {
      schemaVersion: 'harness-bundle.v1',
      bundleSha256: 'a'.repeat(64),
      capturePath: 'B',
      tool: { name: 'claude-code', version: '1.0.42' },
      files: [
        { path: 'global/CLAUDE.md', sha256: 'b'.repeat(64), bytes: 1024 },
        { path: 'project/CLAUDE.md', sha256: 'c'.repeat(64), bytes: 512 },
      ],
    };
    const result = HarnessBundleManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects bundle with no files when included', () => {
    const manifest = {
      schemaVersion: 'harness-bundle.v1',
      bundleSha256: 'a'.repeat(64),
      capturePath: 'B',
      tool: { name: 'claude-code' },
      files: [],
    };
    const result = HarnessBundleManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — should fail (file doesn't exist)**

Run: `cd client && yarn test test/trajectory/harness-bundle-schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `harness-bundle-schema.ts`**

Create `client/src/trajectory/harness-bundle-schema.ts`:

```typescript
import { z } from 'zod';

export const HARNESS_BUNDLE_ARTIFACT_TYPE = 'harness-bundle.v1' as const;

export const HarnessBundleManifestSchema = z.object({
  schemaVersion: z.literal('harness-bundle.v1'),
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
  capturePath: z.enum(['A', 'B', 'C', 'D']),
  tool: z.object({
    name: z.string(),
    version: z.string().optional(),
  }),
  files: z.array(z.object({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  })).min(1),
});

export type HarnessBundleManifest = z.infer<typeof HarnessBundleManifestSchema>;
```

- [ ] **Step 4: Run test — should pass**

Run: `cd client && yarn test test/trajectory/harness-bundle-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/harness-bundle-schema.ts client/test/trajectory/harness-bundle-schema.test.ts
git commit -m "trajectory: add harness-bundle.v1 artifact type

Bundle manifest carries the file list with per-file sha256+bytes;
bundleSha256 is the deterministic hash that becomes executor.codeDigest.
Min 1 file (an opted-out bundle is signalled by absence of the
artifact, not an empty manifest).

Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §3.1, §3.2"
```

### Task 0.4: Add `SESSION_DERIVED_V1_SOLVER_NET_CONTRACT` scaffold

**Files:**
- Modify: `packages/sdk/src/contracts.ts`
- Test: `packages/sdk/test/contracts/session-derived.scaffold.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/sdk/test/contracts/session-derived.scaffold.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SESSION_DERIVED_V1_SOLVER_NET_CONTRACT } from '../../src/contracts.js';

describe('session-derived contract scaffold', () => {
  it('has the expected identity', () => {
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.id).toBe('session-derived');
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.version).toBe('1.0.0');
  });

  it('has claim policy defaults', () => {
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.claimPolicyDefaults.maxConcurrentClaimsPerOperator).toBe(5);
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.claimPolicyDefaults.claimTimeoutMs).toBe(4 * 60 * 60 * 1000);
  });

  it('has evaluator credential requirements', () => {
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.credentialRequirements.evaluating.requiresBond).toBe(true);
    expect(SESSION_DERIVED_V1_SOLVER_NET_CONTRACT.credentialRequirements.evaluating.bondAmountUsdc).toBe('50');
  });
});
```

- [ ] **Step 2: Run test — should fail**

Run: `cd packages/sdk && yarn test test/contracts/session-derived.scaffold.test.ts`
Expected: FAIL — export not present.

- [ ] **Step 3: Add scaffold export to `packages/sdk/src/contracts.ts`**

Append to the existing contracts file (search for `SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT` to find the convention):

```typescript
// Schemas + evaluator filled in Phase 10.
const PLACEHOLDER_SCHEMA = { kind: 'placeholder' as const };

export const SESSION_DERIVED_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  id: 'session-derived',
  version: '1.0.0',
  schemas: {
    task: PLACEHOLDER_SCHEMA as any,      // filled in Phase 10
    solution: PLACEHOLDER_SCHEMA as any,  // filled in Phase 10
    verdict: PLACEHOLDER_SCHEMA as any,   // filled in Phase 10
  },
  claimPolicyDefaults: {
    maxConcurrentClaimsPerOperator: 5,
    claimTimeoutMs: 4 * 60 * 60 * 1000,
  },
  credentialRequirements: {
    solving: { minReputation: 0 },
    evaluating: { minReputation: 0, requiresBond: true, bondAmountUsdc: '50' },
  },
  evaluationFunction: {
    id: '@jinn-network/session-derived-evaluator',
    version: '1.0.0',
    deterministic: false,
  },
  aggregationFunction: {
    id: 'session-derived-rolling-mean',
    version: '1.0.0',
    windowing: { kind: 'rolling-days', days: 30 },
  },
  defaultRuntimePlugins: ['bundled:network-tools', 'bundled:session-derived-runtime'],
};
```

- [ ] **Step 4: Run test — should pass**

Run: `cd packages/sdk && yarn test test/contracts/session-derived.scaffold.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/contracts.ts packages/sdk/test/contracts/session-derived.scaffold.test.ts
git commit -m "sdk: register session-derived v1.0.0 contract scaffold

Contract identity + defaults registered; payload schemas are
placeholders to be filled in Phase 10. The scaffold lets downstream
phases reference the contract identity without circular blocking.

Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §5.1, §5.2"
```

### Task 0.5: Phase 0 PR

- [ ] **Step 1: Run full type + test suite**

Run from repo root:
```bash
cd client && yarn typecheck && yarn test
cd ../packages/sdk && yarn typecheck && yarn test
```
Expected: all pass.

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "Phase 0: capture envelope schema + session-derived scaffold" --body "$(cat <<'EOF'
## Summary
- `role: 'capture'` + `sessionProvenance` added to `jinn.execution.v1` (additive, no break)
- `CaptureManifestSchema` exported from `client/src/trajectory/schema.ts`
- `harness-bundle.v1` artifact type registered
- `SESSION_DERIVED_V1_SOLVER_NET_CONTRACT` scaffold (schemas in Phase 10)

## Test plan
- [ ] yarn test passes in client/
- [ ] yarn test passes in packages/sdk/
- [ ] yarn typecheck zero errors
- [ ] Existing solver flows untouched (smoke against claude-code-learner)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Phase 1 — Embedded OTLP receiver + processor stack

Stand up the OTel SDK boundary inside the daemon. Migrate the existing bespoke trajectory collector onto it. After this phase, all existing harnesses emit OTel to the embedded receiver and traverse the SDK processor stack — but no operator-facing capture flow yet.

**Dependencies:** Phase 0 merged. `jinn-mono-h43b` landed.

**Exit criteria:**
- Embedded OTLP receiver listening on `localhost:4317` (gRPC) and `localhost:4318` (HTTP) when daemon starts.
- All five processors (identity-scrub, path-scrub, credential-scrub, manifest-builder, sqlite-exporter) implemented with unit tests.
- `client/src/trajectory/collector.ts` is a thin SDK shim; one harness (claude-code-learner) migrated to emit through the SDK; the existing `e2e:full-cycle` test still passes end-to-end.
- Spans for non-capture (existing solver) flows continue to land in the trajectory artifact via the same processor stack — i.e., no functional regression.

### Task 1.1: Add OTLP receiver dependency + module skeleton

**Files:**
- Modify: `client/package.json` (add `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/exporter-trace-otlp-http`, `@grpc/grpc-js`)
- Create: `client/src/trajectory/receiver.ts`
- Test: `client/test/trajectory/receiver.test.ts`

- [ ] **Step 1: Add deps**

Run: `cd client && yarn add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-grpc @opentelemetry/exporter-trace-otlp-http @opentelemetry/api @grpc/grpc-js`

Expected: deps installed; `package.json` updated; `yarn.lock` updated.

- [ ] **Step 2: Write failing test (smoke: receiver starts + accepts a span)**

Create `client/test/trajectory/receiver.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startReceiver, Receiver } from '../../src/trajectory/receiver.js';
import { trace, SpanKind } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

describe('embedded OTLP receiver', () => {
  let receiver: Receiver;
  let exporterSdk: NodeSDK;

  beforeEach(async () => {
    receiver = await startReceiver({ grpcPort: 0, httpPort: 0 }); // ephemeral ports
    exporterSdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: `http://localhost:${receiver.httpPort}/v1/traces` }),
    });
    exporterSdk.start();
  });

  afterEach(async () => {
    await exporterSdk.shutdown();
    await receiver.shutdown();
  });

  it('receives a span from a remote OTLP exporter', async () => {
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('test-span', { kind: SpanKind.INTERNAL });
    span.setAttribute('test.key', 'test-value');
    span.end();
    await new Promise((r) => setTimeout(r, 200)); // allow batch processor flush

    const received = receiver.testSink.spans;
    expect(received.length).toBeGreaterThan(0);
    expect(received.some((s) => s.name === 'test-span')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test — should fail (receiver module doesn't exist)**

Run: `cd client && yarn test test/trajectory/receiver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `receiver.ts`**

Create `client/src/trajectory/receiver.ts`:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter as GrpcExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as HttpExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createServer } from 'node:http';
import * as grpc from '@grpc/grpc-js';

export interface ReceiverOptions {
  grpcPort: number;  // 0 = ephemeral
  httpPort: number;  // 0 = ephemeral
  processors?: SpanProcessor[];
}

export interface Receiver {
  grpcPort: number;
  httpPort: number;
  testSink: { spans: ReadableSpan[] };  // for tests; real wiring uses processors
  shutdown(): Promise<void>;
}

class TestSinkProcessor implements SpanProcessor {
  spans: ReadableSpan[] = [];
  forceFlush() { return Promise.resolve(); }
  onStart() {}
  onEnd(span: ReadableSpan) { this.spans.push(span); }
  shutdown() { return Promise.resolve(); }
}

export async function startReceiver(opts: ReceiverOptions): Promise<Receiver> {
  // Bind HTTP listener on opts.httpPort, accept POST /v1/traces with OTLP-HTTP-JSON encoding;
  // bind gRPC listener on opts.grpcPort, accept the OTLP gRPC TraceService.
  // (Implementation uses the otlp-receiver helper in @opentelemetry/sdk-node + @grpc/grpc-js.)
  // Both feed received spans into opts.processors[].onEnd() in order.

  const sink = new TestSinkProcessor();
  const httpServer = createServer(/* ... OTLP HTTP handler ... */);
  await new Promise<void>((resolve) => httpServer.listen(opts.httpPort, '127.0.0.1', () => resolve()));
  const httpAddr = httpServer.address() as { port: number };

  const grpcServer = new grpc.Server();
  // grpcServer.addService(traceServiceDef, { Export: handleExport });
  await new Promise<void>((resolve, reject) =>
    grpcServer.bindAsync(`127.0.0.1:${opts.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err); else resolve();
    }),
  );
  grpcServer.start();

  return {
    grpcPort: 0, // populated by bindAsync callback in real impl
    httpPort: httpAddr.port,
    testSink: sink,
    async shutdown() {
      httpServer.close();
      grpcServer.forceShutdown();
    },
  };
}
```

(Implementation note for the engineer: the OTLP HTTP/JSON path takes `protobufjs` to decode; use the Node SDK's `OTLPProtoSerializer` shipped with `@opentelemetry/exporter-trace-otlp-http` to deserialise, then call each processor's `onEnd` with each span. Keep the TestSinkProcessor minimal — production wiring uses `processors` from opts.)

- [ ] **Step 5: Run test — should pass**

Run: `cd client && yarn test test/trajectory/receiver.test.ts`
Expected: PASS — span round-trips from a fresh SDK exporter to the receiver's test sink.

- [ ] **Step 6: Commit**

```bash
git add client/package.json client/yarn.lock client/src/trajectory/receiver.ts client/test/trajectory/receiver.test.ts
git commit -m "trajectory: embed OTLP gRPC + HTTP receiver

Standard OTel ports (4317 gRPC, 4318 HTTP) at runtime; ephemeral ports
in tests. Spans land in injected processors in order. No production
wiring yet; that's Task 1.7.

Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.1, §4.3"
```

### Task 1.2: Identity-scrub processor

**Files:**
- Create: `client/src/trajectory/processors/identity-scrub.ts`
- Test: `client/test/trajectory/processors/identity-scrub.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/trajectory/processors/identity-scrub.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { IdentityScrubProcessor, IDENTITY_SCRUB_VERSION } from '../../../src/trajectory/processors/identity-scrub.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(attrs: Record<string, unknown>): ReadableSpan {
  return {
    name: 'test',
    attributes: { ...attrs },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }),
    // ...other fields the processor reads; cast for test
  } as unknown as ReadableSpan;
}

describe('IdentityScrubProcessor', () => {
  const proc = new IdentityScrubProcessor({
    username: 'adrianobradley',
    hostname: 'oak-mbp.local',
    machineId: 'XYZ-123',
    gitAuthorEmail: 'oak@example.com',
    gitAuthorName: 'Oak',
  });

  it('replaces username in string attribute values', () => {
    const span = fakeSpan({ 'shell.cwd': '/Users/adrianobradley/repo' });
    proc.onEnd(span);
    expect(span.attributes['shell.cwd']).toBe('/Users/<USER>/repo');
  });

  it('replaces hostname', () => {
    const span = fakeSpan({ 'net.peer.name': 'oak-mbp.local' });
    proc.onEnd(span);
    expect(span.attributes['net.peer.name']).toBe('<HOST>');
  });

  it('replaces git author email', () => {
    const span = fakeSpan({ 'commit.message': 'Author: Oak <oak@example.com>' });
    proc.onEnd(span);
    expect(span.attributes['commit.message']).toContain('<EMAIL>');
    expect(span.attributes['commit.message']).not.toContain('oak@example.com');
  });

  it('reports its identity in version metadata', () => {
    expect(IDENTITY_SCRUB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `cd client && yarn test test/trajectory/processors/identity-scrub.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `identity-scrub.ts`**

Create `client/src/trajectory/processors/identity-scrub.ts`:

```typescript
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const IDENTITY_SCRUB_VERSION = '1.0.0';

export interface IdentityScrubConfig {
  username?: string;
  hostname?: string;
  machineId?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  ipv4Patterns?: RegExp[];
  ipv6Patterns?: RegExp[];
}

const DEFAULT_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export class IdentityScrubProcessor implements SpanProcessor {
  constructor(private readonly cfg: IdentityScrubConfig) {}

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (typeof v === 'string') {
        attrs[key] = this.scrub(v);
      }
    }
  }

  private scrub(s: string): string {
    let out = s;
    if (this.cfg.username) out = out.split(this.cfg.username).join('<USER>');
    if (this.cfg.hostname) out = out.split(this.cfg.hostname).join('<HOST>');
    if (this.cfg.machineId) out = out.split(this.cfg.machineId).join('<MACHINE>');
    if (this.cfg.gitAuthorEmail) out = out.split(this.cfg.gitAuthorEmail).join('<EMAIL>');
    if (this.cfg.gitAuthorName) out = out.split(this.cfg.gitAuthorName).join('<AUTHOR>');
    out = out.replace(DEFAULT_IPV4, '<IPV4>');
    return out;
  }
}
```

- [ ] **Step 4: Run — pass**

Run: `cd client && yarn test test/trajectory/processors/identity-scrub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/processors/identity-scrub.ts client/test/trajectory/processors/identity-scrub.test.ts
git commit -m "processors: identity-scrub (username/hostname/machine/git/IP)

Spec: §4.3 processor stack table; called out in §4.4 as separate from
credential scrub which is the existing V1 pattern set."
```

### Task 1.3: Path-scrub processor

**Files:**
- Create: `client/src/trajectory/processors/path-scrub.ts`
- Test: `client/test/trajectory/processors/path-scrub.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/trajectory/processors/path-scrub.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PathScrubProcessor } from '../../../src/trajectory/processors/path-scrub.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(attrs: Record<string, unknown>): ReadableSpan {
  return { name: 't', attributes: { ...attrs }, spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }) } as unknown as ReadableSpan;
}

describe('PathScrubProcessor', () => {
  const proc = new PathScrubProcessor({ home: '/Users/adrianobradley', repoRoot: '/Users/adrianobradley/harbor/jinn-mono' });

  it('replaces $HOME with /users/anon', () => {
    const span = fakeSpan({ 'file.path': '/Users/adrianobradley/.claude/settings.json' });
    proc.onEnd(span);
    expect(span.attributes['file.path']).toBe('/users/anon/.claude/settings.json');
  });

  it('makes paths relative to repo root', () => {
    const span = fakeSpan({ 'file.path': '/Users/adrianobradley/harbor/jinn-mono/cargo/client/src/main.ts' });
    proc.onEnd(span);
    expect(span.attributes['file.path']).toBe('cargo/client/src/main.ts');
  });

  it('leaves system paths alone', () => {
    const span = fakeSpan({ 'file.path': '/usr/local/bin/node' });
    proc.onEnd(span);
    expect(span.attributes['file.path']).toBe('/usr/local/bin/node');
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `cd client && yarn test test/trajectory/processors/path-scrub.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `path-scrub.ts`**

Create `client/src/trajectory/processors/path-scrub.ts`:

```typescript
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import * as path from 'node:path';

export const PATH_SCRUB_VERSION = '1.0.0';

export interface PathScrubConfig {
  home: string;       // e.g., '/Users/adrianobradley'
  repoRoot?: string;  // e.g., '/Users/adrianobradley/harbor/jinn-mono'
}

export class PathScrubProcessor implements SpanProcessor {
  private readonly homePrefix: string;
  private readonly repoPrefix?: string;

  constructor(cfg: PathScrubConfig) {
    this.homePrefix = cfg.home.endsWith('/') ? cfg.home : cfg.home + '/';
    if (cfg.repoRoot) {
      this.repoPrefix = cfg.repoRoot.endsWith('/') ? cfg.repoRoot : cfg.repoRoot + '/';
    }
  }

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (typeof v === 'string') attrs[key] = this.scrub(v);
    }
  }

  private scrub(s: string): string {
    // Repo-relative wins over home-anonymisation when applicable.
    if (this.repoPrefix && s.startsWith(this.repoPrefix)) {
      return s.slice(this.repoPrefix.length);
    }
    if (s.startsWith(this.homePrefix)) {
      return '/users/anon/' + s.slice(this.homePrefix.length);
    }
    return s;
  }
}
```

- [ ] **Step 4: Run — pass**

Run: `cd client && yarn test test/trajectory/processors/path-scrub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/processors/path-scrub.ts client/test/trajectory/processors/path-scrub.test.ts
git commit -m "processors: path-scrub (home → /users/anon, repo → relative)

Order matters: repo-relative wins so paths inside the project come out
clean instead of /users/anon/<repo-prefix>.

Spec: §4.3"
```

### Task 1.4: Credential-scrub processor (wraps existing pattern set)

**Files:**
- Create: `client/src/trajectory/processors/credential-scrub.ts`
- Test: `client/test/trajectory/processors/credential-scrub.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/trajectory/processors/credential-scrub.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CredentialScrubProcessor } from '../../../src/trajectory/processors/credential-scrub.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(attrs: Record<string, unknown>): ReadableSpan {
  return { name: 't', attributes: { ...attrs }, spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }) } as unknown as ReadableSpan;
}

describe('CredentialScrubProcessor', () => {
  const proc = new CredentialScrubProcessor();

  it('redacts authorization-style attribute keys', () => {
    const span = fakeSpan({ 'http.request.header.authorization': 'Bearer sk-foo123', 'http.url': 'https://x.com' });
    proc.onEnd(span);
    expect(span.attributes['http.request.header.authorization']).toBe('<REDACTED>');
    expect(span.attributes['http.url']).toBe('https://x.com');
  });

  it('redacts apiKey, bearer, password, secret, token, privateKey keys (case-insensitive)', () => {
    const span = fakeSpan({
      apiKey: 'foo', BEARER: 'bar', password: 'baz', secret: 'qux', token: 'tok', privateKey: 'pk',
    });
    proc.onEnd(span);
    expect(span.attributes.apiKey).toBe('<REDACTED>');
    expect(span.attributes.BEARER).toBe('<REDACTED>');
    expect(span.attributes.password).toBe('<REDACTED>');
    expect(span.attributes.secret).toBe('<REDACTED>');
    expect(span.attributes.token).toBe('<REDACTED>');
    expect(span.attributes.privateKey).toBe('<REDACTED>');
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `cd client && yarn test test/trajectory/processors/credential-scrub.test.ts`

- [ ] **Step 3: Implement (wraps existing `secret-scrub.ts` patterns)**

Create `client/src/trajectory/processors/credential-scrub.ts`:

```typescript
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const CREDENTIAL_SCRUB_VERSION = '1.0.0';

const SENSITIVE_KEY_PATTERNS = [
  /authorization/i, /apikey/i, /api_key/i, /bearer/i, /password/i,
  /secret/i, /token/i, /privatekey/i, /private_key/i,
];

const REDACTED = '<REDACTED>';

export class CredentialScrubProcessor implements SpanProcessor {
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
        attrs[key] = REDACTED;
      }
    }
  }
}
```

- [ ] **Step 4: Run — pass**

Run: `cd client && yarn test test/trajectory/processors/credential-scrub.test.ts`

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/processors/credential-scrub.ts client/test/trajectory/processors/credential-scrub.test.ts
git commit -m "processors: credential-scrub wraps existing secret-scrub patterns"
```

### Task 1.5: Manifest-builder processor

**Files:**
- Create: `client/src/trajectory/processors/manifest-builder.ts`
- Test: `client/test/trajectory/processors/manifest-builder.test.ts`

- [ ] **Step 1: Write failing test**

Create `client/test/trajectory/processors/manifest-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ManifestBuilderProcessor } from '../../../src/trajectory/processors/manifest-builder.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(name: string, attrs: Record<string, unknown>): ReadableSpan {
  return { name, attributes: { ...attrs }, spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }) } as unknown as ReadableSpan;
}

describe('ManifestBuilderProcessor', () => {
  it('records redactions on each span and emits a manifest', () => {
    const builder = new ManifestBuilderProcessor({ identityScrubConfig: { username: 'oak' } });
    const s = fakeSpan('s1', { 'shell.cwd': '/Users/<USER>/x', token: '<REDACTED>' });
    builder.onEnd(s);
    const manifest = builder.flushManifest();
    expect(manifest.spans).toHaveLength(1);
    expect(manifest.spans[0].redactedKeys).toContain('token');
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `cd client && yarn test test/trajectory/processors/manifest-builder.test.ts`

- [ ] **Step 3: Implement**

Create `client/src/trajectory/processors/manifest-builder.ts`:

```typescript
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface SpanRedactionRecord {
  spanId: string;
  redactedKeys: string[];
}

export class ManifestBuilderProcessor implements SpanProcessor {
  private readonly records: SpanRedactionRecord[] = [];
  constructor(private readonly cfg: { identityScrubConfig?: unknown; pathScrubConfig?: unknown }) {}

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const redactedKeys: string[] = [];
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'string' && (v === '<REDACTED>' || /^<[A-Z]+>$/.test(v))) {
        redactedKeys.push(k);
      }
    }
    if (redactedKeys.length > 0) {
      this.records.push({ spanId: span.spanContext().spanId, redactedKeys });
    }
  }

  flushManifest() {
    const out = { spans: this.records.slice() };
    this.records.length = 0;
    return out;
  }
}
```

- [ ] **Step 4: Run — pass**

Run: `cd client && yarn test test/trajectory/processors/manifest-builder.test.ts`

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/processors/manifest-builder.ts client/test/trajectory/processors/manifest-builder.test.ts
git commit -m "processors: manifest-builder records per-span redaction keys

Output feeds the existing redactionManifest signing at envelope-assembly
time, plus the new captureManifest's top-level summary."
```

### Task 1.6: SQLite exporter processor

**Files:**
- Create: `client/src/trajectory/processors/sqlite-exporter.ts`
- Test: `client/test/trajectory/processors/sqlite-exporter.test.ts`
- Modify: (skip — exporter persists via Captures store; that store is built in Phase 2; for Phase 1, use an in-memory placeholder Store and revisit in Phase 2)

For Phase 1, the SQLite exporter writes to the **existing** `trajectory_spans` table (used by the legacy collector). Phase 2 adds the pending-captures store and re-targets the exporter.

- [ ] **Step 1: Write failing test (writes to existing table; reads back)**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { SqliteExporterProcessor } from '../../../src/trajectory/processors/sqlite-exporter.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

describe('SqliteExporterProcessor', () => {
  let store: Store;
  beforeEach(() => { store = new Store(':memory:'); });
  afterEach(() => store.close());

  it('writes a span and reads it back by traceId', () => {
    const proc = new SqliteExporterProcessor({ store, sessionId: 'sess-1' });
    const span = {
      name: 'op',
      attributes: { foo: 'bar' },
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }),
      startTime: [0, 0],
      endTime: [1, 0],
    } as unknown as ReadableSpan;
    proc.onEnd(span);
    const rows = store.getSpansByTraceId('a'.repeat(32));
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('op');
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** — straightforward INSERT into the existing `trajectory_spans` table. Module ~50 LOC.

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/processors/sqlite-exporter.ts client/test/trajectory/processors/sqlite-exporter.test.ts
git commit -m "processors: sqlite-exporter persists spans to trajectory_spans table"
```

### Task 1.7: Migrate `client/src/trajectory/collector.ts` to SDK shim

**Files:**
- Modify: `client/src/trajectory/collector.ts`
- Modify: `client/src/restorer/engine/engine.ts` (call site)
- Test: existing `client/test/trajectory/collector.test.ts` and `client/test/restorer/engine/engine.test.ts` must still pass.

- [ ] **Step 1: Refactor collector to wrap NodeSDK + processor stack**

```typescript
// client/src/trajectory/collector.ts (after migration)
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { startReceiver } from './receiver.js';
import { IdentityScrubProcessor } from './processors/identity-scrub.js';
import { PathScrubProcessor } from './processors/path-scrub.js';
import { CredentialScrubProcessor } from './processors/credential-scrub.js';
import { ManifestBuilderProcessor } from './processors/manifest-builder.js';
import { SqliteExporterProcessor } from './processors/sqlite-exporter.js';
import { Store } from '../store/store.js';

export interface CollectorConfig { /* ...identity/path scrub config...; store; receiver ports */ }

export async function startCollector(cfg: CollectorConfig) {
  const processors = [
    new CredentialScrubProcessor(),
    new IdentityScrubProcessor(cfg.identity),
    new PathScrubProcessor(cfg.path),
    new ManifestBuilderProcessor({ identityScrubConfig: cfg.identity, pathScrubConfig: cfg.path }),
    new SqliteExporterProcessor({ store: cfg.store, sessionId: cfg.sessionId }),
  ];
  const receiver = await startReceiver({ grpcPort: cfg.grpcPort ?? 4317, httpPort: cfg.httpPort ?? 4318, processors });
  return { receiver, /* in-process emit hook for harness call sites */ };
}
```

- [ ] **Step 2: Update one harness call site (claude-code-learner)** to emit via the SDK API instead of the bespoke collector. Keep behaviour identical.

- [ ] **Step 3: Run existing collector + engine tests — both must still pass**

Run: `cd client && yarn test test/trajectory/collector.test.ts test/restorer/engine/engine.test.ts`
Expected: PASS.

- [ ] **Step 4: Run `yarn e2e:full-cycle` against an Anvil fork** — confirms no regression.

Run: `cd client && yarn e2e:full-cycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/collector.ts client/src/restorer/engine/engine.ts
git commit -m "trajectory: migrate collector onto OTel SDK + processor stack

The bespoke scrubAttributes function becomes a thin wrapper. Existing
harness call sites unchanged from the outside; behaviour preserved."
```

### Task 1.8: Phase 1 PR

- [ ] **Step 1: All tests green**

Run: `cd client && yarn typecheck && yarn test && yarn e2e`

- [ ] **Step 2: Open PR with body listing migrated harnesses + zero-regression smoke results.**

---

## Phase 2 — Pending captures store

Add the SQLite tables that hold capture-in-progress and capture-pending-review state. Refocus the SQLite exporter from Phase 1 onto these tables when `role: 'capture'` (vs. legacy trajectory writes for solver flows).

**Dependencies:** Phase 1 merged.

**Exit criteria:**
- `pending_captures` table exists with required columns; CRUD methods work.
- The `SqliteExporterProcessor` writes capture-bound spans to the pending table; solver-bound spans continue to land in `trajectory_spans`.
- Read APIs cover the Captures-tab UI's needs (list pending, get-by-session-id, mark approved/skipped).

### Task 2.1: Add `pending_captures` schema + accessors

**Files:**
- Modify: `client/src/store/store.ts`
- Create: `client/src/store/captures.ts` (typed wrappers)
- Test: `client/test/store/captures.test.ts`

- [ ] **Step 1: Write failing test for `savePendingCapture` + `listPending`**

Create `client/test/store/captures.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';

describe('CapturesStore', () => {
  let store: Store;
  let captures: CapturesStore;
  beforeEach(() => { store = new Store(':memory:'); captures = new CapturesStore(store); });
  afterEach(() => store.close());

  it('saves and lists pending captures', () => {
    captures.savePending({
      sessionId: 'sess-1',
      capturedAt: '2026-05-07T00:00:00.000Z',
      originatingTool: { name: 'claude-code', version: '1.0.42' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 42,
      durationMs: 60_000,
      redactedSpanCount: 3,
      repoRemoteUrl: 'git@github.com:Jinn-Network/mono.git',
      repoCommitHash: 'abcd1234'.padEnd(40, 'e'),
    });
    const pending = captures.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('sess-1');
    expect(pending[0].status).toBe('pending');
  });

  it('marks approved and removes from pending list', () => {
    captures.savePending({ sessionId: 'sess-2', capturedAt: new Date().toISOString(), originatingTool: { name: 'codex' }, capturePath: 'B', status: 'pending', spanCount: 10, durationMs: 5_000, redactedSpanCount: 0 });
    captures.markApproved('sess-2', { envelopeCid: 'bafy123', publishedAt: new Date().toISOString() });
    expect(captures.listPending()).toHaveLength(0);
    expect(captures.getApproved('sess-2')!.envelopeCid).toBe('bafy123');
  });

  it('marks skipped with grace deletion timestamp', () => {
    captures.savePending({ sessionId: 'sess-3', capturedAt: new Date().toISOString(), originatingTool: { name: 'aider' }, capturePath: 'B', status: 'pending', spanCount: 1, durationMs: 1_000, redactedSpanCount: 0 });
    captures.markSkipped('sess-3', { skippedAt: new Date().toISOString() });
    expect(captures.listPending()).toHaveLength(0);
    expect(captures.getSkipped('sess-3')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — fail (CapturesStore doesn't exist)**

Run: `cd client && yarn test test/store/captures.test.ts`

- [ ] **Step 3: Add SCHEMA migration to `client/src/store/store.ts`**

In the SCHEMA constant, add:

```sql
CREATE TABLE IF NOT EXISTS pending_captures (
  session_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  originating_tool_name TEXT NOT NULL,
  originating_tool_version TEXT,
  capture_path TEXT NOT NULL CHECK (capture_path IN ('A','B','C','D')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','skipped')),
  span_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  redacted_span_count INTEGER NOT NULL,
  repo_remote_url TEXT,
  repo_commit_hash TEXT,
  envelope_cid TEXT,
  published_at TEXT,
  skipped_at TEXT
);
CREATE INDEX IF NOT EXISTS pending_captures_status_capturedat
  ON pending_captures (status, captured_at DESC);
```

- [ ] **Step 4: Implement `client/src/store/captures.ts`**

Wrap the SQL in typed helpers (`savePending`, `listPending`, `markApproved`, `markSkipped`, `getApproved`, `getSkipped`).

- [ ] **Step 5: Run — pass**

- [ ] **Step 6: Commit**

```bash
git add client/src/store/store.ts client/src/store/captures.ts client/test/store/captures.test.ts
git commit -m "store: add pending_captures table + CapturesStore wrapper

Spec: §4.5 (rate limits + dedup are publisher concerns; this is the
queue), §4.4 (Captures-tab pending list)"
```

### Task 2.2: Wire `SqliteExporterProcessor` to write to pending_captures when capture-bound

The processor needs to know whether the current trace belongs to a capture session or a solver task. Solver flows already pass a `taskId` through trace context; capture flows pass a `sessionId`. The processor branches on whichever is set.

- [ ] **Step 1: Test capture-bound spans land in pending_captures (via the spans-side table) and update `pending_captures.span_count` count** — write the test first.

- [ ] **Step 2 + 3: Implement branch + run.**

- [ ] **Step 4: Commit.**

### Task 2.3: Phase 2 PR

- [ ] **All tests green; PR.**

---

## Phase 3 — Path B transcript watchers + parsers

Stand up the universal-fallback capture path. Each tool gets a `TranscriptParser` that converts native transcript events into a normalised `TranscriptEvent` shape; a single watcher dispatches file-system events to the right parser; a synthetic-span builder converts events into OTel spans for the Phase 1 processor stack.

**Dependencies:** Phase 2 merged.

**Exit criteria:**
- Six per-tool parsers tested against fixture transcripts (one fixture per tool).
- Watcher correctly dispatches file-change events to the right parser based on path.
- Synthetic-span builder produces spans the Phase 1 processor stack handles unchanged.
- End-to-end smoke: a fixture Aider session in a temp dir produces a pending capture in the queue.

### Task 3.1: `TranscriptEvent` + `TranscriptParser` interface

**Files:**
- Create: `client/src/trajectory/transcript-parsers/types.ts`
- Test: `client/test/trajectory/transcript-parsers/types.test.ts`

- [ ] **Step 1: Test (interface compile-check + canonical event shape)**

```typescript
import { describe, it, expect } from 'vitest';
import { TranscriptEventSchema, TranscriptEvent } from '../../../src/trajectory/transcript-parsers/types.js';

describe('TranscriptEvent', () => {
  it('parses each kind', () => {
    const events: unknown[] = [
      { kind: 'user-message', timestamp: '2026-05-07T00:00:00.000Z', content: 'hi' },
      { kind: 'assistant-message', timestamp: '2026-05-07T00:00:01.000Z', content: 'hello' },
      { kind: 'tool-call', timestamp: '2026-05-07T00:00:02.000Z', name: 'Read', args: { path: 'x' } },
      { kind: 'tool-result', timestamp: '2026-05-07T00:00:03.000Z', name: 'Read', content: '...' },
      { kind: 'edit', timestamp: '2026-05-07T00:00:04.000Z', path: 'x.ts', diff: '@@ -1,1 +1,2 @@' },
    ];
    for (const e of events) {
      expect(TranscriptEventSchema.safeParse(e).success).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement.**

```typescript
// client/src/trajectory/transcript-parsers/types.ts
import { z } from 'zod';

export const TranscriptEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-message'), timestamp: z.string().datetime(), content: z.string() }),
  z.object({ kind: z.literal('assistant-message'), timestamp: z.string().datetime(), content: z.string() }),
  z.object({ kind: z.literal('tool-call'), timestamp: z.string().datetime(), name: z.string(), args: z.record(z.unknown()) }),
  z.object({ kind: z.literal('tool-result'), timestamp: z.string().datetime(), name: z.string(), content: z.string(), isError: z.boolean().optional() }),
  z.object({ kind: z.literal('edit'), timestamp: z.string().datetime(), path: z.string(), diff: z.string() }),
]);
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

export interface TranscriptParser {
  /** Tool identity, used to select snapshot rules and brand the synthetic span 'service.name'. */
  readonly tool: 'claude-code' | 'codex' | 'gemini-cli' | 'cursor' | 'aider' | 'continue';
  /** Parse incremental transcript bytes; returns events drained since last call. */
  parseChunk(input: { sessionId: string; chunk: Buffer | string }): TranscriptEvent[];
  /** Parse an entire transcript file (one-shot). */
  parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]>;
}
```

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Commit.**

### Task 3.2: Synthetic span builder

**Files:**
- Create: `client/src/trajectory/synthetic-span-builder.ts`
- Test: `client/test/trajectory/synthetic-span-builder.test.ts`

- [ ] **Step 1: Test that events become OTel spans of the right kind.**

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement using `@opentelemetry/api`'s tracer API; emits spans into the same SDK provider Phase 1 wired up.**

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Commit.**

### Task 3.3: Per-tool parser — Claude Code JSONL

**Files:**
- Create: `client/src/trajectory/transcript-parsers/claude-code-jsonl.ts`
- Create fixture: `client/fixtures/transcripts/claude-code/example-session.jsonl`
- Test: `client/test/trajectory/transcript-parsers/claude-code-jsonl.test.ts`

- [ ] **Step 1: Capture a real Claude Code transcript as fixture.**

```bash
cp ~/.claude/projects/<some-recent-project>/<session-id>.jsonl client/fixtures/transcripts/claude-code/example-session.jsonl
# Then run identity scrub against the fixture before committing.
```

- [ ] **Step 2: Write failing test that parses the fixture and asserts > 0 events of each kind.**

- [ ] **Step 3: Implement parser — Claude Code's JSONL emits one record per `human_turn` / `assistant_turn` / `tool_use` / `tool_result` event. Map to the canonical shape.**

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Commit.**

### Task 3.4: Per-tool parser — Codex sessions

Same shape as 3.3. Source format: `~/.codex/sessions/<id>.jsonl` (or current canonical layout — verify with Codex CLI version on disk). Test fixture committed with identity scrub applied.

### Task 3.5: Per-tool parser — Gemini CLI sessions

Same shape. `~/.gemini/sessions/<id>` (verify exact path).

### Task 3.6: Per-tool parser — Cursor SQLite WAL tail

**Files:**
- Create: `client/src/trajectory/transcript-parsers/cursor-sqlite.ts`
- Test: `client/test/trajectory/transcript-parsers/cursor-sqlite.test.ts`

Cursor's chat history lives in workspace-local SQLite (`<workspace>/.cursor/state.vscdb`). The parser opens the DB read-only, follows the WAL for new rows, and parses Cursor's JSON message format.

- [ ] **Step 1: Capture a fixture DB (or snapshot the message rows as JSON for test injection).**

- [ ] **Step 2: Write test that, given a snapshot DB, parses N messages.**

- [ ] **Step 3: Implement using `better-sqlite3` in read-only WAL mode.**

- [ ] **Steps 4-5: Pass + commit.**

### Task 3.7: Per-tool parser — Aider history files

Aider writes three files: `.aider.chat.history.md`, `.aider.input.history`, and (with `--analytics-log`) a JSONL log. The parser consumes whichever the operator has enabled, preferring `--analytics-log` for richer signal.

- [ ] **Steps follow the 3.3 pattern.**

### Task 3.8: Per-tool parser — Continue dev_data

`.continue/dev_data/<event-kind>/<schema-version>.jsonl` — one file per event kind. Parser globs the directory, tails new lines per file, dispatches per kind.

- [ ] **Steps follow the 3.3 pattern.**

### Task 3.9: Watcher dispatcher

**Files:**
- Create: `client/src/trajectory/transcript-watcher.ts`
- Test: `client/test/trajectory/transcript-watcher.test.ts`

The watcher uses `chokidar` for filesystem events on the transcript paths the operator has opted into; for Cursor's SQLite, polls the WAL marker. On change, dispatches the affected bytes/rows to the matching parser, then through the synthetic-span builder.

- [ ] **Step 1: Test — given a temp-dir Aider transcript, write some lines, watcher dispatches and a span lands in the in-memory test sink.**

- [ ] **Steps 2-5: Implement, pass, commit.**

### Task 3.10: Phase 3 PR

- [ ] **All tests green.**
- [ ] **Smoke: spawn a fresh Aider session in a temp dir; let watcher dispatch; verify a `pending_captures` row exists.**

---

## Phase 4 — Harness-bundle assembler

Build the operator's resolved harness configuration into a deterministic content-addressable bundle. The bundle is a `harness-bundle.v1` artifact whose sha256 is `executor.codeDigest`. Per-tool snapshot rules know which files to include; an `allowedDirectories` config bounds what can ever be read.

**Dependencies:** Phase 3 merged. (Path B parsers established the per-tool mental model.)

**Exit criteria:**
- `assembleBundle(sessionContext)` returns `{ sha256, files[], bytes }` deterministically.
- Per-tool snapshot rules implement the §3.2 file table for all six tools.
- `captures.harnessBundle.enabled = false` produces a bundle of `included: false` with the empty-bundle sentinel sha256.
- `allowedDirectories` enforced — files outside are never read.

### Task 4.1: `SnapshotRule` interface + registry

**Files:**
- Create: `client/src/trajectory/harness-bundle-rules/types.ts`
- Test: `client/test/trajectory/harness-bundle-rules/types.test.ts`

```typescript
// client/src/trajectory/harness-bundle-rules/types.ts
export interface SnapshotRule {
  readonly tool: string;
  /** Returns absolute paths to read (after allowedDirectories filter is applied by the assembler). */
  candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]>;
}
export const SNAPSHOT_RULE_REGISTRY: Record<string, SnapshotRule> = {};
export function registerRule(rule: SnapshotRule) { SNAPSHOT_RULE_REGISTRY[rule.tool] = rule; }
```

- [ ] **Steps follow the established TDD pattern.**

### Task 4.2: Per-tool snapshot rule — Claude Code

Files to consider: `~/.claude/CLAUDE.md`, `<repoRoot>/CLAUDE.md`, the model/hooks/mcpServers subset of `~/.claude/settings.json`, every file under `~/.claude/skills/`, every file under `~/.claude/plugins/<plugin>/skills/`, every MCP server config.

- [ ] **Test against a fixture `~/.claude/` directory in tmp.**

- [ ] **Implement.**

### Task 4.3: Per-tool snapshot rules — Codex / Gemini / Cursor / Aider / Continue

One sub-task per tool, following the §3.2 file table.

### Task 4.4: Deterministic bundle assembler

**Files:**
- Create: `client/src/trajectory/harness-bundle.ts`
- Test: `client/test/trajectory/harness-bundle.test.ts`

```typescript
// client/src/trajectory/harness-bundle.ts (sketch)
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SNAPSHOT_RULE_REGISTRY } from './harness-bundle-rules/types.js';
import { EMPTY_BUNDLE_SHA256 } from './schema.js';

export interface AssembleInput {
  tool: string;
  toolVersion?: string;
  home: string;
  repoRoot?: string;
  allowedDirectories: string[];     // absolute paths
  enabled: boolean;                 // captures.harnessBundle.enabled
  capturePath: 'A' | 'B' | 'C' | 'D';
}

export interface AssembleOutput {
  included: boolean;
  bundleSha256: string;
  manifest: HarnessBundleManifest | null;  // null when included=false
  files: { absolutePath: string; relPath: string; content: Buffer; sha256: string }[];
}

export async function assembleBundle(input: AssembleInput): Promise<AssembleOutput> {
  if (!input.enabled) {
    return { included: false, bundleSha256: EMPTY_BUNDLE_SHA256, manifest: null, files: [] };
  }
  const rule = SNAPSHOT_RULE_REGISTRY[input.tool];
  if (!rule) throw new Error(`no snapshot rule for tool: ${input.tool}`);
  const candidates = await rule.candidatePaths({ home: input.home, repoRoot: input.repoRoot });
  const allowed = candidates.filter((p) => input.allowedDirectories.some((root) => p.startsWith(root)));
  // Read each file; canonicalise (line endings); sha256 each; build sorted-by-relPath manifest; bundleSha256 = sha256(canonical-JSON(manifest)).
  // ...
}
```

- [ ] **Test: same input → same bundleSha256 across two runs (determinism).**

- [ ] **Test: `enabled: false` → empty-bundle sentinel.**

- [ ] **Test: file outside `allowedDirectories` is never read (assert on snapshot mock).**

### Task 4.5: Phase 4 PR.

---

## Phase 5 — Path C LLM-API proxy

Embed a forward proxy on a configurable local port; the operator points `ANTHROPIC_BASE_URL` (and/or `OPENAI_BASE_URL`) at it; the proxy logs request + response into synthetic spans. **Off by default** in v0 (`captures.llmProxy.enabled: false`).

**Dependencies:** Phase 1 merged.

**Exit criteria:**
- Proxy forwards Anthropic + OpenAI shape requests upstream and returns responses unchanged to clients.
- Each request/response pair generates synthetic spans in the same processor stack.
- `captures.llmProxy.enabled: false` skips proxy startup entirely.

### Task 5.1: Add `captures.llmProxy.{enabled,port}` to config

- [ ] **Modify `client/src/config.ts`.**

### Task 5.2: Anthropic shape forward proxy

**Files:**
- Create: `client/src/trajectory/llm-proxy.ts`
- Test: `client/test/trajectory/llm-proxy.test.ts`

- [ ] **Test: spin up upstream mock; client → proxy → upstream; response identical bytes; synthetic spans observed.**

- [ ] **Implement using `hono` (already a project dep).**

### Task 5.3: OpenAI shape forward proxy

Similar to 5.2 but for `/v1/chat/completions`.

### Task 5.4: Phase 5 PR.

---

## Phase 6 — Path D Stop hook + per-tool installers

Build the trigger path. `jinn-stop-hook` reads stdin (per-tool payload), normalises into `StopHookPayload`, POSTs to the daemon. Per-tool installer scripts patch each tool's settings file idempotently.

**Dependencies:** Phase 2 merged. (Path D needs the captures store to dedup boundary signals.)

**Exit criteria:**
- `jinn-stop-hook` binary callable from any of: Claude Code, Codex, Cursor, Gemini CLI.
- `jinn captures install-hooks` (or per-tool subcommand) idempotently patches the right settings file.
- A Claude Code session, on Stop, triggers a path-B safety-net ingest of the transcript path the hook carries.

### Task 6.1: `StopHookPayload` schema + binary

**Files:**
- Create: `client/bin/jinn-stop-hook.ts`
- Create: `client/src/api/stop-hook.ts`
- Test: `client/test/api/stop-hook.test.ts`, `client/test/bin/jinn-stop-hook.test.ts`

### Task 6.2: Per-tool installers (4 sub-tasks: Claude Code, Codex, Gemini CLI, Cursor).

Each installer is a function that:
1. Reads the tool's existing settings file (or creates if missing).
2. Idempotently inserts the Jinn stop-hook entry.
3. Writes back; preserves the operator's other settings.

- [ ] **Test: starting from a fixture settings file with operator-existing entries, the installer inserts the Jinn entry without removing/reordering the operator's entries.**

### Task 6.3: Phase 6 PR.

---

## Phase 7 — Captures-tab UI

Pending list, drill-in (with executor metadata card, harness-bundle summary, redaction diff, trajectory tree), batch approve/skip, per-repo trust toggle.

**Dependencies:** Phase 2, Phase 6 merged.

**Exit criteria:**
- Captures-tab navigation entry visible in the operator app.
- Pending captures list renders rows with all metadata fields (§4.4).
- Drill-in view shows the executor card and harness-bundle summary.
- Batch approve publishes captures (writes go to Phase 8's publish path; in this phase, we mock the publish API and assert it's called with the right envelope shape).
- Playwright covers golden path + skip + trust-this-repo edge cases.

### Task 7.1: HTTP API for captures (list/approve/skip/trust)

**Files:**
- Create: `client/src/api/captures.ts`
- Modify: `client/src/api/server.ts` (route registration)
- Test: `client/test/api/captures-endpoints.test.ts`

GET `/api/captures/pending` — list
GET `/api/captures/:sessionId` — drill-in detail
POST `/api/captures/:sessionId/approve` — mark approved + enqueue publish job
POST `/api/captures/:sessionId/skip` — mark skipped
POST `/api/captures/trust-repos` — set the operator's trusted-repo list

- [ ] **TDD each endpoint.**

### Task 7.2: SPA components

**Files:**
- Create: `client/src/dashboard/spa/src/captures/CapturesTab.tsx`, `CapturesList.tsx`, `CaptureDrillIn.tsx`, `RedactionDiff.tsx`, `HarnessIdCard.tsx`
- Modify: `client/src/dashboard/spa/src/App.routing.tsx`, `App.tsx`

- [ ] **Component tests using existing testing-jinn-app skill conventions (`testing-jinn-app` skill: SPA tests with mocked daemon API).**

### Task 7.3: Playwright e2e for the Captures flow

**Files:**
- Create: `client/src/dashboard/spa/test/captures-flow.spec.ts`

Cover: open Captures tab → see N pending → drill in to one → see executor card → flip skip/include bundle toggle → click approve → assert mock publish API called with the right envelope shape.

### Task 7.4: Phase 7 PR.

---

## Phase 8 — Capture publish path

Tie everything together: on approval, assemble the envelope (with executor mirror + harness-bundle artifact), IPFS-pin trajectory + harness-bundle + final-patch, sign, anchor via `IdentityRegistry.setMetadata`, index in subgraph (Phase 9).

**Dependencies:** Phase 4 + Phase 7 merged.

**Exit criteria:**
- A captured session in the queue, approved by the operator, publishes a `role='capture'` envelope to testnet with all required artifacts pinned and `setMetadata` called.
- Rate-limit + dedup logic enforced (per-operator + per-repo).
- Idle-window session-boundary detector produces clean boundaries when path D is unavailable.

### Task 8.1: `client/src/captures/publish.ts`

Composes: pull spans + bundle from the store, run scrub manifest sign, IPFS-pin every artifact via `corpus.publishArtifact`, assemble the envelope using `executor` from the harness-bundle assembler, sign, call `IdentityRegistry.setMetadata`.

- [ ] **TDD against a fully-mocked dependency tree (subgraph + IPFS + chain calls all mocked).**

### Task 8.2: Idle-window dedup detector

**Files:**
- Create: `client/src/captures/dedup.ts`
- Test: `client/test/captures/dedup.test.ts`

### Task 8.3: Rate limiter

**Files:**
- Create: `client/src/captures/rate-limit.ts`
- Test: `client/test/captures/rate-limit.test.ts`

Per-spec defaults: 10/hour per-operator (burst 30), 5/hour per-repo. Configurable.

### Task 8.4: Phase 8 PR.

---

## Phase 9 — Subgraph indexing for captures

Add `CaptureEnvelope`, `CapturesByRepo`, `CapturesByOperator` entities to the subgraph. Add `Task.sourceCaptureCid` field (used by Phase 12's task-generator).

**Dependencies:** Phase 8 merged. Subgraph deploy on testnet must complete before Phase 12 e2e.

**Exit criteria:**
- Subgraph schema migration deployed to testnet.
- Querying captures by repo or by operator returns correct results given existing testnet captures.

### Task 9.1: schema.graphql migration

### Task 9.2: mappings.ts handler for `role='capture'` envelopes

### Task 9.3: Subgraph test against a fixture envelope

### Task 9.4: Deploy migration to testnet; verify captures from Phase 8 e2e are indexable.

---

## Phase 10 — `session-derived` SolverNet contract + payloads + reference prompt

Fill in the schemas the Phase 0 scaffold left placeholder. Ship the foundation reference prompt as one option (non-canonical per §6.2).

**Dependencies:** Phase 0 merged. Contract scaffold exists.

**Exit criteria:**
- `SessionDerivedTaskSchema` / `SessionDerivedSolutionSchema` / `SessionDerivedVerdictSchema` exported from `packages/sdk/src/payloads/session-derived.ts`.
- `@jinn-network/session-derived-distill-prompt-v1` exported with sha256 hash exposed.
- Existing scaffold contract now references real schemas.

### Task 10.1: Task / Solution / Verdict zod schemas (per spec §5.3, §5.4)

### Task 10.2: Foundation reference prompt module

**Files:**
- Create: `packages/sdk/src/session-derived/distill-prompt-v1.ts`
- Test: `packages/sdk/test/session-derived/distill-prompt-v1.test.ts`

```typescript
// packages/sdk/src/session-derived/distill-prompt-v1.ts
import { createHash } from 'node:crypto';

export const SESSION_DERIVED_DISTILL_PROMPT_V1 = `You are decomposing a captured agent session into atomic Tasks for a SolverNet.

INPUT: a session trajectory (OTel spans), a final patch (if present), session
provenance (repo, commit, language), and the originating harness identity
(executor.implName + plugins[]: which tool, which skills, which plugins, which
model).
... (full prompt per §6.2)`;

export const SESSION_DERIVED_DISTILL_PROMPT_V1_SHA256 =
  createHash('sha256').update(SESSION_DERIVED_DISTILL_PROMPT_V1).digest('hex');
```

- [ ] **Test: prompt is non-empty; sha256 matches the spec's expected hash format.**
- [ ] **Test: prompt is intentionally non-canonical (export documents launchers may substitute).**

### Task 10.3: Replace contract scaffold placeholders with real schemas

### Task 10.4: Phase 10 PR.

---

## Phase 11 — Composite evaluator

`@jinn-network/session-derived-evaluator`: weighted composite over test-suite re-run + structural-similarity + LLM-judge. Renormalises across present signals.

**Dependencies:** Phase 10 merged.

**Exit criteria:**
- Three signal modules (test-suite-rerun.ts, structural-similarity.ts, llm-judge.ts) implemented + tested.
- Composite combiner produces normalised scores per §5.4.
- Verdict carries the per-signal breakdown.

### Task 11.1: Test-suite re-run signal

`{ score, weight: 0.5, present }` — runs the Task's `expected_artifacts.test_suite_ref` against the candidate Solution patch.

- [ ] **TDD against a fixture Docker test-suite + a known-good patch + a known-bad patch.**

### Task 11.2: Structural similarity signal

`{ score, weight: 0.3, present }` — diff-distance metric between candidate patch and gold patch.

### Task 11.3: LLM-judge signal

`{ score, weight: 0.2, present, reasoning }` — Claude/GPT call with a fixed-prompt rubric.

### Task 11.4: Composite combiner

```typescript
function composite(signals: { score: number; weight: number; present: boolean }[]) {
  const present = signals.filter((s) => s.present);
  const totalWeight = present.reduce((a, s) => a + s.weight, 0);
  return present.reduce((a, s) => a + (s.score * s.weight) / totalWeight, 0);
}
```

- [ ] **Tests for renormalisation: missing test-suite + missing gold → LLM-judge alone is the score.**

### Task 11.5: Phase 11 PR.

---

## Phase 12 — Task-generator

Polls corpus for `role='capture'` envelopes; pays x402 to read trajectory + harness-bundle; LLM-distils via Phase 10's reference prompt; quality-gates; posts to JinnRouter.

**Dependencies:** Phase 9 + Phase 10 + Phase 11 merged.

**Exit criteria:**
- Generator started by `daemon.ts` when a launched `session-derived.v0` manifest exists with this operator as launcher.
- Generator polls subgraph, pays x402, runs LLM call, applies gates, posts at least one Task on testnet from a Phase 8 capture.

### Task 12.1: `_session-derived-pool.ts` corpus poll + dedup

### Task 12.2: `_session-derived-distill.ts` LLM call + quality gates

### Task 12.3: `_session-derived-state.ts` generator state store

### Task 12.4: `solver-types/session-derived.ts` SolverTypeDefinition

### Task 12.5: Register in `client/src/solver-types/index.ts`

### Task 12.6: Phase 12 PR.

---

## Phase 13 — E2E + acceptance + import CLI

Tie the full §8.2 acceptance bundle together. Generic `jinn capture import <file>` CLI for the long-tail fallback.

**Dependencies:** Phase 12 merged.

**Exit criteria:** all 10 §8.2 criteria pass.

### Task 13.1: `client/src/cli/commands/capture.ts` for the import path

`jinn capture import path/to/otel-trace.json [--repo .] [--license MIT]`
`jinn capture import path/to/transcript.jsonl --tool aider [--repo .]`

### Task 13.2: Snapshot test: capture envelope vs. claude-code-learner solver Solution have isomorphic envelope shapes (§8.2 #2a)

```typescript
// client/test/captures/envelope-shape-isomorphism.test.ts
import { describe, it, expect } from 'vitest';
import { captureEnvelopeFixture } from './fixtures/capture-envelope.js';
import { learnerSolutionEnvelopeFixture } from './fixtures/learner-solution-envelope.js';

describe('capture vs solver envelope isomorphism', () => {
  it('captures and solver Solutions have the same executor shape', () => {
    const capExec = captureEnvelopeFixture.executor;
    const solExec = learnerSolutionEnvelopeFixture.executor;
    expect(Object.keys(capExec).sort()).toEqual(Object.keys(solExec).sort());
    expect(typeof capExec.codeDigest).toBe(typeof solExec.codeDigest);
    expect(typeof capExec.runtimeBundleDigest).toBe(typeof solExec.runtimeBundleDigest);
    expect(Array.isArray(capExec.plugins)).toBe(true);
    expect(Array.isArray(solExec.plugins)).toBe(true);
  });

  it('only legitimate differences are role + provenance swap', () => {
    expect(captureEnvelopeFixture.role).toBe('capture');
    expect(learnerSolutionEnvelopeFixture.role).toBe('restoration');
    expect(captureEnvelopeFixture.task).toBeUndefined();
    expect(learnerSolutionEnvelopeFixture.task).toBeDefined();
    expect(captureEnvelopeFixture.sessionProvenance).toBeDefined();
    expect(learnerSolutionEnvelopeFixture.sessionProvenance).toBeUndefined();
  });
});
```

### Task 13.3: `client/scripts/e2e-capture-validate.ts`

End-to-end script (parallel to `e2e-validate.ts`):
1. Spawn Anvil fork.
2. Run jinn-client daemon with capture config enabled.
3. Spawn a fixture Claude Code session (using `mock-agent.ts` style) emitting OTel.
4. Verify pending capture exists.
5. Programmatically approve.
6. Verify envelope CID anchored on testnet, subgraph indexes it.
7. Spawn a launched `session-derived.v0` manifest; run task-generator pass.
8. Verify at least one Task posted on testnet with `sourceCaptureCid` matching the capture from step 6.

- [ ] **Wire into `package.json` as `yarn e2e:capture`.**

### Task 13.4: Phase 13 PR.

After this PR merges and CI green, this plan is complete and the §8.2 bundle is satisfied. Proceed to spec §8.3 v0.5 work as separate plans.

---

## Plan summary table

| Phase | Days | PR scope | Blocks |
|---|---|---|---|
| 0 | 2 | Schema + scaffolding | — |
| 1 | 7 | OTLP receiver + processor stack + collector migration | Phase 0 |
| 2 | 2 | Pending captures store | Phase 1 |
| 3 | 12 | Path B watchers + 6 parsers | Phase 2 |
| 4 | 8 | Harness-bundle assembler + 6 snapshot rules | Phase 3 |
| 5 | 4 | Path C LLM-API proxy | Phase 1 |
| 6 | 5 | Path D Stop hook + 4 installers | Phase 2 |
| 7 | 8 | Captures-tab UI | Phase 2, 6 |
| 8 | 4 | Publish path + dedup + rate limit | Phase 4, 7 |
| 9 | 2 | Subgraph indexing | Phase 8 |
| 10 | 2 | SolverNet contract + reference prompt | Phase 0 |
| 11 | 6 | Composite evaluator | Phase 10 |
| 12 | 6 | Task-generator | Phase 9, 10, 11 |
| 13 | 4 | E2E + import CLI + acceptance | Phase 12 |
| **Total** | **~70 days, ~14 weeks** | | |

Phases 1+5 are independent of Phases 2+3+4+6+7+8 in that they touch different files; can be parallelised across two contributors. Phases 10+11 are independent of 1-8; can be parallelised. Phase 12 sequences Phases 9, 10, 11.

---

## Risk register

- **Phase 1 receiver complexity.** OTLP gRPC + HTTP is non-trivial wire-format work. If the SDK's bundled receiver helper turns out to be private API or unsuitable, fallback is to use `@open-telemetry/otlp-grpc-exporter-base` and roll the receiver explicitly — adds ~3-4 days. Mitigate by spiking Task 1.1 first thing in Phase 1.
- **Phase 3 Cursor SQLite WAL tail.** Cursor's schema is undocumented and may change between Cursor versions. If parsing proves fragile, fall back to path D Stop hook + read-the-transcript-on-stop instead of live tailing — degrades latency but works.
- **Phase 4 deterministic hashing across hosts.** Line endings and file ordering can poison determinism. Add an explicit canonicalisation step (line endings → `\n`, sort by relPath, canonical JSON for any structured-data file) in Task 4.4 and assert with cross-host fixture tests.
- **Phase 11 LLM-judge cost.** Verdicts call an LLM. Budget per Task should be < $0.10 to keep evaluator economics viable. If Claude judge is too expensive, fall back to a smaller open-source model via Ollama.
- **Phase 12 x402 polling cost.** The generator pays x402 to read every capture. If many operators publish many captures, foundation budget is consumed quickly. v0 mitigation: foundation launcher applies a freshness filter (only captures from the past 7 days) and a per-repo cap (max N captures distilled per repo per day). v0.5+ revisits with proper cost models.

---

## Self-review

1. **Spec coverage.** §8.1 component table:
   - Envelope schema additions → Task 0.1
   - captureManifest schema → Task 0.2
   - Path A: embedded OTLP receiver → Task 1.1
   - Path B: transcript-tail watchers → Phase 3 (10 tasks)
   - Path B: per-tool transcript parsers → Tasks 3.3-3.8
   - Path C: LLM-API proxy → Phase 5
   - Path D: jinn-stop-hook + per-tool config → Phase 6
   - OTel processor stack → Tasks 1.2-1.6
   - Migration of existing collector → Task 1.7
   - Pending captures store → Task 2.1
   - Captures tab (UI) → Phase 7
   - Generic import CLI → Task 13.1
   - session-derived SolverNet contract → Task 0.4 + Task 10.1-10.3
   - Composite evaluator → Phase 11
   - bundled:session-derived-runtime plugin → not yet covered ⚠️
   - Task-generator → Phase 12
   - Subgraph → Phase 9
   - Tests → distributed throughout
   - Harness-bundle assembler → Phase 4
   - Per-tool harness-bundle snapshot rules → Tasks 4.2-4.3

   **Gap:** `bundled:session-derived-runtime` plugin (per §8.1 row "tools the solver harness needs"). Add Task 12.7 below.

2. **Placeholder scan:** Several "Steps follow the 3.3 pattern" / "Steps 2-5: Implement, pass, commit" references in Phase 3 (Tasks 3.4, 3.5, 3.7, 3.8) and Phase 4 (Task 4.3). These are flagged for the executor to reuse the Task 3.3 detail as the canonical pattern. Acceptable per the writing-plans skill's "if pattern is established, reference once not repeat" allowance — but the engineer reading these out of order might miss it. **Mitigation:** at the start of Phase 3, include a "Pattern note" calling out that 3.3 is the canonical example and 3.4-3.8 follow it.

3. **Type consistency:** `TranscriptParser` in Task 3.1 uses tool union `'claude-code' | 'codex' | 'gemini-cli' | 'cursor' | 'aider' | 'continue'`. Same union appears in Task 4.1 `SnapshotRule.tool: string` (less strict). Tighten 4.1 to the same union to avoid drift. Already noted as a fix-inline.

### Task 3.0 (added during self-review): Pattern note for Phase 3 parsers

Insert at the top of Phase 3, before Task 3.1:

> **Pattern note for Tasks 3.3-3.8:** Task 3.3 (Claude Code JSONL) is the canonical implementation pattern. Subsequent parsers (Codex, Gemini CLI, Aider, Continue, Cursor) repeat the same six-step shape: (1) capture a fixture transcript with identity scrub applied; (2) write a failing test that parses the fixture and asserts > 0 events of each kind the tool emits; (3) run test, see fail; (4) implement parser following Task 3.3's structure (a `parseChunk` for incremental + `parseFull` for one-shot); (5) run test, see pass; (6) commit. Cursor (Task 3.6) replaces the JSONL fixture with a SQLite snapshot fixture.

### Task 4.1 fix-inline: tighten SnapshotRule.tool union

Change `readonly tool: string;` to `readonly tool: 'claude-code' | 'codex' | 'gemini-cli' | 'cursor' | 'aider' | 'continue';` to match TranscriptParser.

### Task 12.7 (added during self-review): `bundled:session-derived-runtime` plugin

**Files:**
- Create: `packages/runtime-plugins/session-derived-runtime/package.json`
- Create: `packages/runtime-plugins/session-derived-runtime/src/index.ts`

The plugin bundles the tools the `session-derived.v0` solver harness needs:
- Docker CLI access (for test-suite re-run)
- Patch tool (`apply-patch.sh` shipped today by claude-code-learner)
- A reasoning-trace logger that wraps each tool call so the solver's emitted trajectory is OTel-shaped

- [ ] **Step 1: scaffold package.json with workspace deps.**
- [ ] **Step 2: write index.ts exporting the plugin manifest the SolverNet contract's `defaultRuntimePlugins` references.**
- [ ] **Step 3: integration test — solver harness can spawn with this plugin and run a fixture session-derived Task.**
- [ ] **Step 4: Phase 12 PR scope updated to include this.**

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-07-telemetry-collector-and-task-generator-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
