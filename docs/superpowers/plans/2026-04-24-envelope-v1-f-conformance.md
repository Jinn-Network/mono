# Envelope V1 — Plan F: Conformance Test Suite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runnable conformance harness that operators execute against their executor builds to confirm envelope + trajectory + artifact output meets the normative V1 spec. The harness has two layers: **Layer 1** (structural conformance — applies to every envelope at every tier) and **Layer 2** (attested-tier-only traced-I/O boundary checks — V1 ships the static-analysis half; runtime half stubs plug in for V2). Output is a `ConformanceReport` consumable by CLI + automation.

**Architecture:** A pure function `runConformance({ envelopeCid, options }) → Promise<ConformanceReport>` under `client/src/conformance/`. Individual checks live in `checks/*.ts` as small, independently-testable functions each returning a `CheckResult`. The harness is a sequence of awaited check invocations that accumulates results and produces a summary. A `jinn conformance` CLI verb invokes the harness and prints the report. Layer 2 runtime checks are stubbed now with clear TODO comments pointing at the V2 TEE plan; their presence in the harness proves the structure accommodates runtime enforcement without refactor.

**Tech Stack:** TypeScript, Vitest, Zod (reuses `SignedEnvelopeSchema`, `KIND_PAYLOADS`, `SignedIntentV1Schema`, `JinnTrajectoryV1Schema` from Plans B/C/D), viem (`keccak256`, signature recovery), Node built-ins (`fs`, `path`, regex-based static grep of source bundle). No AST parser — regex grep is simpler, more robust to bundle format variation, and adequate for the enumerated Layer 2 checks. Fetching envelopes + intents + trajectories uses the existing `client/src/adapters/mech/ipfs.ts` helpers.

**Non-goals for this slice:**
- No runtime enforcement inside TEE (V2 via seccomp/namespace policies).
- No TLS transcript verification (attested V2).
- No on-chain validation-registry submission (Plan E).
- No reproducible-build check — that's the V2 TEE plan's concern.
- No operator-facing GUI — CLI only.
- No AST-based static analysis (regex grep is sufficient for V1).

**Before you start:** Plans A (JCS), B (intent.v1), C (generic envelope), and D (trajectory + span profile) must be merged. Plan F depends on:
- `SignedEnvelopeSchema` + `KIND_PAYLOADS` + the `canonicalJson` hashing pattern from Plan C.
- `SignedIntentV1Schema` + `parseSignedIntentV1` from Plan B.
- `JinnTrajectoryV1Schema` + the span profile from Plan D (Plan D exports a `span-profile.ts` with per-kind required-attribute descriptors).
- `fetchSignedIntentFromIpfs` + a matching `fetchSignedEnvelopeFromIpfs` + `fetchTrajectoryFromIpfs` from the IPFS adapter (Plan C / D land these). If any are missing, Task 1 adds them.

**Reference:** `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §2.5 (uniform-schema principle), §3.1 (K6 span profile + K9 artifactType vocabulary), §3.2 (traced-I/O boundary row), §4.3 (V1 minimum secret-scrub), §4.10 (conformance suite deliverable — full enumerated attested-tier traced-I/O checks).

---

## File structure

New files:
- `client/src/conformance/types.ts` — `ConformanceReport`, `CheckResult`, `ConformanceOptions`, `ConformanceContext`.
- `client/src/conformance/harness.ts` — `runConformance({ envelopeCid, options }) → ConformanceReport` orchestrator.
- `client/src/conformance/checks/envelope.ts` — Layer 1 envelope checks (schema, payload, hash, signature).
- `client/src/conformance/checks/trajectory.ts` — Layer 1 trajectory + span-profile + hash-chain checks.
- `client/src/conformance/checks/artifacts.ts` — Layer 1 artifact vocabulary + trajectory↔artifact linkage checks.
- `client/src/conformance/checks/verdict.ts` — Layer 1 verdict-specific checks (`payload.restorationEnvelope` resolvability, `verificationOfRestoration` presence).
- `client/src/conformance/checks/secret-scrub.ts` — Layer 1 V1 minimum secret-scrub compliance check.
- `client/src/conformance/checks/source-static.ts` — Layer 2 static analysis on the source bundle (a–f).
- `client/src/conformance/checks/source-runtime.ts` — Layer 2 runtime stubs (seccomp / namespace / TLS transcript — V1 returns SKIP; V2 wires real checks).
- `client/src/cli/commands/conformance.ts` — `jinn conformance --envelope-cid <cid>` verb.
- `client/test/conformance/types.test.ts`
- `client/test/conformance/checks/envelope.test.ts`
- `client/test/conformance/checks/trajectory.test.ts`
- `client/test/conformance/checks/artifacts.test.ts`
- `client/test/conformance/checks/verdict.test.ts`
- `client/test/conformance/checks/secret-scrub.test.ts`
- `client/test/conformance/checks/source-static.test.ts`
- `client/test/conformance/harness.test.ts` — integration test: good envelope passes; known-bad manipulated envelopes each fail exactly one check.
- `client/test/conformance/fixtures/` — golden-good + manipulated-bad envelope/trajectory/source-bundle fixtures.
- `docs/runbooks/conformance.md` — operator-facing "how to run conformance" guide.

Modified files:
- `client/src/cli/commands/index.ts` — register the new `conformance` verb.
- `client/src/adapters/mech/ipfs.ts` — if missing from Plans C/D, add `fetchSignedEnvelopeFromIpfs` and `fetchTrajectoryFromIpfs` (and a generic `fetchSourceBundle` that returns a directory of files); otherwise no change.

No deletions.

---

## Task 1: Types + report shape

**Files:**
- Create: `client/src/conformance/types.ts`
- Create: `client/test/conformance/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/conformance/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  summarize,
  overallFromChecks,
  type CheckResult,
} from '../../src/conformance/types.js';

describe('summarize', () => {
  it('counts pass/fail/skip correctly', () => {
    const checks: CheckResult[] = [
      { id: 'a.b', layer: 1, passed: true },
      { id: 'a.c', layer: 1, passed: false, detail: 'bad' },
      { id: 'd.e', layer: 2, passed: true, skipped: true },
    ];
    const s = summarize(checks);
    expect(s).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
  });
});

describe('overallFromChecks', () => {
  it('returns PASS when no failures', () => {
    expect(overallFromChecks([{ id: 'x', layer: 1, passed: true }])).toBe('PASS');
  });
  it('returns FAIL when any Layer 1 check fails', () => {
    expect(
      overallFromChecks([
        { id: 'x', layer: 1, passed: true },
        { id: 'y', layer: 1, passed: false },
      ]),
    ).toBe('FAIL');
  });
  it('returns FAIL when any Layer 2 check fails', () => {
    expect(
      overallFromChecks([
        { id: 'x', layer: 1, passed: true },
        { id: 'y', layer: 2, passed: false },
      ]),
    ).toBe('FAIL');
  });
  it('returns PASS when only skipped checks', () => {
    expect(
      overallFromChecks([
        { id: 'x', layer: 1, passed: true },
        { id: 'y', layer: 2, passed: true, skipped: true },
      ]),
    ).toBe('PASS');
  });
});
```

- [ ] **Step 2: Run — observe FAIL (module-not-found)**

```bash
cd client
yarn vitest run test/conformance/types.test.ts
```

- [ ] **Step 3: Write `client/src/conformance/types.ts`**

```typescript
/**
 * Conformance report shapes.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §4.10.
 *
 * A ConformanceReport is the output of running the harness against an envelope
 * CID. Layer 1 checks apply at every tier (structural). Layer 2 checks apply
 * only at the `attested` tier (traced-I/O boundary). Layer 2 runtime checks
 * are stubbed in V1 (skipped); Layer 2 static checks run fully.
 */

import type { EvidenceTier } from '../types/envelope.js';

export interface CheckResult {
  /** Dotted identifier: `<area>.<check>` — e.g. `envelope.schema`, `trajectory.hash-chain`. */
  id: string;
  /** Layer 1 = structural; Layer 2 = attested-tier traced-I/O boundary. */
  layer: 1 | 2;
  /** Whether the check passed. A skipped check is considered passing for overall verdict purposes. */
  passed: boolean;
  /** Set to true when the check was intentionally not run (e.g. Layer 2 at non-attested tier, or V1 runtime stub). */
  skipped?: boolean;
  /** Short human-readable reason on failure. */
  detail?: string;
}

export type Overall = 'PASS' | 'FAIL' | 'SKIP';

export interface ConformanceSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ConformanceReport {
  envelopeCid: string;
  envelopeTier: EvidenceTier;
  checks: CheckResult[];
  summary: ConformanceSummary;
  overall: Overall;
  layer1Passed: boolean;
  /** 'N/A' when envelopeTier !== 'attested'. */
  layer2Passed: boolean | 'N/A';
}

export interface ConformanceOptions {
  /** Skip Layer 2 source-bundle static checks even at attested tier. Useful during plan-D-only dogfood. */
  skipLayer2?: boolean;
  /** Override IPFS gateway URL (defaults to config). */
  ipfsGatewayUrl?: string;
  /** Override IPFS registry URL (defaults to config). */
  ipfsRegistryUrl?: string;
  /** Pre-fetched envelope bytes (skip IPFS fetch). */
  envelopeBytes?: Uint8Array;
}

/**
 * ConformanceContext carries pre-fetched objects between checks so each
 * check doesn't re-fetch from IPFS. The harness populates this incrementally
 * as checks pass.
 */
export interface ConformanceContext {
  envelopeCid: string;
  envelopeBytes?: Uint8Array;
  envelope?: import('../types/envelope.js').SignedEnvelope;
  intent?: import('../types/intent.js').SignedIntentV1;
  trajectoryBytes?: Uint8Array;
  trajectory?: unknown; // typed after Plan D schema lands
  sourceBundle?: { files: Map<string, string>; manifest?: Record<string, unknown> };
  options: ConformanceOptions;
}

export function summarize(checks: CheckResult[]): ConformanceSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.skipped) skipped++;
    else if (c.passed) passed++;
    else failed++;
  }
  return { total: checks.length, passed, failed, skipped };
}

export function overallFromChecks(checks: CheckResult[]): Overall {
  if (checks.length === 0) return 'SKIP';
  const anyFailed = checks.some((c) => !c.skipped && !c.passed);
  return anyFailed ? 'FAIL' : 'PASS';
}
```

- [ ] **Step 4: Run — green**

```bash
cd client
yarn vitest run test/conformance/types.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck**

```bash
cd client
yarn typecheck
```

- [ ] **Step 6: Commit**

```bash
git add client/src/conformance/types.ts client/test/conformance/types.test.ts
git commit -m "feat(conformance): types + report shape

Scope v0.9 §4.10. Adds ConformanceReport, CheckResult, and the
incremental ConformanceContext that carries pre-fetched objects
between checks so they don't re-fetch from IPFS. Layer 1 = structural
(every envelope); Layer 2 = attested-tier traced-I/O boundary."
```

---

## Task 2: Layer 1 envelope checks — schema + payload

**Files:**
- Create: `client/src/conformance/checks/envelope.ts` (partial — schema + payload checks only; hash + signature in Task 3)
- Create: `client/test/conformance/checks/envelope.test.ts`
- Create: `client/test/conformance/fixtures/good-envelope.ts` — fixture builder for a canonical known-good envelope

- [ ] **Step 1: Write a fixture builder**

Create `client/test/conformance/fixtures/good-envelope.ts` — a pure TypeScript helper that returns a well-formed `SignedEnvelope` + matching `SignedIntentV1` + matching (empty but schema-valid) trajectory + artifact CIDs. Don't hit IPFS. The builder signs with a fixed test private key derived from a seed so hashes are deterministic.

```typescript
import { privateKeyToAccount } from 'viem/accounts';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import type { SignedIntentV1 } from '../../../src/types/intent.js';
import { signIntentV1 } from '../../../src/intents/signing.js';
import { assembleAndSignEnvelope } from '../../../src/restorer/engine/envelope-assembly.js';

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const; // well-known Anvil dev key

export interface GoodFixture {
  intent: SignedIntentV1;
  envelope: SignedEnvelope;
  envelopeBytes: Uint8Array;
  envelopeCid: string; // stub — conformance path does not hit real CID resolver in tests
}

export async function buildGoodRestorationFixture(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<GoodFixture> {
  // build signed intent
  // build envelope calling assembleAndSignEnvelope with a stub ipfs uploader
  // (pass a local capture-only uploader that returns a predictable CID)
  // ...
}
```

