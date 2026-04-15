#!/usr/bin/env npx tsx
import { resolve } from 'node:path';
import {
  asInt,
  nowIso,
  parseArgs,
  parseJsonLines,
  runCommand,
  sleep,
  summarizeError,
  withRailwayContext,
  writeJson,
} from './common.js';

interface ServiceRef {
  label: 'worker' | 'gateway';
  project: string;
  environment: string;
  service: string;
}

interface ParsedLog {
  timestamp?: string;
  message: string;
  requestId?: string;
  level?: string;
}

function usage(exitCode: number = 1): never {
  console.error(
    [
      'Usage: yarn tsx scripts/test/railway/canary-log-gates.ts [options]',
      '',
      'Options:',
      '  --mode pre-smoke|smoke            Default: pre-smoke',
      '  --worker-project <name>           Default: jinn-worker',
      '  --worker-env <name>               Default: production',
      '  --worker-service <name>           Default: canary-worker-2',
      '  --gateway-project <name>          Default: jinn-shared',
      '  --gateway-env <name>              Default: production',
      '  --gateway-service <name>          Default: x402-gateway-canary',
      '  --request-ids <id1,id2,...>       Optional request ids expected in logs',
      '  --lines <n>                       Default: 1200 (all modes)',
      '  --duration-minutes <n>            Smoke only, default: 30',
      '  --poll-seconds <n>                Smoke only, default: 60',
      '  --artifact <path>                 Optional JSON report output',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function toParsedLogs(text: string): ParsedLog[] {
  return parseJsonLines<Record<string, unknown>>(text).map((entry) => ({
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
    message: typeof entry.message === 'string' ? entry.message : '',
    requestId: typeof entry.requestId === 'string' ? entry.requestId : undefined,
    level: typeof entry.level === 'string' ? entry.level : undefined,
  }));
}

function detectSecretLeak(logs: ParsedLog[]): Array<{ pattern: string; sample: string }> {
  const leakPatterns: Array<{ name: string; regex: RegExp }> = [
    {
      name: 'explicit_secret_assignment',
      regex: /(PRIVATE_KEY|OPERATE_PASSWORD|SUPABASE_SERVICE_ROLE_KEY|GITHUB_TOKEN|NANGO_SECRET_KEY)\s*[:=]\s*\S+/i,
    },
    {
      name: 'private_key_payload',
      regex: /private[_-]?key[^\n]{0,24}0x[a-fA-F0-9]{64}/i,
    },
    {
      name: 'github_pat',
      regex: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/,
    },
    {
      name: 'openai_sk',
      regex: /\bsk-[A-Za-z0-9]{20,}\b/,
    },
  ];

  const leaks: Array<{ pattern: string; sample: string }> = [];
  for (const log of logs) {
    if (!log.message) continue;
    for (const pattern of leakPatterns) {
      if (pattern.regex.test(log.message)) {
        leaks.push({
          pattern: pattern.name,
          sample: log.message.slice(0, 200),
        });
      }
    }
  }
  return leaks;
}

async function fetchLogs(service: ServiceRef, lines: number): Promise<ParsedLog[]> {
  return withRailwayContext({
    project: service.project,
    environment: service.environment,
    service: service.service,
    work: async (cwd) => {
      const logs = runCommand({
        cmd: 'railway',
        argv: ['logs', '-e', service.environment, '-s', service.service, '--lines', String(lines), '--json'],
        cwd,
        timeoutMs: 120_000,
      });
      if (!logs.ok) {
        throw new Error(`Failed to fetch logs for ${service.label}: ${logs.stderr || logs.stdout}`);
      }
      return toParsedLogs(logs.stdout);
    },
  });
}

async function fetchServiceHealth(service: ServiceRef): Promise<{ pass: boolean; status: string }> {
  return withRailwayContext({
    project: service.project,
    environment: service.environment,
    service: service.service,
    work: async (cwd) => {
      const result = runCommand({
        cmd: 'railway',
        argv: ['service', 'status', '-s', service.service, '-e', service.environment, '--json'],
        cwd,
        timeoutMs: 60_000,
      });
      if (!result.ok) {
        return { pass: false, status: 'STATUS_COMMAND_FAILED' };
      }

      try {
        const parsed = JSON.parse(result.stdout) as { status?: string };
        return {
          pass: parsed.status === 'SUCCESS',
          status: parsed.status || 'UNKNOWN',
        };
      } catch {
        return { pass: false, status: 'INVALID_STATUS_JSON' };
      }
    },
  });
}

function hasAnyMessage(logs: ParsedLog[], needles: string[]): boolean {
  return logs.some((log) => needles.some((needle) => log.message.includes(needle)));
}

async function runPreSmoke(args: {
  worker: ServiceRef;
  gateway: ServiceRef;
  requestIds: string[];
  lines: number;
}): Promise<any> {
  const [workerLogs, gatewayLogs] = await Promise.all([
    fetchLogs(args.worker, args.lines),
    fetchLogs(args.gateway, args.lines),
  ]);

  const allLogs = [...workerLogs, ...gatewayLogs];
  const leaks = detectSecretLeak(allLogs);

  const authMarkers = [
    'Worker credential capabilities discovered via bridge',
    'Skipping requests requiring unavailable credentials',
    'Cannot verify venture credentials',
    'Skipping — venture lacks required credentials',
    'Invalid ERC-8128 signature',
    'Failed to query capabilities',
  ];

  const authDecisionSeen = hasAnyMessage(allLogs, authMarkers);

  const requestChecks = args.requestIds.map((requestId) => {
    const inWorker = workerLogs.some((log) => log.requestId === requestId || log.message.includes(requestId));
    return {
      requestId,
      seen: inWorker,
    };
  });

  const checks = [
    {
      name: 'no_secret_leaks',
      pass: leaks.length === 0,
      detail: leaks.length > 0 ? `${leaks.length} leak pattern matches` : undefined,
    },
    {
      name: 'auth_decision_logs_present',
      pass: authDecisionSeen,
    },
    {
      name: 'request_ids_present_in_worker_logs',
      pass: requestChecks.every((entry) => entry.seen),
      detail: requestChecks.filter((entry) => !entry.seen).map((entry) => entry.requestId).join(', ') || undefined,
    },
  ];

  const pass = checks.every((check) => check.pass);

  return {
    mode: 'pre-smoke',
    summary: {
      pass,
      checks,
      workerLogCount: workerLogs.length,
      gatewayLogCount: gatewayLogs.length,
    },
    leaks,
    requestChecks,
  };
}

async function runSmoke(args: {
  worker: ServiceRef;
  gateway: ServiceRef;
  lines: number;
  durationMinutes: number;
  pollSeconds: number;
}): Promise<any> {
  const startedAtMs = Date.now();
  const stopAt = startedAtMs + args.durationMinutes * 60_000;
  const samples: Array<{
    at: string;
    workerHealth: string;
    gatewayHealth: string;
    workerMechRegressionHits: number;
    credentialErrorHits: number;
    leaks: number;
  }> = [];

  const seenMessages = new Set<string>();
  let mechRegressionHits = 0;
  let credentialErrorHits = 0;
  const allLeaks: Array<{ pattern: string; sample: string }> = [];
  let healthFailures = 0;

  const mechRegressionMarkers = [
    'No delivery mech configured',
    'Cannot resolve mech',
    'mech remains unresolved',
    'Service has no mech contract address',
  ];

  const credentialErrorMarkers = [
    'Invalid ERC-8128 signature',
    'Failed to query capabilities',
    'Credential bridge probe failed',
    'Cannot verify venture credentials',
    'Skipping requests requiring unavailable credentials',
  ];

  while (Date.now() < stopAt) {
    const [workerHealth, gatewayHealth] = await Promise.all([
      fetchServiceHealth(args.worker),
      fetchServiceHealth(args.gateway),
    ]);

    if (!workerHealth.pass || !gatewayHealth.pass) {
      healthFailures += 1;
    }

    const [workerLogs, gatewayLogs] = await Promise.all([
      fetchLogs(args.worker, args.lines),
      fetchLogs(args.gateway, args.lines),
    ]);

    const mergedLogs = [...workerLogs, ...gatewayLogs];
    const leaks = detectSecretLeak(mergedLogs);
    allLeaks.push(...leaks);

    let sampleMechHits = 0;
    let sampleCredentialHits = 0;

    for (const log of mergedLogs) {
      if (!log.message) continue;
      const key = `${log.timestamp || ''}|${log.message}`;
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);

      if (mechRegressionMarkers.some((marker) => log.message.includes(marker))) {
        mechRegressionHits += 1;
        sampleMechHits += 1;
      }

      if (credentialErrorMarkers.some((marker) => log.message.includes(marker))) {
        credentialErrorHits += 1;
        sampleCredentialHits += 1;
      }
    }

    samples.push({
      at: nowIso(),
      workerHealth: workerHealth.status,
      gatewayHealth: gatewayHealth.status,
      workerMechRegressionHits: sampleMechHits,
      credentialErrorHits: sampleCredentialHits,
      leaks: leaks.length,
    });

    if (Date.now() < stopAt) {
      await sleep(args.pollSeconds * 1000);
    }
  }

  const checks = [
    {
      name: 'worker_and_gateway_health_stable',
      pass: healthFailures === 0,
      detail: `healthFailures=${healthFailures}`,
    },
    {
      name: 'no_mech_resolution_regressions',
      pass: mechRegressionHits === 0,
      detail: `hits=${mechRegressionHits}`,
    },
    {
      name: 'no_repeated_credential_errors',
      pass: credentialErrorHits <= 3,
      detail: `hits=${credentialErrorHits}`,
    },
    {
      name: 'no_secret_leaks',
      pass: allLeaks.length === 0,
      detail: allLeaks.length > 0 ? `hits=${allLeaks.length}` : undefined,
    },
  ];

  return {
    mode: 'smoke',
    summary: {
      pass: checks.every((check) => check.pass),
      checks,
      durationMinutes: args.durationMinutes,
      pollSeconds: args.pollSeconds,
      sampleCount: samples.length,
    },
    metrics: {
      healthFailures,
      mechRegressionHits,
      credentialErrorHits,
      leakHits: allLeaks.length,
    },
    samples,
    leaks: allLeaks.slice(0, 20),
  };
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  if (bools.has('help') || bools.has('h')) usage(0);

  const mode = (flags.mode || 'pre-smoke').trim();
  if (mode !== 'pre-smoke' && mode !== 'smoke') {
    throw new Error(`Unsupported --mode: ${mode}`);
  }

  const worker: ServiceRef = {
    label: 'worker',
    project: flags['worker-project'] || 'jinn-worker',
    environment: flags['worker-env'] || 'production',
    service: flags['worker-service'] || 'canary-worker-2',
  };

  const gateway: ServiceRef = {
    label: 'gateway',
    project: flags['gateway-project'] || 'jinn-shared',
    environment: flags['gateway-env'] || 'production',
    service: flags['gateway-service'] || 'x402-gateway-canary',
  };

  const lines = Math.max(50, asInt(flags.lines, 1200));
  const requestIds = parseCsv(flags['request-ids']);
  const durationMinutes = Math.max(1, asInt(flags['duration-minutes'], 30));
  const pollSeconds = Math.max(10, asInt(flags['poll-seconds'], 60));
  const artifactPath = flags.artifact ? resolve(flags.artifact) : undefined;

  const startedAt = nowIso();
  const report = mode === 'smoke'
    ? await runSmoke({ worker, gateway, lines, durationMinutes, pollSeconds })
    : await runPreSmoke({ worker, gateway, lines, requestIds });

  const payload = {
    startedAt,
    finishedAt: nowIso(),
    worker,
    gateway,
    ...report,
  };

  if (artifactPath) {
    await writeJson(artifactPath, payload);
  }

  console.log(JSON.stringify(payload, null, 2));

  if (!payload.summary.pass) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`canary-log-gates failed: ${summarizeError(err)}`);
  process.exit(1);
});
