# Envelope V1 — Plan D: `jinn.trajectory.v1` OTel Profile + In-Run Hash Chain + V1 Secret-Scrub

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Light up the `trajectory` field on the generic `jinn.execution.v1` envelope (landed in Plan C, currently hardcoded `null`). Every restorer and evaluator run produces a structured, signed `jinn.trajectory.v1` OTLP-JSON blob, uploaded to IPFS, with the CID + sha256 populated on the envelope. The blob carries a normative span profile (required attributes per `jinn.span.kind`), a per-span hash chain (`jinn.prevSpanHash`) that makes partial/truncated traces verifiable-as-prefix, a V1 secret-scrub pass with a signed redaction manifest, and bidirectional trajectory↔artifact linkage.

**Architecture:** New `client/src/trajectory/` module hosts the collector, schema, span profile, hash chain, secret-scrub, emitter, and three traced I/O wrappers (HTTP / MCP / subprocess). The engine instantiates a `TrajectoryCollector` at run start, threads it through the `RestorationContext`, and calls `emitTrajectory(...)` before envelope assembly. Per-impl session orchestrators swap their raw `fetch` / MCP / `spawn` calls for the traced wrappers so every meaningful I/O surfaces as a span. `envelope-assembly.ts` accepts `{ cid, sha256 }` in its inputs and writes them onto the envelope's `trajectory` field. Trajectory signing reuses `signCanonical` + JCS from Plan A; span hashing uses keccak256 (viem) over JCS of the previous span.

**Tech Stack:** TypeScript, Vitest, `@opentelemetry/api` (types only — we write our own in-memory processor to avoid SDK churn), viem (`keccak256`, `toBytes`), existing `canonicalJson` (JCS — Plan A), existing `signCanonical` (Plan C), existing `uploadToIpfs` (adapters/mech/ipfs.ts).

**Non-goals for this slice:**

- No TEE attestation binding of trajectory (V2 — attested-tier `REPORTDATA` binds trajectory digest; V1 trajectory stands alone).
- No TLS-transcript CIDs inside spans (attested-tier extension; V2).
- No streaming / append-signed uploads (V1 is end-of-run one-shot per scope §3.1 row 3).
- No conformance suite execution (Plan F consumes the span-profile checker this plan ships, but Plan F wires it into the operator-facing harness).
- No subgraph integration (Plan G indexes trajectory metadata).
- No trajectory-content indexing (out of scope per scope §3.3).
- No learning-style promotion-record spans (scope §4 item 12 — executor-specific, deferred).

**Before you start:** Plans A (JCS), B (`intent.v1`), and C (generic envelope + artifactType + `assembleAndSignEnvelope`) must all be merged. Plan D populates `envelope.trajectory` — the field itself and the `{ cid, sha256 }` shape both come from Plan C.

**Reference:** `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §2.5 (uniform-schema principle — trajectory required at all tiers), §3.1 (K5 trajectory↔artifact linkage, K6 normative OTel span profile, K9 role vocab, trajectory-signing-granularity row — in-run hash chain), §3.2 (traced I/O boundary), §3.3 (K7 verdict→restoration link — evaluator trajectories are smaller but present), §4.3 (trajectory profile deliverable), §4.10 (conformance suite traced-I/O list — we wire the shims here; Plan F runs the checks).

---

## File structure

New files:

- `client/src/trajectory/schema.ts` — `JinnTrajectoryV1Schema`, `SpanSchema`, `JinnSpanKindSchema` (`jinn.phase`, `jinn.llm_call`, `jinn.mcp_call`, `jinn.artifact.emit`, `jinn.venue_io`, `jinn.state_transition`), redaction-manifest schema.
- `client/src/trajectory/collector.ts` — `TrajectoryCollector` class; span accumulator + start/end helpers + scrub-on-add + hash-chain-on-add.
- `client/src/trajectory/span-profile.ts` — `SPAN_PROFILE` table (required attributes per kind) + `validateSpanProfile(span)` conformance checker.
- `client/src/trajectory/hash-chain.ts` — `computePrevSpanHash(span)` + `GENESIS_HASH(intentCid)` helpers.
- `client/src/trajectory/secret-scrub.ts` — `SECRET_NAME_PATTERNS` allowlist (deny-by-match) + `scrubAttributes(attrs)` + `scrubMcpArgs(args)` helpers.
- `client/src/trajectory/emit.ts` — `emitTrajectory({ collector, intentCid, runId, signer, ipfsRegistryUrl }) → { cid, sha256 }`.
- `client/src/trajectory/wrappers/http.ts` — `tracedHttpCall({ collector, parentSpanId?, req, reqKind })` emitting `jinn.llm_call` or `jinn.venue_io` spans.
- `client/src/trajectory/wrappers/mcp.ts` — `tracedMcpCall({ collector, parentSpanId?, server, tool, args, invoke })` emitting `jinn.mcp_call` spans.
- `client/src/trajectory/wrappers/subprocess.ts` — `tracedSpawn({ collector, parentSpanId?, cmd, args, env })` emitting `jinn.state_transition`-adjacent span events over stdout/stderr.
- `client/src/trajectory/index.ts` — re-exports for consumers.
- Tests mirroring every file above under `client/test/trajectory/`.

Modified files:

- `client/src/restorer/types.ts` — add `trajectory: TrajectoryCollector` to `RestorationContext`.
- `client/src/restorer/engine/engine.ts` — create collector at run start, emit `jinn.phase` + `jinn.state_transition` spans, call `emitTrajectory` before envelope assembly, pass `{ cid, sha256 }` into `assembleAndSignEnvelope`.
- `client/src/restorer/engine/envelope-assembly.ts` — accept `trajectory` input and populate `envelope.trajectory` (Plan C already reserved the field).
- `client/src/restorer/engine/packaging.ts` — after artifact upload, emit `jinn.artifact.emit` spans + attach `producedBy: { spanId, trajectoryCid }` metadata. (`trajectoryCid` is backfilled by the engine when it calls `emitTrajectory` — see Task 16.)
- `client/src/runner/claude.ts` — wrap subprocess spawn via `tracedSpawn`; emit `jinn.state_transition` span events around phases.
- `client/src/restorer/impls/claude-mcp-hyperliquid/session-orchestrator.ts` — swap raw Claude HTTP + MCP calls for traced wrappers.
- `client/src/restorer/impls/claude-mcp-prediction/session-orchestrator.ts` — same.
- `client/src/restorer/impls/claude-mcp-prediction-apy/session-orchestrator.ts` — same.
- Evaluator impls (`portfolio-v0-evaluator`, `prediction-v0-evaluator`, `prediction-apy-v0-evaluator`) — instantiate a (smaller) collector, emit `jinn.venue_io` + `jinn.state_transition` spans around venue fetches + scoring stages.

---

## Task 1: Define `jinn.trajectory.v1` schema + span-kind enum

**Files:**

- Create: `client/src/trajectory/schema.ts`
- Create: `client/test/trajectory/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/trajectory/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  JinnSpanKindSchema,
  SpanSchema,
  RedactionManifestSchema,
  JinnTrajectoryV1Schema,
} from '../../src/trajectory/schema.js';

describe('JinnSpanKindSchema', () => {
  it('accepts every normative kind', () => {
    for (const k of [
      'jinn.phase',
      'jinn.llm_call',
      'jinn.mcp_call',
      'jinn.artifact.emit',
      'jinn.venue_io',
      'jinn.state_transition',
    ]) {
      expect(() => JinnSpanKindSchema.parse(k)).not.toThrow();
    }
  });
  it('rejects unknown kinds', () => {
    expect(() => JinnSpanKindSchema.parse('jinn.gossip')).toThrow();
  });
});

describe('SpanSchema', () => {
  const base = {
    traceId: '0'.repeat(32),
    spanId: '1'.repeat(16),
    parentSpanId: null,
    name: 'phase.design',
    kind: 'INTERNAL',
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000001000000',
    attributes: {
      'jinn.span.kind': 'jinn.phase',
      'jinn.prevSpanHash': '0x' + 'aa'.repeat(32),
    },
    events: [],
    status: { code: 'OK' },
  };

  it('accepts a minimal span', () => {
    expect(() => SpanSchema.parse(base)).not.toThrow();
  });

  it('rejects a span without jinn.prevSpanHash', () => {
    const { attributes: _a, ...rest } = base;
    expect(() =>
      SpanSchema.parse({
        ...rest,
        attributes: { 'jinn.span.kind': 'jinn.phase' },
      }),
    ).toThrow();
  });

  it('rejects a span without jinn.span.kind', () => {
    expect(() =>
      SpanSchema.parse({
        ...base,
        attributes: { 'jinn.prevSpanHash': '0x' + 'bb'.repeat(32) },
      }),
    ).toThrow();
  });
});

describe('RedactionManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const m = {
      spans: [{ spanId: '1'.repeat(16), redactedKeys: ['http.request.header.authorization'] }],
      totalRedactions: 1,
    };
    expect(() => RedactionManifestSchema.parse(m)).not.toThrow();
  });

  it('rejects when totalRedactions disagrees with spans sum', () => {
    const m = {
      spans: [{ spanId: '1'.repeat(16), redactedKeys: ['a', 'b'] }],
      totalRedactions: 1,
    };
    expect(() => RedactionManifestSchema.parse(m)).toThrow();
  });
});

