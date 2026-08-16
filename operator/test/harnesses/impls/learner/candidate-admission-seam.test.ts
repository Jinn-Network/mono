/**
 * C9 leg 2 — the C6 -> C7c seam, end to end: the learner's output is admissible input.
 *
 * A candidate-mode run of the *shipped* `LearnerHarness`, driven by a scripted adapter (no Claude
 * CLI, no network), against a parent policy that is byte-for-byte the Policy Optimization
 * product's own seed fixture. What it emits — the sealed `CandidateManifest` and the materialized
 * candidate tree — is written out as the two fixtures the product's end-to-end campaign admits
 * through its unmodified admission gate.
 *
 * ## FINDING F-C9-1 — where the cross-product seam lives, and where it should eventually live
 *
 * `operator/` **cannot** import `@jinn-network/policy-optimization`, and this is enforced twice:
 *
 * - `architecture/platform-packages.v1.json` puts `@jinn-network/policy-optimization` in release
 *   group `transitional-or-private` (`publishPolicy: "never"`), while `@jinn-network/client` sits
 *   in `legacy-product-lines`, whose `allowedDependencyReleaseGroups` does not include it.
 * - `.github/scripts/policy-optimization-source-boundaries.test.mjs` denies `@jinn-network/client`
 *   **by name** in the product's own `EXPLICITLY_DENIED` list, and forbids its source from
 *   relative-escaping into `operator/`.
 *
 * Both directions are deliberate, so the seam between the two packages is what the design says it
 * is: **the sealed bytes, and nothing else**. This test therefore does the honest thing rather
 * than the convenient one — it takes the evidence-bundle provenance as **opaque input** (a
 * committed document the product authored via `assembleEvidenceBundle`, consumed here per the
 * learner's own contract, which requires provenance and refuses to fabricate it — F-C6-1), and it
 * publishes its output as committed bytes rather than as a shared type.
 *
 * The cost is a two-file fixture contract, and it is a real cost: nothing but this test's
 * byte-equality assertion keeps the two sides in step, and a change on either side that is not
 * regenerated here fails *here* rather than at the boundary that actually matters. Where this
 * should eventually live: a small conformance-fixture package both tiers may depend on (the
 * `benchmarking-records` / TEP conformance-kit pattern, which already solves exactly this for the
 * task-execution tier), or — better — the product consuming a *published* learner candidate
 * artifact through the #2117–#2120 checkpoint train, which is the real distribution path and would
 * make this fixture redundant. Neither is in this program's scope; the finding is filed rather
 * than patched around.
 *
 * ## Where the admission assertion lives
 *
 * Not here — it cannot be. This side proves the bytes are *what the shipped learner emits*; the
 * product side proves they are *admissible*, in
 * `packages/policy-optimization/src/e2e/campaign.test.ts`, which feeds these exact bytes through
 * the unmodified eleven-check gate and puts the resulting arm in a real wave. Read as a pair, the
 * two files close the claim; read alone, neither does.
 *
 * That pairing is what caught **F-C9-2** (see `../../../../src/harnesses/impls/learner/candidate.ts`):
 * this harness emitted the `model` axis as a bare id string, which no campaign can admit. Nothing
 * on either side could have seen it, because neither side owned both spellings.
 *
 * Regenerate the fixtures with `JINN_C9_WRITE_FIXTURES=1 yarn vitest run <this file>`.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  EXECUTION_TUPLE_FORMAT_TOKEN,
  HARNESS_STATE_LOADOUT_KIND,
  hashTreeLearnerPublicV1,
  parseExactCandidateManifest,
  tupleDigest,
  validateCandidateManifest,
  type CandidateEvidenceProvenance,
  type TreeEntry,
} from '@jinn-network/policy-identity';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/harness.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
} from '../../../../src/harnesses/impls/learner/types.js';
import {
  CANDIDATE_DIR_ENV,
  readCandidateEmission,
} from '../../../../src/harnesses/impls/learner/candidate.js';
import { runHarnessWithFreezeFence } from '../../../../src/daemon/freeze-fence.js';
import { hashImplStateDir, harnessHashOptions } from '../../../../src/harnesses/freeze.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

/** The product package's fixture directory — read as documents, never imported as a module. */
const FIXTURES = fileURLToPath(
  new URL('../../../../../packages/policy-optimization/fixtures/learner/', import.meta.url),
);
const WRITE = process.env['JINN_C9_WRITE_FIXTURES'] === '1';

