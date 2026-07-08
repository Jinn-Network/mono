# Stage-2 Cross-Instance Meta-Distill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an additive, opt-in second distillation pass (stage-2) that reads stage-1's in-memory published skills, groups them by polarity, and distils the rule corroborated across ≥2 distinct instances into a `skillKind: 'cross-instance'` skill — reusing stage-1's scrub → contamination → structural-gate → publish path unchanged.

**Architecture:** Stage-2 runs AFTER stage-1 inside `runDistillationPipeline`, gated on `deps.meta`. It reads only stage-1's `DistillResult.published` (joined to the originating `DistillCluster` for provenance) — no corpus round-trip. A new meta-prompt asks for the recurring rule across a same-polarity batch; the emitted skill's provenance is the UNION of the supporting sources' layer-1 evidence CIDs (so `distilledFrom > 1`). The per-cluster loop body of `distillClusters` (scrub → contamination scan → structural gate → package build → publish) is extracted into a shared `finalizeSkill()` helper called by BOTH `distillClusters` and the new `metaDistill`, which guarantees stage-2 passes the identical gate by construction.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod (v4 in `skill-package.ts`, `zod/v3` in `skill-artifact.ts`), Vitest. Package `@jinn-network/harness-layer` at `client/packages/harness-layer/`. Tests run from `client/` via the root vitest config (`packages/*/test/**/*.test.ts`).

## Global Constraints

- **Additive / opt-in only.** Stage-1 behavior must be byte-identical when `meta` is off (AC5). No change to the frozen layer-1 envelope, the promotion gate, or `distillClusters`' existing gate order/output.
- **Stacked branch.** Work is on `feat/1463-cross-instance-meta-distill`, stacked on `#1461` (`claude/distill-quality-distiller`), NOT `next`. Do not rebase onto `next`.
- **`skillKind: 'cross-instance'` is added additively at exactly THREE enum sites** and nowhere else: `distill.ts` `SkillKind` (line 72), `skill-package.ts` `SkillPackageMetaSchema.skillKind` (line 48), `skill-artifact.ts` `SkillProvenanceSchema.skillKind` (line 87). It is a `z.enum` parsed at consume time (`extractSkill`), so ALL three must be widened or meta-skills reject downstream.
- **Identical gate by construction.** Stage-2 MUST reuse the same scrub pipeline, `lexicalContaminationScan`, and `structuralRejection` as stage-1 via the shared `finalizeSkill()` helper. Do not fork the gate.
- **Provenance invariant.** `metadata.jinn.distilledFrom === provenance.length` (enforced by `SkillPackageMetaSchema.refine`). For meta-skills, `provenance = union(supporting evidenceRefs)` (deduped) and `distilledFrom = provenance.length`.
- **No recursion.** Stage-2 consumes ONLY the three stage-1 kinds (`strategic-pattern`, `failure-lesson`, `contrastive`). It never groups a `cross-instance` skill (no meta-of-meta).
- **Prompt auditability.** The new meta-prompt publishes its own SHA-256 (`JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256`), asserted against the exact prompt text in a test, mirroring the v1 prompt convention.
- **Distiller model** default stays `claude-opus-4-8` (§5). Distribution default `coding`. Verifiability tier `evaluator-verified`.
- **Verification commands** (run from `client/`): `yarn typecheck:harness-layer`, targeted `yarn vitest run packages/harness-layer/test`, full `yarn test`, `yarn build`.
- **SDK prerequisite for targeted runs.** `yarn test` runs `yarn build:sdk` first; the standalone `yarn vitest run …` used in per-task steps does not. If a targeted run fails to resolve `@jinn-network/sdk` (some `client/src` imports pull it in transitively, reached from `pipeline.test.ts` / `cli.test.ts` / `skill.test.ts`), run `yarn build:sdk` once, then re-run the targeted command.

---

## File Structure

**Modified source:**
- `client/src/types/skill-artifact.ts` — widen `SkillProvenanceSchema.skillKind` enum (line 87).
- `client/packages/harness-layer/src/skill-package.ts` — widen `SkillPackageMetaSchema.skillKind` enum (line 48).
- `client/packages/harness-layer/src/distill.ts` — widen `SkillKind` (line 72); add `pkg` to `DistillResult.published`; extract `finalizeSkill()`; add `metaDistill()` + its types.
- `client/packages/harness-layer/src/distill-prompt.ts` — add `JINN_SKILL_META_DISTILL_PROMPT_V1` + `_SHA256`.
- `client/packages/harness-layer/src/cluster.ts` — add `buildMetaClusters()` + `MetaCluster`/`MetaSource`/`Stage1PublishedSkill` types.
- `client/packages/harness-layer/src/distill-llm.ts` — add `buildMetaDistillInput()` + `createClaudeMetaDistiller()` + meta output validation.
- `client/packages/harness-layer/src/pipeline.ts` — add `meta`/`metaDistill` to `PipelineDeps`, `metaDistilled` to `PipelineResult`, and the stage-1→stage-2 join.
- `client/packages/harness-layer/src/cli.ts` — add `--meta` flag, default meta port, and meta output rendering.

**Modified tests:**
- `client/packages/harness-layer/test/skill-package.test.ts`
- `client/packages/harness-layer/test/skill.test.ts`
- `client/packages/harness-layer/test/distill.test.ts`
- `client/packages/harness-layer/test/cluster.test.ts`
- `client/packages/harness-layer/test/distill-llm.test.ts`
- `client/packages/harness-layer/test/pipeline.test.ts`
- `client/packages/harness-layer/test/cli.test.ts`

**Modified docs:**
- `spec/2026-07-06-distillation-v1.md` — §7 note + §13 non-goal removal.

`index.ts` is intentionally UNTOUCHED — `clusterEvidence`, `runDistillationPipeline`, and `buildMetaClusters` are not exported from the package barrel (matching the existing pattern); tests and internal callers import from the concrete modules.

---

## Key Interfaces (defined across tasks — reference)

```typescript
// distill.ts
export type SkillKind =
  | 'strategic-pattern' | 'failure-lesson' | 'contrastive' | 'cross-instance';

export interface DistillResult {
  published: Array<{ clusterId: string; skillKind: SkillKind; envelopeRef: string; pkg: SkillPackage }>;
  rejected: Array<{ clusterId: string; reason: string }>;
  errors: Array<{ clusterId: string; error: string }>;
}

export interface MetaDistillLLMOutput extends DistillLLMOutput { supports: string[]; }

export interface MetaDistillDeps {
  metaDistill: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
  publishSkill: (pkg: SkillPackage) => Promise<{ envelopeRef: string; anchorTx: string | null }>;
  slate: { instanceIds: Set<string>; repos?: Set<string> };
  distribution?: string;
  distillModel?: string;
  scrubPipeline?: ScrubPipeline;
  now?: () => Date;
}

export interface MetaDistillResult {
  published: Array<{ metaClusterId: string; skillKind: 'cross-instance'; envelopeRef: string; pkg: SkillPackage }>;
  rejected: Array<{ metaClusterId: string; reason: string }>;
  errors: Array<{ metaClusterId: string; error: string }>;
}

export async function metaDistill(clusters: MetaCluster[], deps: MetaDistillDeps): Promise<MetaDistillResult>;

// cluster.ts
export interface Stage1PublishedSkill {
  clusterId: string;
  skillKind: SkillKind;          // stage-1 polarity
  pkg: SkillPackage;
  evidenceRefs: string[];
  instanceIds: string[];
}
export interface MetaSource {
  id: string;                    // 's1', 's2', …
  name: string; description: string; body: string;
  evidenceRefs: string[]; instanceIds: string[];
}
export interface MetaCluster {
  metaClusterId: string;         // e.g. 'cross-instance:failure-lesson'
  polarity: SkillKind;
  gateTier: 'pattern' | 'lesson' | 'contrastive';
  sources: MetaSource[];
}
export function buildMetaClusters(published: Stage1PublishedSkill[]): MetaCluster[];

// pipeline.ts
// PipelineDeps gains:  meta?: boolean;  metaDistill?: (c: MetaCluster) => Promise<MetaDistillLLMOutput>;
// PipelineResult gains: metaDistilled?: MetaDistillResult;
```

---

### Task 1: Widen the `skillKind` enum to include `'cross-instance'`

**Files:**
- Modify: `client/src/types/skill-artifact.ts:87`
- Modify: `client/packages/harness-layer/src/skill-package.ts:48`
- Modify: `client/packages/harness-layer/src/distill.ts:72`
- Test: `client/packages/harness-layer/test/skill-package.test.ts`
- Test: `client/packages/harness-layer/test/skill.test.ts`

**Interfaces:**
- Produces: `SkillKind` widened to the 4-value union; both Zod enums accept `'cross-instance'`.

- [ ] **Step 1: Write the failing test (skill-package accepts the new kind)**

Add to `test/skill-package.test.ts` inside `describe('jinn.skill.v1 package builder (skill-package.ts)')`:

```typescript
  it('accepts the additive cross-instance skillKind on the meta block', () => {
    const withKind: SkillPackage = { ...pkg, jinn: { ...pkg.jinn, skillKind: 'cross-instance' } };
    expect(parseSkillMarkdown(buildSkillMarkdown(withKind)).jinn.skillKind).toBe('cross-instance');
  });
```