The stub IPFS uploader: intercept `uploadToIpfs` via dependency injection on `assembleAndSignEnvelope`. (Plan C's `EnvelopeAssemblyDeps` already accepts `ipfsRegistryUrl` — extend by passing an optional uploader fn, OR let tests mock `uploadToIpfs` via `vi.mock`.) Use whichever pattern Plan C landed; if Plan C uses `vi.mock`, follow suit.

Return from `buildGoodRestorationFixture`: the signed envelope (with signature), its JSON-serialized bytes, and a synthetic envelope CID string (`bafytestfixture...`). Don't compute a real CID — tests operate on bytes directly.

Also export `buildGoodVerdictFixture` for verdict-path tests.

- [ ] **Step 2: Write failing tests for envelope schema + payload checks**

Create `client/test/conformance/checks/envelope.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  checkEnvelopeSchema,
  checkPayloadValidity,
} from '../../../src/conformance/checks/envelope.js';
import { buildGoodRestorationFixture } from '../fixtures/good-envelope.js';

describe('checkEnvelopeSchema', () => {
  it('passes on a well-formed envelope', async () => {
    const fx = await buildGoodRestorationFixture();
    const result = checkEnvelopeSchema({ envelope: fx.envelope } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.schema');
    expect(result.layer).toBe(1);
  });

  it('fails when schemaVersion is wrong', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, schemaVersion: 'jinn.execution.v2' as any };
    const result = checkEnvelopeSchema({ envelope: bad } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/schemaVersion/);
  });

  it('fails when kind is missing', async () => {
    const fx = await buildGoodRestorationFixture();
    const { kind: _k, ...noKind } = fx.envelope;
    const result = checkEnvelopeSchema({ envelope: noKind as any } as any);
    expect(result.passed).toBe(false);
  });
});

describe('checkPayloadValidity', () => {
  it('passes when payload parses against KIND_PAYLOADS[kind][role]', async () => {
    const fx = await buildGoodRestorationFixture();
    const result = checkPayloadValidity({ envelope: fx.envelope } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.payload');
  });

  it('fails when payload is malformed for the declared kind+role', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, payload: { bogus: 'data' } };
    const result = checkPayloadValidity({ envelope: bad } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('fails when kind is not in KIND_PAYLOADS registry', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, kind: 'unknown.kind' };
    const result = checkPayloadValidity({ envelope: bad } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/unknown/i);
  });
});
```

- [ ] **Step 3: Run — FAIL (module-not-found)**

```bash
cd client
yarn vitest run test/conformance/checks/envelope.test.ts
```

- [ ] **Step 4: Implement the two checks**

Create `client/src/conformance/checks/envelope.ts`:

```typescript
/**
 * Layer 1 envelope checks: schema, payload validity, hash consistency,
 * signature validity.
 */

import { SignedEnvelopeSchema } from '../../types/envelope.js';
import { KIND_PAYLOADS } from '../../types/payloads/index.js';
import type { CheckResult, ConformanceContext } from '../types.js';

export function checkEnvelopeSchema(ctx: ConformanceContext): CheckResult {
  const id = 'envelope.schema';
  const layer = 1 as const;
  const result = SignedEnvelopeSchema.safeParse(ctx.envelope);
  if (result.success) {
    return { id, layer, passed: true };
  }
  return {
    id,
    layer,
    passed: false,
    detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

export function checkPayloadValidity(ctx: ConformanceContext): CheckResult {
  const id = 'envelope.payload';
  const layer = 1 as const;
  const env = ctx.envelope;
  if (!env) {
    return { id, layer, passed: false, detail: 'envelope not loaded' };
  }
  const bucket = KIND_PAYLOADS[env.kind];
  if (!bucket) {
    return { id, layer, passed: false, detail: `unknown kind: ${env.kind}` };
  }
  const schema = bucket[env.role];
  if (!schema) {
    return { id, layer, passed: false, detail: `no payload schema for (${env.kind}, ${env.role})` };
  }
  const result = schema.safeParse(env.payload);
  if (result.success) {
    return { id, layer, passed: true };
  }
  return {
    id,
    layer,
    passed: false,
    detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}
```

- [ ] **Step 5: Run — green**

```bash
cd client
yarn vitest run test/conformance/checks/envelope.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add client/src/conformance/checks/envelope.ts \
        client/test/conformance/checks/envelope.test.ts \
        client/test/conformance/fixtures
git commit -m "feat(conformance): envelope schema + payload checks

Layer 1 structural checks: SignedEnvelopeSchema.safeParse and
KIND_PAYLOADS[kind][role].safeParse. Each returns a CheckResult
with human-readable issue details on failure."
```

---

## Task 3: Layer 1 envelope checks — canonical hash + signature

**Files:**
- Modify: `client/src/conformance/checks/envelope.ts`
- Modify: `client/test/conformance/checks/envelope.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/conformance/checks/envelope.test.ts`:

```typescript
import { checkCanonicalHash, checkSignatureValidity } from '../../../src/conformance/checks/envelope.js';
import { keccak256, toBytes } from 'viem';
import { canonicalJson } from '../../../src/restorer/engine/canonical-json.js';

describe('checkCanonicalHash', () => {
  it('passes when envelope hash = keccak256(JCS(envelope - signature))', async () => {
    const fx = await buildGoodRestorationFixture();
    const result = checkCanonicalHash({ envelope: fx.envelope } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.hash');
  });

  it('fails when signature.hash does not match recomputed hash', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = {
      ...fx.envelope,
      signature: { ...fx.envelope.signature, hash: '0x' + '00'.repeat(32) as `0x${string}` },
    };
    const result = checkCanonicalHash({ envelope: bad } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/hash/i);
  });

  it('fails when any non-signature field is tampered (hash becomes stale)', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, generatedAt: fx.envelope.generatedAt + 1 };
    const result = checkCanonicalHash({ envelope: bad } as any);
    expect(result.passed).toBe(false);
  });
});

describe('checkSignatureValidity', () => {
  it('passes on a valid signature from the declared signer', async () => {
    const fx = await buildGoodRestorationFixture();
    const result = await checkSignatureValidity({ envelope: fx.envelope } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.signature');
  });

  it('fails when signer does not recover from hash+sig', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = {
      ...fx.envelope,
      signature: {
        ...fx.envelope.signature,
        signer: '0x0000000000000000000000000000000000000001' as `0x${string}`,
      },
    };
    const result = await checkSignatureValidity({ envelope: bad } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/signer/i);
  });

  it('fails when sig is malformed', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = {
      ...fx.envelope,
      signature: { ...fx.envelope.signature, sig: '0xbeef' as `0x${string}` },
    };
    const result = await checkSignatureValidity({ envelope: bad } as any);
    expect(result.passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
cd client
yarn vitest run test/conformance/checks/envelope.test.ts
```

- [ ] **Step 3: Implement**

Append to `client/src/conformance/checks/envelope.ts`:

```typescript
import { keccak256, toBytes, recoverAddress, type Hex } from 'viem';
import { canonicalJson } from '../../restorer/engine/canonical-json.js';

export function checkCanonicalHash(ctx: ConformanceContext): CheckResult {
  const id = 'envelope.hash';
  const layer = 1 as const;
  const env = ctx.envelope;
  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  const { signature, ...unsigned } = env;
  const recomputed = keccak256(toBytes(canonicalJson(unsigned)));
  if (recomputed.toLowerCase() !== signature.hash.toLowerCase()) {
    return {
      id,
      layer,
      passed: false,
      detail: `signature.hash ${signature.hash} does not match keccak256(JCS(envelope-signature))=${recomputed}`,
    };
  }
  return { id, layer, passed: true };
}

export async function checkSignatureValidity(ctx: ConformanceContext): Promise<CheckResult> {
  const id = 'envelope.signature';
  const layer = 1 as const;
  const env = ctx.envelope;
  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  const { hash, sig, signer } = env.signature;
  try {
    const recovered = await recoverAddress({ hash: hash as Hex, signature: sig as Hex });
    if (recovered.toLowerCase() !== signer.toLowerCase()) {
      return {
        id,
        layer,
        passed: false,
        detail: `recovered signer ${recovered} does not match declared signer ${signer}`,
      };
    }
    return { id, layer, passed: true };
  } catch (err) {
    return {
      id,
      layer,
      passed: false,
      detail: `signature recovery failed: ${(err as Error).message}`,
    };
  }
}
```

- [ ] **Step 4: Run — green**

```bash
cd client
yarn vitest run test/conformance/checks/envelope.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add client/src/conformance/checks/envelope.ts \
        client/test/conformance/checks/envelope.test.ts
git commit -m "feat(conformance): canonical hash + signature checks

checkCanonicalHash recomputes keccak256(JCS(envelope-signature)) and
compares against signature.hash. checkSignatureValidity recovers the
signer from (hash, sig) via viem.recoverAddress and compares against
signature.signer. Catches tampering of any non-signature envelope field."
```

---

## Task 4: Layer 1 intent reference resolvability

**Files:**
- Modify: `client/src/conformance/checks/envelope.ts`
- Modify: `client/test/conformance/checks/envelope.test.ts`

- [ ] **Step 1: Add failing test**

Append:

```typescript
import { checkIntentReference } from '../../../src/conformance/checks/envelope.js';

describe('checkIntentReference', () => {
  it('passes when ctx.intent is present and parses as SignedIntentV1', async () => {
    const fx = await buildGoodRestorationFixture();
    const result = checkIntentReference({ envelope: fx.envelope, intent: fx.intent } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.intent-ref');
  });

  it('fails when ctx.intent is missing (IPFS resolution failed)', async () => {
    const fx = await buildGoodRestorationFixture();
    const result = checkIntentReference({ envelope: fx.envelope } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/resolve|intent/i);
  });

  it('fails when intent.id does not match the kind/spec referenced by envelope', async () => {
    const fx = await buildGoodRestorationFixture();
    const mismatched = { ...fx.intent, kind: 'prediction.v0' };
    const result = checkIntentReference({
      envelope: fx.envelope,
      intent: mismatched,
    } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/kind/i);
  });
});
```

- [ ] **Step 2: Implement `checkIntentReference`**

```typescript
import { SignedIntentV1Schema } from '../../types/intent.js';

export function checkIntentReference(ctx: ConformanceContext): CheckResult {
  const id = 'envelope.intent-ref';
  const layer = 1 as const;
  if (!ctx.intent) {
    return {
      id,
      layer,
      passed: false,
      detail: `intent CID ${ctx.envelope?.intent.cid} did not resolve from IPFS`,
    };
  }
  const parsed = SignedIntentV1Schema.safeParse(ctx.intent);
  if (!parsed.success) {
    return {
      id,
      layer,
      passed: false,
      detail: `resolved intent failed schema: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  // Kind coherence: the envelope declares `kind`; the intent must declare the same.
  if (ctx.envelope && parsed.data.kind !== ctx.envelope.kind) {
    return {
      id,
      layer,
      passed: false,
      detail: `envelope.kind=${ctx.envelope.kind} but intent.kind=${parsed.data.kind}`,
    };
  }
  return { id, layer, passed: true };
}
```

- [ ] **Step 3: Run tests + commit**

```bash
cd client
yarn vitest run test/conformance/checks/envelope.test.ts
git add client/src/conformance/checks/envelope.ts client/test/conformance/checks/envelope.test.ts
git commit -m "feat(conformance): intent reference resolvability check

Verifies that ctx.intent was resolved from envelope.intent.cid, parses
as SignedIntentV1, and declares the same kind as the envelope."
```

---

## Task 5: Layer 1 trajectory schema + hash chain

**Files:**
- Create: `client/src/conformance/checks/trajectory.ts`
- Create: `client/test/conformance/checks/trajectory.test.ts`
- Create: `client/test/conformance/fixtures/good-trajectory.ts`

- [ ] **Step 1: Add a good-trajectory fixture builder**

Create `client/test/conformance/fixtures/good-trajectory.ts` — builds a tiny trajectory with:
- 3 spans: one `jinn.phase`, one `jinn.llm_call`, one `jinn.artifact.emit`
- Each has a valid `jinn.prevSpanHash` (span 1 = genesis = keccak256 of envelope's `intent.cid`; span 2 = keccak256(JCS(span1)); span 3 = keccak256(JCS(span2)))
- Each has the required attributes per Plan D's span profile
- Each has `jinn.span.kind` set
- Schema-valid per `JinnTrajectoryV1Schema` (Plan D).

Export `buildGoodTrajectoryFixture(envelopeIntentCid)`.

- [ ] **Step 2: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import {
  checkTrajectorySchema,
  checkHashChainIntegrity,
  checkSpanProfileConformance,
} from '../../../src/conformance/checks/trajectory.js';
import { buildGoodTrajectoryFixture } from '../fixtures/good-trajectory.js';

describe('checkTrajectorySchema', () => {
  it('passes on schema-valid trajectory', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    const result = checkTrajectorySchema({ trajectory: traj } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('trajectory.schema');
  });

  it('fails on missing spans array', () => {
    const result = checkTrajectorySchema({ trajectory: { schemaVersion: 'jinn.trajectory.v1' } } as any);
    expect(result.passed).toBe(false);
  });

  it('skips when trajectory is null (envelope.trajectory nullable)', () => {
    const result = checkTrajectorySchema({ trajectory: null, envelope: { trajectory: null } } as any);
    expect(result.skipped).toBe(true);
  });
});

describe('checkHashChainIntegrity', () => {
  it('passes when every span.jinn.prevSpanHash matches keccak256(JCS(prev span))', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    const result = checkHashChainIntegrity({
      trajectory: traj,
      envelope: { intent: { cid: 'bafy-intent' } } as any,
    } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('trajectory.hash-chain');
  });

  it('fails when a later span has wrong prevSpanHash', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    traj.spans[2].attributes['jinn.prevSpanHash'] = '0x' + 'de'.repeat(32);
    const result = checkHashChainIntegrity({
      trajectory: traj,
      envelope: { intent: { cid: 'bafy-intent' } } as any,
    } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/span\[2\]/);
  });

  it("fails when first span's prevSpanHash doesn't match genesis(envelope.intent.cid)", () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    traj.spans[0].attributes['jinn.prevSpanHash'] = '0x' + 'ab'.repeat(32);
    const result = checkHashChainIntegrity({
      trajectory: traj,
      envelope: { intent: { cid: 'bafy-intent' } } as any,
    } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/genesis|span\[0\]/);
  });
});
```

