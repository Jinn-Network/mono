#!/usr/bin/env node
/**
 * Net-liveness probe — operator-independent #1038 silent-stall detector.
 *
 * Reads on-chain truth two ways and cross-references them: chain head via direct
 * RPC, and the latest indexed attempt/verdict via the indexer GraphQL endpoint.
 * Alerts (generic incoming webhook, Slack-compatible) only when the chain is
 * advancing AND the indexer is caught up AND no attempt/verdict has been indexed
 * within the threshold window — the signature of a network stall the operator
 * daemons cannot be trusted to self-report.
 *
 * Stateless and cron-driven, NOT in-daemon. The cron interval is the de-dup /
 * rate-limit; there is no persisted alert marker. Always exits 0 on a completed
 * run — the alert is a side-effect, not a failure mode. See
 * docs/runbooks/net-liveness.md.
 *
 * Usage:
 *   yarn net-liveness
 *   yarn net-liveness -- --config ./my-config.json
 *
 * Env:
 *   JINN_NET_LIVENESS_WEBHOOK_URL       unset → NO-OP (classify + log only)
 *   JINN_NET_LIVENESS_THRESHOLD_MINUTES default 30
 *   JINN_NET_LIVENESS_HEAD_SAMPLE_DELAY_MS default 4000 (gap between the two
 *     chain-head reads; must exceed Base's ~2s blocktime so a live chain
 *     advances at least one block between samples)
 *   (RPC + indexer URL inherited from the daemon config / its env overrides)
 */

import { config as dotenvConfig } from 'dotenv';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs, DEFAULT_TESTNET_DISCOVERY_URL } from '../src/config.js';
import { createJinnPublicClient } from '../src/earning/viem-clients.js';
import {
  runNetLivenessProbe,
  fetchIndexerHeadBlock,
  fetchLatestActivityBlock,
  postNetLivenessWebhook,
  BASE_BLOCKS_PER_MINUTE,
  DEFAULT_HEAD_SAMPLE_DELAY_MS,
} from '../src/monitoring/net-liveness.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

async function main(): Promise<void> {
  const config = loadConfig(getConfigPathFromArgs());
  const network = config.network === 'testnet' ? 'base-sepolia' : 'base';

  // Indexer base URL: explicit discovery.url, else the testnet default. When the
  // operator has pinned the RPC-only floor (discovery.mode 'onchain') and given
  // no URL, there is no indexer to cross-reference against — report and exit.
  const indexerBaseUrl =
    config.discovery?.url ??
    (config.discovery?.mode === 'onchain' ? undefined : DEFAULT_TESTNET_DISCOVERY_URL);
  if (!indexerBaseUrl) {
    console.log('[net-liveness] no indexer configured; cannot cross-reference indexed activity');
    process.exit(0);
  }
  const gqlUrl = indexerBaseUrl.endsWith('/graphql') ? indexerBaseUrl : `${indexerBaseUrl}/graphql`;

  const thresholdMinutes = Number(process.env['JINN_NET_LIVENESS_THRESHOLD_MINUTES'] ?? 30);
  const webhookUrl = process.env['JINN_NET_LIVENESS_WEBHOOK_URL'];
  const headSampleDelayMs = Number(
    process.env['JINN_NET_LIVENESS_HEAD_SAMPLE_DELAY_MS'] ?? DEFAULT_HEAD_SAMPLE_DELAY_MS,
  );

  const client = createJinnPublicClient(config.rpcUrls, network);

  const result = await runNetLivenessProbe({
    // cacheTime:0 bypasses viem's getBlockNumber cache (default ~4s) so the two
    // samples reflect real chain state, not a memoized first read.
    fetchChainHead: () => client.getBlockNumber({ cacheTime: 0 }),
    fetchLatestActivityBlock: () => fetchLatestActivityBlock({ gqlUrl }),
    fetchIndexerHeadBlock: () => fetchIndexerHeadBlock({ baseUrl: indexerBaseUrl }),
    postWebhook: postNetLivenessWebhook(webhookUrl),
    thresholdMinutes,
    sleep,
    headSampleDelayMs,
    now: () => new Date(),
  });

  const staleForMinutes = Number(result.staleForBlocks) / BASE_BLOCKS_PER_MINUTE;
  console.log(
    `[net-liveness] state=${result.state} staleForBlocks=${result.staleForBlocks} ` +
      `(~${staleForMinutes} min) — ${result.reason}` +
      (result.state === 'stale' ? (webhookUrl ? ' [alert posted]' : ' [no webhook configured]') : ''),
  );

  process.exit(0);
}

main().catch((err) => {
  // A throw here is a probe-setup failure (bad config / RPC chain unreachable),
  // not a net-liveness verdict. Surface it loudly with a non-zero exit so a cron
  // failure policy can flag the probe itself as broken.
  console.error('[net-liveness] probe failed to run:', err);
  process.exit(1);
});
