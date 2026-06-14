/**
 * One enrichment batch: claim due evaluation anchors → fetch IPFS → parse with
 * the shared module → write the full field set into verdict_envelope_meta (#779).
 *
 * The field-mapping calls the SAME shared functions the indexer handler uses
 * (parseVerdictEnvelopeLite + resolveInstanceFields from
 * @jinn-network/indexer/enrichment-parse) — that shared module is the anti-drift
 * contract between the in-handler path and this worker.
 *
 * Failure modes mirror the handler's graceful-degrade behaviour:
 *  - verdict-body fetch throws → NO row (no requestId without the body); the
 *    anchor stays un-enriched and reappears in discovery next tick (natural retry).
 *  - swe-rebench-v2 task-body fetch throws AFTER the verdict parsed → the verdict
 *    row is written with enrichmentStatus='retry' (we have requestId by then) and
 *    a backoff. NOT 'ok' with a populated-but-wrong instanceId — but matching the
 *    handler, a task body that simply LACKS instance_id yields ok/instanceId=''
 *    (graceful degrade; the launcher's instanceId_not:"" filter excludes it, #669).
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
  maxRetries: number;
  chainId: number;
  /** Injected for tests; defaults to global fetch in production wiring. */
  fetchImpl?: FetchLike;
  /** epoch-ms clock; injected for deterministic tests. */
  now: () => number;
}

export interface EnrichBatchResult {
  discovered: number;
  enriched: number;
  retried: number;
  failedFetch: number;
}

export async function enrichBatch(
  store: EnrichmentStore,
  deps: EnrichDeps,
): Promise<EnrichBatchResult> {
  const nowMs = deps.now();
  const due = await store.discoverDue(deps.batchSize, nowMs);
  const result: EnrichBatchResult = {
    discovered: due.length,
    enriched: 0,
    retried: 0,
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
      result.failedFetch += 1;
      continue;
    }

    const meta = parseVerdictEnvelopeLite(body);
    if (!meta) {
      // Not a recognisable verdict envelope (no task.requestId). Nothing to key
      // a row on — leave un-enriched (matches the handler, which writes no row).
      result.failedFetch += 1;
      continue;
    }

    let instanceId = '';
    let solverNetManifestCid = '';
    if (meta.solverType.startsWith('swe-rebench-v2') && meta.taskCid) {
      try {
        const taskBody = await fetchIpfsJson(deps.ipfsGateway, meta.taskCid, {
          timeoutMs: deps.ipfsTimeoutMs,
          fetchImpl: deps.fetchImpl,
        });
        const resolved = resolveInstanceFields(taskBody);
        instanceId = resolved.instanceId;
        solverNetManifestCid = resolved.solverNetManifestCid;
      } catch (err) {
        // We have the requestId (verdict parsed) but the task body is
        // unfetchable → backoff retry rather than write a partial 'ok'.
        console.warn(
          `[indexer-enrichment] task body fetch failed for verdict ${meta.requestId.slice(0, 10)}... cid=${meta.taskCid}: ${String(err)}`,
        );
        await store.markRetry({
          requestId: meta.requestId,
          manifestCid: anchor.manifestCid,
          enrichedAtBlock: anchor.publishedAtBlock,
          chainId: deps.chainId,
          now: nowMs,
          maxRetries: deps.maxRetries,
        });
        result.retried += 1;
        continue;
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
      evaluatorVerdict: meta.evaluatorVerdict,
      enrichedAtBlock: anchor.publishedAtBlock,
      chainId: deps.chainId,
    });
    result.enriched += 1;
  }

  return result;
}
