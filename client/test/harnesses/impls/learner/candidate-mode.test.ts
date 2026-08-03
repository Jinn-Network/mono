/**
 * C6 — learner candidate mode (product design §10; substrate §4.2/§5).
 *
 * The primary regression assertion of this unit is the first describe block:
 * a candidate-mode run leaves the ACTIVE `implStateDir` byte-untouched, proved
 * through the shipped freeze-fence hash machinery (hash before, hash after,
 * byte-equal) rather than a bespoke comparison. If that ever regresses, a
 * proposer has silently adopted its own proposal, which is the exact confusion
 * of authorities §10 exists to end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  EXECUTION_TUPLE_FORMAT_TOKEN,
  HARNESS_STATE_LOADOUT_KIND,
  parseExactCandidateManifest,
  tupleDigest,
  validateCandidateManifest,
  type CandidateEvidenceProvenance,
} from '@jinn-network/policy-identity';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/harness.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
} from '../../../../src/harnesses/impls/learner/types.js';
import {
  CANDIDATE_DIR_ENV,
  INLINE_MUTATION_ENV,
  readCandidateEmission,
} from '../../../../src/harnesses/impls/learner/candidate.js';
import { runHarnessWithFreezeFence } from '../../../../src/daemon/freeze-fence.js';
import { hashImplStateDir, harnessHashOptions } from '../../../../src/harnesses/freeze.js';
import type { HarnessContext, HarnessMode } from '../../../../src/harnesses/types.js';

/** A minimal but profile-legal `learner-public.v1` tree. */
async function seedActiveState(dir: string): Promise<void> {
  await mkdir(join(dir, 'skills', 'triage'), { recursive: true });
  await mkdir(join(dir, 'notes'), { recursive: true });
  await writeFile(join(dir, 'policy.json'), '{"policy":{"revert":{}}}\n');
  await writeFile(join(dir, 'skills', 'triage', 'SKILL.md'), '# triage\n\nparent revision.\n');
  await writeFile(join(dir, 'notes', 'seed.md'), 'seed note\n');
}

function evidenceProvenanceFixture(): CandidateEvidenceProvenance {
  return {
    savedQueryDigest: `sha256:${'a'.repeat(64)}`,
    snapshotReceipt: {
      savedQueryDigest: `sha256:${'a'.repeat(64)}`,
      sourceSet: { id: 'urn:jinn:source-set:local', version: '1' },
      sources: [
        {
          source: { id: 'urn:jinn:source:local-catalog', version: '1' },
          checkpoint: {
            source: { id: 'urn:jinn:source:local-catalog', version: '1' },
            value: '42',
            replayable: true,
          },
        },
      ],
      evaluatedAt: '2026-08-03T00:00:00Z',
      reproducibility: 'replayable',
    },
    recordListDigest: `sha256:${'b'.repeat(64)}`,
  };
}

/**
 * Stands in for the real CLI: writes what the Improve/Consolidate phases write,
 * to whichever directory the harness told it to write to. It reads
 * `JINN_LEARNER_CANDIDATE_DIR` from `adapterEnv` exactly as the plugin's prompts
 * read it from the spawned process environment.
 */
class ImprovingAdapter implements HarnessAdapter {
  readonly name = 'improving';
  readonly allowsHarnessSelfModification = false;
  lastInputs?: TaskSessionInputs;