- [ ] **Step 3: Implement the two checks**

Create `client/src/conformance/checks/trajectory.ts`:

```typescript
/**
 * Layer 1 trajectory checks.
 *
 * Depends on Plan D's JinnTrajectoryV1Schema and span-profile descriptors.
 */

import { keccak256, toBytes, type Hex } from 'viem';
import { canonicalJson } from '../../restorer/engine/canonical-json.js';
import type { CheckResult, ConformanceContext } from '../types.js';

// Imported from Plan D — adjust path if Plan D puts them elsewhere.
import { JinnTrajectoryV1Schema } from '../../trajectory/schema.js';
import { SPAN_PROFILE } from '../../trajectory/span-profile.js';

type Span = {
  spanId: string;
  attributes: Record<string, unknown>;
};

export function checkTrajectorySchema(ctx: ConformanceContext): CheckResult {
  const id = 'trajectory.schema';
  const layer = 1 as const;
  // Envelope can legitimately carry a null trajectory at self-signed / committed
  // tier during Plan F's V1 rollout — we skip the check in that case.
  if (ctx.envelope?.trajectory == null && ctx.trajectory == null) {
    return { id, layer, passed: true, skipped: true, detail: 'envelope.trajectory is null' };
  }
  const result = JinnTrajectoryV1Schema.safeParse(ctx.trajectory);
  if (result.success) return { id, layer, passed: true };
  return {
    id,
    layer,
    passed: false,
    detail: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

function genesisHashForIntent(intentCid: string): Hex {
  return keccak256(toBytes(`jinn.trajectory.genesis:${intentCid}`));
}

export function checkHashChainIntegrity(ctx: ConformanceContext): CheckResult {
  const id = 'trajectory.hash-chain';
  const layer = 1 as const;
  const traj = ctx.trajectory as { spans: Span[] } | null | undefined;
  if (!traj) return { id, layer, passed: true, skipped: true };
  const intentCid = ctx.envelope?.intent.cid;
  if (!intentCid) {
    return { id, layer, passed: false, detail: 'envelope.intent.cid missing; cannot compute genesis' };
  }
  const genesis = genesisHashForIntent(intentCid);
  let expectedPrev: Hex = genesis;
  for (let i = 0; i < traj.spans.length; i++) {
    const span = traj.spans[i];
    const declared = span.attributes['jinn.prevSpanHash'] as Hex | undefined;
    if (typeof declared !== 'string' || declared.toLowerCase() !== expectedPrev.toLowerCase()) {
      return {
        id,
        layer,
        passed: false,
        detail: `span[${i}] (${span.spanId}): prevSpanHash ${declared} !== expected ${expectedPrev}${
          i === 0 ? ' (genesis)' : ''
        }`,
      };
    }
    expectedPrev = keccak256(toBytes(canonicalJson(span))) as Hex;
  }
  return { id, layer, passed: true };
}
```

The genesis-hash formula (`keccak256(bytes("jinn.trajectory.genesis:<intent.cid>"))`) is a placeholder — update in Step 4 to whatever Plan D's `span-profile.ts` actually exports as the genesis function. If Plan D exports `genesisHashForIntent`, import and use it directly; delete the local copy.

- [ ] **Step 4: Reconcile with Plan D's genesis function**

Read Plan D's output. If it exports `genesisHashForIntent(intentCid)`, replace the local helper. If not, leave the local helper but file a follow-up issue to unify.

- [ ] **Step 5: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/trajectory.test.ts
git add client/src/conformance/checks/trajectory.ts \
        client/test/conformance/checks/trajectory.test.ts \
        client/test/conformance/fixtures/good-trajectory.ts
git commit -m "feat(conformance): trajectory schema + hash-chain checks

Layer 1 structural checks. checkTrajectorySchema uses Plan D's
JinnTrajectoryV1Schema; skipped when envelope.trajectory is null
(legitimate at self-signed / committed tier during rollout).

checkHashChainIntegrity walks every span and verifies
jinn.prevSpanHash matches keccak256(JCS(prev_span)); first span
links to genesis = keccak256('jinn.trajectory.genesis:' + intent.cid)."
```

---

## Task 6: Layer 1 span profile conformance

**Files:**
- Modify: `client/src/conformance/checks/trajectory.ts`
- Modify: `client/test/conformance/checks/trajectory.test.ts`

Scope §3.1 K6: every span must have the required attributes per its `jinn.span.kind`. Plan D exports `SPAN_PROFILE: Record<SpanKind, { required: string[]; optional?: string[] }>`.

- [ ] **Step 1: Add failing tests**

```typescript
describe('checkSpanProfileConformance', () => {
  it('passes when every span has its kind-required attributes', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    const result = checkSpanProfileConformance({ trajectory: traj } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('trajectory.span-profile');
  });

  it("fails when a jinn.llm_call span is missing 'gen_ai.system'", () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    const llmSpan = traj.spans.find((s: any) => s.attributes['jinn.span.kind'] === 'jinn.llm_call');
    delete llmSpan!.attributes['gen_ai.system'];
    const result = checkSpanProfileConformance({ trajectory: traj } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/gen_ai\.system/);
  });

  it('fails when a span has unknown jinn.span.kind', () => {
    const traj = buildGoodTrajectoryFixture('bafy-intent');
    traj.spans[0].attributes['jinn.span.kind'] = 'jinn.unknown';
    const result = checkSpanProfileConformance({ trajectory: traj } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/unknown/i);
  });
});
```

- [ ] **Step 2: Implement**

Append to `client/src/conformance/checks/trajectory.ts`:

```typescript
export function checkSpanProfileConformance(ctx: ConformanceContext): CheckResult {
  const id = 'trajectory.span-profile';
  const layer = 1 as const;
  const traj = ctx.trajectory as { spans: Span[] } | null | undefined;
  if (!traj) return { id, layer, passed: true, skipped: true };
  const failures: string[] = [];
  for (let i = 0; i < traj.spans.length; i++) {
    const span = traj.spans[i];
    const kind = span.attributes['jinn.span.kind'] as string | undefined;
    if (!kind) {
      failures.push(`span[${i}] missing jinn.span.kind`);
      continue;
    }
    const profile = SPAN_PROFILE[kind];
    if (!profile) {
      failures.push(`span[${i}] unknown jinn.span.kind: ${kind}`);
      continue;
    }
    for (const req of profile.required) {
      if (!(req in span.attributes)) {
        failures.push(`span[${i}] (${kind}) missing required attribute: ${req}`);
      }
    }
  }
  if (failures.length === 0) return { id, layer, passed: true };
  return { id, layer, passed: false, detail: failures.slice(0, 5).join('; ') };
}
```

- [ ] **Step 3: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/trajectory.test.ts
git add client/src/conformance/checks/trajectory.ts client/test/conformance/checks/trajectory.test.ts
git commit -m "feat(conformance): span profile conformance check

Scope v0.9 §3.1 K6. For every span in the trajectory, look up
SPAN_PROFILE[jinn.span.kind] and confirm all required attributes
are present. Unknown kinds fail immediately. Reports up to 5
failures per run to avoid unbounded detail messages."
```

---

## Task 7: Layer 1 artifact vocabulary + trajectory↔artifact linkage

**Files:**
- Create: `client/src/conformance/checks/artifacts.ts`
- Create: `client/test/conformance/checks/artifacts.test.ts`

Two checks:
1. `checkArtifactTypeVocabulary` — required artifact types are present (`trajectory` if envelope has trajectory, `system_snapshot`, `output.<kind>`); reserved standard types from scope §3.1 K9 are allowed; custom types permitted (no failure for unknown types, but we record a `SKIP` note — operators can use custom types freely).
2. `checkTrajectoryArtifactLinkage` — bidirectional linkage per scope §3.1 K5: every artifact with `metadata.producedBy.spanId` references a real span id; every `jinn.artifact.emit` span's `jinn.artifact.cid` attribute references a real artifact CID in `envelope.artifacts[]`.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import {
  checkArtifactTypeVocabulary,
  checkTrajectoryArtifactLinkage,
} from '../../../src/conformance/checks/artifacts.js';
import { buildGoodRestorationFixture } from '../fixtures/good-envelope.js';
import { buildGoodTrajectoryFixture } from '../fixtures/good-trajectory.js';

describe('checkArtifactTypeVocabulary', () => {
  it('passes when required types are present for kind=portfolio.v0', async () => {
    const fx = await buildGoodRestorationFixture();
    // Fixture must seed artifacts with at least: trajectory, system_snapshot, output.portfolio.v0
    const result = checkArtifactTypeVocabulary({ envelope: fx.envelope } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('artifacts.vocabulary');
  });

  it('fails when required output.<kind> is missing', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = {
      ...fx.envelope,
      artifacts: fx.envelope.artifacts.filter((a) => !a.artifactType.startsWith('output.')),
    };
    const result = checkArtifactTypeVocabulary({ envelope: bad } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/output\.portfolio\.v0/);
  });

  it('passes on custom artifactType (vocabulary is extensible)', async () => {
    const fx = await buildGoodRestorationFixture();
    const env = {
      ...fx.envelope,
      artifacts: [
        ...fx.envelope.artifacts,
        { cid: 'bafy-custom', artifactType: 'custom.operator-specific' },
      ],
    };
    const result = checkArtifactTypeVocabulary({ envelope: env } as any);
    expect(result.passed).toBe(true);
  });
});

describe('checkTrajectoryArtifactLinkage', () => {
  it('passes when every artifact.metadata.producedBy.spanId points to a real span', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.intent.id);
    // Fixture must pre-link an artifact to a span in the trajectory.
    const result = checkTrajectoryArtifactLinkage({
      envelope: fx.envelope,
      trajectory: traj,
    } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('artifacts.linkage');
  });

  it('fails when an artifact.producedBy.spanId points to a nonexistent span', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.intent.id);
    const env = {
      ...fx.envelope,
      artifacts: [
        ...fx.envelope.artifacts,
        {
          cid: 'bafy-orphan',
          artifactType: 'runtime_log',
          metadata: { producedBy: { spanId: 'nonexistent', trajectoryCid: 'bafy-traj' } },
        },
      ],
    };
    const result = checkTrajectoryArtifactLinkage({ envelope: env, trajectory: traj } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/nonexistent/);
  });

  it("fails when a jinn.artifact.emit span references a CID not in envelope.artifacts", async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.intent.id);
    // corrupt the emit span's CID
    const emitSpan = traj.spans.find((s: any) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit');
    emitSpan!.attributes['jinn.artifact.cid'] = 'bafy-orphan';
    const result = checkTrajectoryArtifactLinkage({
      envelope: fx.envelope,
      trajectory: traj,
    } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/bafy-orphan/);
  });
});
```

- [ ] **Step 2: Implement**

Create `client/src/conformance/checks/artifacts.ts`:

```typescript
/**
 * Layer 1 artifact vocabulary + linkage checks.
 *
 * Scope v0.9 §3.1 K9 (artifactType vocabulary) + K5 (trajectory↔artifact
 * bidirectional linkage).
 */

import type { CheckResult, ConformanceContext } from '../types.js';

const RESERVED_STANDARD_TYPES = new Set([
  'trajectory',
  'system_snapshot',
  'design_document',
  'session_transcript',
  'runtime_log',
  'code_patch',
  'research_note',
  'skill_bundle',
  'mcp_config',
  'promotion_record',
  'source_bundle',
]);

export function checkArtifactTypeVocabulary(ctx: ConformanceContext): CheckResult {
  const id = 'artifacts.vocabulary';
  const layer = 1 as const;
  const env = ctx.envelope;
  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };

  const types = new Set(env.artifacts.map((a) => a.artifactType));
  const required: string[] = [];
  // output.<kind> is always required
  required.push(`output.${env.kind}`);
  // system_snapshot required at every tier for restoration role (scope §3.1 K9)
  if (env.role === 'restoration') required.push('system_snapshot');
  // trajectory required when envelope.trajectory is populated
  if (env.trajectory != null) required.push('trajectory');

  const missing = required.filter((r) => !types.has(r));
  if (missing.length > 0) {
    return { id, layer, passed: false, detail: `missing required artifactTypes: ${missing.join(', ')}` };
  }
  // Custom types are permitted — no failure for unknown values outside reserved list.
  return { id, layer, passed: true };
}

