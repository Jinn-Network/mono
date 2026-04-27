# Envelope V1 — Plan B: `intent.v1` Schema Formalization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the currently-implicit `DesiredState` into a canonical, signed, IPFS-addressed `intent.v1` document. Every published intent becomes a signed wire-format document with a stable schema; its CID is the root of every knowledge-tree query (scope §3.1 K2). This plan lands the schema, its signing helper, the IPFS upload path, and the creation-side consumers (submit-intent CLI, auto-generators, posting service). The engine-side consumers that read DesiredState at runtime are migrated in Plan C as part of the envelope refactor.

**Architecture:** New module `client/src/types/intent.ts` exports `IntentV1Schema`, `parseIntentV1`, and types. A companion `client/src/intents/signing.ts` exports `signIntentV1(intent, privateKey): SignedIntentV1`. IPFS upload + retrieval go through the existing `adapters/mech/ipfs.ts` but now round-trip through `parseIntentV1` at the boundary. At runtime, engine/restorer code continues to consume `DesiredState` (a supertype that carries runtime fields like `type`, `attemptNumber`). `DesiredState` is renamed to `RestorationJob` to make clear it's NOT the wire format. A small helper `intentV1ToRestorationJob(signed, runtime)` hydrates one from the other.

**Tech Stack:** TypeScript, Vitest, Zod, viem (secp256k1 signing reused from `signCanonical`), existing `canonicalJson` (now JCS — Plan A must land first).

**Non-goals for this slice:**
- No engine refactor (Plan C — envelope).
- No per-kind spec migration (today's `PortfolioV0IntentSchema` et al. stay exactly as-is; Plan C generalizes them under the envelope).
- No trajectory changes (Plan D).
- No 8004 registration for `adw:Intent` (Plan E).
- No CLI UX changes beyond what's needed to produce + consume `IntentV1`.

**Before you start:** Plan A (JCS swap) must be merged. `canonicalJson` is the signing-input producer; Plan B's signer relies on it.

**Reference:** `docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md` §3.1 (K2 intent formalization), §4.1 (schema deliverable), §4.2a (evidenceHash mechanics — same pattern applies to intent signing: JCS of `intent - signature` → keccak256 → sign).

---

## File structure

New files:
- `client/src/types/intent.ts` — `IntentV1Schema`, `SignedIntentV1Schema`, `parseIntentV1`, `parseSignedIntentV1`, types.
- `client/src/intents/signing.ts` — `signIntentV1(intent, agentEoaPrivateKey, safeAddress): SignedIntentV1`; `intentCid(signed): Promise<string>` helper that uploads + returns CID.
- `client/test/types/intent.test.ts` — schema + parse tests.
- `client/test/intents/signing.test.ts` — signing round-trip tests.

Modified files:
- `client/src/types/desired-state.ts` — rename exports from `DesiredState`/`parseDesiredState` to `RestorationJob`/`parseRestorationJob`; broaden to accept `intent: SignedIntentV1` as an optional field (today's loose fields stay, but a new path populates them from `IntentV1`).
- `client/src/types/index.ts` — re-export new types.
- `client/src/cli/commands/submit-intent.ts` — construct a `SignedIntentV1` before publishing to IPFS.
- `client/src/intents/posting-service.ts` — accept `SignedIntentV1` payloads.
- `client/src/intents/prediction-v0-auto.ts`, `prediction-apy-v0-auto.ts` — produce `SignedIntentV1` (via `signIntentV1`).
- `client/src/intents/sources.ts` — typed as `SignedIntentV1`.
- `client/src/adapters/mech/ipfs.ts` — when downloading an intent, parse through `parseSignedIntentV1`.

Renames (import-path updates only):
- Every `DesiredState` import → `RestorationJob`.
- Every `parseDesiredState` import → `parseRestorationJob`.

---

## Task 1: Define `IntentV1Schema` and `SignedIntentV1Schema`

**Files:**
- Create: `client/src/types/intent.ts`
- Create: `client/test/types/intent.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `client/test/types/intent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  IntentV1Schema,
  SignedIntentV1Schema,
  parseIntentV1,
  parseSignedIntentV1,
} from '../../src/types/intent.js';

describe('IntentV1Schema', () => {
  const valid = {
    schemaVersion: 'intent.v1',
    id: '550e8400-e29b-41d4-a716-446655440000',
    kind: 'portfolio.v0',
    description: 'trade one day on HL',
    window: { startTs: 1000, endTs: 87400000 },
    spec: { kind: 'portfolio.v0', account: { venue: 'hyperliquid-testnet', masterAddress: '0xabc' } },
    eligibility: { minClosedTrades: 20 },
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1700000000000,
  };

  it('accepts a well-formed intent', () => {
    expect(() => IntentV1Schema.parse(valid)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() => IntentV1Schema.parse({ ...valid, schemaVersion: 'intent.v2' })).toThrow();
  });

  it('rejects missing creator', () => {
    const { creator: _c, ...missing } = valid;
    expect(() => IntentV1Schema.parse(missing)).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => IntentV1Schema.parse({ ...valid, description: '' })).toThrow();
  });

  it('rejects non-integer timestamps', () => {
    expect(() => IntentV1Schema.parse({ ...valid, createdAt: 1700000000.5 })).toThrow();
  });

  it('rejects kind mismatch between top-level and spec.kind', () => {
    // spec.kind must match the top-level kind (invariant)
    expect(() =>
      IntentV1Schema.parse({
        ...valid,
        kind: 'portfolio.v0',
        spec: { ...valid.spec, kind: 'prediction.v0' },
      }),
    ).toThrow();
  });
});

