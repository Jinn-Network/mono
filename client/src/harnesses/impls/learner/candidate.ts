/**
 * Candidate mode — the learner as a *proposer* (product design §10; substrate §5).
 *
 * The shipped learner bundles four authorities: it executes the policy, it
 * judges the run, it decides what to change, and it adopts the change. Candidate
 * mode separates the last one. Orient and Execute still run against the ACTIVE
 * `implStateDir`, read-only — that directory *is* the policy under evaluation, so
 * touching it mid-run would mean the thing measured and the thing proposed were
 * never distinguishable. Improve and Consolidate write to a provisioned candidate
 * workspace instead, and the run ends by sealing a `CandidateManifest`: a
 * proposal, carrying lineage and provenance and no score at all.
 *
 * The active directory's immutability is not enforced here. It is enforced by the
 * shipped freeze-fence (`client/src/daemon/freeze-fence.ts`), which takes its
 * non-train branch for candidate mode and therefore hashes, snapshots, runs, and
 * re-hashes exactly as it does for `frozen`. That is deliberate: one enforcement
 * mechanism, already trusted, rather than a second one that could disagree with it.
 *
 * ## Layout
 *
 * ```
 * <workspaceRoot>/<runId>/
 *   tree/            the candidate policy — a writable checkout of the parent
 *   emission.json    parent + candidate digests, manifest digest, or the refusal
 *   manifest.json    the sealed CandidateManifest bytes (absent on refusal)
 * ```
 *
 * `tree/` is a **checkout, not a package**. It carries `.git/` so the promoter's
 * and consolidator's commit discipline works unchanged inside it. Packaging a
 * candidate for transport or materialization must strip every profile-ignored
 * root first — substrate §4.2's fail-closed rule, enforced downstream by
 * `assertMaterializable`. The manifest's loadout digest is computed under
 * `learner-public.v1`, which is blind to those roots, so the digest alone cannot
 * catch a smuggled `.git/hooks/*`; only the refusal can. See FINDING F-C6-3.
 *
 * ## Findings (C6; dispositions proposed, none patched silently)
 *
 * - **F-C6-1 — nothing supplies `evidenceProvenance` yet.** The manifest requires the frozen
 *   evidence input the proposer consumed (substrate §5.1), and C7c owns exclusion-filtered
 *   bundle assembly (program ruling R5). Disposition: candidate mode takes it as a required
 *   input and **refuses to seal without it**, rather than synthesizing a receipt. A fabricated
 *   `QuerySnapshotReceipt` is indistinguishable from an honest one once it is in a population,
 *   so the cost of refusing (one run's manifest) is far below the cost of admitting one.
 *   Closes when C7c wires bundle assembly into the proposer call.
 *
 * - **F-C6-2 — typed `candidate` parents need an adoption record.** `parents` should name the
 *   prior manifest when the active directory was materialized from one (substrate §5.1), but
 *   nothing records that today: the `learner-public.v1` classification is exhaustive at the top
 *   level, so a lineage marker cannot be added *inside* the active tree without failing the
 *   digest closed. Disposition: `priorManifestDigest` is a typed input, unset in v0, to be
 *   populated by C7d's `adopt` path, which is the only component that knows a materialization
 *   happened. Until then every candidate names a `tuple` parent, which is correct but coarser.
 *
 * - **F-C6-3 — the emitted candidate tree is a checkout, not a package.** It carries `.git/`
 *   so the promoter's and consolidator's commit discipline works. Any packaging step must run
 *   `assertMaterializable` (substrate §4.2) and strip profile-ignored roots first; the digest
 *   cannot catch a smuggled `.git/hooks/*` because the profile is blind to it by construction.
 *   Disposition: recorded here and in the Layout note above; packaging is C5/C7's surface.
 *
 * - **F-C6-4 — `isolationPolicy` is pinned to the single value every launcher supports.** The
 *   axis is `vacuous` in substrate §4.3's sense, so tuple agreement on it asserts nothing. It
 *   is pinned anyway so the tuple describes what actually ran; consumers apply the weakest-axis
 *   rule. No action — recorded so the vacuity is not later mistaken for a verified match.
 *
 * - **F-C9-2 — the `model` axis was emitted as a bare id string, and had to be an object.**
 *   Surfaced by the C9 end-to-end campaign, the first consumer to take a manifest this harness
 *   sealed and put it through admission. Substrate §4.1 spells the axis
 *   `{"id": "anthropic/claude-haiku-4-5"}`; `modelConstraintAdmits` in
 *   `task-execution-protocol` reads `.provider`/`.id` off both the constraint and the value, so
 *   a bare string satisfies no model constraint at all; and the Policy Optimization product's
 *   `isExactPin` refuses a non-`{id}` model as constraint-shaped. Because every v0 campaign
 *   freezes the model axis (its mutation surface is exactly `["loadout"]`), the bare spelling
 *   made **every** candidate this harness could emit unadmittable — a total seam break that no
 *   unit test on either side could see, because neither side owns both spellings.
 *   Disposition: fixed here, in `buildPolicyTuple`, because the substrate is the authority and
 *   this side was the one departing from it. The fix changes the emitted `tupleDigest`; no
 *   adoption record or published candidate exists yet, so nothing downstream is invalidated.
 *
 * Authority:
 *   docs/superpowers/specs/2026-08-03-policy-optimization-product-design.md §10
 *   docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md §4.2, §5
 */

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  EXECUTION_TUPLE_FORMAT_TOKEN,
  HARNESS_STATE_LOADOUT_KIND,
  sealCandidateManifest,
  tupleDigest,
  type CandidateEvidenceProvenance,
  type CandidateManifest,
  type ExecutionPolicyTuple,
  type PolicyParentRef,
} from '@jinn-network/policy-identity';
import { hashImplStateDir, type HashImplStateDirOptions } from '../../freeze.js';