export function checkTrajectoryArtifactLinkage(ctx: ConformanceContext): CheckResult {
  const id = 'artifacts.linkage';
  const layer = 1 as const;
  const env = ctx.envelope;
  const traj = ctx.trajectory as { spans: Array<{ spanId: string; attributes: Record<string, unknown> }> } | null | undefined;
  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  if (!traj) return { id, layer, passed: true, skipped: true, detail: 'trajectory not present' };

  const spanIds = new Set(traj.spans.map((s) => s.spanId));
  const artifactCids = new Set(env.artifacts.map((a) => a.cid));
  const failures: string[] = [];

  // 1. Every artifact with producedBy.spanId must reference a real span.
  for (const art of env.artifacts) {
    const producedBy = art.metadata?.producedBy;
    if (producedBy?.spanId && !spanIds.has(producedBy.spanId)) {
      failures.push(`artifact ${art.cid} references nonexistent spanId=${producedBy.spanId}`);
    }
  }

  // 2. Every jinn.artifact.emit span's jinn.artifact.cid must be in envelope.artifacts.
  for (const span of traj.spans) {
    if (span.attributes['jinn.span.kind'] === 'jinn.artifact.emit') {
      const cid = span.attributes['jinn.artifact.cid'] as string | undefined;
      if (!cid) {
        failures.push(`span ${span.spanId} (jinn.artifact.emit) has no jinn.artifact.cid`);
      } else if (!artifactCids.has(cid)) {
        failures.push(`span ${span.spanId} references artifact CID ${cid} not in envelope.artifacts`);
      }
    }
  }

  if (failures.length === 0) return { id, layer, passed: true };
  return { id, layer, passed: false, detail: failures.slice(0, 5).join('; ') };
}
```

- [ ] **Step 3: Update the good-envelope fixture**

The good-envelope fixture must seed artifacts (`trajectory`, `system_snapshot`, `output.portfolio.v0`) to pass vocabulary check, and pre-link at least one artifact to a real trajectory span id to exercise linkage.

- [ ] **Step 4: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/artifacts.test.ts
git add client/src/conformance/checks/artifacts.ts client/test/conformance/checks/artifacts.test.ts client/test/conformance/fixtures
git commit -m "feat(conformance): artifact vocabulary + trajectory linkage

Layer 1 artifacts checks. Required types: output.<kind> always;
system_snapshot for role=restoration; trajectory when
envelope.trajectory is populated. Reserved standard types permitted;
custom types permitted (vocabulary extensible per scope §3.1 K9).

Linkage check: every artifact.metadata.producedBy.spanId points to a
real span; every jinn.artifact.emit span's jinn.artifact.cid is in
envelope.artifacts[]."
```

---

## Task 8: Layer 1 verdict-specific checks

**Files:**
- Create: `client/src/conformance/checks/verdict.ts`
- Create: `client/test/conformance/checks/verdict.test.ts`

Scope §3.3: verdict envelopes must carry `payload.restorationEnvelope: { cid, sha256 }` and `payload.verificationOfRestoration: { claimedTier, sdkVersion, timestamp, checks[], overall }`. Verify:
- `payload.restorationEnvelope.cid` resolves (passed via ctx.restorationEnvelopeBytes or ctx.restorationEnvelope)
- declared `payload.restorationEnvelope.sha256` matches the fetched bytes' sha256
- `payload.verificationOfRestoration` is present and structurally valid (nonempty checks array, `overall` ∈ `{valid, invalid}`)

- [ ] **Step 1: Add `restorationEnvelopeBytes` / `restorationEnvelope` to `ConformanceContext`**

Modify `types.ts`:

```typescript
export interface ConformanceContext {
  // ... existing ...
  restorationEnvelopeBytes?: Uint8Array;
  restorationEnvelope?: import('../types/envelope.js').SignedEnvelope;
}
```

- [ ] **Step 2: Write failing tests**

Fixtures: `buildGoodVerdictFixture()` returns a verdict envelope that references a companion restoration envelope via `payload.restorationEnvelope`.

```typescript
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  checkVerdictBackReference,
  checkVerificationRecordPresent,
} from '../../../src/conformance/checks/verdict.js';
import { buildGoodVerdictFixture } from '../fixtures/good-envelope.js';

describe('checkVerdictBackReference', () => {
  it('skipped on restoration-role envelope', async () => {
    const vfx = await buildGoodVerdictFixture();
    const result = checkVerdictBackReference({
      envelope: { ...vfx.envelope, role: 'restoration' },
    } as any);
    expect(result.skipped).toBe(true);
  });

  it('passes when restorationEnvelope.sha256 matches fetched bytes', async () => {
    const vfx = await buildGoodVerdictFixture();
    const result = checkVerdictBackReference({
      envelope: vfx.envelope,
      restorationEnvelopeBytes: vfx.restorationEnvelopeBytes,
    } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('verdict.back-ref');
  });

  it('fails when sha256 does not match', async () => {
    const vfx = await buildGoodVerdictFixture();
    const tampered = new Uint8Array([...vfx.restorationEnvelopeBytes, 0x00]);
    const result = checkVerdictBackReference({
      envelope: vfx.envelope,
      restorationEnvelopeBytes: tampered,
    } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/sha256/i);
  });

  it('fails when restoration bytes not provided (did not resolve)', async () => {
    const vfx = await buildGoodVerdictFixture();
    const result = checkVerdictBackReference({ envelope: vfx.envelope } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/resolve/i);
  });
});

describe('checkVerificationRecordPresent', () => {
  it('skipped on restoration-role envelope', async () => {
    const vfx = await buildGoodVerdictFixture();
    const result = checkVerificationRecordPresent({
      envelope: { ...vfx.envelope, role: 'restoration' },
    } as any);
    expect(result.skipped).toBe(true);
  });

  it('passes when verificationOfRestoration is present + valid', async () => {
    const vfx = await buildGoodVerdictFixture();
    const result = checkVerificationRecordPresent({ envelope: vfx.envelope } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('verdict.verification-record');
  });

  it('fails when verificationOfRestoration has empty checks array', async () => {
    const vfx = await buildGoodVerdictFixture();
    const env = {
      ...vfx.envelope,
      payload: {
        ...vfx.envelope.payload,
        verificationOfRestoration: {
          ...(vfx.envelope.payload as any).verificationOfRestoration,
          checks: [],
        },
      },
    };
    const result = checkVerificationRecordPresent({ envelope: env } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/checks/);
  });
});
```

- [ ] **Step 3: Implement**

```typescript
import { createHash } from 'node:crypto';
import type { CheckResult, ConformanceContext } from '../types.js';

export function checkVerdictBackReference(ctx: ConformanceContext): CheckResult {
  const id = 'verdict.back-ref';
  const layer = 1 as const;
  const env = ctx.envelope;
  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  if (env.role !== 'verdict') return { id, layer, passed: true, skipped: true };
  const payload = env.payload as Record<string, any>;
  const ref = payload?.restorationEnvelope;
  if (!ref || typeof ref.cid !== 'string' || typeof ref.sha256 !== 'string') {
    return { id, layer, passed: false, detail: 'payload.restorationEnvelope missing or malformed' };
  }
  if (!ctx.restorationEnvelopeBytes) {
    return { id, layer, passed: false, detail: `restoration CID ${ref.cid} did not resolve from IPFS` };
  }
  const actualSha = createHash('sha256').update(ctx.restorationEnvelopeBytes).digest('hex');
  if (actualSha !== ref.sha256.toLowerCase()) {
    return {
      id,
      layer,
      passed: false,
      detail: `sha256 mismatch: fetched bytes=${actualSha}, declared=${ref.sha256}`,
    };
  }
  return { id, layer, passed: true };
}

export function checkVerificationRecordPresent(ctx: ConformanceContext): CheckResult {
  const id = 'verdict.verification-record';
  const layer = 1 as const;
  const env = ctx.envelope;
  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  if (env.role !== 'verdict') return { id, layer, passed: true, skipped: true };
  const payload = env.payload as Record<string, any>;
  const rec = payload?.verificationOfRestoration;
  if (!rec || typeof rec !== 'object') {
    return { id, layer, passed: false, detail: 'payload.verificationOfRestoration missing' };
  }
  const issues: string[] = [];
  if (!Array.isArray(rec.checks) || rec.checks.length === 0) {
    issues.push('verificationOfRestoration.checks must be a nonempty array');
  }
  if (rec.overall !== 'valid' && rec.overall !== 'invalid') {
    issues.push(`verificationOfRestoration.overall must be 'valid' or 'invalid', got ${rec.overall}`);
  }
  if (typeof rec.claimedTier !== 'string') issues.push('verificationOfRestoration.claimedTier missing');
  if (typeof rec.sdkVersion !== 'string') issues.push('verificationOfRestoration.sdkVersion missing');
  if (typeof rec.timestamp !== 'number') issues.push('verificationOfRestoration.timestamp missing');
  if (issues.length === 0) return { id, layer, passed: true };
  return { id, layer, passed: false, detail: issues.join('; ') };
}
```

- [ ] **Step 4: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/verdict.test.ts
git add client/src/conformance/checks/verdict.ts \
        client/src/conformance/types.ts \
        client/test/conformance/checks/verdict.test.ts \
        client/test/conformance/fixtures
git commit -m "feat(conformance): verdict back-ref + verification record checks

Scope v0.9 §3.3. Verdict-role envelopes must carry
payload.restorationEnvelope.{cid,sha256} (checked against fetched
bytes) and payload.verificationOfRestoration (claimedTier, sdkVersion,
timestamp, nonempty checks[], overall). Restoration-role envelopes
skip both."
```

---

## Task 9: Layer 1 V1 minimum secret-scrub compliance

**Files:**
- Create: `client/src/conformance/checks/secret-scrub.ts`
- Create: `client/test/conformance/checks/secret-scrub.test.ts`

Scope §4.3: V1 minimum secret-scrub — for all `*.authorization`, `*.apiKey`, `*.bearer`, `*.password`, `*.secret`, `*.token`, `*.privateKey` attribute names in spans (plus MCP tool args matching these patterns), the attribute value must be the redacted marker `<redacted:name>` or structurally not contain a literal credential. We cannot detect *all* possible secrets, but we can detect the common patterns. Positive check: scrubbed values follow the `<redacted:*>` marker format. Negative check: attribute values that look like Bearer tokens (`eyJ...`), hex private keys (`0x[0-9a-f]{64}` for attributes named `*.privateKey` only — elsewhere 64-char hex is legitimate), or obvious API key patterns (`sk-[A-Za-z0-9]{20,}`, `sk-ant-[A-Za-z0-9-]{30,}`) on these named attribute paths trigger a failure.

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { checkSecretScrub } from '../../../src/conformance/checks/secret-scrub.js';

function spanWith(attrs: Record<string, unknown>) {
  return {
    spanId: 'sp1',
    attributes: { 'jinn.span.kind': 'jinn.llm_call', ...attrs },
  };
}

describe('checkSecretScrub', () => {
  it('passes when no sensitive attributes are present', () => {
    const traj = { spans: [spanWith({ 'gen_ai.system': 'anthropic' })] };
    const result = checkSecretScrub({ trajectory: traj } as any);
    expect(result.passed).toBe(true);
  });

  it('passes when sensitive attributes use redacted markers', () => {
    const traj = {
      spans: [
        spanWith({
          'http.request.header.authorization': '<redacted:authorization>',
          'mcp.arg.apiKey': '<redacted:apiKey>',
        }),
      ],
    };
    const result = checkSecretScrub({ trajectory: traj } as any);
    expect(result.passed).toBe(true);
  });

  it('fails on raw Bearer token in *.authorization', () => {
    const traj = {
      spans: [spanWith({ 'http.request.header.authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.def' })],
    };
    const result = checkSecretScrub({ trajectory: traj } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/authorization/);
  });

  it('fails on raw Anthropic API key in *.apiKey', () => {
    const traj = {
      spans: [spanWith({ 'gen_ai.apiKey': 'sk-ant-api03-abcdefghij1234567890abcdef1234567890abcdef' })],
    };
    const result = checkSecretScrub({ trajectory: traj } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/apiKey/);
  });

  it('fails on raw private key in *.privateKey', () => {
    const traj = {
      spans: [spanWith({ 'wallet.privateKey': '0x' + 'a'.repeat(64) })],
    };
    const result = checkSecretScrub({ trajectory: traj } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/privateKey/);
  });

  it('passes when attribute name matches but value is already empty / null', () => {
    const traj = { spans: [spanWith({ 'http.request.header.authorization': '' })] };
    const result = checkSecretScrub({ trajectory: traj } as any);
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
/**
 * V1 minimum secret-scrub compliance.
 *
 * Scope v0.9 §4.3. Attribute names matching the sensitive allowlist must
 * have values that are redaction markers (<redacted:name>), empty strings,
 * or at minimum do not match well-known credential patterns.
 *
 * This is a V1-minimum safety check, not a full IP-protection redaction
 * (that lives in the deferred gating epic).
 */

import type { CheckResult, ConformanceContext } from '../types.js';

const SENSITIVE_SUFFIXES = [
  'authorization',
  'apikey',
  'bearer',
  'password',
  'secret',
  'token',
  'privatekey',
];

// Patterns that indicate a raw credential leaked through.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /^Bearer\s+[A-Za-z0-9._-]{10,}/i,
  /^sk-ant-[A-Za-z0-9_-]{20,}/,
  /^sk-[A-Za-z0-9]{20,}/,
  /^0x[0-9a-fA-F]{64}$/, // only applied for *.privateKey attribute (hex 64 is legitimate elsewhere)
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
];

const REDACTED_MARKER = /^<redacted:[A-Za-z0-9_.-]+>$/;

function isSensitive(attrName: string): string | null {
  const lower = attrName.toLowerCase();
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (lower.endsWith(`.${suffix}`) || lower === suffix) return suffix;
  }
  return null;
}

function looksLikeCredential(value: string, suffix: string): boolean {
  if (value === '' || value == null) return false;
  if (REDACTED_MARKER.test(value)) return false;
  for (const pat of CREDENTIAL_PATTERNS) {
    // hex64 pattern gated to privatekey-style attrs
    if (pat.source.startsWith('^0x[0-9a-fA-F]{64}')) {
      if (suffix === 'privatekey' && pat.test(value)) return true;
      continue;
    }
    if (pat.test(value)) return true;
  }
  return false;
}

export function checkSecretScrub(ctx: ConformanceContext): CheckResult {
  const id = 'secret-scrub.compliance';
  const layer = 1 as const;
  const traj = ctx.trajectory as { spans: Array<{ spanId: string; attributes: Record<string, unknown> }> } | null | undefined;
  if (!traj) return { id, layer, passed: true, skipped: true };
  const failures: string[] = [];
  for (const span of traj.spans) {
    for (const [key, value] of Object.entries(span.attributes)) {
      const suffix = isSensitive(key);
      if (!suffix) continue;
      if (typeof value !== 'string') continue;
      if (REDACTED_MARKER.test(value) || value === '') continue;
      if (looksLikeCredential(value, suffix)) {
        failures.push(`span ${span.spanId} attr ${key} appears to contain a raw credential`);
      }
    }
  }
  if (failures.length === 0) return { id, layer, passed: true };
  return { id, layer, passed: false, detail: failures.slice(0, 5).join('; ') };
}
```