- [ ] **Step 2: Write the failing test (extractSkill round-trips a cross-instance provenance)**

Add to `test/skill.test.ts` inside `describe('extractSkill()')`:

```typescript
  it('round-trips a jinn.skill.v1 artifact carrying skillKind cross-instance (enum widened downstream)', async () => {
    const input = skillArtifact({
      provenance: {
        kind: 'distilled',
        sourceEnvelopeCids: ['bafySrc1', 'bafySrc2'],
        operator: { safeAddress: TEST_SAFE },
        solverType: 'skill-distiller.v0',
        skillKind: 'cross-instance',
      },
    });
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(capturedTask()), deps, { skill: input });
    if (result.vetoed) throw new Error('unexpected veto');
    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    const extracted = extractSkill(record);
    expect(extracted!.shape).toBe('jinn.skill.v1');
    expect(extracted!.skill.provenance.skillKind).toBe('cross-instance');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd client && yarn vitest run packages/harness-layer/test/skill-package.test.ts packages/harness-layer/test/skill.test.ts`
Expected: FAIL — both new tests throw a Zod enum error (`Invalid enum value … 'cross-instance'`).

- [ ] **Step 4: Widen the three enums**

In `client/src/types/skill-artifact.ts` line 87:

```typescript
  skillKind: z.enum(['strategic-pattern', 'failure-lesson', 'contrastive', 'cross-instance']).optional(),
```

In `client/packages/harness-layer/src/skill-package.ts` line 48:

```typescript
    skillKind: z.enum(['strategic-pattern', 'failure-lesson', 'contrastive', 'cross-instance']).optional(),
```

In `client/packages/harness-layer/src/distill.ts` line 72:

```typescript
export type SkillKind = 'strategic-pattern' | 'failure-lesson' | 'contrastive' | 'cross-instance';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd client && yarn vitest run packages/harness-layer/test/skill-package.test.ts packages/harness-layer/test/skill.test.ts`
Expected: PASS — all tests in both files green (the two new + the existing `skillKind: 'failure-lesson'` test).

- [ ] **Step 6: Commit**

```bash
git add client/src/types/skill-artifact.ts client/packages/harness-layer/src/skill-package.ts client/packages/harness-layer/src/distill.ts client/packages/harness-layer/test/skill-package.test.ts client/packages/harness-layer/test/skill.test.ts
git commit -m "feat(harness-layer): widen skillKind enum with cross-instance (three sites)"
```

---

### Task 2: Add the `jinn-skill-meta-distill-prompt-v1` prompt + published SHA

**Files:**
- Modify: `client/packages/harness-layer/src/distill-prompt.ts`
- Test: `client/packages/harness-layer/test/distill.test.ts`

**Interfaces:**
- Produces: `JINN_SKILL_META_DISTILL_PROMPT_V1: string`, `JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256: string`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `test/distill.test.ts` (import the two new symbols at the top from `../src/distill-prompt.js`):

```typescript
import {
  JINN_SKILL_DISTILL_PROMPT_V1,
  JINN_SKILL_DISTILL_PROMPT_V1_SHA256,
  JINN_SKILL_META_DISTILL_PROMPT_V1,
  JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256,
} from '../src/distill-prompt.js';

describe('jinn-skill-meta-distill-prompt-v1', () => {
  it('publishes the SHA-256 of the exact meta prompt (auditability, D4)', () => {
    const actual = createHash('sha256').update(JINN_SKILL_META_DISTILL_PROMPT_V1).digest('hex');
    expect(actual).toBe(JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256);
  });
  it('is cross-instance mode with a polarity hint and the diagnosis-only rule', () => {
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/cross-instance/i);
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/POLARITY/);
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/two distinct instances|≥\s*2|at least two/i);
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/supports/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill.test.ts -t "meta-distill-prompt"`
Expected: FAIL — `JINN_SKILL_META_DISTILL_PROMPT_V1` is not exported.

- [ ] **Step 3: Add the prompt + placeholder SHA**

Append to `client/packages/harness-layer/src/distill-prompt.ts`:

```typescript
/**
 * `jinn-skill-meta-distill-prompt-v1` — the stage-2 cross-instance meta-distill
 * prompt (issue #1463). Input is a BATCH of stage-1 skills that already share a
 * polarity (all strategic-pattern, all failure-lesson, or all contrastive),
 * each labelled with an opaque source id (s1, s2, …). The task is to find the
 * ONE rule that recurs across the batch and is corroborated by AT LEAST TWO
 * DISTINCT instances, and to name which sources corroborate it.
 *
 * Like the v1 distill prompt, this is a foundation reference, not protocol
 * canon; its SHA-256 is published on every meta-distilled skill
 * (`metadata.jinn.distillPromptSha256`).
 */
export const JINN_SKILL_META_DISTILL_PROMPT_V1 = `You distil a BATCH of already-distilled Agent-Skills into ONE higher-order cross-instance Agent-Skill (a SKILL.md package).

Input: a batch of skills, each labelled with an opaque source id (s1, s2, …). Every skill in the batch shares a POLARITY (given below), and each came from a DIFFERENT coding sub-problem instance.

MODE = cross-instance:
- Find the ONE recurring rule that generalises across the batch — the pattern, lesson, or delta that shows up in two or more of the sources for DIFFERENT instances. A rule that appears in only a single source is NOT cross-instance evidence and must not be emitted.
- Corroboration is the signal: emit a skill only for a rule that at least two DISTINCT sources support. List those source ids in "supports".

POLARITY = strategic-pattern: the sources are recurring success strategies — extract the shared generalizable behavior.
POLARITY = failure-lesson: the sources are recurring failure diagnoses. State the shared DIAGNOSIS ("this class of approach fails because …"). Do NOT prescribe a fix as fact — no imperative "instead, do X" or "the correct fix is X"; a hypothesis MUST be marked as one ("likely …", "consider …"). A verified counterfactual is only available in contrastive polarity.
POLARITY = contrastive: the sources are recurring pass↔fail deltas — extract the shared causal decision that separates success from failure; here the counterfactual IS verified, so you MAY state it as fact.

Every skill:
- Produce a name (lowercase-hyphen), a description, a markdown body, and a "supports" list of the source ids that corroborate the rule.
- The description is the retrieval surface and MUST carry BOTH a trigger and an anti-trigger: "Use when … Not for: …".
- The body MUST use EXACTLY these five sections, each non-empty, in this order:
  ## When to use
  ## Strategy
  ## Steps
  ## Pitfalls
  ## Verify
- Generalize: name the transferable rule, not any single instance. Do NOT copy verbatim diff hunks, file paths, symbol names, instance ids, or PR numbers — those are contamination and are rejected downstream.
- Never include secrets, keys, tokens, or credentials. Use placeholder paths (/path/to/project) and invented example identifiers; never real home directories, emails, or machine-specific paths — the output scrub drops the whole skill (fail-closed) on any redaction.
- Be concise. A cross-instance skill that merely concatenates its sources has not earned its place.`;

// sha256(JINN_SKILL_META_DISTILL_PROMPT_V1), verified in distill.test.ts.
export const JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256 =
  '0000000000000000000000000000000000000000000000000000000000000000';
```

- [ ] **Step 4: Compute the real SHA and paste it in**

Run (from `client/packages/harness-layer/`):

```bash
node --input-type=module -e "import { JINN_SKILL_META_DISTILL_PROMPT_V1 } from './src/distill-prompt.ts'; import { createHash } from 'node:crypto'; console.log(createHash('sha256').update(JINN_SKILL_META_DISTILL_PROMPT_V1).digest('hex'));"
```