describe('SignedIntentV1Schema', () => {
  const validIntent = {
    schemaVersion: 'intent.v1',
    id: '550e8400-e29b-41d4-a716-446655440000',
    kind: 'portfolio.v0',
    description: 'trade one day on HL',
    window: { startTs: 1000, endTs: 87400000 },
    spec: { kind: 'portfolio.v0', account: { venue: 'hyperliquid-testnet', masterAddress: '0xabc' } },
    eligibility: {},
    creator: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    createdAt: 1700000000000,
  };

  const validSignature = {
    algo: 'secp256k1' as const,
    signer: '0x2222222222222222222222222222222222222222',
    hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    sig: '0x' + 'aa'.repeat(65),
  };

  it('accepts a valid signed intent', () => {
    const signed = { ...validIntent, signature: validSignature };
    expect(() => SignedIntentV1Schema.parse(signed)).not.toThrow();
  });

  it('rejects a signed intent missing signature', () => {
    expect(() => SignedIntentV1Schema.parse(validIntent)).toThrow();
  });

  it('rejects wrong signature algo', () => {
    const signed = {
      ...validIntent,
      signature: { ...validSignature, algo: 'ed25519' },
    };
    expect(() => SignedIntentV1Schema.parse(signed)).toThrow();
  });
});

describe('parseIntentV1', () => {
  it('returns a typed intent on valid input', () => {
    const valid = {
      schemaVersion: 'intent.v1',
      id: '550e8400-e29b-41d4-a716-446655440000',
      kind: 'portfolio.v0',
      description: 'x',
      window: { startTs: 1, endTs: 2 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: { safeAddress: '0xaaa', agentEoa: '0xbbb' },
      createdAt: 1,
    };
    const parsed = parseIntentV1(valid);
    expect(parsed.kind).toBe('portfolio.v0');
    expect(parsed.schemaVersion).toBe('intent.v1');
  });

  it('throws ZodError on invalid input', () => {
    expect(() => parseIntentV1({ bogus: 'data' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd client
yarn vitest run test/types/intent.test.ts
```

Expected: all tests FAIL with import error (`Cannot find module '../../src/types/intent.js'`).

- [ ] **Step 3: Write the module**

Create `client/src/types/intent.ts`:

```typescript
/**
 * intent.v1 — canonical signed intent document.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §3.1 (K2).
 *
 * An `intent.v1` is the IPFS-addressed, signed document that declares:
 *   - what objective is being requested (kind + spec)
 *   - who created it (Safe + agent EOA)
 *   - when it was created (UTC ms)
 *   - when it applies (window)
 *   - per-kind eligibility rules
 *
 * Its CID is the root of every knowledge-tree query (restoration envelopes
 * reference `intent.cid`; verdict envelopes reference the same). The signed
 * form is what lives on IPFS; the unsigned canonical form (JCS of intent
 * minus `signature`) is what gets hashed + signed.
 */

import { z } from 'zod';
import { WindowSchema } from './desired-state.js';

const HexStringSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

const CreatorSchema = z.object({
  safeAddress: HexStringSchema,
  agentEoa: HexStringSchema,
});

export const IntentV1Schema = z
  .object({
    schemaVersion: z.literal('intent.v1'),
    id: z.string().min(1),
    kind: z.string().min(1),
    description: z.string().min(1),
    window: WindowSchema,
    spec: z
      .object({ kind: z.string() })
      .and(z.record(z.unknown())),
    eligibility: z.record(z.unknown()),
    creator: CreatorSchema,
    createdAt: z.number().int(),
  })
  .refine((d) => d.kind === d.spec.kind, {
    message: 'top-level kind and spec.kind must match',
    path: ['spec', 'kind'],
  });

export type IntentV1 = z.infer<typeof IntentV1Schema>;

export const SignedIntentV1Schema = z
  .object({
    schemaVersion: z.literal('intent.v1'),
    id: z.string().min(1),
    kind: z.string().min(1),
    description: z.string().min(1),
    window: WindowSchema,
    spec: z.object({ kind: z.string() }).and(z.record(z.unknown())),
    eligibility: z.record(z.unknown()),
    creator: CreatorSchema,
    createdAt: z.number().int(),
    signature: SignatureSchema,
  })
  .refine((d) => d.kind === d.spec.kind, {
    message: 'top-level kind and spec.kind must match',
    path: ['spec', 'kind'],
  });

export type SignedIntentV1 = z.infer<typeof SignedIntentV1Schema>;

export function parseIntentV1(input: unknown): IntentV1 {
  return IntentV1Schema.parse(input);
}

export function parseSignedIntentV1(input: unknown): SignedIntentV1 {
  return SignedIntentV1Schema.parse(input);
}
```

- [ ] **Step 4: Run the tests**

Run:

```bash
cd client
yarn vitest run test/types/intent.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck**

Run:

```bash
cd client
yarn typecheck
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/types/intent.ts client/test/types/intent.test.ts
git commit -m "feat(client): add intent.v1 canonical signed-intent schema

Scope v0.9 §3.1 K2: promote DesiredState to canonical signed document.
Adds IntentV1Schema (unsigned) + SignedIntentV1Schema (with signature),
parsers, and types. Consumers migrate in Task 3+.

No runtime behavior change yet — just the type surface."
```

---

## Task 2: Implement `signIntentV1` helper

**Files:**
- Create: `client/src/intents/signing.ts`
- Create: `client/test/intents/signing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/intents/signing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signIntentV1 } from '../../src/intents/signing.js';
import { parseSignedIntentV1, type IntentV1 } from '../../src/types/intent.js';

describe('signIntentV1', () => {
  it('produces a SignedIntentV1 that round-trips through parseSignedIntentV1', () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const intent: IntentV1 = {
      schemaVersion: 'intent.v1',
      id: '550e8400-e29b-41d4-a716-446655440000',
      kind: 'portfolio.v0',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1700000000000,
    };

    const signed = signIntentV1(intent, pk);

    expect(signed.signature.algo).toBe('secp256k1');
    expect(signed.signature.signer.toLowerCase()).toBe(account.address.toLowerCase());
    expect(signed.signature.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.signature.sig).toMatch(/^0x[0-9a-f]{130}$/);
    // round-trip through the schema
    expect(() => parseSignedIntentV1(signed)).not.toThrow();
  });

  it('is deterministic for the same input', () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const intent: IntentV1 = {
      schemaVersion: 'intent.v1',
      id: 'abc',
      kind: 'portfolio.v0',
      description: 'trade',
      window: { startTs: 1, endTs: 86400001 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1700000000000,
    };

    const s1 = signIntentV1(intent, pk);
    const s2 = signIntentV1(intent, pk);
    expect(s1.signature.hash).toBe(s2.signature.hash);
    expect(s1.signature.sig).toBe(s2.signature.sig);
  });

  it('produces hash = keccak256(JCS(intent without signature))', async () => {
    const { keccak256, toBytes } = await import('viem');
    const { canonicalJson } = await import('../../src/restorer/engine/canonical-json.js');

    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const intent: IntentV1 = {
      schemaVersion: 'intent.v1',
      id: 'xyz',
      kind: 'portfolio.v0',
      description: 'x',
      window: { startTs: 1, endTs: 86400001 },
      spec: { kind: 'portfolio.v0' },
      eligibility: {},
      creator: {
        safeAddress: '0x3333333333333333333333333333333333333333',
        agentEoa: account.address,
      },
      createdAt: 1,
    };

    const expectedHash = keccak256(toBytes(canonicalJson(intent)));

    const signed = signIntentV1(intent, pk);
    expect(signed.signature.hash).toBe(expectedHash);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd client
yarn vitest run test/intents/signing.test.ts
```

Expected: FAIL with module-not-found for `../../src/intents/signing.js`.

- [ ] **Step 3: Implement `signIntentV1`**

Create `client/src/intents/signing.ts`:

```typescript
/**
 * intent.v1 signing.
 *
 * Produces a SignedIntentV1 from an IntentV1 + a private key, matching the
 * envelope signing pattern in scope v0.9 §4.2a: JCS(intent minus signature)
 * → keccak256 → sign with agent EOA key.
 *
 * The signer must be the creator.agentEoa (enforced by test; not by the
 * runtime since signing happens client-side — downstream verifiers check
 * `signer == creator.agentEoa` as part of signature validation).
 */

import { keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount, sign as signHash } from 'viem/accounts';
import { canonicalJson } from '../restorer/engine/canonical-json.js';
import type { IntentV1, SignedIntentV1 } from '../types/intent.js';

export function signIntentV1(intent: IntentV1, privateKey: Hex): SignedIntentV1 {
  const canonical = canonicalJson(intent);
  const hash = keccak256(toBytes(canonical));
  const account = privateKeyToAccount(privateKey);
  // Raw ECDSA (no EIP-191 prefix) — matches manifest-assembly.ts signing.
  const sigObj = signHash({ hash, privateKey, to: 'object' } as any);
  // viem's sign returns {r, s, v, yParity}; serialize to 65-byte hex.
  // See signing.ts for the existing pattern — reuse.
  const r = (sigObj as any).r as Hex;
  const s = (sigObj as any).s as Hex;
  const v = Number((sigObj as any).v ?? 27n + BigInt((sigObj as any).yParity ?? 0));
  const sigHex = ('0x' +
    r.slice(2).padStart(64, '0') +
    s.slice(2).padStart(64, '0') +
    v.toString(16).padStart(2, '0')) as Hex;

  return {
    ...intent,
    signature: {
      algo: 'secp256k1',
      signer: account.address,
      hash,
      sig: sigHex,
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run:

```bash
cd client
yarn vitest run test/intents/signing.test.ts
```

Expected: all pass. If the `sign` call needs a different shape, check `client/src/restorer/engine/signing.ts` for the exact viem API we already use (it's `sign({ hash, privateKey })`) and mirror it. Don't invent a new pattern — reuse `signCanonical` if it already does what we need.

- [ ] **Step 5: Refactor — consider reusing `signCanonical`**

Read `client/src/restorer/engine/signing.ts`. If its `signCanonical(obj, privateKey, signerAddress)` function does exactly what Task 2 Step 3 does, replace the body of `signIntentV1` with a call to it, so there's one signing implementation. If subtly different, note why and keep both.

Expected outcome of refactor: `signIntentV1` becomes ~5 lines wrapping `signCanonical`.

- [ ] **Step 6: Run tests again after refactor**

Run:

```bash
cd client
yarn vitest run test/intents/signing.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add client/src/intents/signing.ts client/test/intents/signing.test.ts
git commit -m "feat(client): add intent.v1 signing helper

signIntentV1(intent, pk) -> SignedIntentV1 producing JCS(intent)
→ keccak256 → secp256k1 sign, matching scope v0.9 §4.2a mechanics.
Reuses signCanonical for the actual signing primitive."
```

---

## Task 3: Rename `DesiredState` → `RestorationJob`; `parseDesiredState` → `parseRestorationJob`

This is a mechanical rename across the codebase. `DesiredState` is a misleading name now that `intent.v1` is the wire format: `DesiredState` is actually the *runtime* shape (job-level fields like `type`, `attemptNumber`, `restorationRequestId` live here, not on the signed intent). Rename makes that explicit.

**Files:**
- Modify: `client/src/types/desired-state.ts` — export renamed types.
- Modify: every file under `client/src/` that imports `DesiredState` or `parseDesiredState`.
- Modify: every test file under `client/test/` that imports the same.

- [ ] **Step 1: Rename the exports in `desired-state.ts`**

Open `client/src/types/desired-state.ts` and:

1. Rename the `DesiredStateSchema` zod export → `RestorationJobSchema`.
2. Rename the `DesiredState` interface → `RestorationJob`.
3. Rename the `parseDesiredState` function → `parseRestorationJob`.
4. Do NOT change `RestorationRequest`, `RestorationResult`, `DeliveredResult`, `Window`, `WindowSchema`, or `RequestId` — these keep their names.

The file comment at the top should be updated to "Runtime shape of a restoration / evaluation job — wraps `SignedIntentV1` (see `./intent.ts`) plus runtime fields (attempt number, type, etc.)."

- [ ] **Step 2: Find all callers**

Run:

```bash
cd client
grep -rln "DesiredState\|parseDesiredState" src test 2>&1
```

Note the output — this is the list of files to update in Step 3.

- [ ] **Step 3: Sed-rename each caller**

For each file in the list from Step 2, replace:
- `DesiredState` → `RestorationJob`
- `parseDesiredState` → `parseRestorationJob`
- `desiredState` → `restorationJob` (local variable name — only in files that use this identifier; check with `grep -rln "desiredState" src test`)

**Suggested command** (run from `client/`):

```bash
# Types
find src test -name '*.ts' -exec sed -i '' \
  -e 's/\bDesiredState\b/RestorationJob/g' \
  -e 's/\bparseDesiredState\b/parseRestorationJob/g' \
  {} +
```

On Linux, drop the `''` after `-i`.

- [ ] **Step 4: Verify typecheck**

Run:

```bash
cd client
yarn typecheck
```

Expected: zero errors. If there are errors, they'll be in spots where `desiredState` the identifier was missed — search + fix manually.

- [ ] **Step 5: Run tests**

Run:

```bash
cd client
yarn test
```

Expected: all pass. The rename should be a no-op semantically.

- [ ] **Step 6: Update the `types/index.ts` re-exports**

Open `client/src/types/index.ts` and adjust re-exports to match the new names.

- [ ] **Step 7: Commit**

```bash
git add client/src client/test
git commit -m "refactor(client): rename DesiredState → RestorationJob

The old name implied a wire-format schema, but the type actually holds
runtime fields (type='restoration'|'evaluation', attemptNumber, etc.)
not present on the signed intent.v1 document. Renaming makes the
distinction explicit: RestorationJob = runtime; SignedIntentV1 = wire.

Mechanical rename across ~30 files. No behavior change."
```

---

## Task 4: Make `RestorationJob` carry a typed `intent: SignedIntentV1` field

Today `RestorationJob` (née `DesiredState`) has loose fields like `spec`, `eligibility`, `window`, `description`, `id`. The migration path: add a typed `intent: SignedIntentV1` field. Loose fields remain during the transition for back-compat within the runtime; Plan C removes them when the engine migrates.

**Files:**
- Modify: `client/src/types/desired-state.ts`
- Modify: `client/test/types/desired-state.test.ts` (or wherever parseRestorationJob is tested)

- [ ] **Step 1: Extend `RestorationJobSchema` with optional `intent`**

In `client/src/types/desired-state.ts`, add (after the existing optional fields):

```typescript
import { SignedIntentV1Schema, type SignedIntentV1 } from './intent.js';

// ... existing schema ...

export const RestorationJobSchema = z.object({
  // ... existing fields ...

  /** Typed signed intent document. Populated at IPFS-fetch / submission
   *  boundary. Loose fields (description, window, spec) mirror this when
   *  present — Plan C migrates all runtime consumers to read from `intent`
   *  and drops the loose mirrors. */
  intent: SignedIntentV1Schema.optional(),
});

export interface RestorationJob {
  // ... existing fields ...
  intent?: SignedIntentV1;
}
```

- [ ] **Step 2: Update `parseRestorationJob` to hydrate loose fields from `intent` when present**

If `intent` is supplied but loose fields aren't, copy from `intent`:

```typescript
export function parseRestorationJob(input: unknown): RestorationJob {
  const parsed = RestorationJobSchema.parse(input);
  const intent = parsed.intent;
  return {
    id: parsed.id ?? intent?.id ?? randomUUID(),
    description: parsed.description ?? intent?.description ?? '',
    context: parsed.context,
    window: parsed.window ?? intent?.window,
    spec: (parsed.spec ?? intent?.spec) as RestorationJob['spec'],
    eligibility: parsed.eligibility ?? intent?.eligibility,
    intent,
  };
}
```

- [ ] **Step 3: Add a test asserting hydration**

In the existing RestorationJob test file (check `client/test/types/` — if no test file exists yet, create `client/test/types/desired-state.test.ts`):

```typescript
it('hydrates loose fields from intent when loose fields are absent', () => {
  const intent = {
    schemaVersion: 'intent.v1' as const,
    id: 'abc',
    kind: 'portfolio.v0',
    description: 'trade',
    window: { startTs: 1, endTs: 86400001 },
    spec: { kind: 'portfolio.v0' },
    eligibility: {},
    creator: { safeAddress: '0xaaa', agentEoa: '0xbbb' },
    createdAt: 1,
    signature: {
      algo: 'secp256k1' as const,
      signer: '0xbbb',
      hash: '0x' + 'ab'.repeat(32),
      sig: '0x' + 'cd'.repeat(65),
    },
  };

  const parsed = parseRestorationJob({ intent });
  expect(parsed.description).toBe('trade');
  expect(parsed.window).toEqual({ startTs: 1, endTs: 86400001 });
  expect(parsed.spec?.kind).toBe('portfolio.v0');
});
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd client
yarn test
```

Expected: new test passes; existing tests continue to pass (they don't set `intent`, so hydration doesn't fire).

- [ ] **Step 5: Commit**

```bash
git add client/src/types/desired-state.ts client/test/types
git commit -m "feat(client): RestorationJob.intent carries SignedIntentV1

Optional typed intent field; loose fields (description, window, spec)
hydrate from intent when loose fields are absent. Plan C migrates all
runtime consumers to read intent directly and drops the loose mirrors."
```

---

## Task 5: Migrate `cli/commands/submit-intent.ts` to produce `SignedIntentV1`

The submit-intent CLI reads a spec file, constructs an intent document, uploads it to IPFS, and calls `JinnRouter.createRestorationJob(cid)`. Today it uploads a `DesiredState`; we migrate to uploading a `SignedIntentV1`.

**Files:**
- Modify: `client/src/cli/commands/submit-intent.ts`
- Modify: `client/test/cli/submit-intent.test.ts` (or wherever covered)

- [ ] **Step 1: Read the current implementation**

Open `client/src/cli/commands/submit-intent.ts`. Identify:
- Where the spec file is read and parsed into a `DesiredState`-shaped object
- Where it's uploaded to IPFS (likely via `uploadToIpfs`)
- Where the on-chain tx is sent

- [ ] **Step 2: Build an IntentV1 from the parsed spec**

After reading the spec file, construct an `IntentV1`:

```typescript
import { randomUUID } from 'node:crypto';
import type { IntentV1 } from '../../types/intent.js';

// ...

const intent: IntentV1 = {
  schemaVersion: 'intent.v1',
  id: specFromFile.id ?? randomUUID(),
  kind: specFromFile.spec.kind,       // promoted to top-level
  description: specFromFile.description,
  window: specFromFile.window,
  spec: specFromFile.spec,
  eligibility: specFromFile.eligibility ?? {},
  creator: {
    safeAddress: config.safeAddress,
    agentEoa: account.address,
  },
  createdAt: Date.now(),
};
```

- [ ] **Step 3: Sign the intent and replace the upload**

```typescript
import { signIntentV1 } from '../../intents/signing.js';

const signed = signIntentV1(intent, privateKey);
const intentCid = await uploadToIpfs(ipfsRegistryUrl, signed);
```

Then pass `intentCid` to the on-chain call exactly as before — the createRestorationJob call doesn't change.

- [ ] **Step 4: Run existing submit-intent tests**

Run:

```bash
cd client
yarn vitest run test/cli/submit-intent.test.ts
```

Expected: tests need updating. Fixture spec objects likely don't include `creator` / `createdAt`; test setup must populate them or test must stub `Date.now()` and config.

- [ ] **Step 5: Update fixtures + add a roundtrip test**

Add to `test/cli/submit-intent.test.ts`:

```typescript
it('uploads a SignedIntentV1 document, not a raw spec', async () => {
  // Stub uploadToIpfs to capture its argument, confirm it's a SignedIntentV1.
  const uploads: unknown[] = [];
  const stubbedUpload = async (_url: string, payload: unknown) => {
    uploads.push(payload);
    return 'bafy...stub';
  };

  // ... run submit-intent with stubbed dependencies ...

  expect(uploads.length).toBe(1);
  const uploaded = uploads[0] as Record<string, unknown>;
  expect(uploaded.schemaVersion).toBe('intent.v1');
  expect(uploaded.signature).toBeDefined();
  expect(uploaded.creator).toBeDefined();
});
```

- [ ] **Step 6: Run all CLI tests**

Run:

```bash
cd client
yarn vitest run test/cli/
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add client/src/cli/commands/submit-intent.ts client/test/cli
git commit -m "feat(cli): submit-intent produces SignedIntentV1 for IPFS upload

Reads spec file, constructs IntentV1 with creator/createdAt/schemaVersion,
signs with agent EOA, uploads signed intent to IPFS. On-chain call flow
unchanged (still passes intent CID to JinnRouter.createRestorationJob)."
```

---

## Task 6: Migrate auto-generators (`intents/prediction-v0-auto.ts`, `prediction-apy-v0-auto.ts`)

These are daemon-side auto-post paths for testnet dogfood. They produce intents periodically. Migrate them to produce `SignedIntentV1`.

**Files:**
- Modify: `client/src/intents/prediction-v0-auto.ts`
- Modify: `client/src/intents/prediction-apy-v0-auto.ts`
- Modify: tests if they exist for these generators

- [ ] **Step 1: Identify the intent-building function in each generator**

Read both files. Each one likely has a function like `buildDesiredState(...)` that returns the intent object.

- [ ] **Step 2: Rename + convert — for each generator**

Rename the builder to `buildIntentV1` and update its return type + body:

```typescript
import type { IntentV1 } from '../types/intent.js';
import { signIntentV1 } from './signing.js';

export function buildIntentV1(...): IntentV1 {
  // ... existing logic ...
  return {
    schemaVersion: 'intent.v1',
    id: ...,
    kind: 'prediction.v0',  // or 'prediction.apy.v0'
    description: ...,
    window: ...,
    spec: ...,
    eligibility: ...,
    creator: { safeAddress, agentEoa },
    createdAt: Date.now(),
  };
}

export function buildSignedIntentV1(...): SignedIntentV1 {
  const intent = buildIntentV1(...);
  return signIntentV1(intent, privateKey);
}
```

- [ ] **Step 3: Update the call sites inside the generators**

Wherever the generator currently uploads to IPFS + submits on-chain, use the signed variant.

- [ ] **Step 4: Run tests**

Run:

```bash
cd client
yarn test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/intents
git commit -m "feat(intents): auto-generators produce SignedIntentV1

prediction-v0-auto and prediction-apy-v0-auto now build and sign
IntentV1 documents before IPFS upload. Matches the submit-intent CLI
flow landed in the previous task."
```

---

## Task 7: Migrate `intents/posting-service.ts` to accept `SignedIntentV1`

**Files:**
- Modify: `client/src/intents/posting-service.ts`
- Modify: `client/test/intents/posting-service.test.ts` (if exists)

- [ ] **Step 1: Read `posting-service.ts`**

Note its current API — what does it accept, what does it do?

- [ ] **Step 2: Update the post function's parameter type**

Change `post(desiredState: DesiredState, ...)` (or whatever the current signature is) to `post(signedIntent: SignedIntentV1, ...)`. Internal calls should now operate on the signed intent.

- [ ] **Step 3: Update all call sites**

Run:

```bash
cd client
grep -rln "posting-service\|postingService\|postIntent" src 2>&1
```

Update each caller to pass `SignedIntentV1` instead of `RestorationJob`.

- [ ] **Step 4: Run tests**

Run:

```bash
cd client
yarn test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/intents
git commit -m "refactor(intents): posting-service takes SignedIntentV1"
```

---

## Task 8: Update `adapters/mech/ipfs.ts` to parse downloaded intents through `parseSignedIntentV1`

When the daemon fetches an intent CID from IPFS (e.g. upon observing a new `RestorationJobCreated` event), it today gets back a loose JSON blob. Migrate the parser at the boundary.

**Files:**
- Modify: `client/src/adapters/mech/ipfs.ts`
- Modify: call sites that use the fetched intent
- Tests: update IPFS-fetch tests

- [ ] **Step 1: Locate the intent-fetch function**

In `adapters/mech/ipfs.ts`, find the function that fetches an intent CID. It likely returns `unknown` or `Record<string, unknown>`.

- [ ] **Step 2: Add a typed variant**

Add (alongside the existing function):

```typescript
import { parseSignedIntentV1, type SignedIntentV1 } from '../../types/intent.js';

export async function fetchSignedIntentFromIpfs(
  gatewayUrl: string,
  cid: string,
): Promise<SignedIntentV1> {
  const raw = await fetchFromIpfs(gatewayUrl, cid);
  return parseSignedIntentV1(raw);
}
```

- [ ] **Step 3: Migrate call sites that fetch intents**

In the adapter / daemon layer, wherever an intent CID is fetched, replace the raw `fetchFromIpfs` with `fetchSignedIntentFromIpfs`. Down-consumers get a typed `SignedIntentV1`.

- [ ] **Step 4: Add IPFS-fetch test**

In `client/test/adapters/mech/ipfs.test.ts` (or create):

```typescript
it('parses fetched intent as SignedIntentV1', async () => {
  // Stub or mock fetchFromIpfs to return a well-formed signed intent
  // ...
  const result = await fetchSignedIntentFromIpfs(gatewayUrl, 'bafy...');
  expect(result.schemaVersion).toBe('intent.v1');
  expect(result.signature.algo).toBe('secp256k1');
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd client
yarn test
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/adapters/mech/ipfs.ts client/test/adapters
git commit -m "feat(adapters): fetchSignedIntentFromIpfs parses through parseSignedIntentV1

IPFS reads of intent CIDs return a typed SignedIntentV1. Runtime
consumers that want the legacy loose shape wrap it in a
RestorationJob via parseRestorationJob({ intent: signed })."
```

---

## Task 9: Update `intents/sources.ts` and `intents/kinds/spec-kind.ts` to typed intents

**Files:**
- Modify: `client/src/intents/sources.ts`
- Modify: `client/src/intents/kinds/spec-kind.ts`
- Tests: as above

- [ ] **Step 1: Read both files** to understand their interfaces.

- [ ] **Step 2: Update their public surface** to use `SignedIntentV1` where they currently take or return intent shapes.

- [ ] **Step 3: Run tests**

Run:

```bash
cd client
yarn test
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add client/src/intents
git commit -m "refactor(intents): sources + spec-kind typed as SignedIntentV1"
```

---

## Task 10: Full sweep + migration check

**Files:**
- None directly — this is a verification task.

- [ ] **Step 1: grep for residual loose intent handling**

Run:

```bash
cd client
grep -rln "IntentV1\|SignedIntentV1\|RestorationJob\|parseRestorationJob" src test 2>&1 | wc -l
```

Expected: a healthy number of files (e.g. >25 touched).

- [ ] **Step 2: grep for anything that still refers to the OLD names**

Run:

```bash
cd client
grep -rln "DesiredState\|parseDesiredState" src test 2>&1
```

Expected output: EMPTY. If anything remains, fix it. (The file `desired-state.ts` itself stays as a filename — the runtime `RestorationJob` still lives there. But there should be no more `DesiredState` identifier anywhere.)

- [ ] **Step 3: Run full test suite**

Run:

```bash
cd client
yarn test
```

Expected: 0 failures.

- [ ] **Step 4: Run typecheck and build**

```bash
cd client
yarn typecheck && yarn build
```

Expected: 0 errors.

- [ ] **Step 5: Commit anything stragglers pull**

If the migration check in Steps 1-2 revealed loose ends, clean them up in one commit:

```bash
git add -u
git commit -m "chore(client): intent.v1 migration straggler cleanup"
```

If clean, no commit needed.

---

## Task 11: Update MCP server and e2e-validate script

**Files:**
- Modify: `client/src/mcp/server.ts` — if it exposes intent-shaped data to subprocess Claude, ensure the exposed shape matches `SignedIntentV1`.
- Modify: `client/scripts/e2e-validate.ts` — the e2e test constructs an intent and submits it.

- [ ] **Step 1: Read `mcp/server.ts`**

Look for the intent exposure function. If Claude's MCP tool receives a DesiredState-shaped payload, update it to SignedIntentV1 (or document explicitly that the MCP surface is runtime shape).

- [ ] **Step 2: Update e2e-validate.ts**

The e2e script creates a test intent on Anvil. Update it to produce `SignedIntentV1` via `signIntentV1`.

- [ ] **Step 3: Run e2e**

Run:

```bash
cd client
yarn e2e
```

Expected: pass. The e2e runs a full restoration on an Anvil fork, so this is a meaningful end-to-end check.

- [ ] **Step 4: Commit**

```bash
git add client/src/mcp client/scripts/e2e-validate.ts
git commit -m "feat(mcp,e2e): plumb SignedIntentV1 through subprocess + e2e"
```

---

## Self-review before marking this plan done

- [ ] **Schema exists:** `client/src/types/intent.ts` exports `IntentV1Schema`, `SignedIntentV1Schema`, `parseIntentV1`, `parseSignedIntentV1`.
- [ ] **Signing exists:** `client/src/intents/signing.ts` exports `signIntentV1`.
- [ ] **Naming migration:** no `DesiredState` identifier remains in `src/` or `test/`; `RestorationJob` is the runtime type.
- [ ] **Boundary migration:** IPFS upload (submit-intent CLI, auto-generators, posting-service) and IPFS fetch (adapters/mech/ipfs.ts) both round-trip through the typed schema.
- [ ] **Runtime consumer passthrough:** engine / restorer / evaluator code still compiles against `RestorationJob`; they consume `job.intent` when it's set (added in Plan C, not yet used here).
- [ ] **All tests green:** `yarn test` reports 0 failures.
- [ ] **Build green:** `yarn build` + `yarn typecheck` report 0 errors.
- [ ] **E2E green:** `yarn e2e` passes.

---

## Follow-ups (covered by later plans)

- **Plan C — generic envelope:** replaces the runtime `RestorationJob`'s loose fields (description, window, spec, eligibility) with a single reference into `job.intent`. Drops the mirroring in `parseRestorationJob`.
- **Plan E — ERC-8004 wiring:** registers the intent CID on the Identity Registry as `adw:Intent` with metadata {kind, creator, createdAt, requestId}.
- **Future:** on-chain `registerIntent(cid, metadata)` call is wired from the intent submission path; today, submission ends at `JinnRouter.createRestorationJob(cid)` only.

---

*End of Plan B. On completion, Plan C (generic envelope) is the next step. C depends on Plan B because every envelope `.intent.cid` references an `intent.v1` document.*