- [ ] **Step 3: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/secret-scrub.test.ts
git add client/src/conformance/checks/secret-scrub.ts \
        client/test/conformance/checks/secret-scrub.test.ts
git commit -m "feat(conformance): V1 minimum secret-scrub compliance

Scope v0.9 §4.3. Detects common credential patterns (Bearer tokens,
Anthropic/OpenAI API keys, JWTs, raw private keys) leaked through
attribute names ending in authorization|apiKey|bearer|password|
secret|token|privateKey. Redaction markers (<redacted:*>) pass;
empty strings pass. This is safety, not access control."
```

---

## Task 10: Layer 2 static check (a) — traced HTTP client

**Files:**
- Create: `client/src/conformance/checks/source-static.ts`
- Create: `client/test/conformance/checks/source-static.test.ts`
- Create: `client/test/conformance/fixtures/source-bundles/` — tiny fake source bundles (good + bad variants for each check)

Scope §4.10(a): "all LLM calls route through a measured traced HTTP client (no raw `fetch` / `axios` / `undici.request` etc. to known model provider hosts)". Implementation: grep files under the source bundle for patterns matching raw HTTP egress to `api.anthropic.com`, `api.openai.com`, `api.google.com`, `generativelanguage.googleapis.com`, or their API routes. Whitelist: paths under `src/trajectory/wrappers/http.ts` (the measured wrapper) are exempt.

- [ ] **Step 1: Build fixture source bundles**

Under `client/test/conformance/fixtures/source-bundles/`:
- `good-llm/` — contains `src/trajectory/wrappers/http.ts` (the traced wrapper); elsewhere in source, a module like `src/lib/claude.ts` imports the wrapper and makes calls via it. No raw fetch to api.anthropic.com anywhere.
- `bad-raw-fetch/` — contains `src/lib/claude.ts` with `await fetch('https://api.anthropic.com/v1/messages', ...)`.
- `bad-axios/` — contains `import axios from 'axios'; axios.post('https://api.openai.com/v1/chat/completions', ...)`.

Each bundle is a dict of filepath → file content exported from a TypeScript helper so tests don't depend on the fs layout.

- [ ] **Step 2: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { checkTracedHttpBoundary } from '../../../src/conformance/checks/source-static.js';
import { GOOD_LLM_BUNDLE, BAD_RAW_FETCH_BUNDLE, BAD_AXIOS_BUNDLE } from '../fixtures/source-bundles/index.js';

describe('checkTracedHttpBoundary', () => {
  it('passes on a bundle where all LLM calls route through the wrapper', () => {
    const result = checkTracedHttpBoundary({ sourceBundle: GOOD_LLM_BUNDLE } as any);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('source.traced-http');
    expect(result.layer).toBe(2);
  });

  it('fails on raw fetch to api.anthropic.com', () => {
    const result = checkTracedHttpBoundary({ sourceBundle: BAD_RAW_FETCH_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/api\.anthropic\.com/);
  });

  it('fails on axios call to api.openai.com', () => {
    const result = checkTracedHttpBoundary({ sourceBundle: BAD_AXIOS_BUNDLE } as any);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/api\.openai\.com/);
  });

  it('skipped when no sourceBundle present (non-attested tier)', () => {
    const result = checkTracedHttpBoundary({} as any);
    expect(result.skipped).toBe(true);
  });
});
```

- [ ] **Step 3: Implement**

Create `client/src/conformance/checks/source-static.ts` (start of file — more checks added in Tasks 11–13):

```typescript
/**
 * Layer 2 — static analysis on the source bundle.
 *
 * Scope v0.9 §3.2 traced-I/O boundary + §4.10 checks a-f. Applies at
 * attested tier only. The ConformanceContext.sourceBundle is a
 * { files: Map<path, content>; manifest? } loaded by the harness from
 * executor.source.bundleCid.
 */

import type { CheckResult, ConformanceContext } from '../types.js';

const LLM_PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.cohere.com',
  'api.mistral.ai',
];

const WRAPPER_PATH_ALLOWLIST = [
  'src/trajectory/wrappers/http.ts',
  'src/trajectory/wrappers/llm.ts',
];

function isWhitelisted(path: string): boolean {
  return WRAPPER_PATH_ALLOWLIST.some((allow) => path.endsWith(allow));
}

function scan(files: Map<string, string>, patterns: RegExp[]): Array<{ path: string; line: number; text: string }> {
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const [path, content] of files) {
    if (isWhitelisted(path)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of patterns) {
        if (pat.test(line)) {
          hits.push({ path, line: i + 1, text: line.trim() });
          break;
        }
      }
    }
  }
  return hits;
}

export function checkTracedHttpBoundary(ctx: ConformanceContext): CheckResult {
  const id = 'source.traced-http';
  const layer = 2 as const;
  if (!ctx.sourceBundle) return { id, layer, passed: true, skipped: true };

  const hostPattern = new RegExp(
    LLM_PROVIDER_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|'),
  );
  // Match `fetch(..., host)`, `axios.<method>(..., host)`, `undici.request(..., host)`
  // Simplification: any literal string containing an LLM host in a non-wrapper file.
  const hits = scan(ctx.sourceBundle.files, [
    new RegExp(`['"\`]https?://[^'"\`]*(?:${LLM_PROVIDER_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})`),
  ]);
  if (hits.length === 0) return { id, layer, passed: true };
  return {
    id,
    layer,
    passed: false,
    detail: hits
      .slice(0, 3)
      .map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 80)}`)
      .join('; '),
  };
}
```

- [ ] **Step 4: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/source-static.test.ts
git add client/src/conformance/checks/source-static.ts \
        client/test/conformance/checks/source-static.test.ts \
        client/test/conformance/fixtures/source-bundles
git commit -m "feat(conformance): Layer 2 traced HTTP boundary check

Scope v0.9 §4.10(a). Greps source bundle for string literals containing
LLM provider host URLs (api.anthropic.com, api.openai.com, etc.) in any
file outside the measured-wrapper allowlist. A hit indicates raw egress
bypassing the traced HTTP client — fails attested conformance."
```

---

## Task 11: Layer 2 static checks (b, c) — MCP shim + subprocess spawns

**Files:**
- Modify: `client/src/conformance/checks/source-static.ts`
- Modify: `client/test/conformance/checks/source-static.test.ts`
- Modify: `client/test/conformance/fixtures/source-bundles/index.ts` — add more bundles

Scope §4.10(b): all MCP calls go through a measured MCP shim (detect direct `new MCPClient()` or `@modelcontextprotocol/sdk` client instantiation outside `src/trajectory/wrappers/mcp.ts`).

Scope §4.10(c): no subprocess spawns except via a traced wrapper. Detect `child_process.spawn`, `child_process.exec`, `child_process.execFile`, `child_process.fork`, `execa`, `node:child_process` imports, `Bun.spawn`, `Deno.Command` in files outside `src/trajectory/wrappers/subprocess.ts`.

- [ ] **Step 1: Add fixtures**

- `good-mcp/` — only `src/trajectory/wrappers/mcp.ts` constructs the MCP client; other files use the wrapper.
- `bad-raw-mcp/` — a non-wrapper file does `new Client(...)` from `@modelcontextprotocol/sdk`.
- `good-subprocess/` — only `src/trajectory/wrappers/subprocess.ts` imports `child_process`; other files use the wrapper.
- `bad-raw-spawn/` — a non-wrapper file does `spawn('ls', [])`.
- `bad-execa/` — a non-wrapper file does `import { execa } from 'execa'; await execa('ls')`.

- [ ] **Step 2: Write failing tests**

```typescript
import { checkMcpShim, checkSubprocessBoundary } from '../../../src/conformance/checks/source-static.js';

describe('checkMcpShim', () => {
  it('passes on bundle routing MCP calls through wrapper', () => {
    const r = checkMcpShim({ sourceBundle: GOOD_MCP_BUNDLE } as any);
    expect(r.passed).toBe(true);
    expect(r.id).toBe('source.mcp-shim');
  });
  it('fails on raw MCP client construction outside wrapper', () => {
    const r = checkMcpShim({ sourceBundle: BAD_RAW_MCP_BUNDLE } as any);
    expect(r.passed).toBe(false);
  });
});

describe('checkSubprocessBoundary', () => {
  it('passes when subprocess imports confined to wrapper', () => {
    const r = checkSubprocessBoundary({ sourceBundle: GOOD_SUBPROCESS_BUNDLE } as any);
    expect(r.passed).toBe(true);
    expect(r.id).toBe('source.subprocess');
  });
  it('fails on raw child_process.spawn outside wrapper', () => {
    const r = checkSubprocessBoundary({ sourceBundle: BAD_RAW_SPAWN_BUNDLE } as any);
    expect(r.passed).toBe(false);
  });
  it('fails on execa import outside wrapper', () => {
    const r = checkSubprocessBoundary({ sourceBundle: BAD_EXECA_BUNDLE } as any);
    expect(r.passed).toBe(false);
  });
});
```

- [ ] **Step 3: Implement**

Append to `source-static.ts`:

```typescript
const MCP_WRAPPER_ALLOWLIST = ['src/trajectory/wrappers/mcp.ts'];
const SUBPROCESS_WRAPPER_ALLOWLIST = ['src/trajectory/wrappers/subprocess.ts'];

export function checkMcpShim(ctx: ConformanceContext): CheckResult {
  const id = 'source.mcp-shim';
  const layer = 2 as const;
  if (!ctx.sourceBundle) return { id, layer, passed: true, skipped: true };
  const patterns = [
    /from\s+['"]@modelcontextprotocol\/sdk/,
    /new\s+(?:MCPClient|Client)\s*\(/,
  ];
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const [path, content] of ctx.sourceBundle.files) {
    if (MCP_WRAPPER_ALLOWLIST.some((a) => path.endsWith(a))) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pat of patterns) {
        if (pat.test(lines[i])) {
          hits.push({ path, line: i + 1, text: lines[i].trim() });
          break;
        }
      }
    }
  }
  if (hits.length === 0) return { id, layer, passed: true };
  return {
    id,
    layer,
    passed: false,
    detail: hits.slice(0, 3).map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 80)}`).join('; '),
  };
}

export function checkSubprocessBoundary(ctx: ConformanceContext): CheckResult {
  const id = 'source.subprocess';
  const layer = 2 as const;
  if (!ctx.sourceBundle) return { id, layer, passed: true, skipped: true };
  const patterns = [
    /from\s+['"](?:node:)?child_process['"]/,
    /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/,
    /from\s+['"]execa['"]/,
    /require\s*\(\s*['"]execa['"]\s*\)/,
    /\bBun\.spawn\s*\(/,
    /\bDeno\.Command\s*\(/,
    // covers destructured `spawn`/`exec` from already-imported child_process
    /\b(?:spawn|exec|execFile|fork)\s*\(['"]/,
  ];
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const [path, content] of ctx.sourceBundle.files) {
    if (SUBPROCESS_WRAPPER_ALLOWLIST.some((a) => path.endsWith(a))) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pat of patterns) {
        if (pat.test(lines[i])) {
          hits.push({ path, line: i + 1, text: lines[i].trim() });
          break;
        }
      }
    }
  }
  if (hits.length === 0) return { id, layer, passed: true };
  return {
    id,
    layer,
    passed: false,
    detail: hits.slice(0, 3).map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 80)}`).join('; '),
  };
}
```

- [ ] **Step 4: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/source-static.test.ts
git add client/src/conformance/checks/source-static.ts \
        client/test/conformance/checks/source-static.test.ts \
        client/test/conformance/fixtures/source-bundles
git commit -m "feat(conformance): MCP shim + subprocess boundary checks

Scope v0.9 §4.10(b,c). MCP shim check detects @modelcontextprotocol/sdk
imports and MCPClient/Client construction outside the measured MCP
wrapper. Subprocess check detects child_process / execa / Bun.spawn /
Deno.Command imports and calls outside the measured subprocess wrapper."
```

