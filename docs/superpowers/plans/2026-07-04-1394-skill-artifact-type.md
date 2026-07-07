# First-Class Skill Artifact Type (jinn.skill.v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `jinn.skill.v1` artifact type — SKILL.md + companion files + machine-readable provenance — carried in the existing `jinn.execution.v1` wrapper envelope's `artifacts[]`, published alongside the layer-1 trace envelope, with a shared recognition helper and a `jinn-layer skills install` verb (issue #1394).

**Architecture:** Per the approved Stage-1 design: no change to either envelope schema. The frozen `jinn.trace-envelope.v0` (client/packages/harness-layer/src/envelope.ts + docs/envelope-v0.md) is untouched; the outer `jinn.execution.v1` wrapper (client/src/types/envelope.ts) already accepts any `artifactType` string. The seed importer keeps publishing the synthetic capture trace exactly as now AND additionally attaches the skill artifact to the same wrapper envelope (dual-carriage, zero indexer changes). `extractSkill(record)` recognises both the new artifact and the legacy seeded shape.

**Tech Stack:** TypeScript (ESM), zod/v3, vitest. Worktree: `/Users/gcd/Repositories/main/jinn-mono_worktrees/1394`, branch `feat/1394-skill-artifact-type`.

## Global Constraints

- Mono coding rules: Simplicity First, Surgical Changes, TDD (tests before/with implementation). British English, no emoji.
- AC3: the frozen envelope-v0 caps are NOT edited. The additive-review statement lives in the new schema file's header comment and in the PR description. `git diff` for the branch must show zero changes to `client/packages/harness-layer/src/envelope.ts` and `client/packages/harness-layer/docs/envelope-v0.md`.
- zod import style in this repo: `import { z } from 'zod/v3';`
- Size cap: 1 MiB total decoded content (skillMd + companion files) per skill artifact.
- All test commands run from `client/`: `yarn vitest run <paths>` (harness-layer tests are collected by the root vitest config's `packages/*/test/**/*.test.ts` include; the harness-layer package.json has no test script of its own). Typecheck: `yarn typecheck` from `client/` AND `yarn typecheck` from `client/packages/harness-layer/`.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: SkillArtifactV1Schema (`client/src/types/skill-artifact.ts`)

**Files:**
- Create: `client/src/types/skill-artifact.ts`
- Test: `client/test/types/skill-artifact.test.ts`

**Interfaces:**
- Produces: `SKILL_ARTIFACT_TYPE = 'jinn.skill.v1'`, `SkillArtifactV1Schema`, `type SkillArtifactV1`, `MAX_SKILL_FILES = 64`, `MAX_SKILL_TOTAL_DECODED_BYTES = 1048576`. Consumed by Tasks 2–5.
- Precedent followed: `client/src/trajectory/harness-bundle-schema.ts` (ARTIFACT_TYPE const + schemaVersion literal pattern).

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/types/skill-artifact.test.ts
import { describe, it, expect } from 'vitest';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  MAX_SKILL_TOTAL_DECODED_BYTES,
} from '../../src/types/skill-artifact.js';

const SAFE = '0x1111111111111111111111111111111111111111';

function valid() {
  return {
    schemaVersion: 'jinn.skill.v1',
    skill: {
      name: 'write-tests',
      description: 'Write tests before code',
      skillMd: '# write-tests\n\nAlways write a failing test first.',
    },
    files: [
      {
        path: 'reference/EXAMPLES.md',
        contentBase64: Buffer.from('# examples').toString('base64'),
        sha256: 'a'.repeat(64),
      },
    ],
    provenance: {
      kind: 'distilled',
      sourceEnvelopeCids: ['bafySrc1', 'bafySrc2'],
      operator: { safeAddress: SAFE },
      solverType: 'skill-distiller.v0',
    },
  };
}

