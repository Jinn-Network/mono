/**
 * One enrichment batch: claim due evaluation anchors → fetch IPFS → parse with
 * the shared module → write the full field set into verdict_envelope_meta (#779).
 *
 * The field-mapping calls the SAME shared functions the indexer handler uses
 * (parseVerdictEnvelopeLite + resolveInstanceFields from
 * @jinn-network/indexer/enrichment-parse) — that shared module is the anti-drift
 * contract between the in-handler path and this worker.
 *
 * Failure modes mirror the handler's graceful-degrade behaviour EXACTLY
 * (behaviour-preserving refactor — see plan T2.6 / §9 R3):
 *  - verdict-body fetch throws or parses malformed → NO verdict row (no requestId
 *    without the body); the CID-keyed worker attempt table backs off and
 *    eventually quarantines the anchor.
 *  - swe-rebench-v2 task-body fetch throws AFTER the verdict parsed → the worker
 *    warns and falls through to write enrichmentStatus='ok' with instanceId='' and
 *    solverNetManifestCid='' — identical to handlers.ts (the task-fetch catch there
 *    leaves both empty and writes 'ok'). The launcher's instanceId_not:"" filter then
 *    excludes that partial row from success counts (#669). We do NOT mark it for
 *    retry: that would invent stricter behaviour than the handler.
 *  - a task body that simply LACKS instance_id yields the same ok/instanceId='' row.
 */
import { fetchIpfsJson, type FetchLike } from '@jinn-network/indexer/ipfs';
import {
  parseVerdictEnvelopeLite,
  resolveInstanceFields,
} from '@jinn-network/indexer/enrichment-parse';
import type { EnrichmentStore } from './db.js';

export interface EnrichDeps {
  ipfsGateway: string;
  ipfsTimeoutMs: number;
  batchSize: number;
  chainId: number;
  maxRetries: number;
  /** Injected for tests; defaults to global fetch in production wiring. */
  fetchImpl?: FetchLike;
  /** epoch-ms clock; injected for deterministic tests. */
  now: () => number;
}

export interface EnrichBatchResult {
  discovered: number;
  enriched: number;
  failedFetch: number;
}

export async function enrichBatch(
  store: EnrichmentStore,
  deps: EnrichDeps,
): Promise<EnrichBatchResult> {
  const nowMs = deps.now();
  const due = await store.claimDue(deps.batchSize, nowMs, processingLeaseMs(deps));
  const result: EnrichBatchResult = {
    discovered: due.length,
    enriched: 0,
    failedFetch: 0,
  };

  for (const anchor of due) {
    let body: unknown;
    try {
      body = await fetchIpfsJson(deps.ipfsGateway, anchor.manifestCid, {
        timeoutMs: deps.ipfsTimeoutMs,
        fetchImpl: deps.fetchImpl,
      });
    } catch (err) {
      // No requestId without the body → no row. Re-discovered next tick.
      console.warn(
        `[indexer-enrichment] verdict body fetch failed for ${anchor.manifestCid}: ${String(err)}`,
      );
      await store.markAttemptFailure({
        manifestCid: anchor.manifestCid,
        chainId: anchor.chainId,
        now: nowMs,
        maxRetries: deps.maxRetries,
        error: String(err),
      });
      result.failedFetch += 1;
      continue;
    }

    const meta = parseVerdictEnvelopeLite(body);
    if (!meta) {
      // Not a recognisable verdict envelope (no task.requestId). Nothing to key
      // a verdict row on, but the CID-keyed attempt state prevents a hot loop.
      await store.markAttemptFailure({
        manifestCid: anchor.manifestCid,
        chainId: anchor.chainId,
        now: nowMs,
        maxRetries: deps.maxRetries,
        error: 'malformed verdict envelope',
      });
      result.failedFetch += 1;
      continue;
    }

    let instanceId = '';
    let solverNetManifestCid = '';
    let solutionRequestId = '';
    if (meta.solverType.startsWith('swe-rebench-v2') && meta.taskCid) {
      try {
        const taskBody = await fetchIpfsJson(deps.ipfsGateway, meta.taskCid, {
          timeoutMs: deps.ipfsTimeoutMs,
          fetchImpl: deps.fetchImpl,
        });
        const resolved = resolveInstanceFields(taskBody);
        instanceId = resolved.instanceId;
        solverNetManifestCid = resolved.solverNetManifestCid;
        solutionRequestId = resolved.solutionRequestId;
      } catch (err) {
        // Graceful degrade, matching handlers.ts EXACTLY: we have the requestId
        // (verdict parsed) but the task body is unfetchable. The handler catches,
        // warns, and falls through — leaving instanceId='',
        // solverNetManifestCid='', and solutionRequestId='' — then writes the
        // verdict row with enrichmentStatus='ok'. The launcher's instanceId_not:""
        // filter excludes the partial row from success counts (#669). Do NOT mark
        // for retry.
        console.warn(
          `[indexer-enrichment] task body fetch failed for verdict ${meta.requestId.slice(0, 10)}... cid=${meta.taskCid}: ${String(err)} (writing ok with instanceId='')`,
        );
        // instanceId / solverNetManifestCid / solutionRequestId stay '' — fall through to upsert.
      }
    }

    await store.upsertVerdict({
      requestId: meta.requestId,
      verdictIndex: meta.verdictIndex,
      attemptIndex: meta.attemptIndex,
      taskId: meta.taskId,
      evaluator: meta.evaluator,
      manifestCid: anchor.manifestCid,
      solverType: meta.solverType,
      evidenceTier: meta.evidenceTier,
      actualPassed: meta.actualPassed,
      actualScore: meta.actualScore,
      passedCount: meta.passedCount,
      totalCount: meta.totalCount,
      instanceId,
      solverNetManifestCid,
      solutionRequestId,
      evaluatorVerdict: meta.evaluatorVerdict,
      enrichedAtBlock: anchor.publishedAtBlock,
      chainId: anchor.chainId,
    });
    await store.clearAttempt(anchor.manifestCid, anchor.chainId);
    result.enriched += 1;
  }

  return result;
}

function processingLeaseMs(deps: EnrichDeps): bigint {
  const worstCaseFetchesPerAnchor = 2;
  const lease = Math.max(
    deps.ipfsTimeoutMs * worstCaseFetchesPerAnchor * Math.max(1, deps.batchSize),
    60_000,
  );
  return BigInt(lease);
}