---

## Task 12: Layer 2 static checks (d, e) — raw sockets + dynamic code loading

**Files:**
- Modify: `client/src/conformance/checks/source-static.ts`
- Modify: `client/test/conformance/checks/source-static.test.ts`
- Modify: `client/test/conformance/fixtures/source-bundles/index.ts`

Scope §4.10(d): no raw sockets (`net.createConnection`, `tls.connect`) outside measured TLS wrappers.

Scope §4.10(e): no dynamic code loading (`eval`, `new Function(...)`, `import(...)` of non-relative paths that's not statically analyzable, `vm.runIn*`).

Note on dynamic import: `import('./foo.js')` (relative string literal) is legal and statically analyzable; `import(dynamicExpr)` where the argument isn't a relative string literal is not. We approximate: pass if every `import(...)` call's argument is a string literal starting with `./` or `../` or `node:`; fail otherwise.

- [ ] **Step 1: Add fixtures**

- `bad-raw-socket/` — `import { createConnection } from 'net'; createConnection(...)` outside wrapper.
- `bad-tls-connect/` — `import { connect } from 'tls'; connect(...)` outside wrapper.
- `bad-eval/` — `eval(userInput)`.
- `bad-new-function/` — `new Function('return 1')`.
- `bad-dynamic-import/` — `await import(userPath)`.
- `bad-vm/` — `import vm from 'vm'; vm.runInNewContext(...)`.
- `good-dynamic/` — only statically analyzable relative-path dynamic imports like `await import('./plugin.js')`.

- [ ] **Step 2: Failing tests** (parallel structure).

- [ ] **Step 3: Implement**

Append to `source-static.ts`:

```typescript
const SOCKET_WRAPPER_ALLOWLIST = ['src/trajectory/wrappers/socket.ts', 'src/trajectory/wrappers/http.ts'];

export function checkRawSockets(ctx: ConformanceContext): CheckResult {
  const id = 'source.raw-sockets';
  const layer = 2 as const;
  if (!ctx.sourceBundle) return { id, layer, passed: true, skipped: true };
  const patterns = [
    /\bnet\.createConnection\s*\(/,
    /\btls\.connect\s*\(/,
    /from\s+['"](?:node:)?net['"]/,
    /from\s+['"](?:node:)?tls['"]/,
  ];
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const [path, content] of ctx.sourceBundle.files) {
    if (SOCKET_WRAPPER_ALLOWLIST.some((a) => path.endsWith(a))) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pat of patterns) {
        if (pat.test(lines[i])) {
          hits.push({ path, line: i + 1, text: lines[i].trim() });
          break;
        }
      }
    }
  }
  if (hits.length === 0) return { id, layer, passed: true };
  return {
    id,
    layer,
    passed: false,
    detail: hits.slice(0, 3).map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 80)}`).join('; '),
  };
}

export function checkDynamicCodeLoading(ctx: ConformanceContext): CheckResult {
  const id = 'source.dynamic-code';
  const layer = 2 as const;
  if (!ctx.sourceBundle) return { id, layer, passed: true, skipped: true };
  const hits: Array<{ path: string; line: number; text: string; reason: string }> = [];
  for (const [path, content] of ctx.sourceBundle.files) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // eval(...)
      if (/\beval\s*\(/.test(line)) {
        hits.push({ path, line: i + 1, text: line.trim(), reason: 'eval' });
        continue;
      }
      // new Function(...)
      if (/\bnew\s+Function\s*\(/.test(line)) {
        hits.push({ path, line: i + 1, text: line.trim(), reason: 'new Function' });
        continue;
      }
      // vm.runIn*
      if (/\bvm\.runIn[A-Za-z]+\s*\(/.test(line)) {
        hits.push({ path, line: i + 1, text: line.trim(), reason: 'vm.runIn*' });
        continue;
      }
      // dynamic import() with non-literal argument
      const importMatch = line.match(/\bimport\s*\(\s*([^)]+)\)/);
      if (importMatch) {
        const arg = importMatch[1].trim();
        // literal relative / node: imports are allowed
        const isLiteralAllowed =
          /^['"](?:\.\.?\/[^'"]+|node:[^'"]+)['"]$/.test(arg);
        if (!isLiteralAllowed) {
          hits.push({ path, line: i + 1, text: line.trim(), reason: 'dynamic import with non-literal or non-relative arg' });
        }
      }
    }
  }
  if (hits.length === 0) return { id, layer, passed: true };
  return {
    id,
    layer,
    passed: false,
    detail: hits.slice(0, 3).map((h) => `${h.path}:${h.line} [${h.reason}]: ${h.text.slice(0, 80)}`).join('; '),
  };
}
```

- [ ] **Step 4: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/source-static.test.ts
git add client/src/conformance/checks/source-static.ts \
        client/test/conformance/checks/source-static.test.ts \
        client/test/conformance/fixtures/source-bundles
git commit -m "feat(conformance): raw sockets + dynamic code loading checks

Scope v0.9 §4.10(d,e). Raw sockets: flags net.createConnection,
tls.connect, and their imports outside TLS/HTTP wrappers. Dynamic
code: flags eval, new Function, vm.runIn*, and import() with
non-literal or non-relative/node: arguments. Literal relative imports
(import('./plugin.js')) pass — they're statically analyzable."
```

---

## Task 13: Layer 2 static check (f) — artifact emission helper

**Files:**
- Modify: `client/src/conformance/checks/source-static.ts`
- Modify: `client/test/conformance/checks/source-static.test.ts`
- Modify: `client/test/conformance/fixtures/source-bundles/index.ts`

Scope §4.10(f): all file I/O producing artifacts emits `jinn.artifact.emit` spans. Implementation choice: require that artifact emission goes through a single helper `emitArtifact(...)` exported from a well-known path (e.g. `src/trajectory/artifacts.ts`); flag direct uses of `fs.writeFile` / `fs.writeFileSync` in files that also reference artifact CIDs or upload-to-IPFS.

Narrow approximation for V1 (avoid false positives on arbitrary fs writes): flag files that import `fs` / `node:fs` / `node:fs/promises` AND also contain the string `ipfs` or `uploadToIpfs` or `.cid`, unless the file is the artifact-emit helper itself.

- [ ] **Step 1: Add fixtures**

- `good-artifacts/` — all artifact emission through `src/trajectory/artifacts.ts` which wraps the fs write + span emit.
- `bad-raw-writeFile/` — a non-helper file does `await fs.writeFile(path, bytes)` then `const cid = await uploadToIpfs(...)`.

- [ ] **Step 2: Failing tests** (same pattern).

- [ ] **Step 3: Implement**

```typescript
const ARTIFACT_HELPER_ALLOWLIST = [
  'src/trajectory/artifacts.ts',
  'src/restorer/engine/packaging.ts', // existing packaging helper
];

export function checkArtifactEmitHelper(ctx: ConformanceContext): CheckResult {
  const id = 'source.artifact-emit';
  const layer = 2 as const;
  if (!ctx.sourceBundle) return { id, layer, passed: true, skipped: true };
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const [path, content] of ctx.sourceBundle.files) {
    if (ARTIFACT_HELPER_ALLOWLIST.some((a) => path.endsWith(a))) continue;
    // Does this file import fs?
    const importsFs = /from\s+['"](?:node:)?fs(?:\/promises)?['"]/.test(content);
    if (!importsFs) continue;
    // Does this file also look like it's uploading / producing artifacts?
    const looksArtifacty = /\bipfs\b|uploadToIpfs|\.cid\b|emitArtifact/.test(content);
    if (!looksArtifacty) continue;
    // Find the actual write line
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/\bfs\.(?:writeFile|writeFileSync|createWriteStream)\s*\(/.test(lines[i]) ||
          /\bwriteFile\s*\(/.test(lines[i])) {
        hits.push({ path, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  if (hits.length === 0) return { id, layer, passed: true };
  return {
    id,
    layer,
    passed: false,
    detail: hits.slice(0, 3).map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 80)}`).join('; '),
  };
}
```

- [ ] **Step 4: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/source-static.test.ts
git add client/src/conformance/checks/source-static.ts \
        client/test/conformance/checks/source-static.test.ts \
        client/test/conformance/fixtures/source-bundles
git commit -m "feat(conformance): artifact emit helper check

Scope v0.9 §4.10(f). Flags files that import fs AND reference IPFS/CID
semantics AND call fs.writeFile directly, unless the file is the
canonical artifact-emit helper. The heuristic narrows false positives
by requiring both fs-import + artifact-production context before
flagging a raw write."
```

---

## Task 14: Layer 2 runtime stubs

**Files:**
- Create: `client/src/conformance/checks/source-runtime.ts`
- Create: `client/test/conformance/checks/source-runtime.test.ts`

V1 doesn't implement runtime enforcement — but the harness still reports the stub placeholders so operators see the full attested-tier picture and the V2 plan knows exactly where to plug in. All three return `{ passed: true, skipped: true, detail: 'runtime check pending V2 TEE integration' }`.

- [ ] **Step 1: Write the stubs + tests in one go**

```typescript
// checks/source-runtime.ts
import type { CheckResult, ConformanceContext } from '../types.js';

export function checkSeccompPolicy(ctx: ConformanceContext): CheckResult {
  return {
    id: 'runtime.seccomp-policy',
    layer: 2,
    passed: true,
    skipped: true,
    detail: 'runtime check pending V2 TEE integration',
  };
}
export function checkNamespacePolicy(ctx: ConformanceContext): CheckResult {
  return {
    id: 'runtime.namespace-policy',
    layer: 2,
    passed: true,
    skipped: true,
    detail: 'runtime check pending V2 TEE integration',
  };
}
export function checkTlsTranscriptCapture(ctx: ConformanceContext): CheckResult {
  return {
    id: 'runtime.tls-transcript',
    layer: 2,
    passed: true,
    skipped: true,
    detail: 'runtime check pending V2 TEE integration',
  };
}
```

Parallel tests assert each returns `skipped: true`.

- [ ] **Step 2: Run + commit**

```bash
cd client
yarn vitest run test/conformance/checks/source-runtime.test.ts
git add client/src/conformance/checks/source-runtime.ts \
        client/test/conformance/checks/source-runtime.test.ts
git commit -m "feat(conformance): Layer 2 runtime check stubs

Seccomp, namespace, and TLS transcript capture checks return
{ skipped: true, detail: 'pending V2' }. Placed in harness ordering
now so V2's TEE integration plan can drop in real impls without
touching the harness structure."
```

---

## Task 15: The harness — orchestration + fetches

**Files:**
- Create: `client/src/conformance/harness.ts`
- Create: `client/test/conformance/harness.test.ts`
- Possibly modify: `client/src/adapters/mech/ipfs.ts` to add `fetchSignedEnvelopeFromIpfs`, `fetchTrajectoryFromIpfs`, `fetchSourceBundleFromIpfs` if Plans C/D didn't already.

The harness:
1. Builds `ConformanceContext` from `envelopeCid` + options.
2. Fetches envelope bytes (unless `options.envelopeBytes` provided); parses with `SignedEnvelopeSchema`.
3. Fetches intent by `envelope.intent.cid`; parses with `SignedIntentV1Schema`.
4. Fetches trajectory if `envelope.trajectory?.cid` is present; parses with `JinnTrajectoryV1Schema`.
5. If `envelope.role === 'verdict'`, fetches the restoration envelope bytes (for the back-ref check).
6. If `envelope.evidenceTier === 'attested'` and `envelope.executor.source?.bundleCid` set and `!options.skipLayer2`, fetches + unpacks source bundle into `ctx.sourceBundle`.
7. Runs each check in order; each returns a `CheckResult`; accumulate.
8. Build `ConformanceReport` using `summarize` + `overallFromChecks`; set `layer1Passed` / `layer2Passed`.

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { runConformance } from '../../src/conformance/harness.js';
import { buildGoodRestorationFixture, buildGoodVerdictFixture } from './fixtures/good-envelope.js';
import { buildGoodTrajectoryFixture } from './fixtures/good-trajectory.js';