describe('SkillArtifactV1Schema', () => {
  it('the artifact type constant is the schemaVersion literal', () => {
    expect(SKILL_ARTIFACT_TYPE).toBe('jinn.skill.v1');
  });

  it('parses a valid distilled skill with companion files', () => {
    const parsed = SkillArtifactV1Schema.parse(valid());
    expect(parsed.skill.name).toBe('write-tests');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.provenance.kind).toBe('distilled');
  });

  it('parses an imported seed skill with empty files and seed attribution', () => {
    const parsed = SkillArtifactV1Schema.parse({
      ...valid(),
      files: [],
      provenance: {
        kind: 'imported',
        sourceEnvelopeCids: [],
        operator: { safeAddress: SAFE },
        seed: {
          skill: 'acme/skills/write-tests',
          source: 'https://github.com/acme/skills',
          licence: 'MIT',
        },
      },
    });
    expect(parsed.files).toEqual([]);
    expect(parsed.provenance.seed?.licence).toBe('MIT');
  });

  it('seed licence may be null (repo declares none)', () => {
    const input = valid();
    input.provenance = {
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress: SAFE },
      seed: { skill: 'a/b/c', source: 'https://example.com', licence: null },
    } as never;
    expect(() => SkillArtifactV1Schema.parse(input)).not.toThrow();
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() =>
      SkillArtifactV1Schema.parse({ ...valid(), schemaVersion: 'jinn.skill.v2' }),
    ).toThrow();
  });

  it('rejects absolute and traversal companion paths', () => {
    for (const path of ['/etc/passwd', '../escape.md', 'a/../../b.md', 'C:/windows']) {
      const input = valid();
      input.files[0]!.path = path;
      expect(() => SkillArtifactV1Schema.parse(input)).toThrow();
    }
  });

  it('rejects when total decoded content exceeds the 1 MiB cap', () => {
    const input = valid();
    const big = Buffer.alloc(MAX_SKILL_TOTAL_DECODED_BYTES + 1, 'x').toString('base64');
    input.files[0]!.contentBase64 = big;
    expect(() => SkillArtifactV1Schema.parse(input)).toThrow(/1 MiB|cap/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run test/types/skill-artifact.test.ts`
Expected: FAIL — cannot resolve `../../src/types/skill-artifact.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// client/src/types/skill-artifact.ts
import { z } from 'zod/v3';

/**
 * jinn.skill.v1 — first-class skill artifact (issue #1394).
 *
 * A skill (SKILL.md + optional companion files + machine-readable
 * provenance) carried as one entry in the `jinn.execution.v1` wrapper
 * envelope's `artifacts[]`, published ALONGSIDE the layer-1 trace envelope
 * (never instead of it). Access/pricing come from the enclosing Artifact
 * entry (client/src/types/envelope.ts ArtifactSchema: sha256,
 * access.endpoint, access.priceUsdc, metadata.tags).
 *
 * Frozen-caps review (AC3, additive): this schema is a NEW artifact payload
 * type. It does not touch the frozen layer-1 evidence envelope
 * (jinn.trace-envelope.v0 — client/packages/harness-layer/src/envelope.ts,
 * caps in client/packages/harness-layer/docs/envelope-v0.md) and requires no
 * change to the jinn.execution.v1 wrapper, whose artifacts[] already accepts
 * any artifactType string. Companion-file content lives here, free of the
 * trace envelope's 16 KiB step-attribute cap, under its own 1 MiB total cap.
 *
 * Precedent: client/src/trajectory/harness-bundle-schema.ts.
 */
export const SKILL_ARTIFACT_TYPE = 'jinn.skill.v1' as const;

/** Max companion files per skill. */
export const MAX_SKILL_FILES = 64;
/** Max total decoded bytes (skillMd + all companion files): 1 MiB. */
export const MAX_SKILL_TOTAL_DECODED_BYTES = 1024 * 1024;

const HexAddressSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

/** Relative, traversal-free path — this is written to disk on install. */
const CompanionPathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split('/').includes('..') &&
      !p.split('/').includes(''),
    { message: 'companion file path must be relative and traversal-free' },
  );

export const SkillCompanionFileSchema = z.object({
  path: CompanionPathSchema,
  contentBase64: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const SkillProvenanceSchema = z.object({
  kind: z.enum(['imported', 'distilled']),
  /** Envelope CIDs the skill was distilled from ([] for seed imports). */
  sourceEnvelopeCids: z.array(z.string().min(1)),
  operator: z.object({ safeAddress: HexAddressSchema }),
  solverType: z.string().min(1).optional(),
  /** Seed attribution, mirroring the seeded trace's `seed.attribution`. */
  seed: z
    .object({
      skill: z.string().min(1),
      source: z.string().min(1),
      licence: z.string().nullable(),
    })
    .optional(),
});

/** Decoded size of a base64 string without decoding it. */
function base64DecodedBytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export const SkillArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(SKILL_ARTIFACT_TYPE),
    skill: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      skillMd: z.string().min(1),
    }),
    files: z.array(SkillCompanionFileSchema).max(MAX_SKILL_FILES),
    provenance: SkillProvenanceSchema,
  })
  .refine(
    (a) =>
      new TextEncoder().encode(a.skill.skillMd).length +
        a.files.reduce((n, f) => n + base64DecodedBytes(f.contentBase64), 0) <=
      MAX_SKILL_TOTAL_DECODED_BYTES,
    { message: 'skill artifact exceeds the 1 MiB total decoded-content cap' },
  );

export type SkillCompanionFile = z.infer<typeof SkillCompanionFileSchema>;
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;
export type SkillArtifactV1 = z.infer<typeof SkillArtifactV1Schema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run test/types/skill-artifact.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/types/skill-artifact.ts client/test/types/skill-artifact.test.ts
git commit -m "feat(harness-layer): jinn.skill.v1 skill artifact schema (#1394)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: publish path carries an optional skill artifact (`publish.ts`)

**Files:**
- Modify: `client/packages/harness-layer/src/publish.ts` (PublishOptions at :70-73; artifact assembly at :156-181)
- Test: `client/packages/harness-layer/test/skill.test.ts` (new file, first tests)

**Interfaces:**
- Consumes: `SKILL_ARTIFACT_TYPE`, `SkillArtifactV1Schema`, `type SkillArtifactV1` (Task 1). `HarnessPublishDeps` is unchanged — the skill rides on `PublishOptions`.
- Produces: `PublishOptions.skill?: SkillArtifactV1`. When set, `publish()` uploads a second artifact blob (`deps.publishArtifact({ artifactType: SKILL_ARTIFACT_TYPE, payload })`) and appends a second `Artifact` entry (with `metadata.tags` mirroring `trace.task.distributionTags`) to the wrapper envelope before `buildUnsignedCaptureEnvelope`. Veto still publishes nothing.

- [ ] **Step 1: Write the failing test**

