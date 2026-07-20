/**
 * The bridge — SolverNet execution ledger → layer-1 evidence
 * (spec/2026-07-06-distillation-v1.md §8, D5/D10).
 *
 * Turns swe-rebench attempts into canonical `jinn.episode.v1` evidence via
 * the existing `capture()`→`publish()` pipe, scrubbed at the **layer-2
 * (secret-only) altitude** (D6 — a verified swe-rebench solve is public-repo
 * work, not raw private-machine activity). It sources **both polarities** (D10):
 * verified passes → pattern-eligible evidence; evaluator-confirmed failures →
 * lesson-eligible evidence. Held-out `cap-v0` slate instances are excluded by
 * `instance_id` AND repo; each `(instance_id, polarity)` is retained up to
 * `groupCap` attempts (default 1) so the per-instance attempt group survives for
 * group-relative distillation (#1478).
 *
 * This module is the bridge **core + the publish adapter**. The ledger row
 * source (indexer GraphQL over `verdictEnvelopeMeta`, both polarities) and the
 * IPFS/corpus evidence fetch are injected ports (`BridgeDeps`) — the production
 * adapters are thin and wired at run time; the logic here is what carries the
 * tests.
 */

import { capture, type CapturedTask } from './capture.js';
import { publish, type HarnessPublishDeps } from './publish.js';
import { buildLayer2ScrubPipeline } from '../../../src/trajectory/scrub/layer2.js';
import type { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';

/** A verdict row from the execution ledger, one polarity. */
export interface AttemptRef {
  requestId: string;
  chainId: number;
  /** swe-rebench `instance_id` (owner__repo-N). */
  instanceId: string;
  /** Model the attempt ran under (from `attemptEnvelopeMeta.model`). */
  model: string;
  /** The attempt envelope CID — where the solution patch + task descriptor live. */
  manifestCid: string;
  /** `pass` = verified solve (→ pattern); `fail` = evaluator-confirmed FAIL (→ lesson). */
  polarity: 'pass' | 'fail';
  /**
   * The VERDICT envelope CID — the entry point of the verified 3-hop join to
   * the solver's solution patch (verdict envelope → task doc
   * `restorationRequestId` → attemptEnvelopeMeta → solution envelope). The
   * verdict-source populates it; callers that already carry a resolved
   * `manifestCid` (e.g. the corpus fetcher) do not need it.
   */
  verdictManifestCid?: string;
  /** Echo/lineage key — instances sharing a key are not independent corroboration. */
  sourceLineageKey?: string;
  lookupFlagged?: boolean;
}

/** Evidence fetched for one attempt (the injected IPFS/corpus port). */
export interface BridgeEvidence {
  /** The instance problem statement (scrubbed downstream by capture's layer-2 pipeline). */
  taskSummary: string;
  /** The unified-diff patch the attempt produced. */
  patch: string;
  /** `owner/repo` when known (tag + audit); defaults from the instance id. */
  repo?: string;
  /** First-class native tuple facts copied from the signed solution/task. */
  baseCommit?: string;
  taskCreatedAt?: number;
  instanceId?: string;
  generatorModel?: CapturedTask['environment']['generatorModel'];
  distributionClass?: CapturedTask['environment']['distributionClass'];
  failToPass?: string[];
  passToPass?: string[];
  evalSemanticsVersion?: string;
  /**
   * The solver's own compressed decision-path outline, derived from the raw
   * harness transcript inside the solution's `system_snapshot` artifact
   * (`.claude-code/stdout.jsonl` / `.codex-code/stdout.jsonl` — §8, #1472;
   * `jinn.trajectory.v1` carries no reasoning until #1473). A patch shows
   * *what* changed, not the decision path; pattern-mode under-feeds without
   * it. When absent (hermes, missing/corrupt snapshot), the layer-1 record is
   * tagged `patch-only` (see `toBridgeCapturedTask`) so measurement can
   * stratify by evidence richness. Rides a step attribute → scrubbed by the
   * same layer-2 pipeline as every other attribute; it does not bypass scrub.
   */
  stepTrace?: string;
}

export interface BridgeDeps {
  /** The held-out `cap-v0` slate instance ids (§12). Repo exclusion is derived from these. */
  slateInstanceIds: Set<string>;
  /** Fetch the patch + task descriptor for an attempt (IPFS/corpus). */
  fetchEvidence: (ref: AttemptRef) => Promise<BridgeEvidence>;
  /** Publish a constructed CapturedTask as layer-1 evidence; returns the corpus ref. */
  publishEvidence: (task: CapturedTask, ref: AttemptRef) => Promise<{ envelopeRef: string; anchorTx: string | null }>;
  /** Weak-suite instance ids (discrimination fail) — excluded from bridge input. */
  weakSuiteInstanceIds?: Set<string>;
  /** Lookup-flagged instance ids — excluded from distillation input. */
  lookupFlaggedInstanceIds?: Set<string>;
  /**
   * Attempts retained per `(instance_id, polarity)` — the per-instance attempt
   * GROUP is the distiller's raw material for group-relative distillation
   * (#1478). Default 1 keeps the single-exemplar behavior for standalone
   * callers; the pipeline passes a higher cap so clustering receives the whole
   * group. Rows beyond the cap are recorded in `BridgeResult.deduped`, and
   * since refs arrive in a stable order the kept K are deterministic.
   */
  groupCap?: number;
  now?: () => Date;
}

export interface BridgeResult {
  bridged: Array<{ instanceId: string; polarity: 'pass' | 'fail'; envelopeRef: string; anchorTx: string | null }>;
  excludedHeldOut: Array<{ instanceId: string; reason: 'instance_id' | 'repo' }>;
  /** Attempts dropped because their `(instance_id, polarity)` group already held `groupCap` (#1478). */
  deduped: Array<{ instanceId: string; polarity: 'pass' | 'fail' }>;
  errors: Array<{ requestId: string; error: string }>;
  /**
   * Slate `instance_id`s whose repo could NOT be derived (`repoFromInstanceId`
   * → null). Repo-axis exclusion (§12) is incomplete for these: a same-repo
   * sibling of such a slate id would NOT be caught by the derived-repo guard,
   * only by an exact `instance_id` match. Surfaced (not silently dropped) so an
   * operator sees the contamination-boundary gap; empty once cap-v0 carries
   * repos explicitly.
   */
  unresolvedSlateIds: string[];
}

/**
 * Derive `owner/repo` from a SWE-bench `instance_id` (`owner__repo-<pr#>`),
 * or null when the id does not match the convention. cap-v0 will carry repos
 * explicitly; until then repo exclusion (§12) is derived here.
 */
export function repoFromInstanceId(instanceId: string): string | null {
  const m = /^(.+)__(.+)-\d+$/.exec(instanceId);
  return m ? `${m[1]}/${m[2]}` : null;
}

const NANO = (d: Date): string => `${d.getTime()}000000`;

/**
 * Construct the layer-1 `CapturedTask` for one attempt (both polarities, D10).
 *
 * The full patch goes into the `apply_patch` step attribute. Note: `capture()`
 * caps step attributes at `MAX_STEP_ATTRIBUTES_BYTES` (16 KiB) and truncates the
 * largest value with a receipted `…[truncated]` suffix, so a patch over that
 * bound is stored truncated (inherited from the frozen pipe, D5 — not
 * re-implemented here). Real SWE-bench patches can exceed 16 KiB; the truncation
 * is recorded in the envelope's step receipt, not silent.
 *
 * Evidence-richness (§8, v0.5): when `ev.stepTrace` is present, a
 * `solver:trajectory` step is inserted between the patch and verdict steps (its
 * content is a plain step attribute → scrubbed like the patch). When absent, a
 * `patch-only` tag is appended to `distributionTags` so the three-arm
 * measurement (§11) can stratify distillation quality by evidence richness.
 */
export function toBridgeCapturedTask(ref: AttemptRef, ev: BridgeEvidence, now: Date): CapturedTask {
  const nano = NANO(now);
  const isPass = ref.polarity === 'pass';
  const repo = ev.repo ?? repoFromInstanceId(ref.instanceId) ?? undefined;
  const enriched = typeof ev.stepTrace === 'string' && ev.stepTrace.length > 0;
  return {
    session: {
      sessionId: `bridge:${ref.instanceId}:${ref.polarity}:${ref.requestId}`,
      capturedAt: now.toISOString(),
    },
    task: {
      summary: `swe-rebench ${ref.instanceId}: ${ev.taskSummary}`.slice(0, 500),
      distributionTags: [
        'coding',
        'swe-rebench',
        ...(repo ? [repo.slice(0, 64)] : []),
        ...(enriched ? [] : ['patch-only']),
      ],
      ...(repo ? { repositorySlug: repo } : {}),
      ...(ev.baseCommit ? { baseCommit: ev.baseCommit } : {}),
      ...(ev.taskCreatedAt !== undefined ? { createdAt: ev.taskCreatedAt } : {}),
      instanceId: ev.instanceId ?? ref.instanceId,
    },
    environment: {
      harness: { name: 'jinn-execution-ledger-bridge', version: '0.1.0' },
      model: ref.model || 'unknown',
      tools: [],
      ...(ev.generatorModel ? { generatorModel: ev.generatorModel } : {}),
      ...(ev.distributionClass ? { distributionClass: ev.distributionClass } : {}),
      ...(ev.failToPass !== undefined
        || ev.passToPass !== undefined
        || ev.evalSemanticsVersion !== undefined
        ? {
            verifier: {
              type: 'f2p-p2p' as const,
              failToPass: ev.failToPass ?? [],
              passToPass: ev.passToPass ?? [],
              ...(ev.evalSemanticsVersion
                ? { evalSemanticsVersion: ev.evalSemanticsVersion }
                : {}),
            },
          }
        : {}),
    },
    steps: [
      {
        spanId: 'patch',
        parentSpanId: null,
        kind: 'jinn.tool_call' as const,
        name: 'tool:apply_patch',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: { patch: ev.patch },
        redactedKeys: [],
      },
      ...(enriched
        ? [
            {
              spanId: 'trace',
              parentSpanId: null,
              kind: 'jinn.tool_call' as const,
              name: 'solver:trajectory',
              startTimeUnixNano: nano,
              endTimeUnixNano: nano,
              attributes: { trace: ev.stepTrace as string },
              redactedKeys: [],
            },
          ]
        : []),
      {
        spanId: 'verdict',
        parentSpanId: null,
        kind: 'jinn.tool_call' as const,
        name: 'evaluator:verdict',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: { evaluatorVerdict: isPass ? 'PASS' : 'FAIL', actualPassed: isPass },
        redactedKeys: [],
      },
    ],
    outcome: isPass
      ? { status: 'completed', verifiabilityTier: 'evaluator-verified' }
      : {
          status: 'failed',
          verifiabilityTier: 'evaluator-verified',
          summary: 'evaluator-confirmed failure (lesson-eligible)',
        },
    cost: { durationMs: 0 },
    attemptGroup: {
      groupId: ev.instanceId ?? ref.instanceId,
      attemptId: ref.requestId,
      relatedAttemptRefs: [],
    },
    provenance: 'contributed',
  };
}

/**
 * Bridge a batch of ledger verdict rows into layer-1 evidence. Exclusion
 * (instance_id + derived repo) and dedup happen before any fetch/publish.
 */
export async function bridgeAttempts(refs: AttemptRef[], deps: BridgeDeps): Promise<BridgeResult> {
  const now = deps.now?.() ?? new Date();
  // Derive the slate repos for axis-2 exclusion, and surface any slate id whose
  // repo cannot be derived — repo-exclusion is incomplete for those (see
  // BridgeResult.unresolvedSlateIds), rather than silently narrowing the guard.
  const slateRepos = new Set<string>();
  const unresolvedSlateIds: string[] = [];
  for (const id of deps.slateInstanceIds) {
    const r = repoFromInstanceId(id);
    if (r) slateRepos.add(r);
    else unresolvedSlateIds.push(id);
  }
  const result: BridgeResult = { bridged: [], excludedHeldOut: [], deduped: [], errors: [], unresolvedSlateIds };
  // Retain up to `groupCap` attempts per (instance_id, polarity) — keep the whole
  // attempt group, not one exemplar (#1478). Kept-K is deterministic (refs arrive
  // in a stable order); rows beyond the cap are recorded in `deduped`.
  const groupCap = Math.max(1, deps.groupCap ?? 1);
  const kept = new Map<string, number>();

  for (const ref of refs) {
    if (deps.weakSuiteInstanceIds?.has(ref.instanceId)) {
      result.excludedHeldOut.push({ instanceId: ref.instanceId, reason: 'instance_id' });
      continue;
    }
    if (deps.lookupFlaggedInstanceIds?.has(ref.instanceId)) {
      result.deduped.push({ instanceId: ref.instanceId, polarity: ref.polarity });
      continue;
    }
    if (deps.slateInstanceIds.has(ref.instanceId)) {
      result.excludedHeldOut.push({ instanceId: ref.instanceId, reason: 'instance_id' });
      continue;
    }
    const repo = repoFromInstanceId(ref.instanceId);
    if (repo && slateRepos.has(repo)) {
      result.excludedHeldOut.push({ instanceId: ref.instanceId, reason: 'repo' });
      continue;
    }
    const key = `${ref.instanceId}:${ref.polarity}`;
    if ((kept.get(key) ?? 0) >= groupCap) {
      result.deduped.push({ instanceId: ref.instanceId, polarity: ref.polarity });
      continue;
    }
    try {
      const ev = await deps.fetchEvidence(ref);
      const task = toBridgeCapturedTask(ref, ev, now);
      const pub = await deps.publishEvidence(task, ref);
      // Count only SUCCESSFUL bridges toward the cap — the evidence fetch is a
      // fragile multi-hop join (bridge-fetch-evidence.ts); a miss must not spend
      // a group slot, so a later candidate for the same key can still backfill.
      kept.set(key, (kept.get(key) ?? 0) + 1);
      result.bridged.push({
        instanceId: ref.instanceId,
        polarity: ref.polarity,
        envelopeRef: pub.envelopeRef,
        anchorTx: pub.anchorTx,
      });
    } catch (err) {
      result.errors.push({ requestId: ref.requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * The production `publishEvidence`: run the CapturedTask through `capture()`
 * with the **layer-2 (secret-only) pipeline** injected (D6), then `publish()` —
 * emitting a canonical `jinn.episode.v1` artifact. Reuses the scrubbed pipe; the only
 * departure from a native capture is the scrub altitude.
 */
export function buildBridgeEvidencePublisher(
  deps: HarnessPublishDeps,
  opts: { pipeline?: ScrubPipeline } = {},
): (task: CapturedTask, ref: AttemptRef) => Promise<{ envelopeRef: string; anchorTx: string | null }> {
  const pipeline = opts.pipeline ?? buildLayer2ScrubPipeline();
  return async (task) => {
    const pending = await capture(task, { pipeline });
    const published = await publish(pending, deps);
    if (published.vetoed) throw new Error('unexpected veto bridging evidence');
    return { envelopeRef: published.envelopeRef, anchorTx: published.anchorTx };
  };
}