/**
 * The env var naming the candidate write target. Set on the spawned harness
 * process via the adapter env allowlist; the plugin's `learn` skill binds it as
 * `candidateStateDir` and points Improve and Consolidate at it.
 */
export const CANDIDATE_DIR_ENV = 'JINN_LEARNER_CANDIDATE_DIR';

/** Compatibility flag: legacy inline train-mode mutation of the active directory. */
export const INLINE_MUTATION_ENV = 'JINN_LEARNER_INLINE_MUTATION';

/** The loadout pin's `name` — a single contained path segment (substrate §4.2). */
const LOADOUT_NAME = 'harness-state';

export interface LearnerCandidateConfig {
  /**
   * Root under which candidate workspaces are provisioned. Defaults to a
   * `candidates/` sibling of the active `implStateDir` when unset.
   */
  workspaceRoot?: string;
  /** Agent IRI of the operator proposing this candidate (substrate §5.1 `proposer`). */
  proposerAgentIri?: string;
  /**
   * The frozen evidence bundle the proposer consumed, digests only. Supplied by
   * the campaign engine (C7c owns exclusion-filtered bundle assembly, ruling R5).
   * Absent → this run emits a tree but refuses to seal a manifest. See FINDING F-C6-1.
   */
  evidenceProvenance?: CandidateEvidenceProvenance;
  /**
   * The candidate manifest the ACTIVE directory was materialized from, if any.
   * Present → `parents` names it as a typed `candidate` reference; absent →
   * `parents` names the parent execution tuple. Recorded by the adoption path
   * (C7d). See FINDING F-C6-2.
   */
  priorManifestDigest?: string;
}

/** The run's own configuration, as the axes of an execution-policy tuple. */
export interface CandidatePolicyAxes {
  readonly harness: string;
  readonly model: string | null;
  readonly isolationPolicy: string | null;
}

/** What a candidate-mode run left on disk. Persisted as `emission.json`. */
export interface CandidateEmission {
  readonly runId: string;
  readonly treeDir: string;
  readonly loadoutName: string;
  /** Bare hex, `learner-public.v1` (F9 — the pin adds the `sha256:` spelling). */
  readonly parentTreeDigest: string;
  readonly candidateTreeDigest: string;
  readonly manifestPath?: string;
  readonly manifestDigest?: string;
  /** Present when the tree was produced but no manifest could honestly be sealed. */
  readonly error?: string;
}

export interface ProvisionedCandidate {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly treeDir: string;
  readonly parentTreeDigest: string;
}

function emissionPath(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, runId, 'emission.json');
}

/**
 * Copy the active policy into a writable candidate checkout and record the
 * parent's identity before anything can touch it.
 *
 * The copy is a plain recursive copy, mirroring the freeze-fence's own snapshot
 * (`cp(..., { recursive: true })`) rather than reaching for a filesystem-specific
 * reflink: the fence already proves the parent is untouched, so the copy's job is
 * only to give Improve somewhere to write.
 */
export async function provisionCandidateWorkspace(params: {
  activeDir: string;
  workspaceRoot: string;
  runId: string;
  hashOpts?: HashImplStateDirOptions;
}): Promise<ProvisionedCandidate> {
  const { activeDir, workspaceRoot, runId } = params;
  const parentTreeDigest = await hashImplStateDir(activeDir, params.hashOpts ?? {});
  const baseDir = join(workspaceRoot, runId);
  const treeDir = join(baseDir, 'tree');
  await mkdir(baseDir, { recursive: true });
  await cp(activeDir, treeDir, { recursive: true });
  return { runId, workspaceRoot, baseDir, treeDir, parentTreeDigest };
}