```typescript
// client/packages/harness-layer/test/skill.test.ts
/**
 * jinn.skill.v1 tests (issue #1394): publish-side dual-carriage, extractSkill
 * both-shape recognition, and the publish -> corpus-record round trip.
 */
import { describe, it, expect } from 'vitest';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '../../../src/types/skill-artifact.js';
import { capture, type CapturedTask } from '../src/capture.js';
import {
  publish,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  type HarnessPublishDeps,
} from '../src/publish.js';
import { createMemoryLedger } from '../src/ledger.js';

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

export function skillArtifact(overrides: Partial<SkillArtifactV1> = {}): SkillArtifactV1 {
  return {
    schemaVersion: 'jinn.skill.v1',
    skill: {
      name: 'write-tests',
      description: 'Write tests before code',
      skillMd: '# write-tests\n\nAlways write a failing test first.',
    },
    files: [
      {
        path: 'reference/EXAMPLES.md',
        contentBase64: Buffer.from('# examples\n').toString('base64'),
        sha256: '20a7e6cb8d9f96040367dee3fbe4b2855420faf904e2e5822304ea7897c5b5a2',
      },
    ],
    provenance: {
      kind: 'distilled',
      sourceEnvelopeCids: ['bafySrc1'],
      operator: { safeAddress: TEST_SAFE },
      solverType: 'skill-distiller.v0',
    },
    ...overrides,
  };
}

export function capturedTask(): CapturedTask {
  const nano = '1751587200000000000';
  return {
    session: { sessionId: 'sess-skill-1', capturedAt: '2026-07-04T00:00:00.000Z' },
    task: { summary: 'Distil a skill from traces', distributionTags: ['skills', 'tdd'] },
    environment: {
      harness: { name: 'test-harness', version: '0.0.1' },
      model: 'none',
      tools: [],
    },
    steps: [
      {
        spanId: 's1',
        parentSpanId: null,
        name: 'distil',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: { note: 'hello' },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    cost: { durationMs: 0 },
    provenance: 'contributed',
  };
}

export function mockPublishDeps(): {
  deps: HarnessPublishDeps;
  published: Array<{ artifactType: string; payload: unknown }>;
  envelopes: SignedEnvelope[];
} {
  const published: Array<{ artifactType: string; payload: unknown }> = [];
  const envelopes: SignedEnvelope[] = [];
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async (input) => {
      published.push(input);
      return { cid: `bafy-artifact-${published.length}` };
    },
    publishEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return { cid: `bafy-envelope-${envelopes.length}`, sha256: 'b'.repeat(64) };
    },
    anchorEnvelope: async () => ({
      txHash: `0x${'cd'.repeat(32)}` as `0x${string}`,
      blockNumber: 7,
    }),
  };
  return { deps, published, envelopes };
}

describe('publish() with opts.skill (dual-carriage)', () => {
  it('publishes the trace AND the skill artifact on the same wrapper envelope', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const result = await publish(pending, deps, { skill: skillArtifact() });
    if (result.vetoed) throw new Error('unexpected veto');

    expect(published.map((p) => p.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    expect(SkillArtifactV1Schema.parse(published[1]!.payload).skill.name).toBe('write-tests');

    expect(envelopes).toHaveLength(1);
    const artifacts = envelopes[0]!.artifacts;
    expect(artifacts.map((a) => a.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    const skillEntry = artifacts[1]!;
    // Standard access/pricing fields on the enclosing Artifact entry (AC1).
    expect(skillEntry.access.endpoint).toBe('http://127.0.0.1:7331');
    expect(skillEntry.access.priceUsdc).toBe('0');
    expect(skillEntry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skillEntry.sources?.[0]?.cid).toBe('bafy-artifact-2');
    // metadata.tags mirror the trace's distribution tags.
    expect(skillEntry.metadata?.tags).toEqual(['skills', 'tdd']);
  });

  it('rejects an invalid skill payload before anything is uploaded', async () => {
    const { deps, published } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const bad = { ...skillArtifact(), schemaVersion: 'nope' } as unknown as SkillArtifactV1;
    await expect(publish(pending, deps, { skill: bad })).rejects.toThrow();
    expect(published).toHaveLength(0);
  });

  it('publish without opts.skill is byte-identical to today: one artifact', async () => {
    const { deps, envelopes } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const result = await publish(pending, deps);
    if (result.vetoed) throw new Error('unexpected veto');
    expect(envelopes[0]!.artifacts.map((a) => a.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
    ]);
  });

  it('veto with a skill still publishes nothing', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const result = await publish(pending, deps, { veto: true, skill: skillArtifact() });
    expect(result.vetoed).toBe(true);
    expect(published).toHaveLength(0);
    expect(envelopes).toHaveLength(0);
  });
});
```