function readFixture(name: string): string {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) {
    throw new Error(
      `missing seam fixture ${path}. Regenerate with JINN_C9_WRITE_FIXTURES=1 (see F-C9-1).`,
    );
  }
  return readFileSync(path, 'utf-8');
}

/**
 * The parent policy, taken verbatim from the product's seed fixture. Seeding from the product's
 * own bytes is what makes the emitted manifest's `parents[0]` resolve to the campaign's seed tuple
 * rather than to a lookalike.
 */
const SEED_TREE = JSON.parse(readFixture('seed-tree.json')) as TreeEntry[];

/** Opaque input, per the learner's contract: the product assembled it; this side does not inspect it. */
const EVIDENCE_PROVENANCE = JSON.parse(
  readFixture('evidence-provenance.json'),
) as CandidateEvidenceProvenance;

const PROPOSER = 'did:pkh:eip155:84532:0x1111111111111111111111111111111111111111';
const MODEL = 'claude-haiku-4-5-20251001';

/** Materialize the product's `TreeEntry[]` seed onto disk as a real `implStateDir`. */
async function seedActiveState(dir: string): Promise<void> {
  for (const entry of SEED_TREE) {
    if (entry.kind !== 'file') continue;
    const path = join(dir, ...entry.path.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.content ?? '');
  }
}

