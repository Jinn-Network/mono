# Distillation v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the layer-1→layer-2 distillation pipeline from `spec/2026-07-06-distillation-v1.md`, sequenced so the parts that are buildable-now and unblocked ship first, and the distiller is gated on a cheap raw-evidence-vs-seeds pilot.

**Architecture:** Three sequenced plans. **Plan A** (this document, in full) builds the layer-2 substrate (`jinn.skill.v1` conformant skill package + `publishSkill()` + a secret-only scrub altitude) and re-imports the 84 seeds onto it — which *is* the fix for [#1409](https://github.com/Jinn-Network/mono/issues/1409). **Plan B** (specified at interface level) builds the execution-ledger→layer-1 bridge + the promotion gate. **Plan C** (specified at interface level, **gated**) builds the distiller + the three-arm measurement, and must not start until (a) the capability-eval rig (PR #1416) lands and (b) the seeds-vs-raw-evidence pilot shows raw evidence is worth distilling from.

**Tech Stack:** TypeScript (Node 22), Vitest, Zod, viem; the existing `@jinn-network/client` + `client/packages/harness-layer` packages; the seller-side scrub pipeline (`client/src/trajectory/scrub/`); ERC-8004 anchoring.

## Global Constraints

- **The frozen layer-1 envelope (`jinn.trace-envelope.v0`) is not amended.** Any change to `client/packages/harness-layer/src/envelope.ts` schema is out of scope (spec §2.1, §13).
- **`role` is a closed enum** `['solution','verdict','capture']` (`client/src/types/envelope.ts:25` `CanonicalRoleSchema`). Skills use **`role: 'capture'`** and discriminate via **`solverType: 'distilled-skill'`** + **`artifactType: 'jinn.skill.v1'`** — do NOT add a `'knowledge'` role (that touches the execution-envelope schema + indexer projection; out of scope). This *corrects* spec §5's `role: 'knowledge'` recommendation.
- **`solverType` is a free string** (`envelope.ts:162`, `z.string().min(1)`).
- **Scrub is fail-closed.** No scrub, no publish. The layer-2 pass must still catch genuine secrets (spec §10, D6).
- **Money/counts are never IEEE-754 floats** in payloads — strings or ints (envelope convention).
- **Match existing style:** strict Zod objects, `canonicalJson` for hashing, `sha256Hex` for digests, dependency-injection for I/O (tests inject `publishArtifact`/`publishEnvelope`/`anchorEnvelope`).
- **Commit after every green step.** Conventional-commit prefixes: `feat`/`fix`/`test`.

---

## File structure (Plan A)

- Create: `client/src/trajectory/scrub/layer2.ts` — `buildLayer2ScrubPipeline(policy?)`, the secret-only altitude. One responsibility: assemble the public/derived-content pipeline.
- Create: `client/packages/harness-layer/src/skill.ts` — the `jinn.skill.v1` package: `SkillPackage` type, `SkillProvenanceSchema` (the `metadata.jinn` block), `buildSkillMarkdown()`/`parseSkillMarkdown()`, `SKILL_ARTIFACT_TYPE`. One responsibility: the layer-2 consumable format.
- Create: `client/packages/harness-layer/src/publish-skill.ts` — `publishSkill()`. One responsibility: anchor + wrap a skill package as a corpus record (mirrors `publish.ts`).
- Modify: `client/packages/harness-layer/src/seed-import/execute.ts` — route seeds through `publishSkill()` + layer-2 scrub instead of `capture()`+`publish()` (the #1409 fix).
- Modify: `client/packages/harness-layer/src/consume.ts` — surface `jinn.skill.v1` records (a `kind` on `CorpusSearchHit` + an artifactType filter helper).
- Tests: `client/test/trajectory/scrub/layer2.test.ts`, `client/packages/harness-layer/test/skill.test.ts`, `client/packages/harness-layer/test/publish-skill.test.ts`, `client/packages/harness-layer/test/seed-import-layer2.test.ts`, `client/packages/harness-layer/test/consume-skill.test.ts`.

> **Run tests from `client/`:** `cd client && yarn vitest run <path>`. The harness-layer package tests run under the same client vitest config (see existing `client/packages/harness-layer/test/*.test.ts`).

---

### Task A1: Layer-2 secret-only scrub pipeline

**Files:**
- Create: `client/src/trajectory/scrub/layer2.ts`
- Test: `client/test/trajectory/scrub/layer2.test.ts`

**Interfaces:**
- Consumes: `ScrubPipeline` (`client/src/trajectory/scrub/pipeline.ts`), `keyPolicyStage` + `KeyPolicy` (`./key-policy.ts`), `secretlintStage` (`./secretlint-stage.ts`), `DEFAULT_KEY_POLICY` (`./build.ts`).
- Produces: `buildLayer2ScrubPipeline(policy?: KeyPolicy): ScrubPipeline` — the pipeline used by `publishSkill()` (A2) and seed import (A3). Stages: `[keyPolicyStage, secretlintStage]` — **drops** `openredaction`, `plainPatterns`, `mlPii` (the prose-manglers, spec §10).

- [ ] **Step 1: Write the failing test**

```ts
// client/test/trajectory/scrub/layer2.test.ts
import { describe, it, expect } from 'vitest';
import { buildLayer2ScrubPipeline } from '../../src/trajectory/scrub/layer2.js';

describe('buildLayer2ScrubPipeline', () => {
  it('preserves ordinary prose (the #1409 defacement class)', async () => {
    const p = buildLayer2ScrubPipeline();
    // The literal words #1409 reported being mangled by the trace-grade pipeline.
    const prose =
      'Use this skill before you start. It clarifies user intent and requirements ' +
      'so you can brainstorm the design and explore the problem space.';
    const { attributes } = await p.run({ 'skill.md': prose });
    expect(attributes['skill.md']).toBe(prose); // byte-for-byte, no placeholder tokens
  });

  it('still redacts a genuine secret (fail-closed net intact)', async () => {
    const p = buildLayer2ScrubPipeline();
    const withKey = 'export AWS_SECRET=AKIAIOSFODNN7EXAMPLE and a token wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const { attributes, redactions } = await p.run({ 'skill.md': withKey });
    expect(redactions.length).toBeGreaterThan(0);
    expect(String(attributes['skill.md'])).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('drops the structural drop-tier keys (auth headers, env dumps)', async () => {
    const p = buildLayer2ScrubPipeline();
    const { attributes } = await p.run({ 'env.SECRET': 'x', 'skill.md': 'hello' });
    expect(attributes['env.SECRET']).toBeUndefined();
    expect(attributes['skill.md']).toBe('hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/trajectory/scrub/layer2.test.ts`
Expected: FAIL — `Cannot find module '../../src/trajectory/scrub/layer2.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/trajectory/scrub/layer2.ts
import { ScrubPipeline } from './pipeline.js';
import { keyPolicyStage, type KeyPolicy } from './key-policy.js';
import { secretlintStage } from './secretlint-stage.js';
import { DEFAULT_KEY_POLICY } from './build.js';

/**
 * The layer-2 / public / derived-content scrub altitude (spec §10, D6).
 * Secret-only: structural key policy + the FULL secretlint stage (incl. its
 * Pass-2 entropy secret-shape fallback). Deliberately DROPS openredaction,
 * plain-patterns, and ML-PII — the stages whose PII shape-matching and
 * trigger-word/entropy behaviour deface ordinary public prose (#1409). The
 * input here is public (seeds) or already layer-1-scrubbed (distilled/bridged)
 * content, not raw private machine activity.
 */
export function buildLayer2ScrubPipeline(policy: KeyPolicy = DEFAULT_KEY_POLICY): ScrubPipeline {
  return new ScrubPipeline([keyPolicyStage(policy), secretlintStage(policy)]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/trajectory/scrub/layer2.test.ts`
Expected: PASS (all 3).

> **Contingency (surface, do not silently absorb):** if the "preserves ordinary prose" test FAILS because `secretlintStage`'s Pass-2 entropy fallback mangles a token in the real `brainstorming` seed (see A3 — commit 5c19fc6da shows the entropy fallback *has* mangled slug-like text), STOP and escalate: the choice is (a) further-tune secretlint Pass-2 (a separate `fix`), or (b) define layer-2 as key-policy + secretlint Pass-1 (rules) only, dropping Pass-2 — which trades generic-secret coverage for prose fidelity (a decision for the spec author, spec §10/§16). Do not paper over a failing prose test.

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/scrub/layer2.ts client/test/trajectory/scrub/layer2.test.ts
git commit -m "feat(scrub): layer-2 secret-only pipeline for public/derived content (spec §10)"
```

---

### Task A2: The `jinn.skill.v1` skill package (format + provenance)

**Files:**
- Create: `client/packages/harness-layer/src/skill.ts`
- Test: `client/packages/harness-layer/test/skill.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces:
  - `SKILL_ARTIFACT_TYPE = 'jinn.skill.v1'`
  - `SkillProvenanceSchema` / `SkillProvenance` — the `metadata.jinn` block: `{ schema: 'jinn.skill.v1', distribution: string, verifiabilityTier: string, distilledFrom: number, provenance: string[], distillPromptSha256?: string, distilledAt?: string, seedSource?: string }`
  - `SkillPackage` = `{ name: string; description: string; body: string; license: string | null; jinn: SkillProvenance }`
  - `buildSkillMarkdown(pkg: SkillPackage): string` — emit a conformant `SKILL.md` (YAML frontmatter `name`/`description`/`license`/`metadata.jinn` + markdown body).
  - `parseSkillMarkdown(md: string): SkillPackage` — inverse; throws on a non-conformant package.
  - `assertConformantName(name: string): void` — `name` is lowercase letters/digits/hyphens (skills.sh rule).

- [ ] **Step 1: Write the failing test**

```ts
// client/packages/harness-layer/test/skill.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildSkillMarkdown, parseSkillMarkdown, assertConformantName, SKILL_ARTIFACT_TYPE, type SkillPackage,
} from '../src/skill.js';

const pkg: SkillPackage = {
  name: 'django-queryset-dedup-debugging',
  description: 'Use when a Django ORM queryset returns duplicate rows after a join or prefetch.',
  license: null,
  jinn: {
    schema: 'jinn.skill.v1',
    distribution: 'coding',
    verifiabilityTier: 'evaluator-verified',
    distilledFrom: 3,
    provenance: ['bafy-ref-1', 'bafy-ref-2', 'bafy-ref-3'],
    distillPromptSha256: 'a'.repeat(64),
  },
  body: '# Django queryset dedup\n\nUse `.distinct()` after the join.\n',
};

describe('jinn.skill.v1 package', () => {
  it('round-trips through markdown', () => {
    const md = buildSkillMarkdown(pkg);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('name: django-queryset-dedup-debugging');
    expect(parseSkillMarkdown(md)).toEqual(pkg);
  });

  it('exposes the artifact type constant', () => {
    expect(SKILL_ARTIFACT_TYPE).toBe('jinn.skill.v1');
  });

  it('rejects a non-conformant skill name', () => {
    expect(() => assertConformantName('Django_Queryset')).toThrow();
    expect(() => assertConformantName('django-queryset-dedup-debugging')).not.toThrow();
  });

  it('rejects markdown missing required frontmatter', () => {
    expect(() => parseSkillMarkdown('# no frontmatter')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run packages/harness-layer/test/skill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/packages/harness-layer/src/skill.ts
import { z } from 'zod';

export const SKILL_ARTIFACT_TYPE = 'jinn.skill.v1' as const;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SkillProvenanceSchema = z.strictObject({
  schema: z.literal('jinn.skill.v1'),
  distribution: z.string().min(1),
  verifiabilityTier: z.string().min(1),
  distilledFrom: z.number().int().nonnegative(),
  provenance: z.array(z.string().min(1)),
  distillPromptSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  distilledAt: z.string().optional(),
  seedSource: z.string().optional(),
});
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>;

export interface SkillPackage {
  name: string;
  description: string;
  license: string | null;
  jinn: SkillProvenance;
  body: string;
}

export function assertConformantName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`skill name "${name}" is not conformant (lowercase letters/digits/hyphens only)`);
  }
}

export function buildSkillMarkdown(pkg: SkillPackage): string {
  assertConformantName(pkg.name);
  SkillProvenanceSchema.parse(pkg.jinn);
  // Deterministic, minimal YAML (skill frontmatter is plain scalars + one nested block).
  const fm = [
    '---',
    `name: ${pkg.name}`,
    `description: ${JSON.stringify(pkg.description)}`,
    `license: ${pkg.license === null ? 'null' : JSON.stringify(pkg.license)}`,
    'metadata:',
    '  jinn:',
    ...emitJinnBlock(pkg.jinn).map((l) => `    ${l}`),
    '---',
    '',
  ].join('\n');
  return fm + pkg.body;
}

function emitJinnBlock(j: SkillProvenance): string[] {
  const lines = [
    `schema: ${j.schema}`,
    `distribution: ${JSON.stringify(j.distribution)}`,
    `verifiabilityTier: ${JSON.stringify(j.verifiabilityTier)}`,
    `distilledFrom: ${j.distilledFrom}`,
    'provenance:',
    ...j.provenance.map((r) => `  - ${JSON.stringify(r)}`),
  ];
  if (j.distillPromptSha256) lines.push(`distillPromptSha256: ${j.distillPromptSha256}`);
  if (j.distilledAt) lines.push(`distilledAt: ${JSON.stringify(j.distilledAt)}`);
  if (j.seedSource) lines.push(`seedSource: ${JSON.stringify(j.seedSource)}`);
  return lines;
}

export function parseSkillMarkdown(md: string): SkillPackage {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error('skill markdown missing YAML frontmatter');
  const doc = parseYamlFrontmatter(m[1]!); // see helper below
  const name = String(doc.name ?? '');
  assertConformantName(name);
  const jinn = SkillProvenanceSchema.parse((doc.metadata as any)?.jinn);
  return {
    name,
    description: String(doc.description ?? ''),
    license: doc.license == null ? null : String(doc.license),
    jinn,
    body: m[2] ?? '',
  };
}
```

> **YAML note:** the seed importer already hand-parses `name:` from frontmatter with a line parser (`frontmatterName` in `seed-import/execute.ts`) rather than adding a YAML dep. Mirror that: implement `parseYamlFrontmatter` as a small line-parser covering scalars + the one nested `metadata.jinn` block (list items + scalars), OR — if the package already has `yaml`/`js-yaml` available (check `client/package.json` first) — use it. Keep to the codebase's existing choice; do not add a dep without checking.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run packages/harness-layer/test/skill.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/skill.ts client/packages/harness-layer/test/skill.test.ts
git commit -m "feat(harness-layer): jinn.skill.v1 conformant skill package + provenance (spec §5)"
```

---

### Task A3: `publishSkill()` — anchor + wrap a skill as a corpus record

**Files:**
- Create: `client/packages/harness-layer/src/publish-skill.ts`
- Test: `client/packages/harness-layer/test/publish-skill.test.ts`

**Interfaces:**
- Consumes: `buildUnsignedCaptureEnvelope`, `sha256Hex`, types `CaptureEnvelopeAnchorInput`/`Result`, `CapturePublishedBlob` (`client/src/captures/publish.ts`); `Artifact`, `SignedEnvelope`, `UnsignedEnvelope`, `SignedEnvelopeSchema` (`client/src/types/envelope.ts`); `canonicalJson`, `signCanonical` (as in `publish.ts`); `SkillPackage`, `buildSkillMarkdown`, `SKILL_ARTIFACT_TYPE` (A2); `HarnessPublishDeps` shape (reuse from `publish.ts`).
- Produces: `publishSkill(pkg: SkillPackage, deps: SkillPublishDeps): Promise<{ envelopeRef: string; anchorTx: string | null }>`.

**Key decisions locked by the recon (Global Constraints):**
- The envelope's `solverType` is set to **`'distilled-skill'`** and `role` stays **`'capture'`** (role enum is closed). `buildUnsignedCaptureEnvelope` hardcodes both, so `publishSkill` **must not** call it unchanged — either (a) add an optional `solverType?`/`role?` to `BuildUnsignedCaptureEnvelopeArgs` (defaulting to `'capture'`/`'capture'`) and pass `solverType: 'distilled-skill'`, or (b) build the `UnsignedEnvelope` inline in `publish-skill.ts`. **Prefer (a)** — one builder, minimal duplication; the change is additive and defaulted, so `publishCaptureEnvelope` is unaffected.
- The SKILL.md is the artifact payload with `artifactType: SKILL_ARTIFACT_TYPE`. (Single-file package for v1 — spec §5.)

- [ ] **Step 1: Write the failing test** (fakes for publish/anchor; asserts the discriminator + artifact type)

```ts
// client/packages/harness-layer/test/publish-skill.test.ts
import { describe, it, expect } from 'vitest';
import { publishSkill } from '../src/publish-skill.js';
import { SKILL_ARTIFACT_TYPE, type SkillPackage } from '../src/skill.js';

const pkg: SkillPackage = {
  name: 'example-skill', description: 'Use when X.', license: null,
  jinn: { schema: 'jinn.skill.v1', distribution: 'coding', verifiabilityTier: 'evaluator-verified', distilledFrom: 1, provenance: ['bafy-src'] },
  body: '# Example\n\nDo X.\n',
};

function fakeDeps() {
  const anchored: any[] = [];
  return {
    anchored,
    participant: { safeAddress: '0x'.padEnd(42, '1') as `0x${string}`, agentEoa: '0x'.padEnd(42, '2') as `0x${string}` },
    signer: { address: '0x'.padEnd(42, '2') as `0x${string}`, privateKey: `0x${'a'.repeat(64)}` as `0x${string}` },
    clientGitSha: 'deadbeef',
    publishArtifact: async (i: any) => ({ cid: `cid-artifact`, sha256: 'a'.repeat(64), endpoint: 'https://ipfs.example/artifact' }),
    publishEnvelope: async (_e: any) => ({ cid: 'cid-envelope' }),
    anchorEnvelope: async (i: any) => { anchored.push(i); return { txHash: `0x${'e'.repeat(64)}` as `0x${string}` }; },
  };
}

describe('publishSkill', () => {
  it('publishes a jinn.skill.v1 artifact discriminated by solverType, anchored', async () => {
    const deps = fakeDeps();
    const captured: any[] = [];
    const res = await publishSkill(pkg, { ...deps,
      publishArtifact: async (i: any) => { captured.push(i); return { cid: 'cid-artifact', sha256: 'a'.repeat(64), endpoint: 'https://ipfs.example/artifact' }; },
      publishEnvelope: async (e: any) => { captured.push(e); return { cid: 'cid-envelope' }; },
    });
    expect(res.envelopeRef).toBe('cid-envelope');
    expect(res.anchorTx).toBe(`0x${'e'.repeat(64)}`);
    // the artifact carries the skill type + the SKILL.md payload
    const artifactUpload = captured.find((c) => c.artifactType === SKILL_ARTIFACT_TYPE);
    expect(artifactUpload).toBeTruthy();
    expect(String(artifactUpload.payload)).toContain('name: example-skill');
    // the wrapper envelope discriminates as distilled-skill, role capture
    const env = captured.find((c) => c.solverType);
    expect(env.solverType).toBe('distilled-skill');
    expect(env.role).toBe('capture');
    // anchored under a skill-scoped key (see contingency below)
    expect(deps.anchored[0].metadataKey.startsWith('skill:')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run packages/harness-layer/test/publish-skill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the builder override, then implement `publishSkill`**

First, in `client/src/captures/publish.ts`, make `buildUnsignedCaptureEnvelope` accept optional discriminators (additive, defaulted — `publishCaptureEnvelope` unchanged):

```ts
interface BuildUnsignedCaptureEnvelopeArgs {
  // ...existing fields...
  solverType?: string;   // default 'capture'
  role?: 'solution' | 'verdict' | 'capture'; // default 'capture'
}
// in the returned object:
//   solverType: args.solverType ?? 'capture',
//   role: args.role ?? 'capture',
```

Then implement `publish-skill.ts` (mirrors `harness-layer/src/publish.ts`):

```ts
// client/packages/harness-layer/src/publish-skill.ts
import { buildUnsignedCaptureEnvelope, sha256Hex,
  type CaptureEnvelopeAnchorInput, type CaptureEnvelopeAnchorResult, type CapturePublishedBlob,
} from '../../../src/captures/publish.js';
import type { Artifact, SignedEnvelope, UnsignedEnvelope } from '../../../src/types/envelope.js';
import { SignedEnvelopeSchema } from '../../../src/types/envelope.js';
import { canonicalJson } from '../../../src/harnesses/engine/canonical-json.js';
import { signCanonical } from '../../../src/harnesses/engine/signing.js';
import { EMPTY_BUNDLE_SHA256 } from '../../../src/trajectory/schema.js';
import { buildSkillMarkdown, SKILL_ARTIFACT_TYPE, type SkillPackage } from './skill.js';

const DONATION_ENCODING = 'jinn.artifact.donation.v1' as const;

export interface SkillPublishDeps {
  participant: { safeAddress: `0x${string}`; agentEoa: `0x${string}` };
  signer: { address: `0x${string}`; privateKey?: `0x${string}` };
  clientGitSha: string;
  publishArtifact: (i: { artifactType: string; payload: unknown }) => Promise<CapturePublishedBlob>;
  publishEnvelope: (e: SignedEnvelope) => Promise<CapturePublishedBlob>;
  anchorEnvelope: (i: CaptureEnvelopeAnchorInput) => Promise<CaptureEnvelopeAnchorResult>;
  signEnvelope?: (u: UnsignedEnvelope) => Promise<SignedEnvelope['signature']>;
  defaultArtifactEndpoint?: string;
  now?: () => Date;
}

export async function publishSkill(pkg: SkillPackage, deps: SkillPublishDeps): Promise<{ envelopeRef: string; anchorTx: `0x${string}` | null }> {
  const now = deps.now?.() ?? new Date();
  const md = buildSkillMarkdown(pkg);
  const blob = await deps.publishArtifact({ artifactType: SKILL_ARTIFACT_TYPE, payload: md });
  const sha256 = blob.sha256 ?? sha256Hex(md);
  const endpoint = blob.endpoint ?? deps.defaultArtifactEndpoint;
  if (!endpoint) throw new Error(`skill artifact ${blob.cid} has no access endpoint`);
  const artifact: Artifact = {
    artifactType: SKILL_ARTIFACT_TYPE, sha256,
    metadata: { description: `Distilled skill: ${pkg.name}` },
    access: { endpoint, priceUsdc: blob.priceUsdc ?? '0' },
    sources: [{ kind: 'ipfs', cid: blob.cid, sha256, encoding: DONATION_ENCODING }],
  };
  const unsigned = buildUnsignedCaptureEnvelope({
    capture: {
      sessionId: `skill:${pkg.name}`, capturedAt: now.toISOString(),
      originatingTool: { name: 'jinn-distiller', version: '0.1.0' },
      capturePath: 'A', status: 'pending', spanCount: 0, redactedSpanCount: 0, durationMs: 0,
    } as any, // PendingCaptureRow shape; skills carry no spans
    now, participant: deps.participant, signerAddress: deps.signer.address,
    clientGitSha: deps.clientGitSha, artifacts: [artifact], harnessBundleSha: EMPTY_BUNDLE_SHA256,
    solverType: 'distilled-skill', role: 'capture',
  });
  const signature = deps.signEnvelope ? await deps.signEnvelope(unsigned)
    : (async () => { const s = await signCanonical(unsigned, deps.signer.privateKey!, deps.signer.address);
        return { algo: 'secp256k1' as const, signer: s.signer, hash: s.hash, sig: s.sig }; })();
  const envelope = SignedEnvelopeSchema.parse({ ...unsigned, signature: await signature });
  const envBlob = await deps.publishEnvelope(envelope);
  const anchor = await deps.anchorEnvelope({
    metadataKey: `skill:${envBlob.cid}`, envelopeCid: envBlob.cid,
    envelopeHash: envelope.signature.hash as `0x${string}`, envelope,
  });
  return { envelopeRef: envBlob.cid, anchorTx: anchor.txHash ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run packages/harness-layer/test/publish-skill.test.ts && yarn vitest run test/ packages/harness-layer/test/ 2>&1 | tail -5`
Expected: the new test PASSES; the existing capture-publish tests still PASS (the builder change is additive/defaulted).

> **Contingency — the anchor key (`skill:` vs `capture:`) is not free-choice; verify against the indexer.** Anchoring under `capture:<cid>` routes the payload into `captureEnvelopeMeta` enrichment, whose parser requires a `jinn.trace-envelope.v0` artifact (spec §5). `skill:<cid>` avoids that, but you MUST confirm a `skill:`-anchored envelope is still indexed into the envelope table so `corpus.query()` returns it — read the MetadataSet handler in `packages/indexer/src/` (grep `metadataKey`/`capture:`/`envelope:` routing) BEFORE finalizing. If the indexer only indexes known prefixes, either (a) register a `skill:` prefix in the indexer (a `packages/indexer` change — size it as its own task), or (b) fall back to `capture:` and accept a benign empty-enrichment row. Task A5's round-trip test is the arbiter; do not assume — verify.

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/publish-skill.ts client/src/captures/publish.ts client/packages/harness-layer/test/publish-skill.test.ts
git commit -m "feat(harness-layer): publishSkill() — anchor jinn.skill.v1 as a corpus record (spec §5)"
```

---

### Task A4: Re-import the 84 seeds onto the layer-2 path (the #1409 fix)

**Files:**
- Modify: `client/packages/harness-layer/src/seed-import/execute.ts`
- Test: `client/packages/harness-layer/test/seed-import-layer2.test.ts`

**Interfaces:**
- Consumes: `buildLayer2ScrubPipeline` (A1) applied to the seed body; `publishSkill` (A3); `SkillPackage`/`assertConformantName` (A2); the existing `checkLicence`, `frontmatterName`, `SeedSkill`, `ImportReport`, `SeedSource` (`seed-import/`).
- Produces: `execute()` now emits `jinn.skill.v1` skill packages (not `jinn.trace-envelope.v0` traces). `ImportResult` shape unchanged (`{ imported, skipped, errors }`).

**Change:** replace `toCapturedTask()`→`capture()`→`publish()` (trace-grade) with: scrub the SKILL.md body through the **layer-2** pipeline → build a `SkillPackage` (`provenance: []` since a seed has no evidence back-links; `distilledFrom: 0`; `verifiabilityTier: 'imported'`; `license` from `checkLicence`; `seedSource` = the repo URL; `distribution: 'coding'` or a per-seed tag) → `publishSkill()`. The licence gate stays (structural, unchanged).

- [ ] **Step 1: Write the failing test**

```ts
// client/packages/harness-layer/test/seed-import-layer2.test.ts
import { describe, it, expect } from 'vitest';
import { execute } from '../src/seed-import/execute.js';

// A source with one MIT skill whose body is exactly the #1409 prose class.
const source = {
  name: 'test', list: async () => [{
    skill: 'vercel-labs/skills/brainstorming', source: 'https://github.com/vercel-labs/skills',
    licence: 'MIT', description: 'Brainstorming',
    skillMd: '---\nname: brainstorming\ndescription: Use before you start.\n---\n' +
             'Use this skill to clarify user intent and requirements before you brainstorm.\n',
  }],
};
const report = [{ skill: 'vercel-labs/skills/brainstorming', verdict: 'import', reason: 'MIT' }] as any;

function deps() {
  const published: any[] = [];
  return { published,
    participant: { safeAddress: '0x'.padEnd(42,'1') as `0x${string}`, agentEoa: '0x'.padEnd(42,'2') as `0x${string}` },
    signer: { address: '0x'.padEnd(42,'2') as `0x${string}`, privateKey: `0x${'a'.repeat(64)}` as `0x${string}` },
    clientGitSha: 'sha',
    publishArtifact: async (i: any) => { published.push(i); return { cid: 'c', sha256: 'a'.repeat(64), endpoint: 'https://e' }; },
    publishEnvelope: async () => ({ cid: 'env' }),
    anchorEnvelope: async () => ({ txHash: `0x${'e'.repeat(64)}` as `0x${string}` }),
  };
}

describe('seed import → layer-2 (#1409 fix)', () => {
  it('publishes the seed as a jinn.skill.v1 package with un-defaced prose', async () => {
    const d = deps();
    const res = await execute(report, source as any, d as any);
    expect(res.imported).toHaveLength(1);
    const skillUpload = d.published.find((p) => p.artifactType === 'jinn.skill.v1');
    expect(skillUpload).toBeTruthy();
    // the #1409 acceptance criterion: ordinary words are not placeholder-substituted
    expect(String(skillUpload.payload)).toContain('clarify user intent and requirements before you brainstorm');
    expect(String(skillUpload.payload)).not.toMatch(/\[[A-Z]+_\d+\]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run packages/harness-layer/test/seed-import-layer2.test.ts`
Expected: FAIL — `execute` still emits a `jinn.trace-envelope.v0` artifact (no `jinn.skill.v1` upload).

- [ ] **Step 3: Implement the change** in `execute.ts`

Replace `toCapturedTask` + the `capture()`/`publish()` calls in the loop body with a layer-2 skill build + `publishSkill()`. Sketch of the new loop body (keep the licence gate and error handling exactly as-is):

```ts
import { buildLayer2ScrubPipeline } from '../../../../src/trajectory/scrub/layer2.js';
import { publishSkill } from '../publish-skill.js';
import { assertConformantName, type SkillPackage } from '../skill.js';
// ...
const layer2 = buildLayer2ScrubPipeline();
// inside the try, after the licence check:
const scrubbed = await layer2.run({ 'skill.md': skill.skillMd });
const body = String(scrubbed.attributes['skill.md']);
const name = (frontmatterName(skill.skillMd) ?? skill.skill.split('/').pop()!)
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
assertConformantName(name);
const pkg: SkillPackage = {
  name, description: skill.description ?? name.replace(/-/g, ' '),
  license: skill.licence,
  jinn: { schema: 'jinn.skill.v1', distribution: 'coding', verifiabilityTier: 'imported',
          distilledFrom: 0, provenance: [], seedSource: skill.source },
  body,
};
const published = await publishSkill(pkg, deps);
result.imported.push({ skill: row.skill, envelopeRef: published.envelopeRef, anchorTx: published.anchorTx });
```

> Note: `verifiabilityTier: 'imported'` in the skill provenance marks seeds as non-earned (mirrors the retired `provenance: 'imported'`); the promotion gate (Plan B) never distils from these — they are already layer-2. Delete `toCapturedTask` and its now-unused imports (`capture`, `publish`). Match the file's existing error-handling structure.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run packages/harness-layer/test/seed-import-layer2.test.ts`
Expected: PASS. Also run the existing seed-import tests: `yarn vitest run packages/harness-layer/test/` — update any that asserted the old `jinn.trace-envelope.v0` seed shape (they now assert `jinn.skill.v1`); this is expected and part of the fix.

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/seed-import/execute.ts client/packages/harness-layer/test/seed-import-layer2.test.ts
git commit -m "fix(scrub): re-import seeds as jinn.skill.v1 at layer-2 altitude (#1409)"
```

---

### Task A5: Surface `jinn.skill.v1` on the consume path + round-trip proof

**Files:**
- Modify: `client/packages/harness-layer/src/consume.ts`
- Test: `client/packages/harness-layer/test/consume-skill.test.ts`

**Interfaces:**
- Consumes: the existing `search()`/`get()` in `consume.ts`; `SKILL_ARTIFACT_TYPE` (A2).
- Produces: `CorpusSearchHit` gains `kind: 'skill' | 'trace'` (derived: `artifactTypes.includes(SKILL_ARTIFACT_TYPE) ? 'skill' : 'trace'`); `search(query, { limit?, kind?: 'skill' })` filters to skills when `kind: 'skill'`.

- [ ] **Step 1: Write the failing test** — an in-memory round-trip: publish a skill via a fake corpus, then `search({kind:'skill'})` finds it and `get()` returns the SKILL.md.

```ts
// client/packages/harness-layer/test/consume-skill.test.ts
import { describe, it, expect } from 'vitest';
import { createHarnessLayer } from '../src/consume.js';
import { SKILL_ARTIFACT_TYPE } from '../src/skill.js';

// Inject a fake DiscoveryAPI returning one skill ref + a fake corpus manifest/get.
// (Mirror the injection pattern in the existing consume tests — discovery + store overrides.)
describe('consume surfaces jinn.skill.v1', () => {
  it('search({kind:"skill"}) returns skills and tags the hit kind', async () => {
    const layer = createHarnessLayer({ /* inject discovery + fetchFromIpfs returning a skill envelope */ } as any);
    const hits = await layer.corpus.search('', { /* kind: 'skill' */ } as any);
    const skillHit = hits.find((h) => h.artifactTypes.includes(SKILL_ARTIFACT_TYPE));
    expect(skillHit).toBeTruthy();
    expect((skillHit as any).kind).toBe('skill');
  });
});
```

> The exact fake wiring mirrors the existing `consume.ts` tests in `client/packages/harness-layer/test/` — read one first and copy its discovery/store injection. Do not invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run packages/harness-layer/test/consume-skill.test.ts`
Expected: FAIL — `kind` is undefined / no `kind` filter.

- [ ] **Step 3: Implement** — add `kind` to `CorpusSearchHit` and `toSearchHit` (derive from `artifactTypes`), and a `kind?: 'skill'` option to `search` that filters hits.

```ts
// in CorpusSearchHit: kind: 'skill' | 'trace';
// in toSearchHit(...): kind: envelope.artifacts.some(a => a.artifactType === SKILL_ARTIFACT_TYPE) ? 'skill' : 'trace',
// in search(query, opts): after building hits, if (opts.kind === 'skill') return hits.filter(h => h.kind === 'skill');
```

- [ ] **Step 4: Run test + the real live round-trip proof**

Run (unit): `cd client && yarn vitest run packages/harness-layer/test/consume-skill.test.ts` → PASS.

Run (integration proof — settles the A3 anchor-key contingency against a real indexer): after A1–A4 are merged and a seed re-import has run against a throwaway/testnet corpus, verify `jinn-layer corpus search --kind skill` returns a seed and `corpus get <ref>` returns clean SKILL.md prose. Capture the output as the #1409 acceptance evidence (spec §2.2, issue #1409 acceptance criteria).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/consume.ts client/packages/harness-layer/test/consume-skill.test.ts
git commit -m "feat(harness-layer): surface jinn.skill.v1 skills on the consume path (spec §5, §9)"
```

---

## Plans B & C (subsequent — specified at interface level)

These are **not** full TDD tasks yet: Plan B needs the `cap-v0` slate contract shape from PR #1416 to finalize the exclusion interface, and Plan C is **gated** (see below). Write each as its own `docs/superpowers/plans/` document at pick-up, following this same structure.

> **v0.3 amendment (SkillRL / failure→lessons):** the spec was amended to v0.3 after this plan was written. Plan B/C below predate it and are **updated at Phase-2 pick-up** to match: the bridge (B2/B3) sources **both passes and evaluator-confirmed failures**; the gate (B4) is **tiered** (pattern-eligible + lesson-eligible); the distiller (C1/C2) produces **success→patterns AND failure→lessons** (`skillKind`); and **retrieval-over-evidence ships as the v1 product baseline** (the raw-evidence arm), with the distiller the bet that must beat it (spec §2.4, §6, §7, §8, §11.1, D10/D11).

### Plan B — Bridge + promotion gate (buildable now with an injected held-out set)

- **B1 — Held-out exclusion adapter.** `excludeHeldOutSlate(instanceId, repo): boolean` backed by an injected slate (`{ instanceIds: string[]; repos: string[] }`). Real `cap-v0` slate wired when #1416 publishes it (spec §12). Test: excludes by instance_id AND repo.
- **B2 — Execution-ledger reader.** Query `verdictEnvelopeMeta` where `actualPassed === true` + `enrichmentStatus === 'ok'` + `solverType startsWith 'swe-rebench-v2'` via the DiscoveryAPI (`client/src/discovery/http.ts` — reuse `getInstanceSuccessCounts`-shape queries); **per-instance dedup** (supply is skewed, sympy-27510≈46/390, spec §8). Produces `VerifiedAttempt[]` = `{ requestId, chainId, instanceId, repo, manifestCid, model }`.
- **B3 — Bridge to layer-1 evidence.** For each non-excluded `VerifiedAttempt`: fetch the attempt manifest + solution patch (+ donated `jinn.trajectory.v1` where `donation.enabled` — richer than the coarse `(task,patch,verdict)`, spec §8 research note), build a `CapturedTask`, scrub at **layer-2 altitude** (A1 — public-repo work), publish. Sets `environment.harness.name: 'jinn-execution-ledger-bridge'`, `provenance: 'contributed'`, `verifiabilityTier: 'evaluator-verified'`. Verdict truth = `actualPassed`, **not** `verdictCode` (spec §8). Emits bridged evidence **flagged emissions-ineligible** (spec §8).
- **B4 — Promotion gate + redaction-health guard.** `isEligible(evidence): {ok: boolean; reason?}` — evaluator-verified + contributed + not-held-out + redaction-health. Guard measures **intra-value placeholder density** (not key-count) and detects the **union** of all stage placeholder shapes, driven off `redactedKeys`/`truncatedKeys` (spec §6). Distinct-instance clustering key.

### Plan C — Distiller + three-arm measurement (GATED)

> **Gate — do not start Plan C until BOTH hold:**
> 1. The capability-eval rig (PR #1416) has landed: `client/src/eval/paired.ts`, `wilson.ts`, the `cap-v0` slate + `excludeHeldOutSlate`/`assertNoOverlap`, the swe-rebench-v2 grader are available.
> 2. The **seeds-vs-raw-evidence pilot** (run with Plan B's bridged corpus + the rig) shows raw-evidence retrieval is worth distilling from. If raw-evidence does **not** beat seeds, distillation is very unlikely to (it is a lossy compression of the same evidence) — surface that and re-scope to retrieval-over-evidence per spec §11/D9 before building the distiller.

- **C1 — `jinn-skill-distill-prompt-v1`** + published SHA-256 (mirror `SESSION_DERIVED_DISTILL_PROMPT_V1`), targeting a SKILL.md consumable (spec §7).
- **C2 — `yarn distill`** script: select (gate) → distinct-instance cluster → distil → **full-secret-net output scrub** (A1 pipeline over the distilled body + drop-if-unexplained high-entropy tokens) → **publish-time lexical contamination scan** against the slate → `publishSkill()` with provenance back-links (spec §7).
- **C3 — Three-arm measurement:** pre-installed corpus snapshots {seeds-only, seeds+distilled, seeds+raw-evidence}; the `cap-v0` slate run; **resolve-rate superiority (distilled>seeds) primary, cost as guard** (confirm the inverted IUT with the eval session); report **distilled−raw-evidence** as the Bitter-Lesson result; **pilot power calc** first, Sonnet-class replication load-bearing (spec §11).
- **C4 — Confirm-back:** verify no distilled skill's `metadata.jinn.provenance` traces to a `cap-v0` repo; report to the eval session (spec §12).

---

## Self-Review (Plan A vs spec)

- **Spec coverage (Plan A):** §5 format → A2; publishSkill + role/anchor corrections → A3; §10 layer-2 scrub → A1; §10 seed migration / #1409 fix → A4; §9 consume filter → A5. §6/§8 (gate/bridge) → Plan B; §7/§11 (distiller/measurement) → Plan C (gated). All spec sections map to a task or a named subsequent plan.
- **Placeholder scan:** the two "mirror the existing test wiring" notes (A5) and "read the indexer handler" (A3) are deliberate — they point at an exact existing file to copy/verify rather than fabricate an interface I have not read; every code step that can be concrete, is.
- **Type consistency:** `SkillPackage`/`SkillProvenance`/`SKILL_ARTIFACT_TYPE` (A2) are consumed unchanged by A3/A4/A5; `buildLayer2ScrubPipeline` (A1) by A3(seed)/A4; `publishSkill` signature (A3) by A4. `role: 'capture'` + `solverType: 'distilled-skill'` used consistently.
- **Known contingencies surfaced, not hidden:** (1) secretlint Pass-2 may mangle real seed prose → A1 Step 4 escalation; (2) the `skill:` anchor key must be verified against the indexer → A3 Step 4 + A5 integration proof.

## Live-check results (2026-07-06 — both contingencies resolved)

- **(A) secretlint Pass-2 on real seed bodies — CLEAN.** Fetched the real `obra/superpowers` SKILL.md bodies (`brainstorming` — the exact seed #1409 named — plus `test-driven-development`, `systematic-debugging`) and ran them through `buildLayer2ScrubPipeline`: **byte-for-byte identical**, zero `[SECRET:…]`/`[TYPE_n]`/`[PII:…]` placeholder tokens, and the reported words (`use`, `before`, `user intent`) survive. Pass-2 does not fire on this prose. (Checked 3 of 68 seed-list entries incl. the #1409-named one; not exhaustive across all 68, but the acceptance seed passes.)
- **(B) `skill:` discoverability — WAS A REAL BUG, now fixed.** Code-read confirmed `parseEnvelopeKey` (`packages/indexer/src/types.ts`) rejected any prefix outside `envelope/evaluation/capture`, so a `skill:<cid>` anchor was never upserted into the `Envelope` table → skills invisible to `corpus.query()`/`search()`. Fixed by registering `skill` as a fourth envelope kind (indexed, no enrichment). Verified: new `parseEnvelopeKey` test + 100 handler tests + indexer `tsc` green. Full on-chain round-trip remains the final integration proof but the indexing path is code-verified.