/** The tuple a candidate proposes: the run's axes, with the loadout repinned. */
export function buildPolicyTuple(
  axes: CandidatePolicyAxes,
  treeDigestBareHex: string,
): ExecutionPolicyTuple {
  return {
    formatToken: EXECUTION_TUPLE_FORMAT_TOKEN,
    harness: axes.harness,
    // F-C9-2: the model axis is an OBJECT keyed by `id`, never the bare id string.
    // Substrate §4.1's tuple is `"model": { "id": "anthropic/claude-haiku-4-5" }`, and
    // the reason is semantic rather than cosmetic: `modelConstraintAdmits`
    // (`task-execution-protocol`) reads `.provider` / `.id` off both sides, so a bare
    // string is admitted by no model constraint at all, and the Policy Optimization
    // product's `isExactPin` refuses it as constraint-shaped. Emitting the bare id made
    // every candidate this harness sealed unadmittable into every v0 campaign, since
    // those freeze the model axis by construction. `null` stays `null` — a run with no
    // model configured pins nothing, and saying so is honest.
    model: axes.model === null ? null : { id: axes.model },
    // F9: `learner-public.v1` emits bare hex; a `jinn.harness-state.v1` loadout
    // pin's `digest` carries the `sha256:`-prefixed spelling.
    loadout: {
      kind: HARNESS_STATE_LOADOUT_KIND,
      name: LOADOUT_NAME,
      digest: `sha256:${treeDigestBareHex}`,
    },
    isolationPolicy: axes.isolationPolicy,
  };
}

interface PromotionRecord {
  changeKind?: unknown;
  target?: unknown;
  summary?: unknown;
}

interface ConsolidationRecord {
  durable?: {
    skillsArchived?: unknown;
    promotionsReverted?: unknown;
    notesCompacted?: unknown;
  };
}