Note: the fixture sha256 `20a7e6cb…` is the real digest of `'# examples\n'` (verified with `node -e "console.log(require('crypto').createHash('sha256').update('# examples\n').digest('hex'))"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/skill.test.ts`
Expected: FAIL — dual-carriage test sees only one published artifact (opts.skill is silently ignored: `PublishOptions` has no `skill` field yet, and the invalid-payload test does not reject).

- [ ] **Step 3: Implement in publish.ts**

Add the import (after the existing `types/envelope.js` import at :33-34):

```typescript
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '../../../src/types/skill-artifact.js';
```

Extend `PublishOptions` (:70-73):

```typescript
export interface PublishOptions {
  /** Per-task veto: record locally, publish nothing. */
  veto?: boolean;
  /**
   * First-class skill artifact (#1394): validated against
   * SkillArtifactV1Schema and published as a second artifact on the SAME
   * wrapper envelope, alongside (never instead of) the trace envelope.
   */
  skill?: SkillArtifactV1;
}
```

In `publish()`, validate before any upload (insert immediately after `const trace = toTraceEnvelope(pending);` at :154):

```typescript
  const skill = opts.skill === undefined ? undefined : SkillArtifactV1Schema.parse(opts.skill);
```

Then replace the single-artifact envelope assembly. After the existing `const artifact: Artifact = { … };` block (:165-171), insert:

```typescript
  const artifacts: Artifact[] = [artifact];
  if (skill) {
    const skillBlob = await deps.publishArtifact({
      artifactType: SKILL_ARTIFACT_TYPE,
      payload: skill,
    });
    const skillSha = skillBlob.sha256 ?? sha256Hex(canonicalJson(skill));
    const skillEndpoint = skillBlob.endpoint ?? deps.defaultArtifactEndpoint;
    if (!skillEndpoint) {
      throw new Error(`published skill artifact ${skillBlob.cid} has no access endpoint (set defaultArtifactEndpoint)`);
    }
    artifacts.push({
      artifactType: SKILL_ARTIFACT_TYPE,
      sha256: skillSha,
      metadata: {
        description: `Skill: ${skill.skill.name}`,
        tags: trace.task.distributionTags,
      },
      access: { endpoint: skillEndpoint, priceUsdc: skillBlob.priceUsdc ?? DEFAULT_PRICE_USDC },
      sources: [{ kind: 'ipfs', cid: skillBlob.cid, sha256: skillSha, encoding: DONATION_ARTIFACT_ENCODING }],
    });
  }
```

and change the `buildUnsignedCaptureEnvelope` call (:179) from `artifacts: [artifact],` to `artifacts,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/skill.test.ts packages/harness-layer/test/publish.test.ts`
Expected: PASS (new tests plus the existing publish suite untouched).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/publish.ts client/packages/harness-layer/test/skill.test.ts
git commit -m "feat(harness-layer): publish an optional jinn.skill.v1 artifact alongside the trace (#1394)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: seed importer attaches the skill artifact (dual-carriage)

**Files:**
- Modify: `client/packages/harness-layer/src/seed-import/execute.ts` (seedTags slug at :64-66; publish call at :142)
- Test: `client/packages/harness-layer/test/seed-import.test.ts` (extend `mockPublishDeps` at :62-84; add tests to `describe('execute()')`)

**Interfaces:**
- Consumes: `PublishOptions.skill` (Task 2); `SKILL_ARTIFACT_TYPE`, `type SkillArtifactV1` (Task 1); existing `frontmatterName` (execute.ts :42).
- Produces: exported `skillSlug(skillId: string): string` (reused by Task 4's legacy fallback naming); every imported seed publishes with `provenance.kind: 'imported'`, `sourceEnvelopeCids: []`, `files: []`, `seed: { skill, source, licence }`.

- [ ] **Step 1: Write the failing tests**

In `seed-import.test.ts`, first extend the existing `mockPublishDeps` helper to also record wrapper envelopes — change its return type and body:

```typescript
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import { SKILL_ARTIFACT_TYPE, SkillArtifactV1Schema } from '../../../src/types/skill-artifact.js';

function mockPublishDeps(): {
  deps: HarnessPublishDeps;
  published: Array<{ artifactType: string; payload: unknown }>;
  envelopes: SignedEnvelope[];
} {
  const published: Array<{ artifactType: string; payload: unknown }> = [];
  const envelopes: SignedEnvelope[] = [];
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async (input) => {
      published.push(input);
      return { cid: `bafy-artifact-${published.length}`, sha256: 'a'.repeat(64) };
    },
    publishEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return { cid: `bafy-envelope-${envelopes.length}`, sha256: 'b'.repeat(64) };
    },
    anchorEnvelope: async () => ({ txHash: `0x${'cd'.repeat(32)}` as `0x${string}`, blockNumber: 7 }),
  };
  return { deps, published, envelopes };
}
```

IMPORTANT: the existing test at :153-154 asserts `published` has length 1 with the trace type. Dual-carriage changes that — update it to:

```typescript
    expect(published.map((p) => p.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
```

(the rest of that test — trace provenance, `skill.md` attribute, `seed.attribution` — stays exactly as written: the seeded trace is unchanged, which is the backwards-compat assertion). Then add new tests inside `describe('execute()')`:

```typescript
  // ── First-class skill artifact (#1394) — dual-carriage ────────────────────

  it('attaches a jinn.skill.v1 artifact to the SAME wrapper envelope as the trace', async () => {
    const source = mockSource([skill()]);
    const { deps, published, envelopes } = mockPublishDeps();
    await execute(await plan(source), source, deps);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.artifacts.map((a) => a.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);

    const skillPayload = SkillArtifactV1Schema.parse(
      published.find((p) => p.artifactType === SKILL_ARTIFACT_TYPE)!.payload,
    );
    expect(skillPayload.skill.skillMd).toContain('failing test first');
    expect(skillPayload.skill.name).toBe('write-tests'); // slug (no frontmatter name)
    expect(skillPayload.files).toEqual([]); // companion fetch is #1381's work
    expect(skillPayload.provenance).toMatchObject({
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress: TEST_SAFE },
      seed: {
        skill: 'acme/skills/write-tests',
        source: 'https://github.com/acme/skills',
        licence: 'MIT',
      },
    });
  });

  it('a frontmatter name wins over the slug for the skill artifact name', async () => {
    const source = mockSource([
      skill({
        skill: 'acme/skills/tdd-dir',
        skillMd: '---\nname: test-driven-development\n---\n\n# TDD\n',
      }),
    ]);
    const { deps, published } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const payload = SkillArtifactV1Schema.parse(
      published.find((p) => p.artifactType === SKILL_ARTIFACT_TYPE)!.payload,
    );
    expect(payload.skill.name).toBe('test-driven-development');
  });

  it('the skill Artifact entry mirrors distribution tags into metadata.tags', async () => {
    const source = mockSource([skill()]);
    const { deps, envelopes } = mockPublishDeps();
    await execute(await plan(source), source, deps);
    const entry = envelopes[0]!.artifacts.find((a) => a.artifactType === SKILL_ARTIFACT_TYPE)!;
    expect(entry.metadata?.tags).toContain('seed-import');
    expect(entry.metadata?.tags).toContain('write-tests');
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/seed-import.test.ts`
Expected: the three new tests FAIL (no skill artifact published); the updated length assertion also fails until Step 3.

- [ ] **Step 3: Implement in seed-import/execute.ts**

Add import:

```typescript
import type { SkillArtifactV1 } from '../../../../src/types/skill-artifact.js';
```

Extract the slug helper (replace the inline slug computation in `seedTags` at :64-66):

```typescript
/** Last path segment of a registry-style skill id (`owner/repo/slug`). */
export function skillSlug(skillId: string): string {
  const segments = skillId.split('/').filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? skillId;
}
```

with `seedTags` now using `const slug = skillSlug(skill.skill);` (repoName line unchanged). Add the builder:

```typescript
/** First-class skill artifact for a seed (#1394). Companion-file fetch is #1381. */
function toSkillArtifact(skill: SeedSkill, safeAddress: `0x${string}`): SkillArtifactV1 {
  return {
    schemaVersion: 'jinn.skill.v1',
    skill: {
      name: frontmatterName(skill.skillMd) ?? skillSlug(skill.skill),
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      skillMd: skill.skillMd,
    },
    files: [],
    provenance: {
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress },
      seed: { skill: skill.skill, source: skill.source, licence: skill.licence },
    },
  };
}
```

and change the publish call at :142 to:

```typescript
      const published = await publish(pending, deps, {
        skill: toSkillArtifact(skill, deps.participant.safeAddress),
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/seed-import.test.ts`
Expected: PASS — all existing tests (with the one updated assertion) plus the three new ones.

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/seed-import/execute.ts client/packages/harness-layer/test/seed-import.test.ts
git commit -m "feat(harness-layer): seed importer attaches jinn.skill.v1 alongside the seeded trace (#1394)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `extractSkill()` — both-shape recognition + round trip (`skill.ts`)

**Files:**
- Create: `client/packages/harness-layer/src/skill.ts`
- Test: `client/packages/harness-layer/test/skill.test.ts` (extend)

**Interfaces:**
- Consumes: `CorpusRecord` (consume.ts :109-118 — `{ ref, envelope, provenance, artifacts: CorpusArtifact[] }` where `CorpusArtifact.content: Buffer`); `TRACE_ENVELOPE_ARTIFACT_TYPE` (publish.ts :43); `parseTraceEnvelopeV0` (envelope.ts); `frontmatterName`, `skillSlug` (seed-import/execute.ts); schema from Task 1.
- Produces: `extractSkill(record: CorpusRecord): ExtractedSkill | null` with `interface ExtractedSkill { skill: SkillArtifactV1; shape: 'jinn.skill.v1' | 'seeded-trace' }`. Consumed by Task 5's CLI verb.

- [ ] **Step 1: Write the failing tests** (append to `skill.test.ts`)

```typescript
import type { CorpusRecord } from '../src/consume.js';
import { extractSkill } from '../src/skill.js';

/** Reconstruct the CorpusRecord `corpus get` would return for a publish. */
function toRecord(
  envelope: SignedEnvelope,
  published: Array<{ artifactType: string; payload: unknown }>,
  ref: string,
): CorpusRecord {
  return {
    ref,
    envelope,
    provenance: {
      operator: { agentId: '7', safeAddress: TEST_SAFE },
      evidenceTier: 'self-signed',
      publishedAt: 1,
    },
    artifacts: envelope.artifacts.map((a) => {
      const p = published.find((x) => x.artifactType === a.artifactType);
      if (!p) throw new Error(`no published payload for ${a.artifactType}`);
      const content = Buffer.from(JSON.stringify(p.payload), 'utf-8');
      return {
        sha256: a.sha256,
        artifactType: a.artifactType,
        content,
        source: 'origin' as const,
        sizeBytes: content.length,
      };
    }),
  };
}

/** The seeded shape exactly as seed-import/execute.ts publishes it today. */
function legacySeededTask(): CapturedTask {
  const nano = '1751587200000000000';
  return {
    session: { sessionId: 'seed:acme/skills/write-tests', capturedAt: '2026-07-04T00:00:00.000Z' },
    task: { summary: 'Seed import: acme/skills/write-tests', distributionTags: ['seed-import', 'skills', 'write-tests'] },
    environment: { harness: { name: 'jinn-layer-seed-import', version: '0.1.0' }, model: 'none', tools: [] },
    steps: [
      {
        spanId: 'seed-1',
        parentSpanId: null,
        name: 'seed:skill-md',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: {
          'skill.md': '# write-tests\n\nAlways write a failing test first.',
          'seed.attribution': {
            skill: 'acme/skills/write-tests',
            source: 'https://github.com/acme/skills',
            licence: 'MIT',
          },
        },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    cost: { durationMs: 0 },
    provenance: 'imported',
  };
}

describe('extractSkill()', () => {
  it('round-trips a published jinn.skill.v1 artifact (publish -> record -> extract)', async () => {
    const input = skillArtifact();
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(capturedTask()), deps, { skill: input });
    if (result.vetoed) throw new Error('unexpected veto');

    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    const extracted = extractSkill(record);
    expect(extracted).not.toBeNull();
    expect(extracted!.shape).toBe('jinn.skill.v1');
    expect(extracted!.skill).toEqual(input);
  });

  it('recognises the legacy seeded shape and synthesises equivalent provenance', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(legacySeededTask()), deps); // no opts.skill
    if (result.vetoed) throw new Error('unexpected veto');

    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    const extracted = extractSkill(record);
    expect(extracted).not.toBeNull();
    expect(extracted!.shape).toBe('seeded-trace');
    expect(extracted!.skill.skill.name).toBe('write-tests');
    expect(extracted!.skill.skill.skillMd).toContain('failing test first');
    expect(extracted!.skill.files).toEqual([]);
    expect(extracted!.skill.provenance).toMatchObject({
      kind: 'imported',
      sourceEnvelopeCids: [record.ref],
      operator: { safeAddress: TEST_SAFE },
      seed: {
        skill: 'acme/skills/write-tests',
        source: 'https://github.com/acme/skills',
        licence: 'MIT',
      },
    });
  });

  it('prefers the jinn.skill.v1 artifact when both shapes are present', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(legacySeededTask()), deps, {
      skill: skillArtifact(),
    });
    if (result.vetoed) throw new Error('unexpected veto');
    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    expect(extractSkill(record)!.shape).toBe('jinn.skill.v1');
  });

  it('returns null for a record with no skill in either shape', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(capturedTask()), deps);
    if (result.vetoed) throw new Error('unexpected veto');
    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    expect(extractSkill(record)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/skill.test.ts`
Expected: FAIL — cannot resolve `../src/skill.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// client/packages/harness-layer/src/skill.ts
/**
 * Skill recognition (#1394): the shared install-path helper.
 *
 * `extractSkill(record)` prefers a first-class `jinn.skill.v1` artifact and
 * falls back to the seeded shape (trace-envelope artifact -> `seed:skill-md`
 * step -> `skill.md` attribute + `seed.attribution`), synthesising an
 * equivalent provenance block from the legacy fields — backwards-compatible
 * with every seed published before the first-class type existed.
 */

import { z } from 'zod/v3';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '../../../src/types/skill-artifact.js';
import type { CorpusRecord } from './consume.js';
import { TRACE_ENVELOPE_ARTIFACT_TYPE } from './publish.js';
import { parseTraceEnvelopeV0 } from './envelope.js';
import { frontmatterName, skillSlug } from './seed-import/execute.js';

export interface ExtractedSkill {
  skill: SkillArtifactV1;
  /** Which carrier the skill came from. */
  shape: 'jinn.skill.v1' | 'seeded-trace';
}

const SeedAttributionSchema = z.object({
  skill: z.string().min(1),
  source: z.string().min(1),
  licence: z.string().nullable(),
});

function parseJson(content: Buffer): unknown {
  return JSON.parse(content.toString('utf-8'));
}

/**
 * Extract the skill carried by a corpus record, or null when the record
 * carries none. Throws when a `jinn.skill.v1` artifact is present but
 * malformed — a corrupt first-class skill is an error, not a fall-through.
 */
export function extractSkill(record: CorpusRecord): ExtractedSkill | null {
  const skillArtifact = record.artifacts.find((a) => a.artifactType === SKILL_ARTIFACT_TYPE);
  if (skillArtifact) {
    return {
      skill: SkillArtifactV1Schema.parse(parseJson(skillArtifact.content)),
      shape: 'jinn.skill.v1',
    };
  }

  // Legacy seeded shape (pre-#1394 seed imports).
  const traceArtifact = record.artifacts.find(
    (a) => a.artifactType === TRACE_ENVELOPE_ARTIFACT_TYPE,
  );
  if (!traceArtifact) return null;
  let trace;
  try {
    trace = parseTraceEnvelopeV0(parseJson(traceArtifact.content));
  } catch {
    return null; // not a valid trace envelope — no skill here
  }
  const step = trace.steps.find((s) => s.name === 'seed:skill-md');
  const skillMd = step?.attributes['skill.md'];
  if (typeof skillMd !== 'string' || skillMd.length === 0) return null;
  const attribution = SeedAttributionSchema.safeParse(step!.attributes['seed.attribution']);
  const seed = attribution.success ? attribution.data : undefined;
  return {
    skill: {
      schemaVersion: SKILL_ARTIFACT_TYPE,
      skill: {
        name: frontmatterName(skillMd) ?? (seed ? skillSlug(seed.skill) : 'skill'),
        skillMd,
      },
      files: [],
      provenance: {
        kind: 'imported',
        sourceEnvelopeCids: [record.ref],
        operator: { safeAddress: record.envelope.participant.safeAddress },
        ...(seed ? { seed } : {}),
      },
    },
    shape: 'seeded-trace',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/skill.test.ts`
Expected: PASS (all publish + extract tests).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/skill.ts client/packages/harness-layer/test/skill.test.ts
git commit -m "feat(harness-layer): extractSkill both-shape recognition with round-trip test (#1394)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `jinn-layer skills install <ref> [--out <dir>]`

**Files:**
- Modify: `client/packages/harness-layer/src/cli.ts` (USAGE :42-79; verb gate :288-296; new branch after `const layer = …` at :438)
- Test: `client/packages/harness-layer/test/cli.test.ts` (extend, reusing its `fakeLayer` helper)

**Interfaces:**
- Consumes: `extractSkill`, `ExtractedSkill` (Task 4); `layer.corpus.get(ref)` (existing).
- Produces: CLI verb. Writes `SKILL.md` + companion files (base64-decoded, sha256-verified, paths already schema-validated relative/traversal-free) under `--out <dir>` (default `./<skill-name>`). Exit 1 with a clear message when the record carries no skill.

- [ ] **Step 1: Write the failing tests** (append to `cli.test.ts`)

```typescript
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function skillRecord(): CorpusRecord {
  const companion = Buffer.from('# examples\n', 'utf-8');
  const payload = {
    schemaVersion: 'jinn.skill.v1',
    skill: { name: 'write-tests', skillMd: '# write-tests\n\nAlways write a failing test first.' },
    files: [
      {
        path: 'reference/EXAMPLES.md',
        contentBase64: companion.toString('base64'),
        sha256: createHash('sha256').update(companion).digest('hex'),
      },
    ],
    provenance: {
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress: '0x' + 'a'.repeat(40) },
      seed: { skill: 'acme/skills/write-tests', source: 'https://github.com/acme/skills', licence: 'MIT' },
    },
  };
  const content = Buffer.from(JSON.stringify(payload), 'utf-8');
  return {
    ref: 'bafySkill',
    envelope: {
      solverType: 'capture.v0',
      role: 'capture',
      participant: { safeAddress: '0x' + 'a'.repeat(40), agentEoa: '0x' + 'b'.repeat(40) },
      artifacts: [],
    } as unknown as CorpusRecord['envelope'],
    provenance: {
      operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
      evidenceTier: 'self-signed',
      publishedAt: 1745978400,
    },
    artifacts: [
      {
        sha256: 'c'.repeat(64),
        artifactType: 'jinn.skill.v1',
        content,
        source: 'origin',
        sizeBytes: content.length,
      },
    ],
  };
}

describe('jinn-layer skills install', () => {
  it('installs SKILL.md and companion files from a jinn.skill.v1 record', async () => {
    const { writer, out } = capture();
    const dir = mkdtempSync(join(tmpdir(), 'jinn-skills-'));
    const layer = fakeLayer({ record: skillRecord() });
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', dir],
      { layer, writer },
    );
    expect(code).toBe(0);
    expect(layer.corpus.get).toHaveBeenCalledWith('bafySkill');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('failing test first');
    expect(readFileSync(join(dir, 'reference', 'EXAMPLES.md'), 'utf-8')).toBe('# examples\n');
    const text = out();
    expect(text).toContain(dir);
    expect(text).toContain('imported');
    expect(text).toContain('https://github.com/acme/skills');
  });

  it('exits 1 with a clear message when the record carries no skill', async () => {
    const { writer, out } = capture();
    const record = skillRecord();
    record.artifacts = []; // neither shape present
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', mkdtempSync(join(tmpdir(), 'jinn-skills-'))],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('no skill');
  });

  it('requires a <ref> argument', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['skills', 'install'], { layer: fakeLayer({}), writer });
    expect(code).toBe(2);
    expect(out()).toContain('skills install requires a <ref>');
  });
});
```

(A legacy seeded-shape install already exercises `extractSkill`'s fallback via Task 4's tests; the CLI is shape-agnostic through `extractSkill`, so no duplicate legacy CLI test — Simplicity First.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/cli.test.ts`
Expected: FAIL — unknown verb prints usage, exit 2.

- [ ] **Step 3: Implement in cli.ts**

Imports (top of file): add `dirname` to the `node:path` import, add `import { createHash } from 'node:crypto';`, and `import { extractSkill } from './skill.js';`.

USAGE: add after the `corpus get` line:

```
  skills install <ref> [--out <dir>] [--json]    Install the skill carried by a corpus record
                                                 (jinn.skill.v1 artifact, or the legacy seeded
                                                 trace shape): writes SKILL.md + companion files
                                                 to <dir> (default ./<skill-name>)
```

Verb gate (:288-296): add `const isSkillsInstall = verb === 'skills' && subverb === 'install';` and include it in the `if (!isCorpus && … )` guard.

Branch — insert immediately after `const layer = opts.layer ?? buildDefaultLayer();` (:438):

```typescript
  if (isSkillsInstall) {
    const ref = parsed.positionals[0];
    if (ref === undefined) {
      writer.write(`error: skills install requires a <ref> argument (a manifest CID from a search result)\n\n${USAGE}`);
      return 2;
    }
    const record = await layer.corpus.get(ref);
    const extracted = extractSkill(record);
    if (extracted === null) {
      writer.write(`error: record ${ref} carries no skill (neither a jinn.skill.v1 artifact nor the seeded trace shape)\n`);
      return 1;
    }
    const { skill } = extracted;
    const dir = (parsed.values.out as string | undefined) ?? join(process.cwd(), skill.skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skill.skill.skillMd);
    for (const file of skill.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== file.sha256) {
        writer.write(`error: companion file ${file.path} sha256 mismatch (expected ${file.sha256}, got ${digest})\n`);
        return 1;
      }
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    if (parsed.values.json) {
      writer.write(JSON.stringify({
        dir,
        name: skill.skill.name,
        shape: extracted.shape,
        files: skill.files.map((f) => f.path),
        provenance: skill.provenance,
      }) + '\n');
    } else {
      const p = skill.provenance;
      writer.write([
        `Installed ${skill.skill.name} (${extracted.shape}) to ${dir}`,
        `  files       SKILL.md${skill.files.length > 0 ? `, ${skill.files.map((f) => f.path).join(', ')}` : ''}`,
        `  provenance  ${p.kind}${p.solverType ? ` (${p.solverType})` : ''}`,
        `  operator    ${p.operator.safeAddress}`,
        `  sources     ${p.sourceEnvelopeCids.join(', ') || '-'}`,
        ...(p.seed ? [`  seed        ${p.seed.skill} — ${p.seed.source} (${p.seed.licence ?? 'no licence'})`] : []),
        '',
      ].join('\n'));
    }
    return 0;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client && yarn vitest run packages/harness-layer/test/cli.test.ts`
Expected: PASS (existing 7+ tests plus the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/cli.ts client/packages/harness-layer/test/cli.test.ts
git commit -m "feat(harness-layer): jinn-layer skills install verb (#1394)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: exports, typecheck, full verification

**Files:**
- Modify: `client/packages/harness-layer/src/index.ts`

**Interfaces:**
- Produces: package-level exports of everything #1394 added.

- [ ] **Step 1: Add exports to index.ts** (after the `./publish.js` export block at :45-52)

```typescript
export {
  extractSkill,
  type ExtractedSkill,
} from './skill.js';

export {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  SkillProvenanceSchema,
  SkillCompanionFileSchema,
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_DECODED_BYTES,
  type SkillArtifactV1,
  type SkillProvenance,
  type SkillCompanionFile,
} from '../../../src/types/skill-artifact.js';
```

and add `skillSlug` to the existing `./seed-import/execute.js` export line (:80):

```typescript
export { execute, skillSlug, type ImportResult } from './seed-import/execute.js';
```

- [ ] **Step 2: Full verification**

```bash
cd /Users/gcd/Repositories/main/jinn-mono_worktrees/1394/client
yarn vitest run packages/harness-layer/test test/types/skill-artifact.test.ts   # all green
yarn typecheck                                                                   # zero errors
cd packages/harness-layer && yarn typecheck                                      # zero errors
cd ../.. && git diff origin/next --stat -- packages/harness-layer/src/envelope.ts packages/harness-layer/docs/envelope-v0.md
# Expected: empty output — the frozen layer-1 schema and caps doc are untouched (AC3)
```

- [ ] **Step 3: Commit**

```bash
git add client/packages/harness-layer/src/index.ts
git commit -m "feat(harness-layer): export skill artifact surface from package index (#1394)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: PR description must state the AC3 review** — include: "Schema change reviewed against the frozen envelope-v0 caps: additive. `jinn.skill.v1` is a new artifact payload carried in the `jinn.execution.v1` wrapper's open `artifacts[]`; `jinn.trace-envelope.v0` and `docs/envelope-v0.md` are untouched (see empty `git diff` for both files)."

---

## Acceptance-criteria mapping

| AC | Requirement | Tasks | Evidence |
|----|-------------|-------|----------|
| 1 | `jinn.skill.v1` artifactType with SKILL.md + companion files (#1381-compatible, empty allowed), machine-readable provenance (source envelope CIDs, operator, solverType), standard access/pricing fields | 1, 2 | `skill-artifact.test.ts`; `skill.test.ts` dual-carriage test asserts `access.endpoint` / `priceUsdc` / `sha256` / `sources` / `metadata.tags` on the enclosing Artifact entry |
| 2a | `jinn-layer publish` + `corpus get` round-trip it | 2, 4 | `skill.test.ts` round-trip test (publish → reconstructed CorpusRecord → `extractSkill` equals input) |
| 2b | `/capture-meta` indexes its tags/summary | 3 | Zero indexer changes by design: the seeded trace envelope (which the indexer's two-hop enrichment reads) is published unchanged — `seed-import.test.ts` keeps asserting the trace's tags/summary/attributes; the skill Artifact entry additionally mirrors tags into `metadata.tags` |
| 2c | Harness skills-install path recognises it, backwards-compatible with the seeded shape | 4, 5 | `extractSkill` prefers `jinn.skill.v1`, falls back to seeded shape with synthesised provenance (`skill.test.ts`); `skills install` CLI tests (`cli.test.ts`) |
| 3 | Schema change reviewed against frozen envelope-v0 caps (additive) | 1, 6 | Header comment in `skill-artifact.ts`; Task 6 empty-diff check on `envelope.ts` + `envelope-v0.md`; PR description statement |

## Design corrections / discoveries (verified against the worktree)

1. All seven design file paths exist as named. `PublishOptions` (publish.ts:70) and `HarnessPublishDeps` (publish.ts:48) confirmed — the skill rides on `PublishOptions` (deps unchanged, since the skill is per-publish data, not wiring). `matchesQuery` (consume.ts:136) already matches on `artifactTypes`, so `corpus search jinn.skill` works with zero changes.
2. Harness-layer has **no package-level test script** — tests run from `client/` via the root vitest config (`packages/*/test/**/*.test.ts` include): `yarn vitest run packages/harness-layer/test`. Verified green pre-change.
3. There is **no existing "skills install" code path anywhere in the mono repo** — AC2c's "harness skills-install path" is satisfied by the new shared `extractSkill` helper plus the `jinn-layer skills install` verb (design items 4–5); the external jinn-agent harness consumes `extractSkill` later.
4. `frontmatterName` already exists and is exported from `seed-import/execute.ts:42` — reused, not duplicated; the slug logic is factored into an exported `skillSlug` so `skill.ts` and `seedTags` share it.
5. Import depth from `seed-import/`: `'../../../../src/types/skill-artifact.js'` (one level deeper than publish.ts's `'../../../src/…'`).
6. `CapturePublishedBlob` = `{ cid: string; sha256?: string; endpoint?: string; priceUsdc?: string }` (client/src/captures/publish.ts:23) — the skill Artifact entry falls back to `sha256Hex(canonicalJson(...))` and `defaultArtifactEndpoint` exactly like the trace entry.
7. One existing test assertion must change (seed-import.test.ts:153-154, `published` length/type): dual-carriage makes two artifact uploads. Everything else in the seeded shape is asserted unchanged — that IS the backwards-compat test.
8. The trace envelope's 16 KiB step-attribute cap (envelope-v0.md) still applies to the seeded `skill.md` attribute — unchanged behaviour; the first-class artifact is what lifts skills past it (1 MiB cap), which is why companion files (#1381) live only on the artifact.