  async runTask(inputs: TaskSessionInputs): Promise<void> {
    this.lastInputs = inputs;
    const writeTarget = inputs.adapterEnv?.[CANDIDATE_DIR_ENV] ?? inputs.implStateDir;

    // Improve: mutate a skill in the write target.
    await mkdir(join(writeTarget, 'skills', 'triage'), { recursive: true });
    await writeFile(
      join(writeTarget, 'skills', 'triage', 'SKILL.md'),
      '# triage\n\nparent revision.\n\n## Added by Improve\n\nCheck the base rate first.\n',
    );

    // Improve: one promotion_record per accepted mutation, in workingDir.
    await mkdir(join(inputs.workingDir, '.improve', 'promotions'), { recursive: true });
    await writeFile(
      join(inputs.workingDir, '.improve', 'promotions', '1.json'),
      JSON.stringify({
        ts: 1_716_800_000_000,
        implStateDirShaBefore: 'abc123',
        implStateDirShaAfter: 'def456',
        changeKind: 'skill-edit',
        target: 'skills/triage/SKILL.md',
        summary: 'Added mandatory base-rate check to the triage skill',
        analysisSource: 'recommendationsForImprove[0]',
      }),
    );

    // Consolidate: prune a note, and record it.
    await rm(join(writeTarget, 'notes', 'seed.md'), { force: true });
    await mkdir(join(inputs.workingDir, '.memory-consolidation'), { recursive: true });
    await writeFile(
      join(inputs.workingDir, '.memory-consolidation', 'consolidation_record.json'),
      JSON.stringify({
        ts: 1_716_800_001_000,
        implStateDirShaBefore: 'def456',
        implStateDirShaAfter: 'ghi789',
        durable: {
          skillsArchived: [],
          promotionsReverted: [],
          notesCompacted: 1,
          conflictsResolved: [],
        },
        ephemeral: { movedToPrivate: [], migratedToImplState: [] },
      }),
    );
  }
}

interface Fixture {
  root: string;
  activeDir: string;
  workingDir: string;
  candidateRoot: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'jinn-c6-'));
  const activeDir = join(root, 'active');
  const workingDir = join(root, 'work');
  const candidateRoot = join(root, 'candidates');
  await mkdir(activeDir, { recursive: true });
  await mkdir(workingDir, { recursive: true });
  await seedActiveState(activeDir);
  return { root, activeDir, workingDir, candidateRoot };
}

function makeCtx(fixture: Fixture, mode: HarnessMode): HarnessContext {
  return {
    task: {
      id: 'task-1',
      solverType: 'swe-rebench-v2.v1',
      window: { startTs: 0, endTs: 0 },
    } as HarnessContext['task'],
    requestId: 'req-1',
    solverNet: { name: 'net', solverType: 'swe-rebench-v2.v1', model: 'claude-haiku-4-5-20251001' },
    implStateDir: fixture.activeDir,
    workingDir: fixture.workingDir,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => {} } as unknown as HarnessContext['trajectory'],
    mode,
  } as HarnessContext;
}

function makeHarness(fixture: Fixture, adapter: HarnessAdapter): LearnerHarness {
  return new LearnerHarness({
    adapter,
    pluginRoot: '/tmp/plugin-root',
    routing: { solverTypes: ['swe-rebench-v2.v1'] },
    candidate: {
      workspaceRoot: fixture.candidateRoot,
      proposerAgentIri: 'did:pkh:eip155:84532:0x1111111111111111111111111111111111111111',
      evidenceProvenance: evidenceProvenanceFixture(),
    },
  });
}

/** The harness harvests `workingDir`; seed the typed payload its SolverType requires. */
async function seedHarvestableSolution(workingDir: string): Promise<void> {
  await mkdir(join(workingDir, '.execute'), { recursive: true });
  await writeFile(
    join(workingDir, '.execute', 'solution-payload.json'),
    JSON.stringify({
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/a.py b/a.py\n',
    }),
  );
}