/** Strip the `implStateDir/` / `candidateStateDir/` prefix a promoter may write. */
function normalizeTarget(target: string): string {
  return target.replace(/^(?:implStateDir|candidateStateDir)\//u, '');
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Map the run's `promotion_record`s (Improve) and `consolidation_record`
 * (Consolidate) onto the manifest's `declaredChanges` — the proposer's claim of
 * what changed relative to `parents`. Declared, never verified: the manifest says
 * what the proposer believes it did, and evaluation decides whether it helped.
 */
export async function collectDeclaredChanges(
  workingDir: string,
): Promise<{ summary: string; touchedComponents: string[] }> {
  const summaries: string[] = [];
  const touched = new Set<string>();

  const promotionsDir = join(workingDir, '.improve', 'promotions');
  let promotionFiles: string[] = [];
  try {
    promotionFiles = (await readdir(promotionsDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    promotionFiles = [];
  }
  for (const file of promotionFiles) {
    const record = await readJsonIfPresent<PromotionRecord>(join(promotionsDir, file));
    if (!record) continue;
    if (typeof record.summary === 'string' && record.summary.length > 0) {
      summaries.push(record.summary);
    }
    if (typeof record.target === 'string' && record.target.length > 0) {
      touched.add(normalizeTarget(record.target));
    }
  }

  const consolidation = await readJsonIfPresent<ConsolidationRecord>(
    join(workingDir, '.memory-consolidation', 'consolidation_record.json'),
  );
  const durable = consolidation?.durable;
  if (durable) {
    if (Array.isArray(durable.skillsArchived)) {
      for (const entry of durable.skillsArchived) {
        if (typeof entry === 'string' && entry.length > 0) touched.add(normalizeTarget(entry));
      }
      if (durable.skillsArchived.length > 0) {
        summaries.push(`Consolidation archived ${durable.skillsArchived.length} skill(s)`);
      }
    }
    if (Array.isArray(durable.promotionsReverted) && durable.promotionsReverted.length > 0) {
      summaries.push(`Consolidation reverted ${durable.promotionsReverted.length} promotion(s)`);
    }
    if (typeof durable.notesCompacted === 'number' && durable.notesCompacted > 0) {
      summaries.push(`Consolidation compacted ${durable.notesCompacted} note(s)`);
    }
  }

  const summary = summaries.length > 0
    ? summaries.join('; ')
    : 'No Improve or Consolidate mutation was recorded for this run.';
  return { summary, touchedComponents: [...touched].sort() };
}

/**
 * Seal the candidate manifest and write the emission record.
 *
 * Fail-closed on missing `evidenceProvenance`: a manifest whose provenance was
 * invented names a `QuerySnapshotReceipt` nobody issued, and that document would
 * be indistinguishable from an honest one once it entered a population. Refusing
 * costs a run; fabricating costs the field its meaning.
 */
export async function emitCandidate(params: {
  provisioned: ProvisionedCandidate;
  workingDir: string;
  axes: CandidatePolicyAxes;
  config: LearnerCandidateConfig;
  hashOpts?: HashImplStateDirOptions;
}): Promise<CandidateEmission> {
  const { provisioned, workingDir, axes, config } = params;
  const { workspaceRoot } = provisioned;
  const candidateTreeDigest = await hashImplStateDir(provisioned.treeDir, params.hashOpts ?? {});

  const base = {
    runId: provisioned.runId,
    treeDir: provisioned.treeDir,
    loadoutName: LOADOUT_NAME,
    parentTreeDigest: provisioned.parentTreeDigest,
    candidateTreeDigest,
  };

  const refuse = async (error: string): Promise<CandidateEmission> => {
    const emission: CandidateEmission = { ...base, error };
    await writeFile(
      emissionPath(workspaceRoot, provisioned.runId),
      `${JSON.stringify(emission, null, 2)}\n`,
    );
    return emission;
  };

  // A run whose Improve and Consolidate phases changed nothing has proposed
  // nothing. Sealing it anyway would mint a manifest whose policy tuple is
  // byte-identical to its own declared parent — a self-parented candidate that
  // admission would key to the parent's own `tupleDigest`, silently joining the
  // parent's arm and spending evaluation budget re-measuring a policy already in
  // the population. Refuse: "nothing changed" is a legitimate outcome of a
  // learning run, just not a proposal.
  if (candidateTreeDigest === provisioned.parentTreeDigest) {
    return await refuse(
      'candidate tree is byte-identical to its parent — nothing was proposed',
    );
  }

  if (!config.evidenceProvenance) {
    return await refuse(
      'no evidenceProvenance was supplied to candidate mode; refusing to seal a manifest whose ' +
        'provenance would be fabricated (substrate §5.1 — the frozen evidence input is required)',
    );
  }
  if (!config.proposerAgentIri) {
    return await refuse(
      'no proposer Agent IRI is configured (harness.candidate.proposerAgentIri); refusing to seal ' +
        'an unattributable candidate (substrate §5.1)',
    );
  }

  const policy = buildPolicyTuple(axes, candidateTreeDigest);
  const parents: PolicyParentRef[] = config.priorManifestDigest
    ? [{ kind: 'candidate', digest: config.priorManifestDigest }]
    : [{ kind: 'tuple', digest: tupleDigest(buildPolicyTuple(axes, provisioned.parentTreeDigest)) }];

  const manifest: CandidateManifest = {
    formatToken: CANDIDATE_MANIFEST_FORMAT_TOKEN,
    policy,
    parents,
    proposer: config.proposerAgentIri,
    evidenceProvenance: config.evidenceProvenance,
    declaredChanges: await collectDeclaredChanges(workingDir),
    compatibility: { harnesses: [axes.harness] },
  };

  let sealed: { bytes: Uint8Array; digest: string };
  try {
    sealed = sealCandidateManifest(manifest);
  } catch (err) {
    return await refuse(
      `candidate manifest failed validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const manifestPath = join(provisioned.baseDir, 'manifest.json');
  await writeFile(manifestPath, sealed.bytes);
  const emission: CandidateEmission = { ...base, manifestPath, manifestDigest: sealed.digest };
  await writeFile(
    emissionPath(workspaceRoot, provisioned.runId),
    `${JSON.stringify(emission, null, 2)}\n`,
  );
  return emission;
}

/** Read back what a candidate-mode run emitted. The campaign engine's entry point. */
export async function readCandidateEmission(
  workspaceRoot: string,
  runId: string,
): Promise<CandidateEmission> {
  return JSON.parse(await readFile(emissionPath(workspaceRoot, runId), 'utf-8')) as CandidateEmission;
}

/**
 * Whether legacy inline train-mode mutation is enabled.
 *
 * Train mode mutates the active `implStateDir` in place — fast local adaptation
 * with no identity boundary, which is why product design §10 retires it once the
 * first campaign completes end-to-end. It survives now as a compatibility mode;
 * candidate mode never depends on it.
 */
export function inlineMutationEnabled(): boolean {
  const raw = process.env[INLINE_MUTATION_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}
