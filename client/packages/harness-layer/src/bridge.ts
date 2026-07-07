/**
 * The bridge — SolverNet execution ledger → layer-1 evidence
 * (spec/2026-07-06-distillation-v1.md §8, D5/D10).
 *
 * Turns swe-rebench attempts into layer-1 `jinn.trace-envelope.v0` evidence via
 * the existing frozen `capture()`→`publish()` pipe, scrubbed at the **layer-2
 * (secret-only) altitude** (D6 — a verified swe-rebench solve is public-repo
 * work, not raw private-machine activity). It sources **both polarities** (D10):
 * verified passes → pattern-eligible evidence; evaluator-confirmed failures →
 * lesson-eligible evidence. Held-out `cap-v0` slate instances are excluded by
 * `instance_id` AND repo; each `(instance_id, polarity)` is deduped.
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
}

/** Evidence fetched for one attempt (the injected IPFS/corpus port). */
export interface BridgeEvidence {
  /** The instance problem statement (scrubbed downstream by capture's layer-2 pipeline). */
  taskSummary: string;
  /** The unified-diff patch the attempt produced. */
  patch: string;
  /** `owner/repo` when known (tag + audit); defaults from the instance id. */
  repo?: string;
}

export interface BridgeDeps {
  /** The held-out `cap-v0` slate instance ids (§12). Repo exclusion is derived from these. */
  slateInstanceIds: Set<string>;
  /** Fetch the patch + task descriptor for an attempt (IPFS/corpus). */
  fetchEvidence: (ref: AttemptRef) => Promise<BridgeEvidence>;
  /** Publish a constructed CapturedTask as layer-1 evidence; returns the corpus ref. */
  publishEvidence: (task: CapturedTask, ref: AttemptRef) => Promise<{ envelopeRef: string; anchorTx: string | null }>;
  now?: () => Date;
}

export interface BridgeResult {
  bridged: Array<{ instanceId: string; polarity: 'pass' | 'fail'; envelopeRef: string; anchorTx: string | null }>;
  excludedHeldOut: Array<{ instanceId: string; reason: 'instance_id' | 'repo' }>;
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
 */
export function toBridgeCapturedTask(ref: AttemptRef, ev: BridgeEvidence, now: Date): CapturedTask {
  const nano = NANO(now);
  const isPass = ref.polarity === 'pass';
  const repo = ev.repo ?? repoFromInstanceId(ref.instanceId) ?? undefined;
  return {
    session: {
      sessionId: `bridge:${ref.instanceId}:${ref.polarity}:${ref.requestId}`,
      capturedAt: now.toISOString(),
    },
    task: {
      summary: `swe-rebench ${ref.instanceId}: ${ev.taskSummary}`.slice(0, 500),
      distributionTags: ['coding', 'swe-rebench', ...(repo ? [repo.slice(0, 64)] : [])],
    },
    environment: {
      harness: { name: 'jinn-execution-ledger-bridge', version: '0.1.0' },
      model: ref.model || 'unknown',
      tools: [],
    },
    steps: [
      {
        spanId: 'patch',
        parentSpanId: null,
        name: 'tool:apply_patch',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: { patch: ev.patch },
        redactedKeys: [],
      },
      {
        spanId: 'verdict',
        parentSpanId: null,
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
  const seen = new Set<string>();

  for (const ref of refs) {
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
    if (seen.has(key)) {
      result.deduped.push({ instanceId: ref.instanceId, polarity: ref.polarity });
      continue;
    }
    seen.add(key);
    try {
      const ev = await deps.fetchEvidence(ref);
      const task = toBridgeCapturedTask(ref, ev, now);
      const pub = await deps.publishEvidence(task, ref);
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
 * emitting a `jinn.trace-envelope.v0` artifact. Reuses the frozen pipe; the only
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