describe('candidate mode — the active implStateDir is byte-untouched', () => {
  it('leaves the active directory byte-identical, proved by the shipped freeze-fence', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const harness = makeHarness(fixture, new ImprovingAdapter());
      const hashOpts = harnessHashOptions(harness);

      const before = await hashImplStateDir(fixture.activeDir, hashOpts);
      const fence = await runHarnessWithFreezeFence(harness, makeCtx(fixture, 'candidate'));
      const after = await hashImplStateDir(fixture.activeDir, hashOpts);

      // The fence itself must be satisfied: candidate mode takes the non-train
      // branch, so a mutation of the active directory is a fence violation.
      expect(fence.ok).toBe(true);
      expect(after).toBe(before);
      // ...and the fence's stable pre-hash is what the delivery envelope carries.
      if (fence.ok) expect(fence.codeDigest).toBe(before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('writes the Improve/Consolidate mutations into the candidate tree instead', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const harness = makeHarness(fixture, new ImprovingAdapter());
      await runHarnessWithFreezeFence(harness, makeCtx(fixture, 'candidate'));

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const candidateSkill = await readFile(
        join(emission.treeDir, 'skills', 'triage', 'SKILL.md'),
        'utf-8',
      );
      const activeSkill = await readFile(
        join(fixture.activeDir, 'skills', 'triage', 'SKILL.md'),
        'utf-8',
      );

      expect(candidateSkill).toContain('Added by Improve');
      expect(activeSkill).not.toContain('Added by Improve');
      // The consolidator's prune landed on the candidate, not the parent.
      await expect(readdir(join(emission.treeDir, 'notes'))).resolves.toEqual([]);
      await expect(readdir(join(fixture.activeDir, 'notes'))).resolves.toEqual(['seed.md']);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('hands the plugin the candidate directory through the adapter env allowlist', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const adapter = new ImprovingAdapter();
      await runHarnessWithFreezeFence(makeHarness(fixture, adapter), makeCtx(fixture, 'candidate'));
      expect(adapter.lastInputs?.mode).toBe('candidate');
      expect(adapter.lastInputs?.adapterEnv?.[CANDIDATE_DIR_ENV]).toBeDefined();
      // The active directory still reaches the plugin — read-only — because
      // Orient and Execute run against the policy being evaluated.
      expect(adapter.lastInputs?.implStateDir).toBe(fixture.activeDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('candidate mode — sealed manifest emission', () => {
  it('emits a manifest that round-trips through the substrate validator', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      await runHarnessWithFreezeFence(
        makeHarness(fixture, new ImprovingAdapter()),
        makeCtx(fixture, 'candidate'),
      );

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const bytes = await readFile(emission.manifestPath);
      const parsed = parseExactCandidateManifest(bytes);
      const result = validateCandidateManifest(parsed);

      expect(result.ok).toBe(true);
      expect(parsed.formatToken).toBe(CANDIDATE_MANIFEST_FORMAT_TOKEN);
      expect(emission.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('pins the loadout axis to the candidate tree digest as a jinn.harness-state.v1 pin', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const harness = makeHarness(fixture, new ImprovingAdapter());
      await runHarnessWithFreezeFence(harness, makeCtx(fixture, 'candidate'));

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const manifest = parseExactCandidateManifest(await readFile(emission.manifestPath));

      expect(manifest.policy.formatToken).toBe(EXECUTION_TUPLE_FORMAT_TOKEN);
      expect(manifest.policy.harness).toBe('claude-code');
      expect(manifest.policy.model).toBe('claude-haiku-4-5-20251001');
      expect(manifest.policy.loadout).toEqual({
        kind: HARNESS_STATE_LOADOUT_KIND,
        name: emission.loadoutName,
        // F9: the profile emits bare hex; the pin carries the `sha256:` spelling.
        digest: `sha256:${emission.candidateTreeDigest}`,
      });

      // The candidate tree really is a different policy from its parent.
      expect(emission.candidateTreeDigest).not.toBe(emission.parentTreeDigest);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('names the parent execution tuple as a typed `tuple` parent reference', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      await runHarnessWithFreezeFence(
        makeHarness(fixture, new ImprovingAdapter()),
        makeCtx(fixture, 'candidate'),
      );

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const manifest = parseExactCandidateManifest(await readFile(emission.manifestPath));

      expect(manifest.parents).toHaveLength(1);
      expect(manifest.parents[0]!.kind).toBe('tuple');
      // The parent digest is the tuple whose loadout pins the PARENT tree.
      const parentTuple = {
        ...manifest.policy,
        loadout: {
          kind: HARNESS_STATE_LOADOUT_KIND,
          name: emission.loadoutName,
          digest: `sha256:${emission.parentTreeDigest}`,
        },
      };
      expect(manifest.parents[0]!.digest).toBe(tupleDigest(parentTuple));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('prefers a typed `candidate` parent when the active policy came from a prior manifest', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const priorManifestDigest = `sha256:${'c'.repeat(64)}`;
      const harness = new LearnerHarness({
        adapter: new ImprovingAdapter(),
        pluginRoot: '/tmp/plugin-root',
        routing: { solverTypes: ['swe-rebench-v2.v1'] },
        candidate: {
          workspaceRoot: fixture.candidateRoot,
          proposerAgentIri: 'did:pkh:eip155:84532:0x1111111111111111111111111111111111111111',
          evidenceProvenance: evidenceProvenanceFixture(),
          priorManifestDigest,
        },
      });
      await runHarnessWithFreezeFence(harness, makeCtx(fixture, 'candidate'));

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const manifest = parseExactCandidateManifest(await readFile(emission.manifestPath));
      expect(manifest.parents).toEqual([{ kind: 'candidate', digest: priorManifestDigest }]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('maps promotion_records and the consolidation_record to declaredChanges', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      await runHarnessWithFreezeFence(
        makeHarness(fixture, new ImprovingAdapter()),
        makeCtx(fixture, 'candidate'),
      );

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const manifest = parseExactCandidateManifest(await readFile(emission.manifestPath));

      expect(manifest.declaredChanges.summary).toContain(
        'Added mandatory base-rate check to the triage skill',
      );
      expect(manifest.declaredChanges.touchedComponents).toContain('skills/triage/SKILL.md');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('carries no score and no self-assessment anywhere in the sealed bytes', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      await runHarnessWithFreezeFence(
        makeHarness(fixture, new ImprovingAdapter()),
        makeCtx(fixture, 'candidate'),
      );

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const text = await readFile(emission.manifestPath, 'utf-8');
      const manifest = JSON.parse(text) as Record<string, unknown>;

      // Structural: validation rejects unrecognized non-namespaced top-level fields,
      // so the only checkable form of the no-self-score rule is the field set itself.
      expect(Object.keys(manifest).sort()).toEqual([
        'compatibility',
        'declaredChanges',
        'evidenceProvenance',
        'formatToken',
        'parents',
        'policy',
        'proposer',
      ]);
      for (const banned of ['score', 'rating', 'confidence', 'selfAssessment', 'quality']) {
        expect(text.toLowerCase()).not.toContain(`"${banned.toLowerCase()}"`);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('attributes the proposal to the operator agent IRI from config', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      await runHarnessWithFreezeFence(
        makeHarness(fixture, new ImprovingAdapter()),
        makeCtx(fixture, 'candidate'),
      );
      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      const manifest = parseExactCandidateManifest(await readFile(emission.manifestPath));
      expect(manifest.proposer).toBe(
        'did:pkh:eip155:84532:0x1111111111111111111111111111111111111111',
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('refuses to seal when the candidate tree is byte-identical to its parent', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      // A run that solves but proposes nothing: no Improve, no Consolidate.
      const inertAdapter: HarnessAdapter = {
        name: 'inert',
        allowsHarnessSelfModification: false,
        async runTask() {},
      };
      await runHarnessWithFreezeFence(
        makeHarness(fixture, inertAdapter),
        makeCtx(fixture, 'candidate'),
      );

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      expect(emission.candidateTreeDigest).toBe(emission.parentTreeDigest);
      expect(emission.manifestPath).toBeUndefined();
      expect(emission.error).toContain('byte-identical to its parent');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails closed — no manifest is emitted when no evidence provenance was supplied', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const harness = new LearnerHarness({
        adapter: new ImprovingAdapter(),
        pluginRoot: '/tmp/plugin-root',
        routing: { solverTypes: ['swe-rebench-v2.v1'] },
        candidate: {
          workspaceRoot: fixture.candidateRoot,
          proposerAgentIri: 'did:pkh:eip155:84532:0x1111111111111111111111111111111111111111',
        },
      });
      await runHarnessWithFreezeFence(harness, makeCtx(fixture, 'candidate'));

      const emission = await readCandidateEmission(fixture.candidateRoot, 'req-1');
      // The tree is still produced (the proposal exists); the manifest is not
      // fabricated from a receipt nobody issued.
      expect(emission.manifestPath).toBeUndefined();
      expect(emission.error).toContain('evidenceProvenance');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('deprecated inline self-mutation — the opt-out', () => {
  const ORIGINAL = process.env[INLINE_MUTATION_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[INLINE_MUTATION_ENV];
    else process.env[INLINE_MUTATION_ENV] = ORIGINAL;
  });

  it('is on by default — train mode still runs the full loop', async () => {
    delete process.env[INLINE_MUTATION_ENV];
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const adapter = new ImprovingAdapter();
      await runHarnessWithFreezeFence(makeHarness(fixture, adapter), makeCtx(fixture, 'train'));
      expect(adapter.lastInputs?.mode).toBe('train');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(['0', 'false', 'no'])('runs train mode under frozen semantics when set to %s', async (value) => {
    process.env[INLINE_MUTATION_ENV] = value;
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const adapter = new ImprovingAdapter();
      // The plugin is told `frozen`, so its §2 phase-range guard skips Improve
      // and Memory consolidation — the phases that do the inline mutation.
      await runHarnessWithFreezeFence(makeHarness(fixture, adapter), makeCtx(fixture, 'train'));
      expect(adapter.lastInputs?.mode).toBe('frozen');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not alter frozen or candidate mode', async () => {
    process.env[INLINE_MUTATION_ENV] = '0';
    for (const mode of ['frozen', 'candidate'] as const) {
      const fixture = await makeFixture();
      try {
        await seedHarvestableSolution(fixture.workingDir);
        const adapter = new ImprovingAdapter();
        await runHarnessWithFreezeFence(makeHarness(fixture, adapter), makeCtx(fixture, mode));
        expect(adapter.lastInputs?.mode).toBe(mode);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it('still harvests cleanly with no Improve or Consolidate artifacts', async () => {
    // The opt-out must not then fail harvest for the very artifacts it told the
    // plugin not to produce.
    process.env[INLINE_MUTATION_ENV] = '0';
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const solveOnlyAdapter: HarnessAdapter = {
        name: 'solve-only',
        allowsHarnessSelfModification: false,
        async runTask() {},
      };
      const fence = await runHarnessWithFreezeFence(
        makeHarness(fixture, solveOnlyAdapter),
        makeCtx(fixture, 'train'),
      );
      expect(fence.ok).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('candidate mode — train and frozen behaviour is unchanged', () => {
  it('train mode still mutates the active directory in place and provisions no candidate', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const harness = makeHarness(fixture, new ImprovingAdapter());
      const before = await hashImplStateDir(fixture.activeDir, harnessHashOptions(harness));

      const fence = await runHarnessWithFreezeFence(harness, makeCtx(fixture, 'train'));
      const after = await hashImplStateDir(fixture.activeDir, harnessHashOptions(harness));

      expect(fence.ok).toBe(true);
      expect(after).not.toBe(before);
      await expect(readdir(fixture.candidateRoot)).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('frozen mode still trips the fence on a mutating harness and provisions no candidate', async () => {
    const fixture = await makeFixture();
    try {
      await seedHarvestableSolution(fixture.workingDir);
      const harness = makeHarness(fixture, new ImprovingAdapter());
      const fence = await runHarnessWithFreezeFence(harness, makeCtx(fixture, 'frozen'));

      expect(fence.ok).toBe(false);
      await expect(readdir(fixture.candidateRoot)).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