describe('runConformance — integration', () => {
  it('returns PASS + layer1Passed + layer2=N/A for a good self-signed envelope', async () => {
    const fx = await buildGoodRestorationFixture();
    const traj = buildGoodTrajectoryFixture(fx.envelope.intent.cid);
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        // stub fetches via options
        envelopeBytes: new TextEncoder().encode(JSON.stringify(fx.envelope)),
        // Harness needs an override to inject intent + trajectory without hitting IPFS —
        // see ConformanceOptions extensions below.
        intent: fx.intent,
        trajectory: traj,
      } as any,
    });
    expect(report.overall).toBe('PASS');
    expect(report.layer1Passed).toBe(true);
    expect(report.layer2Passed).toBe('N/A');
    expect(report.summary.failed).toBe(0);
  });

  it('returns FAIL with exactly envelope.schema failing on bogus schemaVersion', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, schemaVersion: 'jinn.execution.v9' };
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: { envelopeBytes: new TextEncoder().encode(JSON.stringify(bad)) } as any,
    });
    expect(report.overall).toBe('FAIL');
    const schemaCheck = report.checks.find((c) => c.id === 'envelope.schema');
    expect(schemaCheck?.passed).toBe(false);
  });

  it('returns FAIL with envelope.hash failing when non-signature field is tampered', async () => {
    const fx = await buildGoodRestorationFixture();
    const bad = { ...fx.envelope, generatedAt: fx.envelope.generatedAt + 1 };
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: { envelopeBytes: new TextEncoder().encode(JSON.stringify(bad)), intent: fx.intent } as any,
    });
    const hashCheck = report.checks.find((c) => c.id === 'envelope.hash');
    expect(hashCheck?.passed).toBe(false);
  });

  it('runs Layer 2 checks when tier=attested and source is provided', async () => {
    const fx = await buildGoodRestorationFixture({
      evidenceTier: 'attested',
      // plus whatever the fixture needs for an attested envelope
    });
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(fx.envelope)),
        intent: fx.intent,
        sourceBundle: { files: new Map([['src/index.ts', 'console.log("hi")']]) },
      } as any,
    });
    // Layer 2 checks should appear in the report (even if all pass)
    expect(report.checks.some((c) => c.layer === 2 && !c.skipped)).toBe(true);
    expect(report.layer2Passed).not.toBe('N/A');
  });

  it('verdict envelope runs verdict-specific checks', async () => {
    const vfx = await buildGoodVerdictFixture();
    const report = await runConformance({
      envelopeCid: vfx.envelopeCid,
      options: {
        envelopeBytes: new TextEncoder().encode(JSON.stringify(vfx.envelope)),
        intent: vfx.intent,
        restorationEnvelopeBytes: vfx.restorationEnvelopeBytes,
      } as any,
    });
    expect(report.checks.some((c) => c.id === 'verdict.back-ref')).toBe(true);
    expect(report.checks.some((c) => c.id === 'verdict.verification-record')).toBe(true);
    expect(report.overall).toBe('PASS');
  });
});
```

- [ ] **Step 2: Extend ConformanceOptions with injection fields**

For testability, extend `ConformanceOptions` to allow pre-populated objects:

```typescript
export interface ConformanceOptions {
  skipLayer2?: boolean;
  ipfsGatewayUrl?: string;
  ipfsRegistryUrl?: string;
  envelopeBytes?: Uint8Array;
  /** Test-only overrides — skip corresponding IPFS fetches. */
  intent?: import('../types/intent.js').SignedIntentV1;
  trajectory?: unknown;
  restorationEnvelopeBytes?: Uint8Array;
  sourceBundle?: { files: Map<string, string>; manifest?: Record<string, unknown> };
}
```

- [ ] **Step 3: Implement the harness**

```typescript
/**
 * Conformance harness — orchestrates Layer 1 + Layer 2 checks.
 *
 * Scope v0.9 §4.10. Fetches envelope + intent + trajectory + (at attested
 * tier) source bundle from IPFS, then runs every check and assembles a
 * ConformanceReport.
 */

import { SignedEnvelopeSchema } from '../types/envelope.js';
import { parseSignedIntentV1 } from '../types/intent.js';
import {
  fetchSignedEnvelopeFromIpfs,
  fetchSignedIntentFromIpfs,
  fetchTrajectoryFromIpfs,
  fetchSourceBundleFromIpfs,
} from '../adapters/mech/ipfs.js';
import {
  checkEnvelopeSchema,
  checkPayloadValidity,
  checkCanonicalHash,
  checkSignatureValidity,
  checkIntentReference,
} from './checks/envelope.js';
import {
  checkTrajectorySchema,
  checkHashChainIntegrity,
  checkSpanProfileConformance,
} from './checks/trajectory.js';
import {
  checkArtifactTypeVocabulary,
  checkTrajectoryArtifactLinkage,
} from './checks/artifacts.js';
import { checkVerdictBackReference, checkVerificationRecordPresent } from './checks/verdict.js';
import { checkSecretScrub } from './checks/secret-scrub.js';
import {
  checkTracedHttpBoundary,
  checkMcpShim,
  checkSubprocessBoundary,
  checkRawSockets,
  checkDynamicCodeLoading,
  checkArtifactEmitHelper,
} from './checks/source-static.js';
import {
  checkSeccompPolicy,
  checkNamespacePolicy,
  checkTlsTranscriptCapture,
} from './checks/source-runtime.js';
import {
  summarize,
  overallFromChecks,
  type CheckResult,
  type ConformanceContext,
  type ConformanceOptions,
  type ConformanceReport,
} from './types.js';

const LAYER1_CHECKS = [
  checkEnvelopeSchema,
  checkPayloadValidity,
  checkCanonicalHash,
  // signature is async
  checkIntentReference,
  checkTrajectorySchema,
  checkHashChainIntegrity,
  checkSpanProfileConformance,
  checkArtifactTypeVocabulary,
  checkTrajectoryArtifactLinkage,
  checkVerdictBackReference,
  checkVerificationRecordPresent,
  checkSecretScrub,
];

const LAYER2_STATIC_CHECKS = [
  checkTracedHttpBoundary,
  checkMcpShim,
  checkSubprocessBoundary,
  checkRawSockets,
  checkDynamicCodeLoading,
  checkArtifactEmitHelper,
];

const LAYER2_RUNTIME_CHECKS = [
  checkSeccompPolicy,
  checkNamespacePolicy,
  checkTlsTranscriptCapture,
];

export interface RunConformanceArgs {
  envelopeCid: string;
  options?: ConformanceOptions;
}

export async function runConformance(args: RunConformanceArgs): Promise<ConformanceReport> {
  const options: ConformanceOptions = args.options ?? {};
  const ctx: ConformanceContext = { envelopeCid: args.envelopeCid, options };

  // 1. Envelope
  try {
    const bytes =
      options.envelopeBytes ?? (await fetchEnvelopeBytes(args.envelopeCid, options));
    ctx.envelopeBytes = bytes;
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    const parseResult = SignedEnvelopeSchema.safeParse(parsed);
    if (parseResult.success) {
      ctx.envelope = parseResult.data;
    } else {
      // Leave ctx.envelope undefined; checkEnvelopeSchema will capture.
      ctx.envelope = parsed; // let schema check produce the detailed failure
    }
  } catch (err) {
    // Resolution / parse failure — record and short-circuit.
    return buildReport(args.envelopeCid, 'self-signed', [
      {
        id: 'envelope.fetch',
        layer: 1,
        passed: false,
        detail: `envelope could not be fetched / parsed: ${(err as Error).message}`,
      },
    ]);
  }

  // 2. Intent
  if (options.intent) {
    ctx.intent = options.intent;
  } else if (ctx.envelope?.intent.cid) {
    try {
      ctx.intent = await fetchSignedIntentFromIpfs(
        options.ipfsGatewayUrl ?? '',
        ctx.envelope.intent.cid,
      );
    } catch {
      /* leave undefined; checkIntentReference captures */
    }
  }

  // 3. Trajectory
  if (options.trajectory !== undefined) {
    ctx.trajectory = options.trajectory;
  } else if (ctx.envelope?.trajectory?.cid) {
    try {
      ctx.trajectory = await fetchTrajectoryFromIpfs(
        options.ipfsGatewayUrl ?? '',
        ctx.envelope.trajectory.cid,
      );
    } catch {
      /* leave undefined */
    }
  }

  // 4. Verdict: restoration back-ref
  if (ctx.envelope?.role === 'verdict') {
    const ref = (ctx.envelope.payload as any)?.restorationEnvelope;
    if (options.restorationEnvelopeBytes) {
      ctx.restorationEnvelopeBytes = options.restorationEnvelopeBytes;
    } else if (ref?.cid) {
      try {
        ctx.restorationEnvelopeBytes = await fetchEnvelopeBytes(ref.cid, options);
      } catch {
        /* leave undefined */
      }
    }
  }

  // 5. Source bundle (attested only)
  const isAttested = ctx.envelope?.evidenceTier === 'attested';
  if (isAttested && !options.skipLayer2) {
    if (options.sourceBundle) {
      ctx.sourceBundle = options.sourceBundle;
    } else if (ctx.envelope?.executor.source?.bundleCid) {
      try {
        ctx.sourceBundle = await fetchSourceBundleFromIpfs(
          options.ipfsGatewayUrl ?? '',
          ctx.envelope.executor.source.bundleCid,
        );
      } catch {
        /* leave undefined — static checks will skip */
      }
    }
  }

  // 6. Run checks
  const checks: CheckResult[] = [];
  for (const fn of LAYER1_CHECKS) {
    checks.push(fn(ctx));
  }
  // signature check is async — run separately
  checks.push(await checkSignatureValidity(ctx));

  if (isAttested && !options.skipLayer2) {
    for (const fn of LAYER2_STATIC_CHECKS) checks.push(fn(ctx));
    for (const fn of LAYER2_RUNTIME_CHECKS) checks.push(fn(ctx));
  }

  return buildReport(args.envelopeCid, ctx.envelope?.evidenceTier ?? 'self-signed', checks);
}

async function fetchEnvelopeBytes(cid: string, options: ConformanceOptions): Promise<Uint8Array> {
  const env = await fetchSignedEnvelopeFromIpfs(options.ipfsGatewayUrl ?? '', cid);
  return new TextEncoder().encode(JSON.stringify(env));
}

function buildReport(
  envelopeCid: string,
  envelopeTier: ConformanceReport['envelopeTier'],
  checks: CheckResult[],
): ConformanceReport {
  const summary = summarize(checks);
  const overall = overallFromChecks(checks);
  const layer1 = checks.filter((c) => c.layer === 1);
  const layer2 = checks.filter((c) => c.layer === 2);
  const layer1Passed = layer1.every((c) => c.skipped || c.passed);
  const layer2Passed: boolean | 'N/A' =
    envelopeTier !== 'attested' ? 'N/A' : layer2.every((c) => c.skipped || c.passed);
  return { envelopeCid, envelopeTier, checks, summary, overall, layer1Passed, layer2Passed };
}
```

- [ ] **Step 4: Add the IPFS adapter helpers if missing**

Check Plans C/D — if `fetchSignedEnvelopeFromIpfs`, `fetchTrajectoryFromIpfs`, and `fetchSourceBundleFromIpfs` aren't present on `adapters/mech/ipfs.ts`, add stubs now. The source bundle fetch unpacks a tarball IPFS CID into a `{ files: Map<path, content>; manifest? }` structure. V1 acceptable impl: fetch a JSON manifest listing files by relative path, then fetch each file by CID (operator includes a `files.json` map at the bundle root). V2's reproducible-build plan revisits this.

- [ ] **Step 5: Run integration tests**

```bash
cd client
yarn vitest run test/conformance/
```

Expected: all green. If an override option doesn't take effect, the harness didn't honor the passed-in `intent` / `trajectory` / etc. — fix before proceeding.

- [ ] **Step 6: Commit**

```bash
git add client/src/conformance/harness.ts \
        client/src/conformance/types.ts \
        client/src/adapters/mech/ipfs.ts \
        client/test/conformance/harness.test.ts
git commit -m "feat(conformance): harness orchestrates Layer 1 + Layer 2 checks

runConformance({ envelopeCid, options }) fetches envelope + intent +
trajectory + (at attested tier) source bundle from IPFS, runs all
checks in a stable order, and assembles a ConformanceReport. Overall
= FAIL if any non-skipped check fails. layer2Passed = 'N/A' when tier
is not attested. Injection overrides on ConformanceOptions skip the
corresponding IPFS fetches for test isolation."
```

---

## Task 16: CLI verb

**Files:**
- Create: `client/src/cli/commands/conformance.ts`
- Modify: `client/src/cli/commands/index.ts` — register the command

- [ ] **Step 1: Read existing command patterns**

Open `client/src/cli/commands/submit-intent.ts` and `client/src/cli/commands/doctor.ts` to mirror the existing command style (action signature, output formatting, exit codes).

- [ ] **Step 2: Implement the command**

```typescript
/**
 * `jinn conformance --envelope-cid <cid>` verb.
 *
 * Runs the conformance harness and prints the ConformanceReport. Exits 0
 * on PASS, 1 on FAIL, 2 on unexpected error.
 */

