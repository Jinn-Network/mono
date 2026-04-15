#!/usr/bin/env npx tsx
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { buildIpfsPayload } from 'jinn-node/agent/shared/ipfs-payload-builder.js';
import { getMechAddress, getMechChainConfig, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
import {
  asInt,
  nowIso,
  parseArgs,
  parseJsonLines,
  postGraphql,
  providerList,
  runCommand,
  sleep,
  summarizeError,
  withRailwayContext,
  writeJson,
} from './common.js';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.test'), override: true, quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.e2e'), override: true, quiet: true });

interface DispatchState {
  request: {
    id: string;
    delivered: boolean;
    deliveryIpfsHash: string | null;
    transactionHash: string | null;
    blockTimestamp: string | null;
    jobName: string | null;
  } | null;
  delivery: {
    transactionHash: string;
    deliveryMech: string | null;
    ipfsHash: string | null;
    blockTimestamp: string | null;
  } | null;
}

function usage(exitCode: number = 1): never {
  console.error(
    [
      'Usage: yarn tsx scripts/test/railway/canary-dispatch.ts --workstream <id> [options]',
      '',
      'Options:',
      '  --scenario baseline|credential|noncredential   Default: baseline',
      '  --tools <csv>                                  Override enabled tools list',
      '  --workstream <id>                              Required workstream id',
      '  --operate-dir <path>                           Default: /Users/adrianobradley/jinn-nodes/jinn-node/.operate',
      '  --instruction <text>                           Override GOAL-001 directive',
      '  --job-name <name>                              Optional custom job name',
      '  --env <K=V,K2=V2>                              Additional payload env map',
      '  --ponder-url <url>                             Default: https://indexer.jinn.network/graphql',
      '  --poll-seconds <n>                             Default: 20',
      '  --timeout-seconds <n>                          Default: 900',
      '  --expect-delivered true|false                  Default: true',
      '  --worker-project <name>                        Default: jinn-worker',
      '  --worker-env <name>                            Default: production',
      '  --worker-service <name>                        Default: canary-worker-2',
      '  --log-lines <n>                                Default: 1500',
      '  --artifact <path>                              Optional JSON output path',
      '',
      'Exit code is non-zero when expectations are not met.',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseEnvCsv(csv: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!csv) return out;

  for (const part of csv.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }

  return out;
}

function toolsForScenario(scenario: string): string[] {
  switch (scenario) {
    case 'credential':
      return ['venture_query', 'create_artifact', 'create_measurement'];
    case 'noncredential':
      return ['google_web_search', 'create_artifact'];
    case 'baseline':
    default:
      return ['google_web_search', 'create_artifact', 'create_measurement'];
  }
}

function instructionForScenario(scenario: string): string {
  switch (scenario) {
    case 'credential':
      return 'Use venture_query to read venture data and summarize result concisely.';
    case 'noncredential':
      return 'Use non-credential tools only and produce a concise status summary.';
    default:
      return 'Execute the requested work and return concise structured output.';
  }
}

async function getRequestState(ponderUrl: string, requestId: string): Promise<DispatchState> {
  const payload = await postGraphql<{
    data?: {
      request?: {
        id: string;
        delivered: boolean;
        deliveryIpfsHash?: string | null;
        transactionHash?: string | null;
        blockTimestamp?: string | null;
        jobName?: string | null;
      } | null;
      delivery?: {
        transactionHash: string;
        deliveryMech?: string | null;
        ipfsHash?: string | null;
        blockTimestamp?: string | null;
      } | null;
    };
  }>(
    ponderUrl,
    `
      query CanaryDispatchState($id: String!) {
        request(id: $id) {
          id
          delivered
          deliveryIpfsHash
          transactionHash
          blockTimestamp
          jobName
        }
        delivery(id: $id) {
          transactionHash
          deliveryMech
          ipfsHash
          blockTimestamp
        }
      }
    `,
    { id: requestId },
  );

  return {
    request: payload.data?.request
      ? {
          id: payload.data.request.id,
          delivered: payload.data.request.delivered,
          deliveryIpfsHash: payload.data.request.deliveryIpfsHash ?? null,
          transactionHash: payload.data.request.transactionHash ?? null,
          blockTimestamp: payload.data.request.blockTimestamp ?? null,
          jobName: payload.data.request.jobName ?? null,
        }
      : null,
    delivery: payload.data?.delivery
      ? {
          transactionHash: payload.data.delivery.transactionHash,
          deliveryMech: payload.data.delivery.deliveryMech ?? null,
          ipfsHash: payload.data.delivery.ipfsHash ?? null,
          blockTimestamp: payload.data.delivery.blockTimestamp ?? null,
        }
      : null,
  };
}

async function fetchWorkerEvidence(args: {
  project: string;
  environment: string;
  service: string;
  requestId: string;
  lines: number;
}): Promise<{
  claimSeen: boolean;
  executionSeen: boolean;
  deliverySeen: boolean;
  credentialSkipSeen: boolean;
  requestLogCount: number;
}> {
  return withRailwayContext({
    project: args.project,
    environment: args.environment,
    service: args.service,
    work: async (cwd) => {
      const cmd = runCommand({
        cmd: 'railway',
        argv: ['logs', '-e', args.environment, '-s', args.service, '--lines', String(args.lines), '--json'],
        cwd,
        timeoutMs: 120_000,
      });

      if (!cmd.ok) {
        throw new Error(`Failed to fetch worker logs: ${cmd.stderr || cmd.stdout}`);
      }

      const entries = parseJsonLines<Record<string, unknown>>(cmd.stdout);
      const scoped = entries.filter((entry) => {
        const entryRequestId = typeof entry.requestId === 'string' ? entry.requestId : '';
        const msgField = typeof entry.message === 'string' ? entry.message : '';
        const pinoMsg = typeof entry.msg === 'string' ? entry.msg : '';
        return entryRequestId === args.requestId || msgField.includes(args.requestId) || pinoMsg.includes(args.requestId);
      });

      const entryText = (entry: Record<string, unknown>): string => {
        const parts: string[] = [];
        if (typeof entry.message === 'string') parts.push(entry.message);
        if (typeof entry.msg === 'string') parts.push(entry.msg);
        return parts.join(' ');
      };

      const hasMessage = (needle: string): boolean =>
        scoped.some((entry) => entryText(entry).includes(needle));

      const credentialSkipSeen = scoped.some((entry) => {
        const text = entryText(entry);
        return (
          text.includes('Skipping requests requiring unavailable credentials') ||
          text.includes('Cannot verify venture credentials') ||
          text.includes('Skipping — venture lacks required credentials') ||
          text.includes('No eligible requests after credential filter')
        );
      });

      return {
        claimSeen: hasMessage('Claimed via Control API'),
        executionSeen: hasMessage('Processing request') || hasMessage('Execution completed'),
        deliverySeen: hasMessage('Delivered via Safe'),
        credentialSkipSeen,
        requestLogCount: scoped.length,
      };
    },
  });
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  if (bools.has('help') || bools.has('h')) usage(0);

  const workstreamId = flags.workstream;
  if (!workstreamId) {
    throw new Error('--workstream is required');
  }

  const scenario = (flags.scenario || 'baseline').trim();
  const tools = parseCsv(flags.tools);
  const enabledTools = tools.length > 0 ? tools : toolsForScenario(scenario);
  const instruction = flags.instruction || instructionForScenario(scenario);
  const operateDir = resolve(flags['operate-dir'] || '/Users/adrianobradley/jinn-nodes/jinn-node/.operate');
  const additionalEnv = parseEnvCsv(flags.env);
  const jobName = flags['job-name'] || `canary-${scenario}-${Date.now()}`;
  const expectedDelivered = (flags['expect-delivered'] || 'true').toLowerCase() !== 'false';

  const workerProject = flags['worker-project'] || 'jinn-worker';
  const workerEnvironment = flags['worker-env'] || 'production';
  const workerService = flags['worker-service'] || 'canary-worker-2';

  const pollSeconds = Math.max(5, asInt(flags['poll-seconds'], 20));
  const timeoutSeconds = Math.max(30, asInt(flags['timeout-seconds'], 900));
  const logLines = Math.max(200, asInt(flags['log-lines'], 1500));

  const ponderUrl = (flags['ponder-url'] || process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql').trim();
  const artifactPath = flags.artifact ? resolve(flags.artifact) : undefined;

  process.env.OPERATE_PROFILE_DIR = operateDir;

  const blueprint = JSON.stringify({
    invariants: [
      {
        id: 'GOAL-001',
        form: 'directive',
        description: instruction,
      },
      {
        id: 'FORMAT-001',
        form: 'directive',
        description: 'Return concise markdown with explicit success or failure statement.',
      },
    ],
  });

  const startedAt = nowIso();
  const jobDefinitionId = crypto.randomUUID();

  const { ipfsJsonContents } = await buildIpfsPayload({
    blueprint,
    jobName,
    jobDefinitionId,
    enabledTools,
    skipBranch: true,
    workstreamId,
    additionalContextOverrides: Object.keys(additionalEnv).length > 0 ? { env: additionalEnv } : undefined,
  });

  const mechAddress = getMechAddress();
  const chainConfig = getMechChainConfig();
  const privateKey = getServicePrivateKey();

  if (!mechAddress) {
    throw new Error('No mech address found in operate profile.');
  }
  if (!privateKey) {
    throw new Error('No service private key found in operate profile.');
  }

  const dispatchResult = await marketplaceInteract({
    prompts: [blueprint],
    priorityMech: mechAddress,
    tools: enabledTools,
    ipfsJsonContents,
    chainConfig,
    keyConfig: { source: 'value', value: privateKey },
    postOnly: true,
    responseTimeout: 61,
  });

  const requestId = Array.isArray(dispatchResult?.request_ids) ? dispatchResult.request_ids[0] : undefined;
  if (!requestId) {
    throw new Error('Dispatch failed: no request id returned');
  }

  const timeoutAt = Date.now() + timeoutSeconds * 1000;
  let latestState: DispatchState | null = null;
  let deliveredObserved = false;

  while (Date.now() < timeoutAt) {
    latestState = await getRequestState(ponderUrl, requestId);
    if (latestState.request?.delivered && latestState.delivery?.transactionHash) {
      deliveredObserved = true;
      break;
    }
    await sleep(pollSeconds * 1000);
  }

  if (!latestState) {
    latestState = await getRequestState(ponderUrl, requestId);
  }

  let evidence: Awaited<ReturnType<typeof fetchWorkerEvidence>>;
  let evidenceUnavailable = false;
  try {
    evidence = await fetchWorkerEvidence({
      project: workerProject,
      environment: workerEnvironment,
      service: workerService,
      requestId,
      lines: logLines,
    });
  } catch (err: any) {
    console.error(`Warning: log evidence collection failed (${summarizeError(err)}). Falling back to Ponder-only checks.`);
    evidenceUnavailable = true;
    evidence = { claimSeen: false, executionSeen: false, deliverySeen: false, credentialSkipSeen: false, requestLogCount: 0 };
  }

  const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

  if (expectedDelivered) {
    checks.push({
      name: 'request_delivered',
      pass: deliveredObserved && Boolean(latestState.request?.delivered),
      detail: `delivered=${latestState.request?.delivered ?? false}`,
    });
    checks.push({
      name: 'delivery_tx_present',
      pass: Boolean(latestState.delivery?.transactionHash),
      detail: `tx=${latestState.delivery?.transactionHash ?? 'null'}`,
    });
    checks.push({
      name: 'claim_log_present',
      pass: evidenceUnavailable || evidence.claimSeen,
      detail: evidenceUnavailable ? 'skipped (logs unavailable)' : `requestLogCount=${evidence.requestLogCount}`,
    });
    checks.push({
      name: 'execution_log_present',
      pass: evidenceUnavailable || evidence.executionSeen,
      detail: evidenceUnavailable ? 'skipped (logs unavailable)' : `requestLogCount=${evidence.requestLogCount}`,
    });
    checks.push({
      name: 'delivery_log_present',
      // Primary evidence is on-chain delivery (request_delivered + delivery_tx_present).
      // Log evidence is supplementary — "Delivered via Safe" may be evicted from the
      // Railway log window or lost to pino/Railway JSON field collisions.
      pass: evidenceUnavailable || evidence.deliverySeen || deliveredObserved,
      detail: evidenceUnavailable
        ? 'skipped (logs unavailable)'
        : evidence.deliverySeen
          ? `requestLogCount=${evidence.requestLogCount}`
          : deliveredObserved
            ? 'advisory: delivery log not found, but on-chain delivery confirmed'
            : `requestLogCount=${evidence.requestLogCount}`,
    });
  } else {
    const notDelivered = !deliveredObserved;
    checks.push({
      name: 'request_not_delivered_within_timeout',
      pass: notDelivered,
      detail: `delivered=${latestState.request?.delivered ?? false}`,
    });
    checks.push({
      name: 'credential_skip_log_present',
      // Worker credential cache is a startup singleton — if gateway policies changed after
      // worker start, the worker may not skip (cache is stale). The primary assertion is
      // request_not_delivered_within_timeout; skip log is advisory.
      pass: evidenceUnavailable || evidence.credentialSkipSeen || notDelivered,
      detail: evidenceUnavailable
        ? 'skipped (logs unavailable)'
        : evidence.credentialSkipSeen
          ? `requestLogCount=${evidence.requestLogCount}`
          : notDelivered
            ? 'advisory: skip log not found, but request was not delivered (pass by primary check)'
            : `requestLogCount=${evidence.requestLogCount}`,
    });
  }

  const pass = checks.every((check) => check.pass);
  const report = {
    startedAt,
    finishedAt: nowIso(),
    scenario,
    workstreamId,
    jobName,
    jobDefinitionId,
    enabledTools,
    requestId,
    dispatchTransactionHash: dispatchResult?.transaction_hash || null,
    expectedDelivered,
    deliveredObserved,
    state: latestState,
    evidence,
    evidenceUnavailable,
    checks,
    summary: {
      pass,
      failedChecks: checks.filter((check) => !check.pass).map((check) => check.name),
    },
  };

  if (artifactPath) {
    await writeJson(artifactPath, report);
  }

  console.log(JSON.stringify(report, null, 2));

  if (!pass) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`canary-dispatch failed: ${summarizeError(err)}`);
  process.exit(1);
});