describe('JinnTrajectoryV1Schema', () => {
  const valid = {
    schemaVersion: 'jinn.trajectory.v1',
    runId: '550e8400-e29b-41d4-a716-446655440000',
    parentEnvelopeCid: null,
    spans: [],
    redactionManifest: { spans: [], totalRedactions: 0 },
    signature: {
      algo: 'secp256k1',
      signer: '0x' + '22'.repeat(20),
      hash: '0x' + 'ef'.repeat(32),
      sig: '0x' + '12'.repeat(65),
    },
  };

  it('accepts a well-formed trajectory blob', () => {
    expect(() => JinnTrajectoryV1Schema.parse(valid)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() =>
      JinnTrajectoryV1Schema.parse({ ...valid, schemaVersion: 'jinn.trajectory.v2' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd client
yarn vitest run test/trajectory/schema.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Write `client/src/trajectory/schema.ts`**

```typescript
/**
 * jinn.trajectory.v1 — OTLP-JSON-shaped trace blob signed and uploaded once
 * per run. Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 trajectory row + K6 span profile, §4.3 trajectory profile deliverable.
 *
 * Each span carries jinn.prevSpanHash (in-run hash chain) + jinn.span.kind
 * (normative profile). Secret-scrub (§4.3 V1 minimum) produces a run-level
 * redactionManifest signed alongside the spans.
 */

import { z } from 'zod';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const JinnSpanKindSchema = z.enum([
  'jinn.phase',
  'jinn.llm_call',
  'jinn.mcp_call',
  'jinn.artifact.emit',
  'jinn.venue_io',
  'jinn.state_transition',
]);
export type JinnSpanKind = z.infer<typeof JinnSpanKindSchema>;

const EventSchema = z.object({
  timeUnixNano: z.string(),
  name: z.string(),
  attributes: z.record(z.unknown()).optional(),
});

const SpanStatusSchema = z.object({
  code: z.enum(['UNSET', 'OK', 'ERROR']),
  message: z.string().optional(),
});

/** An OTLP-shaped span with Jinn-required attributes. */
export const SpanSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parentSpanId: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
  name: z.string().min(1),
  kind: z.enum(['INTERNAL', 'CLIENT', 'SERVER', 'PRODUCER', 'CONSUMER']),
  startTimeUnixNano: z.string(),
  endTimeUnixNano: z.string(),
  attributes: z
    .record(z.unknown())
    .refine((a) => typeof a['jinn.span.kind'] === 'string', {
      message: 'jinn.span.kind attribute required',
    })
    .refine((a) => typeof a['jinn.prevSpanHash'] === 'string', {
      message: 'jinn.prevSpanHash attribute required',
    }),
  events: z.array(EventSchema),
  status: SpanStatusSchema,
});
export type Span = z.infer<typeof SpanSchema>;

export const RedactionManifestSchema = z
  .object({
    spans: z.array(
      z.object({
        spanId: z.string().regex(/^[0-9a-f]{16}$/),
        redactedKeys: z.array(z.string()),
      }),
    ),
    totalRedactions: z.number().int().nonnegative(),
  })
  .refine(
    (m) => m.spans.reduce((acc, s) => acc + s.redactedKeys.length, 0) === m.totalRedactions,
    { message: 'totalRedactions must equal sum of per-span redactedKeys' },
  );
export type RedactionManifest = z.infer<typeof RedactionManifestSchema>;

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

export const JinnTrajectoryV1Schema = z.object({
  schemaVersion: z.literal('jinn.trajectory.v1'),
  runId: z.string().min(1),
  parentEnvelopeCid: z.string().nullable(),
  spans: z.array(SpanSchema),
  redactionManifest: RedactionManifestSchema,
  signature: SignatureSchema,
});
export type JinnTrajectoryV1 = z.infer<typeof JinnTrajectoryV1Schema>;

/** Unsigned form — what we hash + sign. */
export const UnsignedTrajectorySchema = JinnTrajectoryV1Schema.omit({ signature: true });
export type UnsignedTrajectory = z.infer<typeof UnsignedTrajectorySchema>;
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/schema.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
cd client
yarn typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/trajectory/schema.ts client/test/trajectory/schema.test.ts
git commit -m "feat(trajectory): jinn.trajectory.v1 schema + span-kind enum

Six normative span kinds per scope §3.1 K6. Spans require
jinn.span.kind + jinn.prevSpanHash attributes. Trajectory blob is
signed + uploaded once per run; redactionManifest is signed alongside
the spans (scope §4.3 V1 minimum secret-scrub)."
```

---

## Task 2: Normative span profile + conformance checker

**Files:**

- Create: `client/src/trajectory/span-profile.ts`
- Create: `client/test/trajectory/span-profile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/trajectory/span-profile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateSpanProfile, SPAN_PROFILE } from '../../src/trajectory/span-profile.js';
import type { Span } from '../../src/trajectory/schema.js';

function mkSpan(kind: string, attrs: Record<string, unknown>): Span {
  return {
    traceId: '0'.repeat(32),
    spanId: '1'.repeat(16),
    parentSpanId: null,
    name: 'test',
    kind: 'INTERNAL',
    startTimeUnixNano: '1',
    endTimeUnixNano: '2',
    attributes: {
      'jinn.span.kind': kind,
      'jinn.prevSpanHash': '0x' + 'aa'.repeat(32),
      ...attrs,
    },
    events: [],
    status: { code: 'OK' },
  };
}

describe('validateSpanProfile', () => {
  it('accepts jinn.phase with jinn.phase.name', () => {
    const s = mkSpan('jinn.phase', { 'jinn.phase.name': 'design' });
    expect(validateSpanProfile(s)).toEqual({ valid: true });
  });

  it('rejects jinn.phase missing jinn.phase.name', () => {
    const s = mkSpan('jinn.phase', {});
    const r = validateSpanProfile(s);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.missing).toContain('jinn.phase.name');
  });

  it('accepts jinn.llm_call with full gen_ai attrs', () => {
    const s = mkSpan('jinn.llm_call', {
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'claude-opus-4-7',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('rejects jinn.llm_call missing gen_ai.request.model', () => {
    const s = mkSpan('jinn.llm_call', { 'gen_ai.system': 'anthropic' });
    expect(validateSpanProfile(s).valid).toBe(false);
  });

  it('accepts jinn.mcp_call with server/tool attrs', () => {
    const s = mkSpan('jinn.mcp_call', {
      'mcp.server.name': 'hyperliquid',
      'mcp.tool.name': 'place_order',
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('accepts jinn.artifact.emit with cid/type/sha256', () => {
    const s = mkSpan('jinn.artifact.emit', {
      'jinn.artifact.cid': 'bafy-x',
      'jinn.artifact.artifactType': 'system_snapshot',
      'jinn.artifact.sha256': 'ab'.repeat(32),
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('accepts jinn.venue_io with net.peer attrs', () => {
    const s = mkSpan('jinn.venue_io', {
      'net.peer.name': 'api.hyperliquid-testnet.xyz',
      'http.request.method': 'POST',
      'http.response.status_code': 200,
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('accepts jinn.state_transition with from/to', () => {
    const s = mkSpan('jinn.state_transition', {
      'jinn.state.from': 'CLAIMED',
      'jinn.state.to': 'PACKAGED',
    });
    expect(validateSpanProfile(s).valid).toBe(true);
  });

  it('SPAN_PROFILE covers every normative kind', () => {
    for (const k of [
      'jinn.phase',
      'jinn.llm_call',
      'jinn.mcp_call',
      'jinn.artifact.emit',
      'jinn.venue_io',
      'jinn.state_transition',
    ]) {
      expect(SPAN_PROFILE[k]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test — verify fail**

```bash
cd client
yarn vitest run test/trajectory/span-profile.test.ts
```

Expected: FAIL (module-not-found).

- [ ] **Step 3: Implement `client/src/trajectory/span-profile.ts`**

```typescript
/**
 * Normative span profile per scope §3.1 K6 + §4.3.
 *
 * For each jinn.span.kind, declares required attribute keys. Consumers
 * (Plan F conformance suite, manifest-validation layer) call
 * validateSpanProfile to check each span in a trajectory.
 *
 * Required attributes at V1 (all tiers). Attested-tier extensions (TLS
 * transcript CIDs) layer on top in V2.
 */

import type { Span, JinnSpanKind } from './schema.js';

export const SPAN_PROFILE: Record<JinnSpanKind, readonly string[]> = {
  'jinn.phase': ['jinn.phase.name'],
  'jinn.llm_call': [
    'gen_ai.system',
    'gen_ai.request.model',
    'gen_ai.usage.input_tokens',
    'gen_ai.usage.output_tokens',
  ],
  'jinn.mcp_call': ['mcp.server.name', 'mcp.tool.name'],
  'jinn.artifact.emit': [
    'jinn.artifact.cid',
    'jinn.artifact.artifactType',
    'jinn.artifact.sha256',
  ],
  'jinn.venue_io': [
    'net.peer.name',
    'http.request.method',
    'http.response.status_code',
  ],
  'jinn.state_transition': ['jinn.state.from', 'jinn.state.to'],
};

export type SpanProfileResult =
  | { valid: true }
  | { valid: false; missing: string[]; kind: string };

export function validateSpanProfile(span: Span): SpanProfileResult {
  const kind = span.attributes['jinn.span.kind'] as JinnSpanKind;
  const required = SPAN_PROFILE[kind];
  if (!required) return { valid: false, missing: ['<unknown-kind>'], kind };
  const missing = required.filter((k) => span.attributes[k] === undefined);
  if (missing.length > 0) return { valid: false, missing, kind };
  return { valid: true };
}

/** Bulk-validate all spans in a trajectory. Returns first failure, or null if all pass. */
export function findFirstProfileViolation(spans: Span[]): {
  span: Span;
  result: Exclude<SpanProfileResult, { valid: true }>;
} | null {
  for (const s of spans) {
    const r = validateSpanProfile(s);
    if (!r.valid) return { span: s, result: r };
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/span-profile.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/span-profile.ts client/test/trajectory/span-profile.test.ts
git commit -m "feat(trajectory): normative span profile + validator

Six normative kinds with required-attribute lists per scope §3.1 K6.
findFirstProfileViolation surfaces the first non-conforming span for
downstream conformance checks (Plan F)."
```

---

## Task 3: In-run hash chain helpers

**Files:**

- Create: `client/src/trajectory/hash-chain.ts`
- Create: `client/test/trajectory/hash-chain.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { computePrevSpanHash, computeGenesisHash } from '../../src/trajectory/hash-chain.js';
import { canonicalJson } from '../../src/restorer/engine/canonical-json.js';
import type { Span } from '../../src/trajectory/schema.js';

describe('computeGenesisHash', () => {
  it('returns keccak256(JCS({runStart: intentCid}))', () => {
    const intentCid = 'bafy-intent';
    const expected = keccak256(toBytes(canonicalJson({ runStart: intentCid })));
    expect(computeGenesisHash(intentCid)).toBe(expected);
  });

  it('is stable for the same intent CID', () => {
    expect(computeGenesisHash('bafy-x')).toBe(computeGenesisHash('bafy-x'));
  });

  it('differs for different intent CIDs', () => {
    expect(computeGenesisHash('bafy-x')).not.toBe(computeGenesisHash('bafy-y'));
  });
});

describe('computePrevSpanHash', () => {
  function mk(spanId: string): Span {
    return {
      traceId: '0'.repeat(32),
      spanId,
      parentSpanId: null,
      name: 'n',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.phase',
        'jinn.prevSpanHash': '0x' + 'aa'.repeat(32),
      },
      events: [],
      status: { code: 'OK' },
    };
  }

  it('returns keccak256 of JCS(span)', () => {
    const s = mk('1'.repeat(16));
    const expected = keccak256(toBytes(canonicalJson(s)));
    expect(computePrevSpanHash(s)).toBe(expected);
  });

  it('is deterministic across re-computations', () => {
    const s = mk('2'.repeat(16));
    expect(computePrevSpanHash(s)).toBe(computePrevSpanHash(s));
  });

  it('changes when any span field changes', () => {
    const a = mk('3'.repeat(16));
    const b = { ...a, name: 'different' };
    expect(computePrevSpanHash(a)).not.toBe(computePrevSpanHash(b));
  });
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
cd client
yarn vitest run test/trajectory/hash-chain.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `client/src/trajectory/hash-chain.ts`**

```typescript
/**
 * In-run per-span hash chain.
 *
 * Scope: §3.1 trajectory-signing-granularity row — "each span carries
 * jinn.prevSpanHash linking to the previous span's hash; first span
 * links to a run-start genesis value derived from envelope intent CID."
 *
 * Motivation: a crashed run that failed to upload the signed trajectory
 * blob still produces a verifiable-as-prefix trace if spans are recovered
 * elsewhere (enclave memory dump, challenger capture). Partial authenticity
 * is not zero.
 */

import { keccak256, toBytes, type Hex } from 'viem';
import { canonicalJson } from '../restorer/engine/canonical-json.js';
import type { Span } from './schema.js';

/** Genesis value for the chain — keccak256(JCS({runStart: intentCid})). */
export function computeGenesisHash(intentCid: string): Hex {
  return keccak256(toBytes(canonicalJson({ runStart: intentCid })));
}

/** Hash of a finalized span, to be set as jinn.prevSpanHash on the next one. */
export function computePrevSpanHash(span: Span): Hex {
  return keccak256(toBytes(canonicalJson(span)));
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/hash-chain.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/hash-chain.ts client/test/trajectory/hash-chain.test.ts
git commit -m "feat(trajectory): in-run hash chain helpers

computeGenesisHash(intentCid) seeds the chain; computePrevSpanHash(span)
hashes a finalized span. JCS (Plan A) + keccak256 (viem). Scope §3.1."
```

---

## Task 4: V1 secret-scrub — patterns + attribute walker

**Files:**

- Create: `client/src/trajectory/secret-scrub.ts`
- Create: `client/test/trajectory/secret-scrub.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import {
  SECRET_NAME_PATTERNS,
  isSecretKey,
  scrubAttributes,
  scrubMcpArgs,
} from '../../src/trajectory/secret-scrub.js';

describe('isSecretKey', () => {
  it('matches authorization / apiKey / bearer / password / secret / token / privateKey (case-insensitive)', () => {
    for (const k of [
      'authorization',
      'apiKey',
      'API_KEY',
      'bearer',
      'password',
      'secret',
      'token',
      'privateKey',
      'http.request.header.authorization',
      'some.weird.api_key',
      'x.bearer.something',
    ]) {
      expect(isSecretKey(k)).toBe(true);
    }
  });

  it('does not match non-secret keys', () => {
    for (const k of ['gen_ai.request.model', 'mcp.tool.name', 'net.peer.name', 'jinn.phase.name']) {
      expect(isSecretKey(k)).toBe(false);
    }
  });
});

describe('scrubAttributes', () => {
  it('replaces secret values with <redacted:keyname> and records the key', () => {
    const attrs = {
      'gen_ai.request.model': 'claude',
      'http.request.header.authorization': 'Bearer sk-abc',
      'mcp.tool.args.password': 'hunter2',
    };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    expect(scrubbed['gen_ai.request.model']).toBe('claude');
    expect(scrubbed['http.request.header.authorization']).toBe(
      '<redacted:http.request.header.authorization>',
    );
    expect(scrubbed['mcp.tool.args.password']).toBe('<redacted:mcp.tool.args.password>');
    expect(redactedKeys.sort()).toEqual(
      ['http.request.header.authorization', 'mcp.tool.args.password'].sort(),
    );
  });

  it('is a no-op when no secrets are present', () => {
    const attrs = { 'gen_ai.system': 'anthropic' };
    const { scrubbed, redactedKeys } = scrubAttributes(attrs);
    expect(scrubbed).toEqual(attrs);
    expect(redactedKeys).toEqual([]);
  });

  it('does not mutate the input object', () => {
    const attrs = { password: 'x' };
    scrubAttributes(attrs);
    expect(attrs.password).toBe('x');
  });
});

describe('scrubMcpArgs', () => {
  it('redacts values when arg names match secret patterns', () => {
    const args = { symbol: 'BTC', apiKey: 'xyz', notional: 100 };
    const { scrubbed, redactedKeys } = scrubMcpArgs(args);
    expect(scrubbed.symbol).toBe('BTC');
    expect(scrubbed.notional).toBe(100);
    expect(scrubbed.apiKey).toBe('<redacted:apiKey>');
    expect(redactedKeys).toEqual(['apiKey']);
  });

  it('handles nested objects shallowly (only top-level keys)', () => {
    // V1 is top-level only; nested is Plan F tightening.
    const args = { outer: { apiKey: 'x' } };
    const { redactedKeys } = scrubMcpArgs(args);
    expect(redactedKeys).toEqual([]);
  });
});

describe('SECRET_NAME_PATTERNS', () => {
  it('is the exact V1 list', () => {
    expect(SECRET_NAME_PATTERNS.map((p) => p.source)).toEqual([
      '(^|\\.)authorization$',
      '(^|\\.)apikey$',
      '(^|\\.)api[_-]?key$',
      '(^|\\.)bearer$',
      '(^|\\.)password$',
      '(^|\\.)secret$',
      '(^|\\.)token$',
      '(^|\\.)privatekey$',
      '(^|\\.)private[_-]?key$',
    ]);
  });
});
```

- [ ] **Step 2: Run test, verify fail**

```bash
cd client
yarn vitest run test/trajectory/secret-scrub.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `client/src/trajectory/secret-scrub.ts`**

```typescript
/**
 * V1 minimum secret-scrub conformance.
 *
 * Scope: §4.3 bullet — "attribute-name allowlist drops values for known
 * credential fields (*.authorization, *.apiKey, *.bearer, *.password,
 * *.secret, *.token, *.privateKey, plus MCP tool args matching these
 * patterns). Scrubbed attributes are replaced with <redacted:name>
 * markers; a run-level redaction manifest records *which* fields were
 * scrubbed (not values) and is signed alongside spans."
 *
 * This is safety, not access control. IP-protection redaction lives in
 * the deferred gating epic per scope §5.
 */

/** V1 pattern set. Case-insensitive; matches at end-of-key or after a dot. */
export const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /(^|\.)authorization$/i,
  /(^|\.)apikey$/i,
  /(^|\.)api[_-]?key$/i,
  /(^|\.)bearer$/i,
  /(^|\.)password$/i,
  /(^|\.)secret$/i,
  /(^|\.)token$/i,
  /(^|\.)privatekey$/i,
  /(^|\.)private[_-]?key$/i,
];

export function isSecretKey(key: string): boolean {
  return SECRET_NAME_PATTERNS.some((p) => p.test(key));
}

/**
 * Walk a flat attribute map and replace secret values with a marker.
 * Returns a new object plus the list of keys that were redacted.
 */
export function scrubAttributes<T extends Record<string, unknown>>(
  attrs: T,
): { scrubbed: Record<string, unknown>; redactedKeys: string[] } {
  const scrubbed: Record<string, unknown> = { ...attrs };
  const redactedKeys: string[] = [];
  for (const [k, _v] of Object.entries(attrs)) {
    if (isSecretKey(k)) {
      scrubbed[k] = `<redacted:${k}>`;
      redactedKeys.push(k);
    }
  }
  return { scrubbed, redactedKeys };
}

/**
 * Scrub MCP tool call arguments by argument name. V1 is top-level-only;
 * deep recursion is Plan F tightening.
 */
export function scrubMcpArgs(
  args: Record<string, unknown>,
): { scrubbed: Record<string, unknown>; redactedKeys: string[] } {
  return scrubAttributes(args);
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/secret-scrub.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/secret-scrub.ts client/test/trajectory/secret-scrub.test.ts
git commit -m "feat(trajectory): V1 secret-scrub conformance

Nine deny-patterns (case-insensitive, end-of-key or post-dot).
Attribute values for matching keys are replaced with <redacted:keyname>;
the redacted key list is returned for redactionManifest assembly.
Scope §4.3 V1 minimum."
```

---

## Task 5: `TrajectoryCollector` — scrub + chain on add

**Files:**

- Create: `client/src/trajectory/collector.ts`
- Create: `client/test/trajectory/collector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';
import { computeGenesisHash, computePrevSpanHash } from '../../src/trajectory/hash-chain.js';

describe('TrajectoryCollector', () => {
  let c: TrajectoryCollector;
  beforeEach(() => {
    c = new TrajectoryCollector({ intentCid: 'bafy-intent', runId: 'run-1' });
  });

  it('starts with empty spans and zero redactions', () => {
    expect(c.snapshot().spans).toEqual([]);
    expect(c.snapshot().redactionManifest.totalRedactions).toBe(0);
  });

  it('assigns jinn.prevSpanHash = genesis on the first span', () => {
    const span = c.addSpan({
      name: 'phase.design',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    expect(span.attributes['jinn.prevSpanHash']).toBe(computeGenesisHash('bafy-intent'));
  });

  it('assigns jinn.prevSpanHash = hash(previous) on subsequent spans', () => {
    const s1 = c.addSpan({
      name: 'a',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    const s2 = c.addSpan({
      name: 'b',
      kind: 'INTERNAL',
      startTimeUnixNano: '2',
      endTimeUnixNano: '3',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'planning' },
      events: [],
      status: { code: 'OK' },
    });
    expect(s2.attributes['jinn.prevSpanHash']).toBe(computePrevSpanHash(s1));
  });

  it('assigns unique 16-hex spanIds + shared 32-hex traceId', () => {
    const s1 = c.addSpan({
      name: 'a',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    const s2 = c.addSpan({
      name: 'b',
      kind: 'INTERNAL',
      startTimeUnixNano: '2',
      endTimeUnixNano: '3',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'planning' },
      events: [],
      status: { code: 'OK' },
    });
    expect(s1.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s2.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s1.spanId).not.toBe(s2.spanId);
    expect(s1.traceId).toBe(s2.traceId);
  });

  it('scrubs secret attributes and records them in the redactionManifest', () => {
    const s = c.addSpan({
      name: 'llm',
      kind: 'CLIENT',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.llm_call',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-opus-4-7',
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
        'http.request.header.authorization': 'Bearer sk-abc',
      },
      events: [],
      status: { code: 'OK' },
    });
    expect(s.attributes['http.request.header.authorization']).toBe(
      '<redacted:http.request.header.authorization>',
    );
    const snap = c.snapshot();
    expect(snap.redactionManifest.totalRedactions).toBe(1);
    expect(snap.redactionManifest.spans[0].spanId).toBe(s.spanId);
    expect(snap.redactionManifest.spans[0].redactedKeys).toEqual([
      'http.request.header.authorization',
    ]);
  });

  it('threads parentSpanId through explicit parentage', () => {
    const parent = c.addSpan({
      name: 'phase',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '10',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });
    const child = c.addSpan({
      name: 'llm',
      kind: 'CLIENT',
      startTimeUnixNano: '2',
      endTimeUnixNano: '3',
      attributes: {
        'jinn.span.kind': 'jinn.llm_call',
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'm',
        'gen_ai.usage.input_tokens': 1,
        'gen_ai.usage.output_tokens': 1,
      },
      events: [],
      status: { code: 'OK' },
      parentSpanId: parent.spanId,
    });
    expect(child.parentSpanId).toBe(parent.spanId);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
cd client
yarn vitest run test/trajectory/collector.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `client/src/trajectory/collector.ts`**

```typescript
/**
 * TrajectoryCollector — in-memory span accumulator.
 *
 * Invariants (enforced on add):
 *   - span.traceId is shared across all spans in a run (set at construction)
 *   - span.spanId is 16 hex chars unique per span
 *   - span.attributes['jinn.prevSpanHash'] is set to genesis (for first span)
 *     or the keccak256(JCS(previous finalized span)) on add — callers do NOT
 *     set it.
 *   - span.attributes['jinn.span.kind'] MUST be supplied by the caller.
 *   - secrets are scrubbed before the span is appended; redacted keys are
 *     recorded against this span's spanId in the redactionManifest.
 */

import { randomBytes } from 'node:crypto';
import type { Span, RedactionManifest } from './schema.js';
import { computeGenesisHash, computePrevSpanHash } from './hash-chain.js';
import { scrubAttributes } from './secret-scrub.js';

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export interface CollectorInit {
  intentCid: string;
  runId: string;
  /** Override for tests. Defaults to randomBytes(16). */
  traceId?: string;
}

/** Caller-supplied span input. Omits chain + id fields the collector assigns. */
export interface SpanInput {
  name: string;
  kind: Span['kind'];
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  events: Span['events'];
  status: Span['status'];
  parentSpanId?: string | null;
}

export class TrajectoryCollector {
  readonly runId: string;
  readonly intentCid: string;
  private readonly traceId: string;
  private readonly spans: Span[] = [];
  private readonly redactionEntries: RedactionManifest['spans'] = [];
  private totalRedactions = 0;
  private lastSpanHash: string;

  constructor(init: CollectorInit) {
    this.runId = init.runId;
    this.intentCid = init.intentCid;
    this.traceId = init.traceId ?? hex(16);
    this.lastSpanHash = computeGenesisHash(init.intentCid);
  }

  /** Append a span; returns the finalized span (with assigned ids + chain hash). */
  addSpan(input: SpanInput): Span {
    if (typeof input.attributes['jinn.span.kind'] !== 'string') {
      throw new Error('TrajectoryCollector.addSpan: jinn.span.kind attribute required');
    }

    const { scrubbed, redactedKeys } = scrubAttributes(input.attributes);

    const span: Span = {
      traceId: this.traceId,
      spanId: hex(8),
      parentSpanId: input.parentSpanId ?? null,
      name: input.name,
      kind: input.kind,
      startTimeUnixNano: input.startTimeUnixNano,
      endTimeUnixNano: input.endTimeUnixNano,
      attributes: {
        ...scrubbed,
        'jinn.prevSpanHash': this.lastSpanHash,
      },
      events: input.events,
      status: input.status,
    };

    this.spans.push(span);
    this.lastSpanHash = computePrevSpanHash(span);

    if (redactedKeys.length > 0) {
      this.redactionEntries.push({ spanId: span.spanId, redactedKeys });
      this.totalRedactions += redactedKeys.length;
    }

    return span;
  }

  /** Immutable snapshot for emit / tests. */
  snapshot(): { spans: Span[]; redactionManifest: RedactionManifest } {
    return {
      spans: this.spans.slice(),
      redactionManifest: {
        spans: this.redactionEntries.slice(),
        totalRedactions: this.totalRedactions,
      },
    };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/collector.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/collector.ts client/test/trajectory/collector.test.ts
git commit -m "feat(trajectory): TrajectoryCollector with scrub + hash chain

Append-only span buffer. On addSpan: scrub secret attributes, record
redactions against spanId, stamp jinn.prevSpanHash (genesis for span 0,
keccak256(JCS(prev)) for subsequent spans). Immutable snapshot() exposes
spans + redactionManifest for emit."
```

---

## Task 6: `emitTrajectory` — sign + upload

**Files:**

- Create: `client/src/trajectory/emit.ts`
- Create: `client/test/trajectory/emit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';
import { emitTrajectory } from '../../src/trajectory/emit.js';
import { canonicalJson } from '../../src/restorer/engine/canonical-json.js';
import { JinnTrajectoryV1Schema } from '../../src/trajectory/schema.js';

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async (_url: string, data: unknown) => {
    // Deterministic stub CID derived from content
    const h = keccak256(toBytes(canonicalJson(data)));
    return `bafy-stub-${h.slice(2, 10)}`;
  }),
}));

describe('emitTrajectory', () => {
  it('returns a CID and sha256 of the signed blob, and the signed blob schema-validates', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy-intent', runId: 'run-1' });
    c.addSpan({
      name: 'phase.design',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
      events: [],
      status: { code: 'OK' },
    });

    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);

    const result = await emitTrajectory({
      collector: c,
      runId: 'run-1',
      signerPrivateKey: pk,
      signerAddress: account.address,
      ipfsRegistryUrl: 'http://stub',
    });

    expect(result.cid).toMatch(/^bafy-stub-/);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Signed blob must schema-validate
    expect(() => JinnTrajectoryV1Schema.parse(result.signed)).not.toThrow();
    // Signer matches
    expect(result.signed.signature.signer.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('signs keccak256(JCS(trajectory without signature))', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy-intent', runId: 'run-2' });
    c.addSpan({
      name: 'x',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'p' },
      events: [],
      status: { code: 'OK' },
    });
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const result = await emitTrajectory({
      collector: c,
      runId: 'run-2',
      signerPrivateKey: pk,
      signerAddress: account.address,
      ipfsRegistryUrl: 'http://stub',
    });
    const { signature: _s, ...unsigned } = result.signed;
    expect(result.signed.signature.hash).toBe(keccak256(toBytes(canonicalJson(unsigned))));
  });
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
cd client
yarn vitest run test/trajectory/emit.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `client/src/trajectory/emit.ts`**

```typescript
/**
 * Emit a signed jinn.trajectory.v1 blob and upload it to IPFS.
 *
 * Signing mirrors envelope-assembly.ts (§4.2a mechanics):
 *   hash = keccak256(JCS(trajectory minus signature))
 *   → signed with agent EOA key
 *   → signed blob uploaded to IPFS
 *   → { cid, sha256 } returned for the envelope.
 */

import { createHash } from 'node:crypto';
import { keccak256, toBytes, type Hex } from 'viem';
import { signCanonical } from '../restorer/engine/signing.js';
import { canonicalJson } from '../restorer/engine/canonical-json.js';
import { uploadToIpfs } from '../adapters/mech/ipfs.js';
import type { TrajectoryCollector } from './collector.js';
import type { JinnTrajectoryV1 } from './schema.js';

export interface EmitTrajectoryParams {
  collector: TrajectoryCollector;
  runId: string;
  /** Set to the parent restoration envelope CID for a verdict trajectory; null otherwise. */
  parentEnvelopeCid?: string | null;
  signerPrivateKey: Hex;
  signerAddress: `0x${string}`;
  ipfsRegistryUrl: string;
}

export interface EmitTrajectoryResult {
  cid: string;
  sha256: string;
  signed: JinnTrajectoryV1;
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

export async function emitTrajectory(
  p: EmitTrajectoryParams,
): Promise<EmitTrajectoryResult> {
  const snap = p.collector.snapshot();
  const unsigned = {
    schemaVersion: 'jinn.trajectory.v1' as const,
    runId: p.runId,
    parentEnvelopeCid: p.parentEnvelopeCid ?? null,
    spans: snap.spans,
    redactionManifest: snap.redactionManifest,
  };

  const sig = await signCanonical(unsigned, p.signerPrivateKey, p.signerAddress);

  const signed: JinnTrajectoryV1 = {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: p.signerAddress,
      hash: sig.hash as Hex,
      sig: sig.sig as Hex,
    },
  };

  const serialized = JSON.stringify(signed);
  const sha256 = sha256Hex(serialized);
  const cid = await uploadToIpfs(p.ipfsRegistryUrl, signed);

  return { cid, sha256, signed };
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/emit.test.ts
```

Expected: all pass. If `signCanonical`'s exact shape differs from Plan C, mirror what envelope-assembly.ts does (same pattern); don't invent a new signing primitive.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/emit.ts client/test/trajectory/emit.test.ts
git commit -m "feat(trajectory): emitTrajectory signs + uploads jinn.trajectory.v1

hash = keccak256(JCS(unsigned)), signed with agent EOA (mirroring
envelope-assembly.ts §4.2a mechanics). sha256 computed over the
serialized signed blob (matches IPFS content addressing). cid returned
from adapters/mech/ipfs.uploadToIpfs."
```

---

## Task 7: Traced HTTP wrapper — `jinn.llm_call` + `jinn.venue_io`

**Files:**

- Create: `client/src/trajectory/wrappers/http.ts`
- Create: `client/test/trajectory/wrappers/http.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { tracedHttpCall } from '../../../src/trajectory/wrappers/http.js';

describe('tracedHttpCall', () => {
  it('emits a jinn.llm_call span for model endpoints', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    await tracedHttpCall({
      collector: c,
      spanKind: 'jinn.llm_call',
      genAi: {
        system: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 40,
      },
      req: { url: 'https://api.anthropic.com/v1/messages', method: 'POST' },
      invoke: async () => ({ status: 200, body: { ok: true } }),
    });
    const snap = c.snapshot();
    expect(snap.spans).toHaveLength(1);
    expect(snap.spans[0].attributes['jinn.span.kind']).toBe('jinn.llm_call');
    expect(snap.spans[0].attributes['gen_ai.request.model']).toBe('claude-opus-4-7');
    expect(snap.spans[0].attributes['gen_ai.usage.input_tokens']).toBe(100);
  });

  it('emits a jinn.venue_io span for non-LLM endpoints', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    await tracedHttpCall({
      collector: c,
      spanKind: 'jinn.venue_io',
      req: { url: 'https://api.hyperliquid-testnet.xyz/info', method: 'POST' },
      invoke: async () => ({ status: 200, body: {} }),
    });
    const s = c.snapshot().spans[0];
    expect(s.attributes['jinn.span.kind']).toBe('jinn.venue_io');
    expect(s.attributes['net.peer.name']).toBe('api.hyperliquid-testnet.xyz');
    expect(s.attributes['http.request.method']).toBe('POST');
    expect(s.attributes['http.response.status_code']).toBe(200);
  });

  it('records ERROR status when invoke throws, and rethrows', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    await expect(
      tracedHttpCall({
        collector: c,
        spanKind: 'jinn.venue_io',
        req: { url: 'https://x.example/api', method: 'GET' },
        invoke: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const s = c.snapshot().spans[0];
    expect(s.status.code).toBe('ERROR');
  });

  it('scrubs Authorization header before attaching it to the span', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    await tracedHttpCall({
      collector: c,
      spanKind: 'jinn.llm_call',
      genAi: { system: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1 },
      req: {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: { authorization: 'Bearer sk-abc' },
      },
      invoke: async () => ({ status: 200, body: {} }),
    });
    const snap = c.snapshot();
    expect(snap.spans[0].attributes['http.request.header.authorization']).toBe(
      '<redacted:http.request.header.authorization>',
    );
    expect(snap.redactionManifest.totalRedactions).toBe(1);
  });
});
```

- [ ] **Step 2: Run test — verify fail**

```bash
cd client
yarn vitest run test/trajectory/wrappers/http.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `client/src/trajectory/wrappers/http.ts`**

```typescript
/**
 * Traced HTTP client wrapper.
 *
 * Emits one span per call. spanKind controls attribute profile:
 *   - jinn.llm_call → gen_ai.* attributes from OTel GenAI semconv
 *   - jinn.venue_io → net.peer.name + http.* attributes
 *
 * Collector scrubs secret headers automatically (Authorization, etc.).
 * On throw: span records ERROR status with message; error is re-raised.
 */

import type { TrajectoryCollector } from '../collector.js';

export interface HttpRequestLike {
  url: string;
  method: string;
  headers?: Record<string, string>;
}

export interface HttpResponseLike {
  status: number;
  body?: unknown;
}

export interface GenAiAttrs {
  system: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TracedHttpCallParams {
  collector: TrajectoryCollector;
  spanKind: 'jinn.llm_call' | 'jinn.venue_io';
  req: HttpRequestLike;
  invoke: () => Promise<HttpResponseLike>;
  genAi?: GenAiAttrs;
  parentSpanId?: string;
  /** Human-readable span name. Defaults to `${method} ${url.host}`. */
  name?: string;
}

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function tracedHttpCall(
  p: TracedHttpCallParams,
): Promise<HttpResponseLike> {
  const start = nowNanos();
  const name = p.name ?? `${p.req.method} ${hostOf(p.req.url)}`;
  const baseAttrs: Record<string, unknown> = {
    'jinn.span.kind': p.spanKind,
    'net.peer.name': hostOf(p.req.url),
    'http.request.method': p.req.method,
    'url.full': p.req.url,
  };
  if (p.req.headers) {
    for (const [k, v] of Object.entries(p.req.headers)) {
      baseAttrs[`http.request.header.${k.toLowerCase()}`] = v;
    }
  }
  if (p.spanKind === 'jinn.llm_call' && p.genAi) {
    baseAttrs['gen_ai.system'] = p.genAi.system;
    baseAttrs['gen_ai.request.model'] = p.genAi.model;
    baseAttrs['gen_ai.usage.input_tokens'] = p.genAi.inputTokens;
    baseAttrs['gen_ai.usage.output_tokens'] = p.genAi.outputTokens;
  }

  try {
    const res = await p.invoke();
    const end = nowNanos();
    p.collector.addSpan({
      name,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: {
        ...baseAttrs,
        'http.response.status_code': res.status,
      },
      events: [],
      status: { code: res.status >= 400 ? 'ERROR' : 'OK' },
      parentSpanId: p.parentSpanId,
    });
    return res;
  } catch (err) {
    const end = nowNanos();
    p.collector.addSpan({
      name,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: {
        ...baseAttrs,
        // Provide a stub status so jinn.venue_io profile requirement is met.
        'http.response.status_code': 0,
      },
      events: [
        {
          timeUnixNano: end,
          name: 'exception',
          attributes: { 'exception.message': (err as Error).message },
        },
      ],
      status: { code: 'ERROR', message: (err as Error).message },
      parentSpanId: p.parentSpanId,
    });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/wrappers/http.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/wrappers/http.ts client/test/trajectory/wrappers/http.test.ts
git commit -m "feat(trajectory): traced HTTP wrapper for LLM + venue calls

tracedHttpCall emits jinn.llm_call or jinn.venue_io spans with OTel
GenAI / net.peer attributes. Secret headers (Authorization) scrub via
TrajectoryCollector before landing on the span. ERROR status when the
invoke throws; error re-raised to caller (non-swallowing)."
```

---

## Task 8: Traced MCP wrapper — `jinn.mcp_call`

**Files:**

- Create: `client/src/trajectory/wrappers/mcp.ts`
- Create: `client/test/trajectory/wrappers/mcp.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { tracedMcpCall } from '../../../src/trajectory/wrappers/mcp.js';

describe('tracedMcpCall', () => {
  it('emits a jinn.mcp_call span with server + tool attrs', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    const res = await tracedMcpCall({
      collector: c,
      server: 'hyperliquid',
      tool: 'place_order',
      args: { symbol: 'BTC', size: 0.01 },
      invoke: async () => ({ ok: true, orderId: 'oid' }),
    });
    expect(res).toEqual({ ok: true, orderId: 'oid' });
    const s = c.snapshot().spans[0];
    expect(s.attributes['jinn.span.kind']).toBe('jinn.mcp_call');
    expect(s.attributes['mcp.server.name']).toBe('hyperliquid');
    expect(s.attributes['mcp.tool.name']).toBe('place_order');
    expect(s.attributes['mcp.tool.args.symbol']).toBe('BTC');
    expect(s.attributes['mcp.tool.args.size']).toBe(0.01);
  });

  it('redacts secret arg values', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    await tracedMcpCall({
      collector: c,
      server: 'x',
      tool: 't',
      args: { apiKey: 'xyz', symbol: 'BTC' },
      invoke: async () => ({}),
    });
    const s = c.snapshot().spans[0];
    expect(s.attributes['mcp.tool.args.apiKey']).toBe('<redacted:mcp.tool.args.apiKey>');
    expect(s.attributes['mcp.tool.args.symbol']).toBe('BTC');
    expect(c.snapshot().redactionManifest.totalRedactions).toBe(1);
  });

  it('records ERROR on throw and rethrows', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    await expect(
      tracedMcpCall({
        collector: c,
        server: 'x',
        tool: 't',
        args: {},
        invoke: async () => {
          throw new Error('mcp-down');
        },
      }),
    ).rejects.toThrow('mcp-down');
    expect(c.snapshot().spans[0].status.code).toBe('ERROR');
  });
});
```

- [ ] **Step 2: Run fail**

```bash
cd client
yarn vitest run test/trajectory/wrappers/mcp.test.ts
```

- [ ] **Step 3: Implement `client/src/trajectory/wrappers/mcp.ts`**

```typescript
/**
 * Traced MCP tool-call wrapper.
 *
 * Every MCP tool invocation emits one jinn.mcp_call span. Top-level args
 * are surfaced as mcp.tool.args.<name> attributes (collector scrubs secret
 * names). Nested arg redaction is Plan F tightening.
 */

import type { TrajectoryCollector } from '../collector.js';

export interface TracedMcpCallParams<T> {
  collector: TrajectoryCollector;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  invoke: () => Promise<T>;
  parentSpanId?: string;
}

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

export async function tracedMcpCall<T>(p: TracedMcpCallParams<T>): Promise<T> {
  const start = nowNanos();
  const argAttrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.args)) {
    argAttrs[`mcp.tool.args.${k}`] = v;
  }
  const baseAttrs: Record<string, unknown> = {
    'jinn.span.kind': 'jinn.mcp_call',
    'mcp.server.name': p.server,
    'mcp.tool.name': p.tool,
    ...argAttrs,
  };

  try {
    const res = await p.invoke();
    p.collector.addSpan({
      name: `mcp.${p.server}.${p.tool}`,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: nowNanos(),
      attributes: baseAttrs,
      events: [],
      status: { code: 'OK' },
      parentSpanId: p.parentSpanId,
    });
    return res;
  } catch (err) {
    const end = nowNanos();
    p.collector.addSpan({
      name: `mcp.${p.server}.${p.tool}`,
      kind: 'CLIENT',
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: baseAttrs,
      events: [
        {
          timeUnixNano: end,
          name: 'exception',
          attributes: { 'exception.message': (err as Error).message },
        },
      ],
      status: { code: 'ERROR', message: (err as Error).message },
      parentSpanId: p.parentSpanId,
    });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/wrappers/mcp.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/wrappers/mcp.ts client/test/trajectory/wrappers/mcp.test.ts
git commit -m "feat(trajectory): traced MCP wrapper for jinn.mcp_call spans"
```

---

## Task 9: Traced subprocess wrapper

**Files:**

- Create: `client/src/trajectory/wrappers/subprocess.ts`
- Create: `client/test/trajectory/wrappers/subprocess.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { tracedSpawn } from '../../../src/trajectory/wrappers/subprocess.js';

describe('tracedSpawn', () => {
  it('runs a command and emits a state_transition span around it', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    const res = await tracedSpawn({
      collector: c,
      cmd: 'sh',
      args: ['-c', 'echo hello'],
      stateFrom: 'PREPARED',
      stateTo: 'RAN_CLAUDE',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello');
    const s = c.snapshot().spans[0];
    expect(s.attributes['jinn.span.kind']).toBe('jinn.state_transition');
    expect(s.attributes['jinn.state.from']).toBe('PREPARED');
    expect(s.attributes['jinn.state.to']).toBe('RAN_CLAUDE');
    expect(s.attributes['subprocess.cmd']).toBe('sh');
    expect(s.attributes['subprocess.exit_code']).toBe(0);
    // stdout / stderr surface as events, not attribute bytes (keeps span small)
    expect(s.events.some((e) => e.name === 'subprocess.stdout.chunk')).toBe(true);
  });

  it('reports ERROR on non-zero exit', async () => {
    const c = new TrajectoryCollector({ intentCid: 'bafy', runId: 'r' });
    const res = await tracedSpawn({
      collector: c,
      cmd: 'sh',
      args: ['-c', 'exit 3'],
      stateFrom: 'X',
      stateTo: 'Y',
    });
    expect(res.exitCode).toBe(3);
    const s = c.snapshot().spans[0];
    expect(s.status.code).toBe('ERROR');
  });
});
```

- [ ] **Step 2: Run fail**

```bash
cd client
yarn vitest run test/trajectory/wrappers/subprocess.test.ts
```

- [ ] **Step 3: Implement `client/src/trajectory/wrappers/subprocess.ts`**

```typescript
/**
 * Traced subprocess wrapper.
 *
 * Emits one jinn.state_transition span per invocation. stdout + stderr
 * chunks arrive as span events (subprocess.stdout.chunk / stderr.chunk)
 * with the chunk bytes in event attributes — lets the span stay small
 * while preserving I/O for later analysis.
 *
 * Attested-tier extension (V2): chunk attributes encrypted-or-hashed when
 * policy demands it. V1 records plaintext.
 */

import { spawn } from 'node:child_process';
import type { TrajectoryCollector } from '../collector.js';

export interface TracedSpawnParams {
  collector: TrajectoryCollector;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  stateFrom: string;
  stateTo: string;
  parentSpanId?: string;
}

export interface TracedSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

export async function tracedSpawn(p: TracedSpawnParams): Promise<TracedSpawnResult> {
  const start = nowNanos();
  let stdout = '';
  let stderr = '';
  const events: { timeUnixNano: string; name: string; attributes?: Record<string, unknown> }[] = [];

  const child = spawn(p.cmd, p.args, { env: p.env, cwd: p.cwd });

  child.stdout.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    stdout += s;
    events.push({
      timeUnixNano: nowNanos(),
      name: 'subprocess.stdout.chunk',
      attributes: { 'subprocess.stdout.bytes': s },
    });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    stderr += s;
    events.push({
      timeUnixNano: nowNanos(),
      name: 'subprocess.stderr.chunk',
      attributes: { 'subprocess.stderr.bytes': s },
    });
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });

  p.collector.addSpan({
    name: `subprocess.${p.cmd}`,
    kind: 'INTERNAL',
    startTimeUnixNano: start,
    endTimeUnixNano: nowNanos(),
    attributes: {
      'jinn.span.kind': 'jinn.state_transition',
      'jinn.state.from': p.stateFrom,
      'jinn.state.to': p.stateTo,
      'subprocess.cmd': p.cmd,
      'subprocess.args': p.args,
      'subprocess.exit_code': exitCode,
    },
    events,
    status: exitCode === 0 ? { code: 'OK' } : { code: 'ERROR', message: `exit ${exitCode}` },
    parentSpanId: p.parentSpanId,
  });

  return { exitCode, stdout, stderr };
}
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/trajectory/wrappers/subprocess.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/wrappers/subprocess.ts client/test/trajectory/wrappers/subprocess.test.ts
git commit -m "feat(trajectory): traced subprocess wrapper with stdout/stderr events"
```

---

## Task 10: Trajectory index + RestorationContext threading

**Files:**

- Create: `client/src/trajectory/index.ts`
- Modify: `client/src/restorer/types.ts`

- [ ] **Step 1: Write the index re-exports**

```typescript
// client/src/trajectory/index.ts
export * from './schema.js';
export * from './collector.js';
export * from './span-profile.js';
export * from './hash-chain.js';
export * from './secret-scrub.js';
export * from './emit.js';
export { tracedHttpCall } from './wrappers/http.js';
export { tracedMcpCall } from './wrappers/mcp.js';
export { tracedSpawn } from './wrappers/subprocess.js';
```

- [ ] **Step 2: Add `trajectory` field to `RestorationContext`**

Open `client/src/restorer/types.ts` and add:

```typescript
import type { TrajectoryCollector } from '../trajectory/collector.js';

export interface RestorationContext {
  // ... existing fields ...

  /**
   * Collector for jinn.trajectory.v1 spans emitted during this run.
   * Impls MUST route all LLM / MCP / venue / subprocess I/O through
   * the traced wrappers exported from client/src/trajectory/ so every
   * meaningful I/O surfaces as a span. Scope §3.2 traced-I/O boundary.
   */
  trajectory: TrajectoryCollector;
}
```

- [ ] **Step 3: Typecheck to surface broken callers**

```bash
cd client
yarn typecheck
```

Expected: zero errors — we've added a required field but no existing construction site compiles yet, so this will actually show call-site failures. Those get fixed in Task 11 (engine).

If typecheck is green, it means `RestorationContext` is constructed via typed factories that haven't been updated yet; keep going.

- [ ] **Step 4: Commit intermediate state**

```bash
git add client/src/trajectory/index.ts client/src/restorer/types.ts
git commit -m "feat(trajectory): re-export index + thread collector through RestorationContext

Every run now carries a TrajectoryCollector via context. Engine wires the
instance in Task 11; impl migrations (tasks 12–15) route I/O through
traced wrappers and add phase spans."
```

---

## Task 11: Engine integration — create collector, emit trajectory, populate envelope field

**Files:**

- Modify: `client/src/restorer/engine/engine.ts`
- Modify: `client/src/restorer/engine/envelope-assembly.ts`
- Modify: `client/test/restorer/engine/engine.test.ts` (or equivalent)
- Modify: `client/test/restorer/engine/envelope-assembly.test.ts`

- [ ] **Step 1: Envelope-assembly accepts trajectory input**

In `client/src/restorer/engine/envelope-assembly.ts`, extend `EnvelopeInputs`:

```typescript
export interface EnvelopeInputs {
  // ... existing fields ...

  /** Signed trajectory reference. Populates envelope.trajectory. */
  trajectory?: { cid: string; sha256: string } | null;
}
```

Then inside `assembleAndSignEnvelope`, replace the hardcoded `trajectory: null` with the input (defaulting to `null` when absent):

```typescript
const trajectory = inputs.trajectory
  ? { cid: inputs.trajectory.cid, sha256: inputs.trajectory.sha256 }
  : null;
```

- [ ] **Step 2: Extend envelope-assembly test**

In `client/test/restorer/engine/envelope-assembly.test.ts` add:

```typescript
it('populates envelope.trajectory when a trajectory ref is provided', async () => {
  const { envelope } = await assembleAndSignEnvelope(
    {
      ...baseInputs,
      trajectory: { cid: 'bafy-traj', sha256: 'a'.repeat(64) },
    },
    deps,
  );
  expect(envelope.trajectory).toEqual({ cid: 'bafy-traj', sha256: 'a'.repeat(64) });
});

it('leaves envelope.trajectory null when omitted', async () => {
  const { envelope } = await assembleAndSignEnvelope(baseInputs, deps);
  expect(envelope.trajectory).toBeNull();
});
```

- [ ] **Step 3: Engine instantiates collector at run start**

In `client/src/restorer/engine/engine.ts`, at the start of a run (where RestorationContext is built):

```typescript
import { TrajectoryCollector, emitTrajectory } from '../../trajectory/index.js';

// ...
const trajectory = new TrajectoryCollector({
  intentCid: job.intent?.signature ? await intentCidOf(job.intent) : job.intent?.id ?? 'unknown',
  runId: run.id,
});

const ctx: RestorationContext = {
  // ... existing ...
  trajectory,
};
```

Use the CID returned by Plan B's intent upload when available; fall back to the intent id for legacy jobs.

- [ ] **Step 4: Engine emits `jinn.state_transition` spans at every state change**

Wrap the existing state-machine transition helper so every transition emits a span:

```typescript
async function transitionTo(
  ctx: RestorationContext,
  from: string,
  to: string,
): Promise<void> {
  ctx.trajectory.addSpan({
    name: `state.${from}_to_${to}`,
    kind: 'INTERNAL',
    startTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
    endTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
    attributes: {
      'jinn.span.kind': 'jinn.state_transition',
      'jinn.state.from': from,
      'jinn.state.to': to,
    },
    events: [],
    status: { code: 'OK' },
  });
  // ... persist transition as before
}
```

Replace every inline state-write with a call to `transitionTo(...)`.

- [ ] **Step 5: Engine calls `emitTrajectory` before envelope assembly**

Right before `assembleAndSignEnvelope`:

```typescript
const traj = await emitTrajectory({
  collector: ctx.trajectory,
  runId: run.id,
  parentEnvelopeCid: null, // backfilled below after envelope upload if this is a verdict
  signerPrivateKey: agentEoaPrivateKey,
  signerAddress: participant.agentEoa as `0x${string}`,
  ipfsRegistryUrl: config.ipfsRegistryUrl,
});

const { envelope, envelopeCid, envelopeHash } = await assembleAndSignEnvelope(
  {
    // ... existing inputs ...
    trajectory: { cid: traj.cid, sha256: traj.sha256 },
  },
  deps,
);
```

- [ ] **Step 6: Run engine tests**

```bash
cd client
yarn vitest run test/restorer/engine/envelope-assembly.test.ts test/restorer/engine/engine.test.ts
```

Expected: pass. Fixtures may need updating (add `trajectory` stubs).

- [ ] **Step 7: Commit**

```bash
git add client/src/restorer/engine client/test/restorer/engine
git commit -m "feat(engine): thread TrajectoryCollector + emit trajectory pre-assembly

Every run instantiates a TrajectoryCollector at start, emits
jinn.state_transition spans on every state change, and emits a signed
jinn.trajectory.v1 blob to IPFS immediately before envelope assembly.
The resulting { cid, sha256 } is written onto envelope.trajectory.
Scope §2.5 uniform-schema (trajectory required at all tiers)."
```

---

## Task 12: Migrate `claude-mcp-hyperliquid/session-orchestrator.ts` to traced wrappers

**Files:**

- Modify: `client/src/restorer/impls/claude-mcp-hyperliquid/session-orchestrator.ts`
- Modify: `client/test/restorer/impls/claude-mcp-hyperliquid/*`

- [ ] **Step 1: Read the orchestrator**

Identify every I/O call: (a) Claude API HTTP calls, (b) MCP tool calls, (c) any raw `fetch` to Hyperliquid venue.

- [ ] **Step 2: Wrap Claude API calls with `tracedHttpCall`**

For every direct HTTP call to the Anthropic endpoint, replace:

```typescript
const res = await fetch(url, { method: 'POST', body });
```

with:

```typescript
import { tracedHttpCall } from '../../../trajectory/index.js';

const res = await tracedHttpCall({
  collector: ctx.trajectory,
  spanKind: 'jinn.llm_call',
  genAi: {
    system: 'anthropic',
    model: opts.model,
    inputTokens: /* from response usage */,
    outputTokens: /* from response usage */,
  },
  req: { url, method: 'POST', headers: { authorization: `Bearer ${apiKey}` } },
  invoke: async () => {
    const r = await fetch(url, { method: 'POST', body });
    const body = await r.json();
    return { status: r.status, body };
  },
});
```

Note: the Claude CLI spawned via subprocess (`runner/claude.ts`) is the subprocess path; Task 13 covers that. This task only touches direct HTTP.

If the orchestrator only ever invokes Claude via the subprocess runner (no direct HTTP), skip this step and proceed to MCP.

- [ ] **Step 3: Wrap MCP tool invocations with `tracedMcpCall`**

Every call into the Hyperliquid MCP server (via the local MCP shim) becomes:

```typescript
import { tracedMcpCall } from '../../../trajectory/index.js';

const result = await tracedMcpCall({
  collector: ctx.trajectory,
  server: 'hyperliquid',
  tool: toolName,
  args,
  invoke: async () => mcpClient.callTool(toolName, args),
});
```

- [ ] **Step 4: Wrap direct venue HTTP (if any)**

If any code in the orchestrator hits `https://api.hyperliquid-testnet.xyz/*` directly (e.g. for snapshots), wrap with `tracedHttpCall({ spanKind: 'jinn.venue_io', ... })`.

- [ ] **Step 5: Emit `jinn.phase` spans around major phases**

If the orchestrator has distinct phases (design / planning / execute / repair — or however this impl names them), bracket each:

```typescript
const phaseStart = `${BigInt(Date.now()) * 1_000_000n}`;
// ... phase work ...
const phaseEnd = `${BigInt(Date.now()) * 1_000_000n}`;
ctx.trajectory.addSpan({
  name: `phase.design`,
  kind: 'INTERNAL',
  startTimeUnixNano: phaseStart,
  endTimeUnixNano: phaseEnd,
  attributes: { 'jinn.span.kind': 'jinn.phase', 'jinn.phase.name': 'design' },
  events: [],
  status: { code: 'OK' },
});
```

- [ ] **Step 6: Run impl tests**

```bash
cd client
yarn vitest run test/restorer/impls/claude-mcp-hyperliquid/
```

Expected: pass. Tests may need mock adjustments if they assert on fetch/MCP call counts — traced wrappers preserve invocation count but add a span after each call. Adjust any assertions that previously counted raw fetches to count traced calls.

- [ ] **Step 7: Commit**

```bash
git add client/src/restorer/impls/claude-mcp-hyperliquid client/test/restorer/impls/claude-mcp-hyperliquid
git commit -m "feat(claude-mcp-hyperliquid): route I/O through traced wrappers

Claude HTTP, Hyperliquid MCP tool calls, and direct venue HTTP now
emit jinn.llm_call / jinn.mcp_call / jinn.venue_io spans via the
trajectory wrappers. Phase boundaries emit jinn.phase spans.
Scope §3.2 traced-I/O boundary."
```

---

## Task 13: Migrate the Claude CLI subprocess runner

**Files:**

- Modify: `client/src/runner/claude.ts`
- Modify: `client/test/runner/*`

- [ ] **Step 1: Read `runner/claude.ts`**

It currently spawns `claude` via `child_process.spawn` and returns stdout. Collector threading: the runner receives a `ctx: RestorationContext` so it can access `ctx.trajectory`; if the current signature doesn't pass context, update it.

- [ ] **Step 2: Wrap the spawn with `tracedSpawn`**

Replace the raw spawn with:

```typescript
import { tracedSpawn } from '../trajectory/index.js';

const result = await tracedSpawn({
  collector: ctx.trajectory,
  cmd: claudeBin,
  args: [/* ... */],
  env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
  stateFrom: 'PREPARED',
  stateTo: 'RAN_CLAUDE',
});

if (result.exitCode !== 0) {
  throw new Error(`Claude subprocess exited ${result.exitCode}: ${result.stderr}`);
}

return result.stdout;
```

- [ ] **Step 3: Update callers**

Any caller that passes runner params without `ctx` / `trajectory` must now pass the context. If callers previously called `runClaude(args)`, make it `runClaude(ctx, args)`.

- [ ] **Step 4: Run runner tests**

```bash
cd client
yarn vitest run test/runner/
```

Expected: pass. Tests may need to mock `TrajectoryCollector` — pass a fresh collector from the test setup.

- [ ] **Step 5: Commit**

```bash
git add client/src/runner client/test/runner
git commit -m "feat(runner): route Claude CLI spawn through tracedSpawn

Subprocess invocation emits a jinn.state_transition span with stdout/stderr
as span events. Collector threaded via RestorationContext."
```

---

## Task 14: Migrate `claude-mcp-prediction` + `claude-mcp-prediction-apy` orchestrators

**Files:**

- Modify: `client/src/restorer/impls/claude-mcp-prediction/session-orchestrator.ts`
- Modify: `client/src/restorer/impls/claude-mcp-prediction-apy/session-orchestrator.ts`
- Modify: tests for each

- [ ] **Step 1: Apply the same pattern as Task 12 to both**

For each orchestrator: wrap LLM HTTP (if any direct calls) with `tracedHttpCall({ spanKind: 'jinn.llm_call', ... })`, MCP calls with `tracedMcpCall`, and direct venue HTTP with `tracedHttpCall({ spanKind: 'jinn.venue_io', ... })`. Add phase spans around distinct phases.

- [ ] **Step 2: Run tests**

```bash
cd client
yarn vitest run test/restorer/impls/claude-mcp-prediction/ test/restorer/impls/claude-mcp-prediction-apy/
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add client/src/restorer/impls/claude-mcp-prediction client/src/restorer/impls/claude-mcp-prediction-apy client/test/restorer/impls/claude-mcp-prediction client/test/restorer/impls/claude-mcp-prediction-apy
git commit -m "feat(prediction impls): route I/O through traced wrappers"
```

---

## Task 15: Migrate evaluators to emit (smaller) trajectories

**Files:**

- Modify: `client/src/restorer/impls/portfolio-v0-evaluator/index.ts`
- Modify: `client/src/restorer/impls/prediction-v0-evaluator/index.ts`
- Modify: `client/src/restorer/impls/prediction-apy-v0-evaluator/index.ts`
- Modify: their tests

Evaluators re-fetch venue state and run deterministic checks — the trajectory is smaller but still required (scope §2.5 uniform-schema).

- [ ] **Step 1: Pattern — for each evaluator**

Wrap venue fetches with `tracedHttpCall({ spanKind: 'jinn.venue_io', ... })`. Emit `jinn.phase` spans around major stages (e.g. `rederive`, `check`, `score`). Emit a `jinn.state_transition` span when the evaluator concludes with verdict PASS / FAIL / REJECTED.

- [ ] **Step 2: Parent envelope CID**

Evaluators know the restoration envelope CID (`payload.restorationEnvelope.cid`). Pass it to `emitTrajectory` as `parentEnvelopeCid` so the verdict trajectory explicitly references the restoration it's scoring:

```typescript
const traj = await emitTrajectory({
  collector: ctx.trajectory,
  runId: run.id,
  parentEnvelopeCid: restorationEnvelopeCid,
  signerPrivateKey: agentEoaPrivateKey,
  signerAddress: participant.agentEoa as `0x${string}`,
  ipfsRegistryUrl: config.ipfsRegistryUrl,
});
```

The engine's default (Task 11) passes `null`; evaluators override it.

- [ ] **Step 3: Run evaluator tests**

```bash
cd client
yarn vitest run test/restorer/impls/portfolio-v0-evaluator/ test/restorer/impls/prediction-v0-evaluator/ test/restorer/impls/prediction-apy-v0-evaluator/
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add client/src/restorer/impls/portfolio-v0-evaluator client/src/restorer/impls/prediction-v0-evaluator client/src/restorer/impls/prediction-apy-v0-evaluator client/test/restorer/impls/portfolio-v0-evaluator client/test/restorer/impls/prediction-v0-evaluator client/test/restorer/impls/prediction-apy-v0-evaluator
git commit -m "feat(evaluators): emit jinn.trajectory.v1 with parentEnvelopeCid

Evaluators route venue I/O through tracedHttpCall, emit jinn.phase spans
around rederive/check/score stages, and set trajectory.parentEnvelopeCid
to the restoration envelope being scored (scope §3.3 K7)."
```

---

## Task 16: Trajectory↔artifact linkage — `jinn.artifact.emit` + `producedBy`

**Files:**

- Modify: `client/src/restorer/engine/packaging.ts`
- Modify: `client/test/restorer/engine/packaging.test.ts`

Scope §3.1 K5: when packaging produces an artifact (upload + sha256 + CID), it must (a) emit a `jinn.artifact.emit` span with the CID/type/sha256 as attributes and (b) stamp the resulting `Artifact` with `metadata.producedBy: { spanId, trajectoryCid }`.

The twist: the span exists before `emitTrajectory` runs, so we don't know the trajectoryCid at span-emit time. Pattern: stamp `spanId` now; backfill `trajectoryCid` after `emitTrajectory` returns.

- [ ] **Step 1: Emit `jinn.artifact.emit` spans inside packaging**

In `packaging.ts`, after each successful artifact upload:

```typescript
const span = ctx.trajectory.addSpan({
  name: `artifact.${artifact.artifactType}`,
  kind: 'PRODUCER',
  startTimeUnixNano: startNs,
  endTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
  attributes: {
    'jinn.span.kind': 'jinn.artifact.emit',
    'jinn.artifact.cid': artifact.cid,
    'jinn.artifact.artifactType': artifact.artifactType,
    'jinn.artifact.sha256': artifact.sha256,
  },
  events: [],
  status: { code: 'OK' },
});

// Stamp spanId; trajectoryCid is backfilled after emitTrajectory().
artifact.metadata = {
  ...(artifact.metadata ?? {}),
  producedBy: { spanId: span.spanId, trajectoryCid: '' },
};
```

- [ ] **Step 2: Backfill `trajectoryCid` in the engine**

In `engine.ts`, after `emitTrajectory` returns, walk the artifact list and backfill:

```typescript
for (const a of artifacts) {
  if (a.metadata?.producedBy) {
    a.metadata.producedBy = {
      ...a.metadata.producedBy,
      trajectoryCid: traj.cid,
    };
  }
}
```

Do this before `assembleAndSignEnvelope` so the envelope artifacts carry the final linkage.

- [ ] **Step 3: Add a test for the round-trip**

In `client/test/restorer/engine/packaging.test.ts` (or wherever artifacts are asserted end-to-end):

```typescript
it('artifact metadata carries producedBy.{spanId, trajectoryCid} matching an emitted jinn.artifact.emit span', async () => {
  const { envelope, trajectory } = await runTestRestoration(/* ... */);
  const artifact = envelope.artifacts[0];
  expect(artifact.metadata?.producedBy?.spanId).toBeTruthy();
  expect(artifact.metadata?.producedBy?.trajectoryCid).toBe(envelope.trajectory?.cid);

  // Find the emit-span in the trajectory; its spanId should match.
  const emitSpan = trajectory.spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit');
  expect(emitSpan).toBeDefined();
  expect(emitSpan!.spanId).toBe(artifact.metadata!.producedBy!.spanId);
  expect(emitSpan!.attributes['jinn.artifact.cid']).toBe(artifact.cid);
});
```

- [ ] **Step 4: Run tests**

```bash
cd client
yarn vitest run test/restorer/engine/packaging.test.ts test/restorer/engine/engine.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/restorer/engine client/test/restorer/engine
git commit -m "feat(packaging): bidirectional trajectory↔artifact linkage

Packaging emits a jinn.artifact.emit span for each uploaded artifact
(cid, artifactType, sha256 attrs) and stamps the artifact metadata
with producedBy.{spanId, trajectoryCid}. trajectoryCid backfills
after emitTrajectory so the envelope artifact list carries the
finalized linkage. Scope §3.1 K5."
```

---

## Task 17: E2E verification

**Files:** None — verification only.

- [ ] **Step 1: Run the full test suite**

```bash
cd client
yarn test
```

Expected: 0 failures.

- [ ] **Step 2: Typecheck + build**

```bash
cd client
yarn typecheck && yarn build
```

Expected: 0 errors.

- [ ] **Step 3: Run e2e**

```bash
cd client
yarn e2e
```

Expected: pass. The e2e runs restoration + evaluation end-to-end on an Anvil fork. After this plan, the delivered envelope's `.trajectory` field is non-null, its trajectory CID is retrievable from IPFS, and the signed blob schema-validates against `JinnTrajectoryV1Schema`.

- [ ] **Step 4: Spot-check an emitted trajectory**

Grab the envelope CID printed by the e2e and fetch the trajectory CID:

```bash
cd client
yarn tsx -e "
import { parseSignedEnvelope } from './src/types/envelope.js';
import { JinnTrajectoryV1Schema } from './src/trajectory/schema.js';

const envelopeCid = process.argv[2];
const envRaw = await fetch(\`https://gateway.autonolas.tech/ipfs/\${envelopeCid}\`).then(r => r.json());
const env = parseSignedEnvelope(envRaw);
console.log('envelope.trajectory:', env.trajectory);

const trajCid = env.trajectory?.cid;
if (!trajCid) throw new Error('no trajectory');
const trajRaw = await fetch(\`https://gateway.autonolas.tech/ipfs/\${trajCid}\`).then(r => r.json());
const traj = JinnTrajectoryV1Schema.parse(trajRaw);
console.log('trajectory schema-valid; spans:', traj.spans.length, 'redactions:', traj.redactionManifest.totalRedactions);
" -- <envelope-cid>
```

Expected: schema-valid, nonzero spans, redactionManifest consistent. Delete the scratch script after.

- [ ] **Step 5: grep for raw I/O paths that slipped through**

```bash
cd client
grep -rn "await fetch(" src/restorer/impls src/runner 2>&1
grep -rn "child_process" src/restorer/impls src/runner 2>&1
```

Expected: either empty or only in files that legitimately need raw I/O (e.g. test fixtures). Any raw `fetch` or `spawn` inside an impl's orchestrator or inside `runner/claude.ts` is a miss from Tasks 12–14 — wrap it.

- [ ] **Step 6: Commit any straggler fixes**

```bash
git add -u
git commit -m "chore(trajectory): final traced-I/O cleanup"
```

(Empty if clean.)

---

## Self-review before marking this plan done

- [ ] **Schema lives:** `client/src/trajectory/schema.ts` exports `JinnTrajectoryV1Schema`, `SpanSchema`, `JinnSpanKindSchema`, `RedactionManifestSchema`.
- [ ] **Collector lives:** `TrajectoryCollector` scrubs secrets on add, stamps `jinn.prevSpanHash` on add, assigns 16-hex spanIds + shared traceId.
- [ ] **Span profile enforced:** `validateSpanProfile(span)` rejects spans missing required attributes for their kind; all six normative kinds covered.
- [ ] **Hash chain correct:** genesis = `keccak256(JCS({runStart: intentCid}))`; each subsequent span's `prevSpanHash` = `keccak256(JCS(previous finalized span))`.
- [ ] **Secret-scrub normative:** nine patterns (authorization, apiKey, api_key, bearer, password, secret, token, privateKey, private_key) — case-insensitive, end-of-key or post-dot. Values replaced with `<redacted:keyname>`; redactionManifest records keys per spanId.
- [ ] **Emit correct:** `emitTrajectory` produces a schema-valid signed blob, hash = `keccak256(JCS(unsigned))`, sha256 over serialized signed bytes.
- [ ] **Wrappers in place:** `tracedHttpCall`, `tracedMcpCall`, `tracedSpawn` emit normative spans; errors record ERROR status and rethrow.
- [ ] **Engine wires it:** collector instantiated at run start, `jinn.state_transition` on every state change, `emitTrajectory` runs before envelope assembly, envelope.trajectory populated with `{ cid, sha256 }`.
- [ ] **Artifact linkage:** `jinn.artifact.emit` span emitted per artifact; `artifact.metadata.producedBy.{spanId, trajectoryCid}` set and matches the span.
- [ ] **Impls migrated:** `claude-mcp-hyperliquid`, `claude-mcp-prediction`, `claude-mcp-prediction-apy` orchestrators + `runner/claude.ts` route all I/O through traced wrappers.
- [ ] **Evaluators migrated:** all three evaluators emit trajectories with `parentEnvelopeCid` = restoration CID.
- [ ] **All tests green:** `yarn test` reports 0 failures.
- [ ] **Build green:** `yarn build` + `yarn typecheck` report 0 errors.
- [ ] **E2E green:** `yarn e2e` passes; spot-checked trajectory schema-validates from IPFS.

---

## Follow-ups (covered by later plans)

- **Plan E — ERC-8004 wiring:** registers each trajectory CID (via the envelope) on the Identity Registry alongside the envelope itself. No direct trajectory registration; the envelope carries the CID.
- **Plan F — conformance suite:** runs `validateSpanProfile` across every trajectory found in the corpus, plus static checks against source bundles (no raw `fetch` / `spawn` / `eval` / raw sockets — scope §4.10 traced-I/O list). This plan ships the profile-validator function; Plan F ships the operator-facing harness that runs it + the static analyses.
- **Plan G — subgraph schema:** indexes trajectory metadata (CID, spanCount, redactionCount) — not span content.
- **V2 attested-tier extensions:**
  - `REPORTDATA` binds trajectory digest (scope §3.2 TEE↔trajectory binding).
  - TLS-transcript CIDs inside LLM/venue spans (`net.tls.transcript.cid`) per §2.5 exception.
  - Nested MCP-arg redaction + runtime seccomp policies preventing raw sockets (scope §4.10).
- **V2 streaming:** append-signed live chunk uploads mid-run (scope §3.1 trajectory row).
- **Conformance tightening (Plan F follow-up):** nested argument redaction (V1 is top-level only); attribute-name patterns for additional credential formats surfaced by operators in practice.
- **Trajectory-chunking hard cap:** scope §6 flags this — long-running runs may produce MB+ trajectories. Plan D emits one blob; if operator runs push size beyond a threshold, either (a) chunk + cross-link by CID or (b) V2 streaming. Defer deciding the threshold until real runs produce data.

---

*End of Plan D. On completion, the `trajectory` field on every envelope is populated at every tier; the knowledge-tree has its branches. Plans E (ERC-8004 wiring), F (conformance suite), and G (subgraph) can proceed in parallel from here.*