/** Walk a directory back into the `TreeEntry[]` shape, sorted by path. */
async function readTree(dir: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function walk(current: string): Promise<void> {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(current, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        entries.push({
          path: relative(dir, full).split(sep).join('/'),
          kind: 'file',
          content: await readFile(full, 'utf-8'),
        });
      }
    }
  }
  await walk(dir);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Stands in for the Claude CLI: writes exactly what the Improve and Consolidate phases write, to
 * whichever directory the harness told it to write to.
 *
 * It confines itself to `skills/` on purpose. The campaign declares `mutablePaths.prefixes:
 * ["skills/"]` (ruling R2's additive per-file check), so a candidate that also pruned a note would
 * be refused at admission check 7 — correctly, and for a reason that has nothing to do with the
 * seam under test here.
 */
class RepositoryWorkImprover implements HarnessAdapter {
  readonly name = 'repository-work-improver';
  readonly allowsHarnessSelfModification = false;
  lastInputs?: TaskSessionInputs;

  async runTask(inputs: TaskSessionInputs): Promise<void> {
    this.lastInputs = inputs;
    const writeTarget = inputs.adapterEnv?.[CANDIDATE_DIR_ENV] ?? inputs.implStateDir;

    // Improve: sharpen an existing skill.
    await mkdir(join(writeTarget, 'skills', 'run-focused-tests'), { recursive: true });
    await writeFile(
      join(writeTarget, 'skills', 'run-focused-tests', 'SKILL.md'),
      '# Run focused tests\n\nRun the single failing test before the module, and the module '
        + 'before the suite.\n\n## Added by Improve\n\nRe-run the failing test after every edit, '
        + 'not once at the end.\n',
    );

    // Improve: promote a new skill the debriefs kept recommending.
    await mkdir(join(writeTarget, 'skills', 'reproduce-first'), { recursive: true });
    await writeFile(
      join(writeTarget, 'skills', 'reproduce-first', 'SKILL.md'),
      '# Reproduce first\n\nReproduce the failure locally before reading the implementation.\n',
    );

    // One promotion_record per accepted mutation, in workingDir.
    await mkdir(join(inputs.workingDir, '.improve', 'promotions'), { recursive: true });
    await writeFile(
      join(inputs.workingDir, '.improve', 'promotions', '1.json'),
      JSON.stringify({
        ts: 1_716_800_000_000,
        changeKind: 'skill-edit',
        target: 'skills/run-focused-tests/SKILL.md',
        summary: 'Re-run the failing test after every edit',
        analysisSource: 'recommendationsForImprove[0]',
      }),
    );
    await writeFile(
      join(inputs.workingDir, '.improve', 'promotions', '2.json'),
      JSON.stringify({
        ts: 1_716_800_000_500,
        changeKind: 'skill-add',
        target: 'skills/reproduce-first/SKILL.md',
        summary: 'Promoted a reproduce-first skill from three debrief runs',
        analysisSource: 'recommendationsForImprove[1]',
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
  const root = await mkdtemp(join(tmpdir(), 'jinn-c9-seam-'));
  const activeDir = join(root, 'active');
  const workingDir = join(root, 'work');
  const candidateRoot = join(root, 'candidates');
  await mkdir(activeDir, { recursive: true });
  await mkdir(workingDir, { recursive: true });
  await seedActiveState(activeDir);
  return { root, activeDir, workingDir, candidateRoot };
}

function makeCtx(fixture: Fixture): HarnessContext {
  return {
    task: {
      id: 'task-1',
      solverType: 'swe-rebench-v2.v1',
      window: { startTs: 0, endTs: 0 },
    } as HarnessContext['task'],
    requestId: 'c9-seam',
    solverNet: { name: 'net', solverType: 'swe-rebench-v2.v1', model: MODEL },
    implStateDir: fixture.activeDir,
    workingDir: fixture.workingDir,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => {} } as unknown as HarnessContext['trajectory'],
    mode: 'candidate',
  } as HarnessContext;
}

function makeHarness(fixture: Fixture): LearnerHarness {
  return new LearnerHarness({
    adapter: new RepositoryWorkImprover(),
    pluginRoot: '/tmp/plugin-root',
    routing: { solverTypes: ['swe-rebench-v2.v1'] },
    candidate: {
      workspaceRoot: fixture.candidateRoot,
      proposerAgentIri: PROPOSER,
      evidenceProvenance: EVIDENCE_PROVENANCE,
    },
  });
}

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

interface Emitted {
  manifestBytes: Buffer;
  tree: TreeEntry[];
  parentTreeDigest: string;
  candidateTreeDigest: string;
}

/** One candidate-mode run of the real harness, through the real freeze-fence. */
async function emitOnce(): Promise<Emitted> {
  const fixture = await makeFixture();
  try {
    await seedHarvestableSolution(fixture.workingDir);
    const harness = makeHarness(fixture);
    const before = await hashImplStateDir(fixture.activeDir, harnessHashOptions(harness));
    const fence = await runHarnessWithFreezeFence(harness, makeCtx(fixture));
    const after = await hashImplStateDir(fixture.activeDir, harnessHashOptions(harness));

    // The proposer must not have adopted its own proposal.
    expect(fence.ok).toBe(true);
    expect(after).toBe(before);

    const emission = await readCandidateEmission(fixture.candidateRoot, 'c9-seam');
    expect(emission.error).toBeUndefined();
    expect(emission.manifestPath).toBeDefined();
    return {
      manifestBytes: await readFile(emission.manifestPath!),
      tree: await readTree(emission.treeDir),
      parentTreeDigest: emission.parentTreeDigest,
      candidateTreeDigest: emission.candidateTreeDigest,
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

const emitted = await emitOnce();

describe('C6 candidate mode emits a real sealed manifest with no CLI', () => {
  it('validates through the substrate validator and is its own sealed form', () => {
    const parsed = parseExactCandidateManifest(emitted.manifestBytes);
    expect(validateCandidateManifest(parsed).ok).toBe(true);
    expect(parsed.formatToken).toBe(CANDIDATE_MANIFEST_FORMAT_TOKEN);
  });

  it('carries the evidence provenance the product issued, verbatim', () => {
    const parsed = parseExactCandidateManifest(emitted.manifestBytes);
    // Opaque to this side by design (F-C9-1): copied through, never reconstructed.
    expect(parsed.evidenceProvenance).toEqual(EVIDENCE_PROVENANCE);
  });

  it('names the product seed policy as its typed `tuple` parent', () => {
    const parsed = parseExactCandidateManifest(emitted.manifestBytes);
    const parentTuple = {
      formatToken: EXECUTION_TUPLE_FORMAT_TOKEN,
      harness: parsed.policy.harness,
      model: parsed.policy.model,
      loadout: {
        kind: HARNESS_STATE_LOADOUT_KIND,
        name: 'harness-state',
        digest: `sha256:${emitted.parentTreeDigest}`,
      },
      isolationPolicy: parsed.policy.isolationPolicy,
    };
    expect(parsed.parents).toEqual([{ kind: 'tuple', digest: tupleDigest(parentTuple) }]);
    // ...and the parent tree really is the product's seed, hashed by the product's own profile.
    expect(emitted.parentTreeDigest).toBe(hashTreeLearnerPublicV1(SEED_TREE));
  });

  it('confines its changes to `skills/`, which is what the campaign declares mutable', () => {
    const changed = emitted.tree.filter((entry) => {
      const parent = SEED_TREE.find((seed) => seed.path === entry.path);
      return parent === undefined || parent.content !== entry.content;
    });
    const removed = SEED_TREE.filter(
      (seed) => !emitted.tree.some((entry) => entry.path === seed.path),
    );
    expect(removed).toEqual([]);
    expect(changed.length).toBeGreaterThan(0);
    for (const entry of changed) expect(entry.path.startsWith('skills/'), entry.path).toBe(true);
  });
});

describe('the two implementations of learner-public.v1 agree', () => {
  it("the client's directory walk and the product's in-memory hash produce one digest", () => {
    // This is the load-bearing seam assertion. `hashImplStateDir(dir, {profile:'learner-public.v1'})`
    // walks a real filesystem; `hashTreeLearnerPublicV1(entries)` hashes described entries. They
    // are independent implementations of one published profile, and a campaign's materialization
    // check (admission #6) is exactly a comparison across them. If they ever disagree, every
    // learner-emitted candidate becomes unadmittable.
    expect(hashTreeLearnerPublicV1(emitted.tree)).toBe(emitted.candidateTreeDigest);
  });

  it('the manifest pins the loadout to that shared digest', () => {
    const parsed = parseExactCandidateManifest(emitted.manifestBytes);
    expect(parsed.policy.loadout).toEqual({
      kind: HARNESS_STATE_LOADOUT_KIND,
      name: 'harness-state',
      // F9: the profile emits bare hex; the pin carries the `sha256:` spelling.
      digest: `sha256:${hashTreeLearnerPublicV1(emitted.tree)}`,
    });
    expect(emitted.candidateTreeDigest).not.toBe(emitted.parentTreeDigest);
  });
});

describe('the emitted bytes are the fixture the product campaign admits', () => {
  it('matches the committed manifest fixture byte for byte', () => {
    const path = join(FIXTURES, 'candidate-manifest.json');
    if (WRITE) writeFileSync(path, emitted.manifestBytes);
    expect(existsSync(path)).toBe(true);
    expect(Buffer.compare(readFileSync(path), emitted.manifestBytes)).toBe(0);
  });

  it('matches the committed tree fixture byte for byte', () => {
    const path = join(FIXTURES, 'candidate-tree.json');
    const text = `${JSON.stringify(emitted.tree, null, 2)}\n`;
    if (WRITE) writeFileSync(path, text);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(text);
  });

  it('is deterministic — a second run emits the same bytes', async () => {
    const again = await emitOnce();
    expect(Buffer.compare(again.manifestBytes, emitted.manifestBytes)).toBe(0);
    expect(again.tree).toEqual(emitted.tree);
  });
});