import type { CliCommand } from '../command.js';
import { runConformance } from '../../conformance/harness.js';

export const conformanceCommand: CliCommand = {
  name: 'conformance',
  summary: 'Run the envelope + trajectory conformance suite against a signed envelope CID.',
  args: [
    {
      name: 'envelope-cid',
      description: 'IPFS CID of the SignedEnvelope to check.',
      required: true,
    },
    {
      name: 'skip-layer2',
      description: 'Skip Layer 2 (source-static) checks even at attested tier.',
      type: 'boolean',
      required: false,
    },
    {
      name: 'json',
      description: 'Print the full ConformanceReport as JSON instead of a human summary.',
      type: 'boolean',
      required: false,
    },
  ],
  async run({ args, config, output }) {
    const envelopeCid = args['envelope-cid'] as string;
    const report = await runConformance({
      envelopeCid,
      options: {
        ipfsGatewayUrl: config.ipfsGatewayUrl,
        ipfsRegistryUrl: config.ipfsRegistryUrl,
        skipLayer2: args['skip-layer2'] === true,
      },
    });

    if (args.json === true) {
      output.writeLine(JSON.stringify(report, null, 2));
    } else {
      output.writeLine(`Conformance report for ${report.envelopeCid}`);
      output.writeLine(`  Tier: ${report.envelopeTier}`);
      output.writeLine(
        `  Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`,
      );
      output.writeLine(`  Layer 1: ${report.layer1Passed ? 'PASS' : 'FAIL'}`);
      output.writeLine(
        `  Layer 2: ${report.layer2Passed === 'N/A' ? 'N/A (not attested)' : report.layer2Passed ? 'PASS' : 'FAIL'}`,
      );
      output.writeLine(`  Overall: ${report.overall}`);
      output.writeLine('');
      for (const c of report.checks) {
        const icon = c.skipped ? '—' : c.passed ? '✓' : '✗';
        output.writeLine(`  ${icon} [L${c.layer}] ${c.id}${c.detail ? `: ${c.detail}` : ''}`);
      }
    }

    return { exitCode: report.overall === 'PASS' ? 0 : 1 };
  },
};
```

Adjust the exact signature to match whatever `CliCommand` interface is used in the existing command file — e.g. the `run` function's signature, how args are parsed, how output is printed, what `CliCommand` fields exist.

- [ ] **Step 3: Register the command**

In `client/src/cli/commands/index.ts`, import `conformanceCommand` and add it to the command array.

- [ ] **Step 4: Smoke test**

```bash
cd client
yarn build
node dist/bin/jinn.js conformance --help
```

Expected: the command prints its help text.

```bash
node dist/bin/jinn.js conformance --envelope-cid bafy-fake
```

Expected: the command attempts to fetch from IPFS (will fail with a meaningful fetch error since the CID is fake, but the CLI plumbing works end-to-end and exits nonzero).

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/conformance.ts client/src/cli/commands/index.ts
git commit -m "feat(cli): jinn conformance verb

Runs runConformance against an envelope CID and prints a
human-readable summary or full JSON report. Exits 0 on PASS, 1 on
FAIL. Accepts --skip-layer2 for operators who want a Layer 1 smoke
check without the attested-tier source bundle analysis, and --json
for automation."
```

---

## Task 17: Operator runbook

**Files:**
- Create: `docs/runbooks/conformance.md`

Contents outline:
- What conformance proves (schema + span profile + traced-I/O boundary).
- How to run it: `yarn jinn conformance --envelope-cid <cid>`.
- What each check ID means (short sentence per).
- How to interpret Layer 2 = `N/A` (your envelope isn't claiming attested tier).
- How to fix common failures (e.g. `source.traced-http` → route all LLM calls through `src/trajectory/wrappers/http.ts`).
- Expected V2 additions (the runtime-layer stubs).
- Link back to scope §4.10.

- [ ] **Step 1: Write the runbook**

Keep it to ~200 lines. Sections:
- **When to run conformance**
- **Layer 1 checks (structural)** — one line per check
- **Layer 2 checks (traced-I/O boundary, attested tier only)** — one line per check
- **Common failures + fixes**
- **What V2 adds**

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/conformance.md
git commit -m "docs: operator runbook for running conformance

Explains the two layers, per-check purpose, how to invoke, how to
read results, and common failures + fixes. Sends operators to scope
v0.9 §4.10 for the full normative definition."
```

---

## Task 18: Integration — golden good + manipulated bad

**Files:**
- Modify: `client/test/conformance/harness.test.ts` — expand the integration suite.

Build a matrix of manipulated-bad envelopes, one per Layer 1 check, to confirm each check triggers exactly when expected and not when unexpected.

- [ ] **Step 1: Add failing tests**

```typescript
describe('runConformance — known-bad matrix', () => {
  const scenarios: Array<{
    name: string;
    mutate: (fx: any) => unknown;
    expectFailing: string[];
  }> = [
    {
      name: 'wrong schemaVersion → envelope.schema fails',
      mutate: (fx) => ({ ...fx.envelope, schemaVersion: 'jinn.execution.v99' }),
      expectFailing: ['envelope.schema'],
    },
    {
      name: 'bogus payload → envelope.payload fails',
      mutate: (fx) => ({ ...fx.envelope, payload: { garbage: 1 } }),
      expectFailing: ['envelope.payload'],
    },
    {
      name: 'generatedAt tampered → envelope.hash fails',
      mutate: (fx) => ({ ...fx.envelope, generatedAt: fx.envelope.generatedAt + 1 }),
      expectFailing: ['envelope.hash'],
    },
    {
      name: 'signer replaced → envelope.signature fails',
      mutate: (fx) => ({
        ...fx.envelope,
        signature: { ...fx.envelope.signature, signer: '0xdead' + '0'.repeat(36) },
      }),
      expectFailing: ['envelope.signature'],
    },
    {
      name: 'intent kind mismatch → envelope.intent-ref fails',
      mutate: (fx) => fx.envelope, // rely on overriding intent separately in the test body
      expectFailing: ['envelope.intent-ref'],
    },
    // ... etc for each check id.
  ];

  for (const s of scenarios) {
    it(s.name, async () => {
      const fx = await buildGoodRestorationFixture();
      const tampered = s.mutate(fx);
      const report = await runConformance({
        envelopeCid: fx.envelopeCid,
        options: {
          envelopeBytes: new TextEncoder().encode(JSON.stringify(tampered)),
          intent: fx.intent,
          trajectory: buildGoodTrajectoryFixture(fx.envelope.intent.cid),
        } as any,
      });
      const failingIds = report.checks.filter((c) => !c.skipped && !c.passed).map((c) => c.id);
      for (const expected of s.expectFailing) {
        expect(failingIds).toContain(expected);
      }
    });
  }
});
```

- [ ] **Step 2: Run**

```bash
cd client
yarn vitest run test/conformance/harness.test.ts
```

Expected: each scenario identifies its expected-failing check. If cross-contamination is observed (a mutation triggers unexpected failures), investigate whether the check is over-strict or the mutation corrupts more than intended — tighten mutation scope if so.

- [ ] **Step 3: Commit**

```bash
git add client/test/conformance/harness.test.ts
git commit -m "test(conformance): known-bad matrix for Layer 1 checks

One mutation per Layer 1 check, asserting the check fails and
others still pass. Catches regressions where a single bad change
accidentally satisfies what should be a strict check."
```

---

## Task 19: Wire `conformance` into `yarn e2e`

**Files:**
- Modify: `client/scripts/e2e-validate.ts` — after a successful restoration round-trip, invoke the conformance harness against the produced envelope CID; fail the e2e if it doesn't PASS.

- [ ] **Step 1: Read `scripts/e2e-validate.ts`**

Find the point after `adapter.deliverToMarketplace` where the delivered envelope CID is known.

- [ ] **Step 2: Add a post-delivery conformance step**

```typescript
import { runConformance } from '../src/conformance/harness.js';

// ... after successful delivery ...
console.log('Running conformance against delivered envelope...');
const report = await runConformance({
  envelopeCid: deliveredCid,
  options: { ipfsGatewayUrl, skipLayer2: true }, // e2e doesn't produce a source bundle
});
if (report.overall !== 'PASS') {
  console.error('Conformance FAILED:');
  for (const c of report.checks.filter((x) => !x.skipped && !x.passed)) {
    console.error(`  ✗ [L${c.layer}] ${c.id}: ${c.detail}`);
  }
  process.exit(1);
}
console.log('Conformance PASSED.');
```

- [ ] **Step 3: Run e2e**

```bash
cd client
yarn e2e
```

Expected: the e2e script still passes, now with the post-delivery conformance check included.

- [ ] **Step 4: Commit**

```bash
git add client/scripts/e2e-validate.ts
git commit -m "test(e2e): run conformance against delivered envelope

Adds a post-delivery conformance check. Passes --skip-layer2 because
the e2e does not produce an attested-tier source bundle. Catches any
future regression where an impl produces a structurally invalid
envelope that nonetheless round-trips through the loop."
```

---

## Task 20: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Full test suite**

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

- [ ] **Step 3: E2E (post-conformance-wire)**

```bash
cd client
yarn e2e
```

Expected: PASS including post-delivery conformance step.

- [ ] **Step 4: Manual CLI smoke**

```bash
cd client
node dist/bin/jinn.js conformance --help
# exit 0, help text printed
```

- [ ] **Step 5: grep verification — no residual stubs**

```bash
cd client
grep -rn "TODO\|FIXME\|XXX" src/conformance
```

Expected output: only the pre-declared V2 stubs in `source-runtime.ts` with the `pending V2 TEE integration` marker. Nothing else should be a leftover placeholder.

---

## Self-review before marking this plan done

- [ ] **Types exist:** `client/src/conformance/types.ts` exports `ConformanceReport`, `CheckResult`, `ConformanceOptions`, `ConformanceContext`, `summarize`, `overallFromChecks`.
- [ ] **Every Layer 1 check has a dedicated test:** envelope schema, payload, canonical hash, signature, intent reference, trajectory schema, hash chain, span profile, artifact vocabulary, trajectory↔artifact linkage, verdict back-ref, verification record, secret-scrub.
- [ ] **Every Layer 2 static check exists:** traced HTTP, MCP shim, subprocess, raw sockets, dynamic code, artifact emit helper.
- [ ] **Layer 2 runtime stubs exist** and return `skipped: true` with the V2 marker.
- [ ] **Harness orchestrates** fetching + ordering + reporting; injection overrides work for testability.
- [ ] **CLI verb `jinn conformance`** registers + runs + exits with meaningful code.
- [ ] **Integration test matrix** — each Layer 1 mutation triggers its specific check failure.
- [ ] **Runbook** exists at `docs/runbooks/conformance.md`.
- [ ] **e2e runs conformance** against delivered envelopes.
- [ ] **Full suite green:** `yarn test` reports 0 failures; `yarn typecheck` + `yarn build` + `yarn e2e` all pass.
- [ ] **No loose TODOs** outside the declared V2 runtime stubs.

---

## Follow-ups (out of scope for this plan)

- **V2 TEE plan:** plug real implementations into the three runtime stubs (`source-runtime.ts`) — seccomp policy check, namespace policy check, TLS transcript capture. These consume the enclave's captured runtime evidence (captured by the Phala Dstack integration) and assert the attested binary honored its sandbox contract.
- **Plan E (ERC-8004):** after Plan F lands, challengers can optionally use the harness output as a `validationResponse` payload when filing challenges via the Validation Registry. The conformance `CheckResult` list is a natural fit for the `checks[]` field on a challenger verification record.
- **V2 reproducible-build check:** in V2 an additional Layer 2 check verifies `rebuild(executor.source.bundleCid) === executor.source.measurement`. Add `checkReproducibleBuild` to the Layer 2 array and plumb a `buildFn` into `ConformanceOptions`.
- **V2 attestation quote verification:** an additional Layer 2 check verifies the attestation quote's signature + measurement + reportData binding via the published verification SDK. Same pattern: add to Layer 2 array; plumb SDK into options.
- **Subgraph (Plan G) consumption:** a later enhancement can expose `overall` / `layer1Passed` / `layer2Passed` as derived fields on the `ExecutionEnvelope` subgraph entity. Indexer runs conformance off-chain during indexing and surfaces the verdict to downstream buyers.
- **Static analysis upgrade to AST-based:** the regex-grep approach is adequate for V1 but will generate false positives for tricky cases (string-embedded URLs in comments, etc.). Upgrade to `@typescript-eslint/parser`-based detectors when false-positive volume justifies the dependency cost.

---

*End of Plan F. Layer 1 + Layer 2 static checks ship here. Layer 2 runtime checks are stubbed and will plug into the V2 TEE plan without harness refactor. On completion, the substrate for "operator X's envelopes conform to the V1 spec" is fully automated and available as `yarn jinn conformance` for every operator on the network.*