If Node cannot import the `.ts` directly, use the equivalent tsx invocation or copy the string into a scratch `.mjs`. Replace the 64-zero placeholder in `JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256` with the printed hex.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill.test.ts -t "meta-distill-prompt"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/packages/harness-layer/src/distill-prompt.ts client/packages/harness-layer/test/distill.test.ts
git commit -m "feat(harness-layer): add jinn-skill-meta-distill-prompt-v1 + published SHA"
```

---

### Task 3: Extract `finalizeSkill()` from the `distillClusters` loop (refactor, no behavior change) + carry `pkg` on published entries

**Files:**
- Modify: `client/packages/harness-layer/src/distill.ts:200-283`
- Test: `client/packages/harness-layer/test/distill.test.ts` (add one assertion; existing tests are the regression net)

**Interfaces:**
- Produces (module-private): `finalizeSkill(out, spec, deps)`.
- Produces (public): `DistillResult.published[i].pkg: SkillPackage` (additive).
- Consumes: `SkillKind` (Task 1), `JINN_SKILL_DISTILL_PROMPT_V1_SHA256`.

- [ ] **Step 1: Write the failing test (published entries now carry the built package)**

Add to `test/distill.test.ts` inside `describe('distillClusters …')`:

```typescript
  it('carries the built SkillPackage on each published entry (stage-2 join surface)', async () => {
    const d = deps(cleanOut);
    const res = await distillClusters([cluster({ tier: 'pattern' })], d);
    expect(res.published[0]!.pkg).toBeDefined();
    expect(res.published[0]!.pkg.name).toBe('orm-queryset-dedup');
    expect(res.published[0]!.pkg.jinn.skillKind).toBe('strategic-pattern');
    // identical to the object handed to publishSkill
    expect(res.published[0]!.pkg).toEqual(d.published[0]!);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill.test.ts -t "carries the built SkillPackage"`
Expected: FAIL — `res.published[0].pkg` is `undefined`.

- [ ] **Step 3: Extract `finalizeSkill` and rewire `distillClusters`**

In `client/packages/harness-layer/src/distill.ts`, replace the whole `distillClusters` function (currently lines ~200-283, from `const SKILL_KIND_BY_TIER` through the closing brace) with:

```typescript
const SKILL_KIND_BY_TIER: Record<DistillCluster['tier'], SkillKind> = {
  pattern: 'strategic-pattern',
  lesson: 'failure-lesson',
  contrastive: 'contrastive',
};

/** The gate/skill parameters `finalizeSkill` needs — the only per-cluster axes that vary. */
interface FinalizeSpec {
  /** Drives the structural gate (incl. the lesson imperative-counterfactual guard). */
  tier: DistillCluster['tier'];
  /** Provenance back-links → `metadata.jinn.provenance`; its length is `distilledFrom`. */
  evidenceRefs: string[];
  /** The distiller input, for the honest `evidenceTokens` estimate. */
  input: unknown;
  /** The published `metadata.jinn.skillKind`. */
  skillKind: SkillKind;
  /** SHA of the prompt that produced `out` → `metadata.jinn.distillPromptSha256`. */
  promptSha: string;
}

/** Resolved (not lazy) deps shared by both distill stages. */
interface FinalizeDeps {
  pipeline: ScrubPipeline;
  distribution: string;
  now: Date;
  slate: { instanceIds: Set<string>; repos?: Set<string> };
  distillModel?: string;
  publishSkill: (pkg: SkillPackage) => Promise<{ envelopeRef: string; anchorTx: string | null }>;
}

type FinalizeResult =
  | { ok: true; pkg: SkillPackage; envelopeRef: string }
  | { ok: false; reason: string };

/**
 * The shared per-skill finish: fail-closed output scrub (2) → contamination scan
 * (3) → structural gate (4) → name check → package build → publish (5). Returns a
 * deterministic rejection reason, or the published package. `publishSkill`
 * failures throw (the caller records them as errors). Called by BOTH
 * `distillClusters` and `metaDistill` so stage-2 passes the identical gate.
 */
async function finalizeSkill(
  out: DistillLLMOutput,
  spec: FinalizeSpec,
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  // (2) fail-closed output secret scrub.
  const scrubbed = await deps.pipeline.run({ 'skill.md': out.body });
  if (scrubbed.redactions.length > 0 || String(scrubbed.attributes['skill.md']) !== out.body) {
    const hits = [...new Set(scrubbed.redactions.map((r) => `${r.stage}/${r.detail ?? r.kind}`))];
    const detail = hits.length > 0 ? hits.join(', ') : 'body altered by scrub';
    return { ok: false, reason: `secret-in-output (dropped, fail-closed): ${detail}` };
  }

  // (3) contamination scan against the held-out slate.
  const scan = lexicalContaminationScan(out.body, deps.slate);
  if (scan.contaminated) return { ok: false, reason: `contamination: ${scan.hits.join(', ')}` };

  // (4) deterministic structural conformance gate.
  const structuralReason = structuralRejection(out, spec.tier);
  if (structuralReason) return { ok: false, reason: structuralReason };

  const name = sanitizeName(out.name);
  if (!name) return { ok: false, reason: `non-conformant skill name from distiller: ${JSON.stringify(out.name)}` };
  assertConformantName(name);

  const pkg: SkillPackage = {
    name,
    description: out.description,
    license: null,
    jinn: {
      schema: 'jinn.skill.v1',
      distribution: deps.distribution,
      verifiabilityTier: 'evaluator-verified',
      distilledFrom: spec.evidenceRefs.length,
      provenance: spec.evidenceRefs,
      distillPromptSha256: spec.promptSha,
      distilledAt: deps.now.toISOString(),
      skillKind: spec.skillKind,
      ...(deps.distillModel ? { distillModel: deps.distillModel } : {}),
      evidenceTokens: estimateTokens(JSON.stringify(spec.input ?? '')),
      skillTokens: estimateTokens(out.body),
    },
    body: out.body,
  };
  const pub = await deps.publishSkill(pkg);
  return { ok: true, pkg, envelopeRef: pub.envelopeRef };
}

export async function distillClusters(
  clusters: DistillCluster[],
  deps: DistillDeps,
): Promise<DistillResult> {
  const finalizeDeps: FinalizeDeps = {
    pipeline: deps.scrubPipeline ?? buildLayer2ScrubPipeline(),
    distribution: deps.distribution ?? 'coding',
    now: deps.now?.() ?? new Date(),
    slate: deps.slate,
    ...(deps.distillModel ? { distillModel: deps.distillModel } : {}),
    publishSkill: deps.publishSkill,
  };
  const result: DistillResult = { published: [], rejected: [], errors: [] };

  for (const cluster of clusters) {
    try {
      const out = await deps.distill(cluster);
      const skillKind = SKILL_KIND_BY_TIER[cluster.tier];
      const fin = await finalizeSkill(
        out,
        {
          tier: cluster.tier,
          evidenceRefs: cluster.evidenceRefs,
          input: cluster.input,
          skillKind,
          promptSha: JINN_SKILL_DISTILL_PROMPT_V1_SHA256,
        },
        finalizeDeps,
      );
      if (fin.ok) {
        result.published.push({ clusterId: cluster.clusterId, skillKind, envelopeRef: fin.envelopeRef, pkg: fin.pkg });
      } else {
        result.rejected.push({ clusterId: cluster.clusterId, reason: fin.reason });
      }
    } catch (err) {
      result.errors.push({ clusterId: cluster.clusterId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
```

Then update the `DistillResult` interface (line 74) to add the `pkg` field:

```typescript
export interface DistillResult {
  published: Array<{ clusterId: string; skillKind: SkillKind; envelopeRef: string; pkg: SkillPackage }>;
  rejected: Array<{ clusterId: string; reason: string }>;
  errors: Array<{ clusterId: string; error: string }>;
}
```

Note: `estimateTokens`, `sanitizeName`, `assertConformantName`, `lexicalContaminationScan`, `structuralRejection`, `buildLayer2ScrubPipeline`, `ScrubPipeline`, and `JINN_SKILL_DISTILL_PROMPT_V1_SHA256` are all already imported/defined in this module — reuse them, do not redefine.

- [ ] **Step 4: Run the distill + pipeline + cli tests to verify the refactor is green**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill.test.ts packages/harness-layer/test/pipeline.test.ts packages/harness-layer/test/cli.test.ts`
Expected: PASS — all existing `distillClusters` tests (secret drop, contamination, structural, name, contrastive, auditability, counterfactual) plus the new `pkg` test, and the pipeline/cli tests that read `distilled.published`, are green. This proves the extraction preserved the exact gate order and outputs.

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/distill.ts client/packages/harness-layer/test/distill.test.ts
git commit -m "refactor(harness-layer): extract finalizeSkill; carry pkg on DistillResult.published"
```

---

### Task 4: `buildMetaClusters()` — group stage-1 skills into polarity meta-clusters

**Files:**
- Modify: `client/packages/harness-layer/src/cluster.ts`
- Test: `client/packages/harness-layer/test/cluster.test.ts`

**Interfaces:**
- Consumes: `SkillKind` and `SkillPackage` (from `distill.js` / `skill-package.js`).
- Produces: `Stage1PublishedSkill`, `MetaSource`, `MetaCluster`, `buildMetaClusters()`.

- [ ] **Step 1: Write the failing tests**

Create `test/cluster-meta.test.ts` (a sibling test file keeps the meta surface separate; the root vitest glob `packages/*/test/**/*.test.ts` collects it):

```typescript
import { describe, it, expect } from 'vitest';
import { buildMetaClusters, type Stage1PublishedSkill } from '../src/cluster.js';
import type { SkillPackage } from '../src/skill-package.js';
import type { SkillKind } from '../src/distill.js';

function pkg(name: string): SkillPackage {
  return {
    name,
    description: `Use when ${name}. Not for: unrelated cases.`,
    license: null,
    jinn: {
      schema: 'jinn.skill.v1',
      distribution: 'coding',
      verifiabilityTier: 'evaluator-verified',
      distilledFrom: 1,
      provenance: [`bafy-${name}`],
    },
    body: `## When to use\nx\n## Strategy\nx\n## Steps\nx\n## Pitfalls\nx\n## Verify\nx\n`,
  };
}

function s1(over: Partial<Stage1PublishedSkill> & { clusterId: string; skillKind: SkillKind; instanceIds: string[] }): Stage1PublishedSkill {
  return {
    pkg: pkg(over.clusterId),
    evidenceRefs: [`ev-${over.clusterId}`],
    ...over,
  } as Stage1PublishedSkill;
}

describe('buildMetaClusters (group stage-1 skills by polarity, §7 stage-2)', () => {
  it('groups a ≥2-distinct-instance polarity into one meta-cluster with labelled sources', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'lesson:instA', skillKind: 'failure-lesson', instanceIds: ['instA'] }),
      s1({ clusterId: 'lesson:instB', skillKind: 'failure-lesson', instanceIds: ['instB'] }),
    ]);
    expect(clusters).toHaveLength(1);
    const mc = clusters[0]!;
    expect(mc.metaClusterId).toBe('cross-instance:failure-lesson');
    expect(mc.polarity).toBe('failure-lesson');
    expect(mc.gateTier).toBe('lesson');
    expect(mc.sources.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(mc.sources[0]!.evidenceRefs).toEqual(['ev-lesson:instA']);
    expect(mc.sources[0]!.instanceIds).toEqual(['instA']);
  });

  it('drops a polarity with fewer than 2 DISTINCT instances', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'lesson:instA', skillKind: 'failure-lesson', instanceIds: ['instA'] }),
      s1({ clusterId: 'lesson:instA-2', skillKind: 'failure-lesson', instanceIds: ['instA'] }), // same instance
    ]);
    expect(clusters).toEqual([]);
  });

  it('maps each stage-1 polarity to its gate tier', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'pattern:a', skillKind: 'strategic-pattern', instanceIds: ['a'] }),
      s1({ clusterId: 'pattern:b', skillKind: 'strategic-pattern', instanceIds: ['b'] }),
      s1({ clusterId: 'contrastive:c', skillKind: 'contrastive', instanceIds: ['c'] }),
      s1({ clusterId: 'contrastive:d', skillKind: 'contrastive', instanceIds: ['d'] }),
    ]);
    const byPolarity = Object.fromEntries(clusters.map((c) => [c.polarity, c.gateTier]));
    expect(byPolarity['strategic-pattern']).toBe('pattern');
    expect(byPolarity['contrastive']).toBe('contrastive');
  });

  it('never recurses on a cross-instance polarity (no meta-of-meta)', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'xi:a', skillKind: 'cross-instance', instanceIds: ['a'] }),
      s1({ clusterId: 'xi:b', skillKind: 'cross-instance', instanceIds: ['b'] }),
    ]);
    expect(clusters).toEqual([]);
  });

  it('is deterministic — meta-clusters sorted by metaClusterId', () => {
    const clusters = buildMetaClusters([
      s1({ clusterId: 'pattern:a', skillKind: 'strategic-pattern', instanceIds: ['a'] }),
      s1({ clusterId: 'pattern:b', skillKind: 'strategic-pattern', instanceIds: ['b'] }),
      s1({ clusterId: 'lesson:a', skillKind: 'failure-lesson', instanceIds: ['a'] }),
      s1({ clusterId: 'lesson:b', skillKind: 'failure-lesson', instanceIds: ['b'] }),
    ]);
    expect(clusters.map((c) => c.metaClusterId)).toEqual([
      'cross-instance:failure-lesson',
      'cross-instance:strategic-pattern',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && yarn vitest run packages/harness-layer/test/cluster-meta.test.ts`
Expected: FAIL — `buildMetaClusters` is not exported.

- [ ] **Step 3: Implement `buildMetaClusters`**

Append to `client/packages/harness-layer/src/cluster.ts` (add the `SkillPackage` and `SkillKind` imports at the top):

```typescript
import type { SkillPackage } from './skill-package.js';
import type { DistillCluster, SkillKind } from './distill.js';
```

```typescript
/**
 * A stage-1 published skill joined to its originating cluster's provenance —
 * the stage-2 (cross-instance meta-distill) input (issue #1463). `pkg` supplies
 * the meta-distiller's reading material (the distilled skill); `evidenceRefs` /
 * `instanceIds` supply the union provenance and the ≥2-distinct-instance test.
 */
export interface Stage1PublishedSkill {
  clusterId: string;
  skillKind: SkillKind;
  pkg: SkillPackage;
  evidenceRefs: string[];
  instanceIds: string[];
}

/** One labelled source inside a meta-cluster (its id is what the model echoes in `supports`). */
export interface MetaSource {
  id: string;
  name: string;
  description: string;
  body: string;
  evidenceRefs: string[];
  instanceIds: string[];
}

/** A same-polarity batch of ≥2-distinct-instance stage-1 skills for the meta-distiller. */
export interface MetaCluster {
  metaClusterId: string;
  polarity: SkillKind;
  gateTier: DistillCluster['tier'];
  sources: MetaSource[];
}

/** The three stage-1 polarities and the structural-gate tier each keeps in stage-2. */
const META_GATE_TIER: Record<'strategic-pattern' | 'failure-lesson' | 'contrastive', DistillCluster['tier']> = {
  'strategic-pattern': 'pattern',
  'failure-lesson': 'lesson',
  'contrastive': 'contrastive',
};

/**
 * Group stage-1 published skills into one meta-cluster per polarity. A polarity
 * is meta-distillable only when it spans **≥2 distinct instances** (a
 * cross-instance rule needs corroboration from different problems). Meta-of-meta
 * is impossible: a `cross-instance` polarity is skipped. Deterministic —
 * meta-clusters and their sources come back in a stable order.
 */
export function buildMetaClusters(published: Stage1PublishedSkill[]): MetaCluster[] {
  const byPolarity = new Map<SkillKind, Stage1PublishedSkill[]>();
  for (const p of published) {
    if (!(p.skillKind in META_GATE_TIER)) continue; // never recurse on cross-instance
    const group = byPolarity.get(p.skillKind) ?? [];
    group.push(p);
    byPolarity.set(p.skillKind, group);
  }

  const clusters: MetaCluster[] = [];
  for (const [polarity, group] of byPolarity) {
    const distinctInstances = new Set(group.flatMap((g) => g.instanceIds));
    if (distinctInstances.size < 2) continue;
    const sources: MetaSource[] = group.map((g, i) => ({
      id: `s${i + 1}`,
      name: g.pkg.name,
      description: g.pkg.description,
      body: g.pkg.body,
      evidenceRefs: g.evidenceRefs,
      instanceIds: g.instanceIds,
    }));
    clusters.push({
      metaClusterId: `cross-instance:${polarity}`,
      polarity,
      gateTier: META_GATE_TIER[polarity as 'strategic-pattern' | 'failure-lesson' | 'contrastive'],
      sources,
    });
  }

  clusters.sort((a, b) => (a.metaClusterId < b.metaClusterId ? -1 : a.metaClusterId > b.metaClusterId ? 1 : 0));
  return clusters;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && yarn vitest run packages/harness-layer/test/cluster-meta.test.ts`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/cluster.ts client/packages/harness-layer/test/cluster-meta.test.ts
git commit -m "feat(harness-layer): buildMetaClusters — group stage-1 skills by polarity"
```

---

### Task 5: `metaDistill()` — corroborate ≥2 instances, union provenance, reuse the gate

**Files:**
- Modify: `client/packages/harness-layer/src/distill.ts`
- Test: `client/packages/harness-layer/test/distill.test.ts`

**Interfaces:**
- Consumes: `finalizeSkill` (Task 3), `MetaCluster`/`MetaSource` (Task 4), `JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256` (Task 2).
- Produces: `MetaDistillLLMOutput`, `MetaDistillDeps`, `MetaDistillResult`, `metaDistill()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/distill.test.ts`. First a shared meta-source factory + meta-deps factory near the existing `deps()` helper:

```typescript
import { buildMetaClusters, type MetaCluster, type Stage1PublishedSkill } from '../src/cluster.js';
import { metaDistill, type MetaDistillDeps, type MetaDistillLLMOutput } from '../src/distill.js';

function stage1(clusterId: string, skillKind: 'failure-lesson' | 'strategic-pattern' | 'contrastive', instanceId: string): Stage1PublishedSkill {
  return {
    clusterId,
    skillKind,
    evidenceRefs: [`ev-${instanceId}`],
    instanceIds: [instanceId],
    pkg: {
      name: `s-${instanceId}`,
      description: `Use when ${instanceId}. Not for: unrelated.`,
      license: null,
      jinn: {
        schema: 'jinn.skill.v1', distribution: 'coding', verifiabilityTier: 'evaluator-verified',
        distilledFrom: 1, provenance: [`ev-${instanceId}`],
      },
      // a full 5-section body so the union of source bodies dwarfs one meta body (AC4)
      body: CONFORMANT_BODY,
    },
  };
}

function metaDeps(out: MetaDistillLLMOutput, over: Partial<MetaDistillDeps> = {}): MetaDistillDeps & { published: SkillPackage[] } {
  const published: SkillPackage[] = [];
  return {
    published,
    slate: { instanceIds: new Set(['django__django-99999']) },
    metaDistill: async () => out,
    publishSkill: async (pkg) => { published.push(pkg); return { envelopeRef: `meta-${pkg.name}`, anchorTx: null }; },
    now: () => new Date('2026-07-08T00:00:00.000Z'),
    ...over,
  } as MetaDistillDeps & { published: SkillPackage[] };
}

const cleanMetaOut: MetaDistillLLMOutput = {
  name: 'cross-instance-dedup-lesson',
  description: 'Use when a class of queries fans out rows across joins. Not for: single-table reads.',
  body: CONFORMANT_BODY,
  supports: ['s1', 's2'],
};

describe('metaDistill (stage-2 cross-instance, §7 issue #1463)', () => {
  const failureBatch = () => buildMetaClusters([
    stage1('lesson:instA', 'failure-lesson', 'instA'),
    stage1('lesson:instB', 'failure-lesson', 'instB'),
  ]);

  it('AC1: publishes a cross-instance skill whose provenance unions the supporting evidence CIDs (distilledFrom > 1)', async () => {
    const d = metaDeps(cleanMetaOut);
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(1);
    expect(res.published[0]!.skillKind).toBe('cross-instance');
    const jinn = d.published[0]!.jinn;
    expect(jinn.skillKind).toBe('cross-instance');
    expect(jinn.provenance.sort()).toEqual(['ev-instA', 'ev-instB']);
    expect(jinn.distilledFrom).toBe(2);
    expect(jinn.distillPromptSha256).toBe(JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256);
  });

  it('AC2: four briefcase-style failure sources across 4 instances → ≥1 corroborated skill linking ≥2', async () => {
    const four = buildMetaClusters([
      stage1('lesson:bc1', 'failure-lesson', 'bc1'),
      stage1('lesson:bc2', 'failure-lesson', 'bc2'),
      stage1('lesson:bc3', 'failure-lesson', 'bc3'),
      stage1('lesson:bc4', 'failure-lesson', 'bc4'),
    ]);
    const d = metaDeps({ ...cleanMetaOut, supports: ['s1', 's3', 's4'] });
    const res = await metaDistill(four, d);
    expect(res.published).toHaveLength(1);
    expect(d.published[0]!.jinn.provenance.sort()).toEqual(['ev-bc1', 'ev-bc3', 'ev-bc4']);
    expect(d.published[0]!.jinn.provenance.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects when the model corroborates fewer than 2 distinct instances', async () => {
    const d = metaDeps({ ...cleanMetaOut, supports: ['s1'] });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/fewer than 2 distinct/i);
  });

  it('AC3: a meta skill missing a skeleton section is rejected by the SAME structural gate', async () => {
    const noVerify = CONFORMANT_BODY.replace(/## Verify[\s\S]*$/, '').trimEnd() + '\n';
    const d = metaDeps({ ...cleanMetaOut, body: noVerify });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/skeleton: missing section "## Verify"/);
  });

  it('AC3: a meta skill whose body names a slate token is dropped by the SAME contamination scan', async () => {
    const d = metaDeps({ ...cleanMetaOut, body: CONFORMANT_BODY + '\nsee django__django-99999\n' });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/contamination/);
  });

  it('AC4: evidenceTokens (union of source bodies) exceeds skillTokens (one meta body)', async () => {
    const d = metaDeps(cleanMetaOut);
    await metaDistill(failureBatch(), d);
    const jinn = d.published[0]!.jinn;
    expect(jinn.evidenceTokens!).toBeGreaterThan(jinn.skillTokens!);
  });

  it('holds the failure-lesson diagnosis-only rule via the shared gate tier', async () => {
    const prescriptive = CONFORMANT_BODY.replace(
      'An order_by on a joined column can re-expand the rows distinct() collapsed.',
      'Instead, use select_related() to avoid the fan-out entirely.',
    );
    const d = metaDeps({ ...cleanMetaOut, body: prescriptive });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/counterfactual/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill.test.ts -t "metaDistill"`
Expected: FAIL — `metaDistill` is not exported.

- [ ] **Step 3: Implement `metaDistill` in `distill.ts`**

Add the imports at the top of `distill.ts`:

```typescript
import { JINN_SKILL_DISTILL_PROMPT_V1_SHA256, JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256 } from './distill-prompt.js';
import type { MetaCluster, MetaSource } from './cluster.js';
```

(Replace the existing single-symbol `distill-prompt.js` import.) Note: `MetaCluster`/`MetaSource` live in `cluster.ts`, which imports types from `distill.ts` — TypeScript `import type` cycles are erased at compile time, so this is safe.

Append to `distill.ts`:

```typescript
/** Stage-2 (cross-instance) LLM output: a distilled skill plus the source ids it corroborates. */
export interface MetaDistillLLMOutput extends DistillLLMOutput {
  /** Opaque source ids (s1, s2, …) the model says corroborate the emitted rule. */
  supports: string[];
}

export interface MetaDistillDeps {
  /** The meta LLM port: runs jinn-skill-meta-distill-prompt-v1 over one meta-cluster. */
  metaDistill: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
  publishSkill: (pkg: SkillPackage) => Promise<{ envelopeRef: string; anchorTx: string | null }>;
  slate: { instanceIds: Set<string>; repos?: Set<string> };
  distribution?: string;
  distillModel?: string;
  scrubPipeline?: ScrubPipeline;
  now?: () => Date;
}

export interface MetaDistillResult {
  published: Array<{ metaClusterId: string; skillKind: 'cross-instance'; envelopeRef: string; pkg: SkillPackage }>;
  rejected: Array<{ metaClusterId: string; reason: string }>;
  errors: Array<{ metaClusterId: string; error: string }>;
}

/**
 * Stage-2 cross-instance meta-distill (issue #1463). For each same-polarity
 * meta-cluster: run the meta LLM, keep only the sources it names in `supports`,
 * require **≥2 distinct supporting instances**, union their layer-1 evidence
 * CIDs into the provenance, and finish through the SAME `finalizeSkill` gate as
 * stage-1 — so a meta-skill passes the identical scrub / contamination /
 * structural checks. Additive and opt-in; never called unless the pipeline
 * enables it.
 */
export async function metaDistill(
  clusters: MetaCluster[],
  deps: MetaDistillDeps,
): Promise<MetaDistillResult> {
  const finalizeDeps: FinalizeDeps = {
    pipeline: deps.scrubPipeline ?? buildLayer2ScrubPipeline(),
    distribution: deps.distribution ?? 'coding',
    now: deps.now?.() ?? new Date(),
    slate: deps.slate,
    ...(deps.distillModel ? { distillModel: deps.distillModel } : {}),
    publishSkill: deps.publishSkill,
  };
  const result: MetaDistillResult = { published: [], rejected: [], errors: [] };

  for (const cluster of clusters) {
    try {
      const out = await deps.metaDistill(cluster);

      // Keep sources the model corroborated, in the cluster's stable id order
      // (deterministic regardless of the model's `supports` ordering).
      const supported = new Set(out.supports);
      const supportedSources: MetaSource[] = cluster.sources.filter((s) => supported.has(s.id));

      const distinctInstances = new Set(supportedSources.flatMap((s) => s.instanceIds));
      if (distinctInstances.size < 2) {
        result.rejected.push({
          metaClusterId: cluster.metaClusterId,
          reason: `cross-instance: fewer than 2 distinct supporting instances (got ${distinctInstances.size})`,
        });
        continue;
      }

      // Union the supporting evidence refs (dedup, preserve first-seen order) →
      // provenance; its length is distilledFrom (> 1). The finalize `input` is
      // the supported source bodies, so evidenceTokens is the honest union size.
      const seen = new Set<string>();
      const unionRefs: string[] = [];
      for (const s of supportedSources) for (const ref of s.evidenceRefs) {
        if (!seen.has(ref)) { seen.add(ref); unionRefs.push(ref); }
      }
      const finalizeInput = supportedSources.map((s) => ({ name: s.name, description: s.description, body: s.body }));

      const fin = await finalizeSkill(
        out,
        {
          tier: cluster.gateTier,
          evidenceRefs: unionRefs,
          input: finalizeInput,
          skillKind: 'cross-instance',
          promptSha: JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256,
        },
        finalizeDeps,
      );
      if (fin.ok) {
        result.published.push({ metaClusterId: cluster.metaClusterId, skillKind: 'cross-instance', envelopeRef: fin.envelopeRef, pkg: fin.pkg });
      } else {
        result.rejected.push({ metaClusterId: cluster.metaClusterId, reason: fin.reason });
      }
    } catch (err) {
      result.errors.push({ metaClusterId: cluster.metaClusterId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill.test.ts`
Expected: PASS — the whole `distill.test.ts` file (existing + Task 2 meta-prompt + Task 3 pkg + Task 5 metaDistill).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/distill.ts client/packages/harness-layer/test/distill.test.ts
git commit -m "feat(harness-layer): metaDistill — cross-instance corroboration + union provenance"
```

---

### Task 6: `createClaudeMetaDistiller()` — the production meta LLM port

**Files:**
- Modify: `client/packages/harness-layer/src/distill-llm.ts`
- Test: `client/packages/harness-layer/test/distill-llm.test.ts`

**Interfaces:**
- Consumes: `MetaCluster` (Task 4), `MetaDistillLLMOutput` (Task 5), `JINN_SKILL_META_DISTILL_PROMPT_V1` (Task 2), existing `ChildLike`/`SpawnLike`/`extractJsonObject` (this module).
- Produces: `buildMetaDistillInput()`, `createClaudeMetaDistiller()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/distill-llm.test.ts` (import the new symbols + `MetaCluster`):

```typescript
import { createClaudeMetaDistiller, buildMetaDistillInput } from '../src/distill-llm.js';
import { JINN_SKILL_META_DISTILL_PROMPT_V1 } from '../src/distill-prompt.js';
import type { MetaCluster } from '../src/cluster.js';

const metaCluster: MetaCluster = {
  metaClusterId: 'cross-instance:failure-lesson',
  polarity: 'failure-lesson',
  gateTier: 'lesson',
  sources: [
    { id: 's1', name: 'a', description: 'da', body: 'body-a-distinct', evidenceRefs: ['ev-a'], instanceIds: ['a'] },
    { id: 's2', name: 'b', description: 'db', body: 'body-b-distinct', evidenceRefs: ['ev-b'], instanceIds: ['b'] },
  ],
};

describe('createClaudeMetaDistiller', () => {
  it('parses a { name, description, body, supports } object from stdout', async () => {
    const out = { name: 'xi', description: 'Use when … Not for: …', body: 'b', supports: ['s1', 's2'] };
    const child = fakeChild({ stdout: JSON.stringify(out) });
    const { spawn } = makeSpawn(child);
    const meta = createClaudeMetaDistiller({ spawnImpl: spawn });
    await expect(meta(metaCluster)).resolves.toEqual(out);
  });

  it('sends the meta prompt, the POLARITY hint, and the labelled sources on stdin', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b', supports: ['s1', 's2'] }) });
    const { spawn } = makeSpawn(child);
    const meta = createClaudeMetaDistiller({ spawnImpl: spawn });
    await meta(metaCluster);
    const sent = (child as unknown as { writes: string[] }).writes.join('');
    expect(sent).toContain(JINN_SKILL_META_DISTILL_PROMPT_V1);
    expect(sent).toContain('POLARITY = failure-lesson');
    expect(sent).toContain('s1');
    expect(sent).toContain('body-a-distinct');
  });

  it('throws when supports is missing or not an array of strings', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn } = makeSpawn(child);
    const meta = createClaudeMetaDistiller({ spawnImpl: spawn });
    await expect(meta(metaCluster)).rejects.toThrow(/supports/);
  });

  it('buildMetaDistillInput labels each source and states the JSON contract', () => {
    const input = buildMetaDistillInput(JINN_SKILL_META_DISTILL_PROMPT_V1, metaCluster);
    expect(input).toContain('POLARITY = failure-lesson');
    expect(input).toContain('s1');
    expect(input).toContain('s2');
    expect(input).toContain('"supports"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill-llm.test.ts -t "MetaDistiller|buildMetaDistillInput"`
Expected: FAIL — `createClaudeMetaDistiller` / `buildMetaDistillInput` are not exported.

- [ ] **Step 3: Implement the meta port**

Append to `client/packages/harness-layer/src/distill-llm.ts` (add `import type { MetaCluster } from './cluster.js';` and `import type { MetaDistillLLMOutput } from './distill.js';` at the top):

```typescript
/**
 * Serialize a meta-cluster into the model input appended after the meta prompt:
 * the POLARITY (so the model keeps the right voice — diagnosis-only for
 * failure-lesson) and each source labelled with its opaque id. Only id + the
 * distilled skill's name/description/body are sent — evidence refs and instance
 * ids are audit metadata the model must not echo.
 */
function serializeMetaCluster(cluster: MetaCluster): string {
  const sources = cluster.sources
    .map((s) => `--- ${s.id} ---\nname: ${s.name}\ndescription: ${s.description}\nbody:\n${s.body}`)
    .join('\n\n');
  return `POLARITY = ${cluster.polarity}\n\nSOURCES (already-distilled skills, one per instance):\n${sources}`;
}

/** Build the full meta model input: the versioned meta prompt + the sources + the JSON contract. */
export function buildMetaDistillInput(prompt: string, cluster: MetaCluster): string {
  return [
    prompt,
    '',
    serializeMetaCluster(cluster),
    '',
    'Return ONLY a single JSON object with exactly these fields, and nothing else:',
    '{ "name": "...", "description": "...", "body": "...", "supports": ["s1", "s2"] }',
    '- name: lowercase-hyphen skill name.',
    '- description: the retrieval surface ("Use when … Not for: …").',
    '- body: the markdown SKILL.md body (the five fixed sections).',
    '- supports: the source ids (s1, s2, …) that corroborate the rule; at least two DISTINCT sources.',
  ].join('\n');
}

/** Validate the parsed object is a { name, description, body, supports } meta output. */
function assertMetaDistillOutput(parsed: unknown): MetaDistillLLMOutput {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('meta-distill LLM: model output is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of ['name', 'description', 'body'] as const) {
    if (typeof obj[field] !== 'string' || obj[field] === '') {
      throw new Error(`meta-distill LLM: model output missing/invalid field "${field}"`);
    }
  }
  if (!Array.isArray(obj.supports) || !obj.supports.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new Error('meta-distill LLM: model output missing/invalid field "supports" (expected a string[])');
  }
  return {
    name: obj.name as string,
    description: obj.description as string,
    body: obj.body as string,
    supports: obj.supports as string[],
  };
}

/**
 * Build the stage-2 meta-distill LLM port (issue #1463). Same spawn/parse
 * scaffolding as {@link createClaudeDistiller}: spawns `claude -p --model`,
 * pipes {@link buildMetaDistillInput} on stdin, and parses the strict JSON
 * (tolerating a prose wrapper via the shared {@link extractJsonObject}).
 */
export function createClaudeMetaDistiller(
  opts: { claudePath?: string; model?: string; spawnImpl?: SpawnLike } = {},
): (cluster: MetaCluster) => Promise<MetaDistillLLMOutput> {
  const claudePath = opts.claudePath ?? DEFAULT_CLAUDE_PATH;
  const model = opts.model ?? DEFAULT_MODEL;
  const spawnImpl: SpawnLike = opts.spawnImpl ?? ((command, args) => spawn(command, [...args]));

  return async function metaDistillPort(cluster: MetaCluster): Promise<MetaDistillLLMOutput> {
    const { JINN_SKILL_META_DISTILL_PROMPT_V1 } = await import('./distill-prompt.js');
    const input = buildMetaDistillInput(JINN_SKILL_META_DISTILL_PROMPT_V1, cluster);
    const args = ['-p', '--model', model];

    return new Promise<MetaDistillLLMOutput>((resolve, reject) => {
      const child = spawnImpl(claudePath, args);
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new Error(`meta-distill LLM: claude exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          resolve(assertMetaDistillOutput(extractJsonObject(stdout)));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      child.stdin?.write(input);
      child.stdin?.end();
    });
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && yarn vitest run packages/harness-layer/test/distill-llm.test.ts`
Expected: PASS — the whole file (existing `createClaudeDistiller` tests + the four new meta tests).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/distill-llm.ts client/packages/harness-layer/test/distill-llm.test.ts
git commit -m "feat(harness-layer): createClaudeMetaDistiller — stage-2 meta LLM port"
```

---

### Task 7: Wire stage-2 into `runDistillationPipeline` (opt-in)

**Files:**
- Modify: `client/packages/harness-layer/src/pipeline.ts`
- Test: `client/packages/harness-layer/test/pipeline.test.ts`

**Interfaces:**
- Consumes: `metaDistill`/`MetaDistillLLMOutput` (Task 5), `buildMetaClusters`/`MetaCluster`/`Stage1PublishedSkill` (Task 4).
- Produces: `PipelineDeps.meta?: boolean`, `PipelineDeps.metaDistill?`, `PipelineResult.metaDistilled?: MetaDistillResult`.

- [ ] **Step 1: Write the failing tests**

Add to `test/pipeline.test.ts`. First widen the `deps()` fixture's verdict source so a same-polarity batch has ≥2 distinct instances (needed for a meta-cluster to form). Add a second passing instance to the default list and a `metaOut` stub:

```typescript
import type { MetaCluster } from '../src/cluster.js';
import type { MetaDistillLLMOutput } from '../src/distill.js';

const META_OUT: MetaDistillLLMOutput = {
  name: 'cross-instance-orm-dedup',
  description: 'Use when a class of ORM queries fans out rows. Not for: single-table reads.',
  body: [
    '## When to use', 'A class of queries returns duplicate rows after a join.',
    '## Strategy', 'Collapse duplicates at the ORM layer across the shared pattern.',
    '## Steps', '1. Spot the fan-out. 2. Dedup at the join.',
    '## Pitfalls', 'An order_by on a joined column can re-expand the rows.',
    '## Verify', 'Assert the row count equals the expected unique count.',
  ].join('\n\n'),
  supports: ['s1', 's2'],
};
```

Then add tests inside `describe('runDistillationPipeline (Tier-0 dry-run)')`:

```typescript
  it('AC5: leaves metaDistilled undefined and stage-1 unchanged when meta is disabled', async () => {
    const { d } = deps();
    const res = await runDistillationPipeline(d);
    expect(res.metaDistilled).toBeUndefined();
    expect(res.distilled.published).toHaveLength(2); // stage-1 identical to today
  });

  it('runs stage-2 when meta is enabled and a polarity spans ≥2 distinct instances', async () => {
    // two passing instances → two strategic-pattern skills → one meta-cluster.
    const { d, skills } = deps({
      verdictSource: {
        list: async () => [
          ref('flask__flask-1', 'pass'),
          ref('requests__requests-3', 'pass'),
          ref('django__django-99999', 'pass'), // held-out → excluded
        ],
      },
      meta: true,
      metaDistill: async (_c: MetaCluster) => META_OUT,
    });
    const res = await runDistillationPipeline(d);
    expect(res.distilled.published).toHaveLength(2);
    expect(res.metaDistilled).toBeDefined();
    expect(res.metaDistilled!.published).toHaveLength(1);
    const meta = res.metaDistilled!.published[0]!;
    expect(meta.skillKind).toBe('cross-instance');
    // provenance unions BOTH instances' layer-1 evidence refs (distilledFrom > 1).
    expect(meta.pkg.jinn.distilledFrom).toBeGreaterThan(1);
    expect(meta.pkg.jinn.provenance.length).toBe(meta.pkg.jinn.distilledFrom);
    // AC4: the union of source bodies is larger than the one meta body.
    expect(meta.pkg.jinn.evidenceTokens!).toBeGreaterThan(meta.pkg.jinn.skillTokens!);
    // the meta skill was actually published as a package too
    expect(skills.some((s) => s.jinn.skillKind === 'cross-instance')).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && yarn vitest run packages/harness-layer/test/pipeline.test.ts -t "meta"`
Expected: FAIL — `meta`/`metaDistill`/`metaDistilled` are not on the types; `res.metaDistilled` is `undefined` in the enabled case.

- [ ] **Step 3: Implement the pipeline wiring**

In `client/packages/harness-layer/src/pipeline.ts`, update imports:

```typescript
import { distillClusters, metaDistill, type DistillCluster, type DistillLLMOutput, type DistillResult, type MetaDistillLLMOutput, type MetaDistillResult } from './distill.js';
import { clusterEvidence, buildMetaClusters, type MetaCluster, type Stage1PublishedSkill } from './cluster.js';
```

Add to `PipelineDeps` (after `distillModel`):

```typescript
  /** Enable stage-2 cross-instance meta-distill (issue #1463). Default off (opt-in). */
  meta?: boolean;
  /** The stage-2 meta LLM port. Required when `meta` is true. */
  metaDistill?: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
```

Add to `PipelineResult`:

```typescript
  /** Stage-2 result — present only when `meta` was enabled. */
  metaDistilled?: MetaDistillResult;
```

In `runDistillationPipeline`, after the stage-1 `distilled` is computed (after the existing `const distilled = await distillClusters(...)` call) and before `return`:

```typescript
  // 4. Stage-2 (opt-in) — cross-instance meta-distill over the stage-1 skills
  //    this run just published. Reads only in-memory results (no corpus round-trip).
  let metaDistilled: MetaDistillResult | undefined;
  if (deps.meta) {
    if (!deps.metaDistill) {
      throw new Error('runDistillationPipeline: meta is enabled but no metaDistill port was provided');
    }
    const clusterById = new Map(clusters.map((c) => [c.clusterId, c]));
    const stage1: Stage1PublishedSkill[] = distilled.published.map((p) => {
      const cl = clusterById.get(p.clusterId);
      if (!cl) throw new Error(`meta: no originating cluster for ${p.clusterId}`);
      return { clusterId: p.clusterId, skillKind: p.skillKind, pkg: p.pkg, evidenceRefs: cl.evidenceRefs, instanceIds: cl.instanceIds };
    });
    metaDistilled = await metaDistill(buildMetaClusters(stage1), {
      metaDistill: deps.metaDistill,
      publishSkill: deps.publishSkill,
      slate: deps.slate,
      ...(deps.distribution ? { distribution: deps.distribution } : {}),
      ...(deps.distillModel ? { distillModel: deps.distillModel } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  return { bridge, clusterCount: clusters.length, distilled, ...(metaDistilled ? { metaDistilled } : {}) };
```

Replace the existing `return { bridge, clusterCount: clusters.length, distilled };` with the return above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && yarn vitest run packages/harness-layer/test/pipeline.test.ts`
Expected: PASS — the whole file (existing dry-run + secret-drop tests, plus the two new meta tests).

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/pipeline.ts client/packages/harness-layer/test/pipeline.test.ts
git commit -m "feat(harness-layer): opt-in stage-2 meta-distill in runDistillationPipeline"
```

---

### Task 8: CLI `--meta` flag + run-output rendering

**Files:**
- Modify: `client/packages/harness-layer/src/cli.ts`
- Test: `client/packages/harness-layer/test/cli.test.ts`

**Interfaces:**
- Consumes: `createClaudeMetaDistiller` (Task 6), `runDistillationPipeline` meta wiring (Task 7), `MetaCluster`/`MetaDistillLLMOutput`.
- Produces: `DistillCliDeps.metaDistill?`, a `--meta` boolean flag, meta lines in the human + JSON output.

- [ ] **Step 1: Write the failing tests**

Add to `test/cli.test.ts` inside `describe('jinn-layer distill run')`. First extend `stubDeps` to include a same-polarity ≥2-instance verdict list and a meta stub; then two tests:

```typescript
  const META_OUT = {
    name: 'cross-instance-orm-dedup',
    description: 'Use when a class of ORM queries fans out rows. Not for: single-table reads.',
    body: [
      '## When to use', 'A class of queries returns duplicate rows after a join.',
      '## Strategy', 'Collapse duplicates at the ORM layer across the shared pattern.',
      '## Steps', '1. Spot the fan-out. 2. Dedup at the join.',
      '## Pitfalls', 'An order_by on a joined column can re-expand the rows.',
      '## Verify', 'Assert the row count equals the expected unique count.',
    ].join('\n\n'),
    supports: ['s1', 's2'],
  };

  function stubMetaDeps(): Partial<DistillCliDeps> {
    return {
      verdictSource: {
        list: async () => [
          dref('flask__flask-1', 'pass'),
          dref('requests__requests-3', 'pass'),
        ],
      },
      metaDistill: async (_c: MetaCluster): Promise<MetaDistillLLMOutput> => META_OUT,
    };
  }

  it('AC4: --meta runs stage-2 and shows a cross-instance skill with evidenceTokens > skillTokens', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--meta', '--out', outDir, '--json'], {
      writer,
      distillDeps: stubDeps(stubMetaDeps()),
    });
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.metaDistilled.published).toHaveLength(1);
    const meta = result.metaDistilled.published[0];
    expect(meta.skillKind).toBe('cross-instance');
    expect(meta.pkg.jinn.evidenceTokens).toBeGreaterThan(meta.pkg.jinn.skillTokens);
  });

  it('--meta prints the meta section in human output', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    await runJinnLayerCli(['distill', 'run', '--meta', '--out', outDir], {
      writer,
      distillDeps: stubDeps(stubMetaDeps()),
    });
    const text = out();
    expect(text).toContain('meta-distilled: published 1');
    expect(text).toMatch(/META cross-instance .*evidenceTokens=\d+ skillTokens=\d+/);
  });

  it('without --meta, no meta section is printed (stage-1 unchanged)', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    await runJinnLayerCli(['distill', 'run', '--out', outDir], { writer, distillDeps: stubDeps() });
    expect(out()).not.toContain('meta-distilled');
  });
```

Add the imports at the top of `cli.test.ts`: `import type { MetaCluster } from '../src/cluster.js'; import type { MetaDistillLLMOutput } from '../src/distill.js';`. Also update the `stubDeps` signature so it accepts overrides (it already takes `over: Partial<DistillCliDeps>` — pass `stubMetaDeps()`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd client && yarn vitest run packages/harness-layer/test/cli.test.ts -t "meta"`
Expected: FAIL — `--meta` is not a known flag / `result.metaDistilled` undefined.

- [ ] **Step 3: Implement the CLI flag + rendering**

In `client/packages/harness-layer/src/cli.ts`:

Add the meta port import near the other distill imports:

```typescript
import { createClaudeDistiller, createClaudeMetaDistiller } from './distill-llm.js';
import type { DistillCluster, DistillLLMOutput, MetaDistillLLMOutput } from './distill.js';
import type { MetaCluster } from './cluster.js';
```

(Merge with the existing `createClaudeDistiller` and `DistillCluster, DistillLLMOutput` imports — do not duplicate.)

Add a field to `DistillCliDeps`:

```typescript
  /** The stage-2 meta LLM port. Default: createClaudeMetaDistiller. */
  metaDistill?: (cluster: MetaCluster) => Promise<MetaDistillLLMOutput>;
```

Add the `meta` option to the `parseArgs` options object (alongside `veto`):

```typescript
        meta: { type: 'boolean', default: false },
```

In the `isDistill` block, after `const distillModel = …` and the `const distill = …` lines, add:

```typescript
    const metaEnabled = parsed.values.meta as boolean;
    const metaDistillPort = dd.metaDistill ?? createClaudeMetaDistiller({ model: distillModel });
```

Extend the `runDistillationPipeline({ … })` call to pass meta wiring (add inside the object literal, before the `...(limit …)` spread):

```typescript
      ...(metaEnabled ? { meta: true, metaDistill: metaDistillPort } : {}),
```

Extend the human-readable output block (after the existing `for (const e of result.distilled.errors) …` loop and before `lines.push('', ...skills written under...)`):

```typescript
      if (result.metaDistilled) {
        lines.push('', `meta-distilled: published ${result.metaDistilled.published.length}, rejected ${result.metaDistilled.rejected.length}, errors ${result.metaDistilled.errors.length}`);
        for (const p of result.metaDistilled.published) {
          lines.push(`  META ${p.skillKind} ${p.envelopeRef} (${p.metaClusterId}) evidenceTokens=${p.pkg.jinn.evidenceTokens} skillTokens=${p.pkg.jinn.skillTokens}`);
        }
        for (const r of result.metaDistilled.rejected) lines.push(`  meta-rejected ${r.metaClusterId} — ${r.reason}`);
        for (const e of result.metaDistilled.errors) lines.push(`  META-ERROR ${e.metaClusterId} — ${e.error}`);
      }
```

The `--json` branch already emits `{ ...result, outDir }`, which now carries `metaDistilled` automatically — no change needed there.

Update the exit code to also fail on meta errors:

```typescript
    return result.distilled.errors.length > 0 || (result.metaDistilled?.errors.length ?? 0) > 0 ? 1 : 0;
```

Optionally add a one-line `--meta` note to the `distill run` USAGE entry (the line at ~86-90): append `[--meta]` and a short "run stage-2 cross-instance meta-distill" clause. Keep it to the existing style.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd client && yarn vitest run packages/harness-layer/test/cli.test.ts`
Expected: PASS — existing distill-run tests plus the three new `--meta` tests.

- [ ] **Step 5: Commit**

```bash
git add client/packages/harness-layer/src/cli.ts client/packages/harness-layer/test/cli.test.ts
git commit -m "feat(harness-layer): distill run --meta flag + stage-2 output"
```

---

### Task 9: Spec amendment (surgical)

**Files:**
- Modify: `spec/2026-07-06-distillation-v1.md` (§7 end, §13 Out-of-scope)

**Interfaces:** none (docs).

- [ ] **Step 1: Add the §7 in-scope note**

In `spec/2026-07-06-distillation-v1.md`, immediately after the §7 "Output of v1:" paragraph (the paragraph ending `… must *earn its place* against raw-evidence retrieval (§11, D9).`, just before the `## 8.` heading), add:

```markdown
**Stage-2 — cross-instance meta-distill (in scope, additive/opt-in; issue #1463).** After the
single-pass distillation above, an opt-in second pass groups the stage-1 skills this run just
published **by polarity** (their `skillKind`) and asks a distinct prompt
(`jinn-skill-meta-distill-prompt-v1`, its own published SHA) for the recurring rule corroborated
across **≥2 distinct instances**. It emits a `skillKind: 'cross-instance'` skill whose provenance is
the **union** of the supporting sources' layer-1 evidence CIDs (so `distilledFrom > 1`), and reuses
the same output-scrub → contamination-scan → structural-gate → publish path unchanged. It reads only
stage-1's in-memory results — no corpus round-trip — and never groups a `cross-instance` skill (no
recursion). Disabled by default (`yarn distill … --meta` / pipeline `meta: true`).
```

- [ ] **Step 2: Remove the superseded §13 non-goal bullet**

In §13 "Out of scope:", delete the bullet (line ~651):

```markdown
- **Automated clustering** beyond distinct-instance + tags + summary similarity.
```

Leave every other §13 bullet and the §7 step-2 clustering language untouched (that language governs stage-1 grouping of layer-1 evidence; stage-2 groups stage-1 skills, a different axis).

- [ ] **Step 3: Commit**

```bash
git add spec/2026-07-06-distillation-v1.md
git commit -m "docs(spec): scope stage-2 cross-instance meta-distill into distillation-v1 §7/§13"
```

---

### Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the harness-layer package**

Run: `cd client && yarn typecheck:harness-layer`
Expected: zero errors. (This is the fast, targeted typecheck for the package this plan touches.)

- [ ] **Step 2: Full typecheck (includes client/src/types/skill-artifact.ts)**

Run: `cd client && yarn typecheck`
Expected: zero errors. Confirms the `skill-artifact.ts` enum widening is consistent across the whole `client/src` tree.

- [ ] **Step 3: Run the whole harness-layer test surface**

Run: `cd client && yarn vitest run packages/harness-layer/test`
Expected: all green — distill, distill-llm, cluster, cluster-meta, pipeline, cli, skill, skill-package.

- [ ] **Step 4: Run the full default suite (regression net)**

Run: `cd client && yarn test`
Expected: all green. Confirms nothing outside the package (that reads `SkillProvenanceSchema` / `DistillResult`) regressed.

- [ ] **Step 5: Build (the package is bundled into `dist/` via `scripts/bundle-jinn-layer.mjs`)**

Run: `cd client && yarn build`
Expected: builds clean (tsc + SPA + jinn-layer bundle + `yarn typecheck:harness-layer`).

- [ ] **Step 6: Acceptance-criteria self-check**

Confirm each AC has a passing test:
- AC1 → `distill.test.ts` "AC1: publishes a cross-instance skill whose provenance unions…" + `pipeline.test.ts` "runs stage-2 when meta is enabled…".
- AC2 → `distill.test.ts` "AC2: four briefcase-style failure sources…".
- AC3 → `distill.test.ts` "AC3: … SAME structural gate" + "AC3: … SAME contamination scan"; identical-gate-by-construction from the `finalizeSkill` refactor (Task 3).
- AC4 → `distill.test.ts` "AC4: evidenceTokens … exceeds skillTokens" + `pipeline.test.ts` + `cli.test.ts` "AC4: --meta … evidenceTokens > skillTokens" (shown in run output).
- AC5 → `pipeline.test.ts` "AC5: leaves metaDistilled undefined and stage-1 unchanged" + `cli.test.ts` "without --meta, no meta section" + the whole existing distill/pipeline/cli suite staying green after Task 3.

---

## Self-Review

**Spec coverage (design note → tasks):**
- Refactor `distill.ts` per-cluster loop → `finalizeSkill` → Task 3. ✓
- Meta-LLM output `supports: string[]`; map ids → sources; union evidenceRefs; reject <2 distinct instances → Task 5. ✓
- New meta prompt + `_SHA256` + SHA assertion mirroring v1 → Task 2. ✓
- Batch assembly grouped by `skillKind`, gate `tier` per polarity, synthetic input = supported sources → Tasks 4 (grouping/gateTier) + 5 (finalize input from supported subset). ✓
- Thread stage-1 → stage-2 via `pkg` on `DistillResult.published` + join by `clusterId` in `pipeline.ts` → Tasks 3 + 7. ✓
- `skillKind: 'cross-instance'` at the three enum sites → Task 1. ✓
- Pipeline `meta?: boolean` + `metaDistilled` on result + `if (deps.meta)` → Task 7. ✓
- CLI `--meta` + print meta skills → Task 8. ✓
- Spec §7 note + §13 bullet removal, no §7 "two modes" edit → Task 9. ✓

**Existing-test impact (must stay green):**
- `DistillResult.published` gains `pkg` (additive) — Task 3 keeps every existing `distill.test.ts` / `pipeline.test.ts` / `cli.test.ts` assertion valid (all read `.length`, `.skillKind`, `.envelopeRef`, `.clusterId`, none exclude extra fields). Verified by Task 3 Step 4 and Task 10 Steps 3–4.
- Enum widening is backwards-compatible: no existing test asserts the enum rejects a fourth value; no exhaustive `switch` on `skillKind` exists (grep confirmed). `test/skill-package.test.ts:62` (`failure-lesson`) and `test/skill.test.ts` seed tests remain valid.
- `finalizeSkill` preserves the exact gate order (scrub → contamination → structural → name) and the exact rejection-reason strings, so the existing `distillClusters` rejection tests (secret, contamination, skeleton, Not-for, counterfactual, empty-name) match unchanged.

**Type consistency:** `finalizeSkill(out, spec, deps)` uses `FinalizeSpec`/`FinalizeDeps`/`FinalizeResult` consistently in both callers; `metaDistill` uses `MetaCluster.gateTier` as the `finalizeSkill` `tier`; `Stage1PublishedSkill` fields (`clusterId`, `skillKind`, `pkg`, `evidenceRefs`, `instanceIds`) match what `pipeline.ts` assembles and what `buildMetaClusters` reads. `MetaDistillLLMOutput extends DistillLLMOutput` so it is accepted by `finalizeSkill(out: DistillLLMOutput, …)`.

**Import-cycle note:** `cluster.ts` `import type { … } from './distill.js'` and `distill.ts` `import type { MetaCluster, MetaSource } from './cluster.js'` form a type-only cycle — erased at compile time, safe under NodeNext.
