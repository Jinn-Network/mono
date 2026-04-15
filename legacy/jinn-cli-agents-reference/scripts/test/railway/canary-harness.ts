#!/usr/bin/env npx tsx
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  asInt,
  ensureDir,
  nowIso,
  parseArgs,
  runCommand,
  summarizeError,
  withRailwayContext,
  writeJson,
} from './common.js';

type Session = 'pre-smoke' | 'smoke';
type PhaseStatus = 'PASS' | 'FAIL' | 'SKIP';

interface PhaseResult {
  phase: number;
  name: string;
  status: PhaseStatus;
  detail?: string;
}

interface HarnessConfig {
  session: Session;
  repo: string;
  branch: string;
  workerProject: string;
  workerEnv: string;
  workerService: string;
  gatewayProject: string;
  gatewayEnv: string;
  gatewayService: string;
  workstream: string;
  operateDir: string;
  expectedDeliveryRate: number;
  runId: string;
  runDir: string;
  preSmokeRunId?: string;
  smokeDurationMinutes: number;
}

function usage(exitCode: number = 1): never {
  console.error(
    [
      'Usage: yarn test:railway:canary -- --session pre-smoke|smoke [options]',
      '',
      'Options:',
      '  --session pre-smoke|smoke           Default: pre-smoke',
      '  --repo <owner/repo>                 Default: Jinn-Network/jinn-node',
      '  --branch <name>                     Default: main',
      '  --worker-project <name>             Default: jinn-worker',
      '  --worker-env <name>                 Default: production',
      '  --worker-service <name>             Default: canary-worker-2',
      '  --gateway-project <name>            Default: jinn-shared',
      '  --gateway-env <name>                Default: production',
      '  --gateway-service <name>            Default: x402-gateway-canary',
      '  --workstream <id>                   Required for pre-smoke',
      '  --operate-dir <path>                Default: /Users/adrianobradley/jinn-nodes/jinn-node/.operate',
      '  --expected-delivery-rate <n>        Default: 99',
      '  --run-id <id>                       Optional run id override',
      '  --pre-smoke-run-id <id>             Smoke session input source',
      '  --smoke-duration-minutes <n>        Default: 30',
      '',
      'Artifacts are written to .tmp/railway-canary-e2e/<run-id>/',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function renderCheckpoint(results: PhaseResult[]): string {
  const lines: string[] = [];
  lines.push('# Canary Checkpoints');
  lines.push('');
  for (const result of results) {
    const detail = result.detail ? ` - ${result.detail}` : '';
    lines.push(`- [${result.status}] Phase ${result.phase} — ${result.name}${detail}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderFinalReport(args: {
  config: HarnessConfig;
  phases: PhaseResult[];
  artifactPaths: Record<string, string>;
  overallPass: boolean;
}): string {
  const lines: string[] = [];
  lines.push('# RAILWAY MAINNET CANARY E2E REPORT');
  lines.push(`Session: ${args.config.session}`);
  lines.push(`Repo/Branch: ${args.config.repo}:${args.config.branch}`);
  lines.push(`Run ID: ${args.config.runId}`);
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');
  lines.push('| Phase | Name | Result |');
  lines.push('|---|---|---|');
  for (const phase of args.phases) {
    lines.push(`| ${phase.phase} | ${phase.name} | ${phase.status} |`);
  }
  lines.push('');
  lines.push(`Overall: ${args.overallPass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('## Artifacts');
  for (const [name, path] of Object.entries(args.artifactPaths)) {
    lines.push(`- ${name}: ${path}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function runTsxScript(args: {
  script: string;
  argv: string[];
  timeoutMs?: number;
}): Promise<{ pass: boolean; output: string; error: string }> {
  const res = runCommand({
    cmd: 'yarn',
    argv: ['tsx', args.script, ...args.argv],
    cwd: resolve(import.meta.dirname, '..', '..', '..'),
    timeoutMs: args.timeoutMs,
    env: process.env,
  });

  return {
    pass: res.ok,
    output: res.stdout,
    error: res.stderr || res.stdout,
  };
}

async function checkRailwayAccess(project: string, environment: string, service: string): Promise<void> {
  await withRailwayContext({
    project,
    environment,
    service,
    work: async (cwd) => {
      const status = runCommand({
        cmd: 'railway',
        argv: ['service', 'status', '-s', service, '-e', environment, '--json'],
        cwd,
        timeoutMs: 60_000,
      });
      if (!status.ok) {
        throw new Error(`Cannot access ${project}/${environment}/${service}: ${status.stderr || status.stdout}`);
      }
    },
  });
}

async function resolveLatestPassingPreSmokeRun(baseDir: string): Promise<string | null> {
  if (!existsSync(baseDir)) return null;
  const entries = await readdir(baseDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const dir of dirs) {
    const summaryPath = join(baseDir, dir, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    try {
      const summary = JSON.parse(await readFile(summaryPath, 'utf-8')) as { session?: string; overallPass?: boolean; hasSuccessfulDelivery?: boolean };
      if (summary.session === 'pre-smoke' && summary.overallPass && summary.hasSuccessfulDelivery) {
        return dir;
      }
    } catch {
      // ignore parse errors
    }
  }

  return null;
}

async function runPreSmoke(config: HarnessConfig, artifactPaths: Record<string, string>): Promise<{ phases: PhaseResult[]; overallPass: boolean; hasSuccessfulDelivery: boolean }> {
  const phases: PhaseResult[] = [];
  let hasSuccessfulDelivery = false;

  const failPhase = (phase: number, name: string, detail: string): { phases: PhaseResult[]; overallPass: boolean; hasSuccessfulDelivery: boolean } => {
    phases.push({ phase, name, status: 'FAIL', detail });
    return { phases, overallPass: false, hasSuccessfulDelivery };
  };

  // Phase 0: Hard preflight
  try {
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
    const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

    checks.push({
      name: 'node_22',
      pass: nodeMajor === 22,
      detail: `node=${process.version}`,
    });

    checks.push({
      name: 'nvm_active',
      pass: Boolean(process.env.NVM_BIN),
    });

    const whoami = runCommand({ cmd: 'railway', argv: ['whoami'], timeoutMs: 30_000 });
    checks.push({
      name: 'railway_authenticated',
      pass: whoami.ok,
      detail: whoami.ok ? undefined : whoami.stderr || whoami.stdout,
    });

    checks.push({
      name: 'operate_dir_exists',
      pass: existsSync(config.operateDir),
      detail: config.operateDir,
    });

    await checkRailwayAccess(config.workerProject, config.workerEnv, config.workerService);
    checks.push({ name: 'worker_service_access', pass: true });

    await checkRailwayAccess(config.gatewayProject, config.gatewayEnv, config.gatewayService);
    checks.push({ name: 'gateway_service_access', pass: true });

    const deliveryRate = runCommand({
      cmd: 'yarn',
      argv: ['tsx', 'jinn-node/scripts/mech/assert-delivery-rates.ts', '--expected', String(config.expectedDeliveryRate)],
      cwd: resolve(import.meta.dirname, '..', '..', '..'),
      timeoutMs: 180_000,
      env: {
        ...process.env,
        OPERATE_PROFILE_DIR: config.operateDir,
        OLAS_MIDDLEWARE_PATH: resolve(config.operateDir, '..'),
        LOG_LEVEL: 'error',
      },
    });

    checks.push({
      name: 'delivery_rate_assertion',
      pass: deliveryRate.ok,
      detail: deliveryRate.ok ? undefined : deliveryRate.stderr || deliveryRate.stdout,
    });

    const pass = checks.every((check) => check.pass);
    await writeJson(artifactPaths.preflight, {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      checks,
      pass,
    });

    if (!pass) {
      const failed = checks.find((check) => !check.pass);
      return failPhase(0, 'Hard Preflight', failed?.detail || failed?.name || 'Preflight failed');
    }

    phases.push({ phase: 0, name: 'Hard Preflight', status: 'PASS' });
  } catch (err) {
    return failPhase(0, 'Hard Preflight', summarizeError(err));
  }

  // Phase 1: Deploy correctness
  try {
    const run = await runTsxScript({
      script: 'scripts/test/railway/canary-deploy-assert.ts',
      argv: [
        '--repo', config.repo,
        '--branch', config.branch,
        '--worker-project', config.workerProject,
        '--worker-env', config.workerEnv,
        '--worker-service', config.workerService,
        '--gateway-project', config.gatewayProject,
        '--gateway-env', config.gatewayEnv,
        '--gateway-service', config.gatewayService,
        '--artifact', artifactPaths.deploy,
      ],
      timeoutMs: 420_000,
    });

    if (!run.pass) {
      return failPhase(1, 'Deploy Correctness', run.error.slice(0, 500));
    }

    phases.push({ phase: 1, name: 'Deploy Correctness', status: 'PASS' });
  } catch (err) {
    return failPhase(1, 'Deploy Correctness', summarizeError(err));
  }

  // Phase 2: Baseline worker function
  let baselineRequestId: string | undefined;
  try {
    const run = await runTsxScript({
      script: 'scripts/test/railway/canary-dispatch.ts',
      argv: [
        '--scenario', 'baseline',
        '--workstream', config.workstream,
        '--operate-dir', config.operateDir,
        '--expect-delivered', 'true',
        '--worker-project', config.workerProject,
        '--worker-env', config.workerEnv,
        '--worker-service', config.workerService,
        '--artifact', artifactPaths.dispatch,
      ],
      timeoutMs: 1_200_000,
    });

    if (!run.pass) {
      return failPhase(2, 'Baseline Worker Function', run.error.slice(0, 500));
    }

    const baseline = JSON.parse(await readFile(artifactPaths.dispatch, 'utf-8')) as { requestId?: string; summary?: { pass?: boolean } };
    baselineRequestId = baseline.requestId;
    hasSuccessfulDelivery = baseline.summary?.pass === true;

    if (!baseline.summary?.pass || !baselineRequestId) {
      return failPhase(2, 'Baseline Worker Function', 'Baseline dispatch did not produce successful delivery evidence');
    }

    phases.push({ phase: 2, name: 'Baseline Worker Function', status: 'PASS' });
  } catch (err) {
    return failPhase(2, 'Baseline Worker Function', summarizeError(err));
  }

  // Phase 3: Credential authorization matrix
  const authArtifact = join(config.runDir, 'credential-matrix-auth.json');
  const filteringArtifact = join(config.runDir, 'credential-matrix-filtering.json');
  try {
    const authRun = await runTsxScript({
      script: 'scripts/test/railway/canary-credential-matrix.ts',
      argv: [
        '--mode', 'auth',
        '--provider', 'supabase',
        '--workstream', config.workstream,
        '--request-id', baselineRequestId!,
        '--operate-dir', config.operateDir,
        '--worker-project', config.workerProject,
        '--worker-env', config.workerEnv,
        '--worker-service', config.workerService,
        '--gateway-project', config.gatewayProject,
        '--gateway-env', config.gatewayEnv,
        '--gateway-service', config.gatewayService,
        '--artifact', authArtifact,
      ],
      timeoutMs: 1_500_000,
    });

    if (!authRun.pass) {
      return failPhase(3, 'Credential Authorization Matrix', authRun.error.slice(0, 500));
    }

    phases.push({ phase: 3, name: 'Credential Authorization Matrix', status: 'PASS' });
  } catch (err) {
    return failPhase(3, 'Credential Authorization Matrix', summarizeError(err));
  }

  // Phase 4: Job filtering behavior
  try {
    const filteringRun = await runTsxScript({
      script: 'scripts/test/railway/canary-credential-matrix.ts',
      argv: [
        '--mode', 'filtering',
        '--provider', 'supabase',
        '--workstream', config.workstream,
        '--request-id', baselineRequestId!,
        '--operate-dir', config.operateDir,
        '--worker-project', config.workerProject,
        '--worker-env', config.workerEnv,
        '--worker-service', config.workerService,
        '--gateway-project', config.gatewayProject,
        '--gateway-env', config.gatewayEnv,
        '--gateway-service', config.gatewayService,
        '--artifact', filteringArtifact,
      ],
      timeoutMs: 1_500_000,
    });

    if (!filteringRun.pass) {
      return failPhase(4, 'Job Filtering Behavior', filteringRun.error.slice(0, 500));
    }

    const authJson = JSON.parse(await readFile(authArtifact, 'utf-8'));
    const filteringJson = JSON.parse(await readFile(filteringArtifact, 'utf-8'));
    await writeJson(artifactPaths.credentialMatrix, {
      startedAt: nowIso(),
      finishedAt: nowIso(),
      mode: 'combined',
      auth: authJson,
      filtering: filteringJson,
      summary: {
        pass: Boolean(authJson?.summary?.passAll) && Boolean(filteringJson?.summary?.passAll),
      },
    });

    phases.push({ phase: 4, name: 'Job Filtering Behavior', status: 'PASS' });
  } catch (err) {
    return failPhase(4, 'Job Filtering Behavior', summarizeError(err));
  }

  // Phase 5: fail-closed + security + observability
  try {
    const requestIdsArg = [baselineRequestId].filter(Boolean).join(',');
    const run = await runTsxScript({
      script: 'scripts/test/railway/canary-log-gates.ts',
      argv: [
        '--mode', 'pre-smoke',
        '--worker-project', config.workerProject,
        '--worker-env', config.workerEnv,
        '--worker-service', config.workerService,
        '--gateway-project', config.gatewayProject,
        '--gateway-env', config.gatewayEnv,
        '--gateway-service', config.gatewayService,
        '--request-ids', requestIdsArg,
        '--artifact', artifactPaths.logs,
      ],
      timeoutMs: 300_000,
    });

    if (!run.pass) {
      return failPhase(5, 'Fail-Closed + Security/Observability', run.error.slice(0, 500));
    }

    phases.push({ phase: 5, name: 'Fail-Closed + Security/Observability', status: 'PASS' });
  } catch (err) {
    return failPhase(5, 'Fail-Closed + Security/Observability', summarizeError(err));
  }

  return {
    phases,
    overallPass: phases.every((phase) => phase.status === 'PASS'),
    hasSuccessfulDelivery,
  };
}

async function runSmoke(config: HarnessConfig, artifactPaths: Record<string, string>): Promise<{ phases: PhaseResult[]; overallPass: boolean; hasSuccessfulDelivery: boolean }> {
  const phases: PhaseResult[] = [];
  const baseDir = resolve(import.meta.dirname, '..', '..', '..', '.tmp', 'railway-canary-e2e');

  const preSmokeRunId = config.preSmokeRunId || await resolveLatestPassingPreSmokeRun(baseDir);
  if (!preSmokeRunId) {
    phases.push({ phase: 0, name: 'Smoke Preconditions', status: 'FAIL', detail: 'No passing pre-smoke summary found' });
    return { phases, overallPass: false, hasSuccessfulDelivery: false };
  }

  const preSmokeSummaryPath = join(baseDir, preSmokeRunId, 'summary.json');
  if (!existsSync(preSmokeSummaryPath)) {
    phases.push({ phase: 0, name: 'Smoke Preconditions', status: 'FAIL', detail: `Missing summary file: ${preSmokeSummaryPath}` });
    return { phases, overallPass: false, hasSuccessfulDelivery: false };
  }

  const preSmokeSummary = JSON.parse(await readFile(preSmokeSummaryPath, 'utf-8')) as { overallPass?: boolean; hasSuccessfulDelivery?: boolean };
  if (!preSmokeSummary.overallPass || !preSmokeSummary.hasSuccessfulDelivery) {
    phases.push({ phase: 0, name: 'Smoke Preconditions', status: 'FAIL', detail: 'Pre-smoke did not pass or lacks successful delivery evidence' });
    return { phases, overallPass: false, hasSuccessfulDelivery: Boolean(preSmokeSummary.hasSuccessfulDelivery) };
  }

  phases.push({ phase: 0, name: 'Smoke Preconditions', status: 'PASS', detail: `pre-smoke run=${preSmokeRunId}` });

  const run = await runTsxScript({
    script: 'scripts/test/railway/canary-log-gates.ts',
    argv: [
      '--mode', 'smoke',
      '--worker-project', config.workerProject,
      '--worker-env', config.workerEnv,
      '--worker-service', config.workerService,
      '--gateway-project', config.gatewayProject,
      '--gateway-env', config.gatewayEnv,
      '--gateway-service', config.gatewayService,
      '--duration-minutes', String(config.smokeDurationMinutes),
      '--artifact', artifactPaths.logs,
    ],
    timeoutMs: (config.smokeDurationMinutes * 60 + 240) * 1000,
  });

  if (!run.pass) {
    phases.push({ phase: 1, name: 'Smoke Window (30m)', status: 'FAIL', detail: run.error.slice(0, 500) });
    return { phases, overallPass: false, hasSuccessfulDelivery: true };
  }

  phases.push({ phase: 1, name: 'Smoke Window (30m)', status: 'PASS' });

  return { phases, overallPass: true, hasSuccessfulDelivery: true };
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  if (bools.has('help') || bools.has('h')) usage(0);

  const session = (flags.session || 'pre-smoke') as Session;
  if (!['pre-smoke', 'smoke'].includes(session)) {
    throw new Error(`Invalid --session: ${session}`);
  }

  const repo = flags.repo || 'Jinn-Network/jinn-node';
  const branch = flags.branch || 'main';

  const config: HarnessConfig = {
    session,
    repo,
    branch,
    workerProject: flags['worker-project'] || 'jinn-worker',
    workerEnv: flags['worker-env'] || 'production',
    workerService: flags['worker-service'] || 'canary-worker-2',
    gatewayProject: flags['gateway-project'] || 'jinn-shared',
    gatewayEnv: flags['gateway-env'] || 'production',
    gatewayService: flags['gateway-service'] || 'x402-gateway-canary',
    workstream: flags.workstream || '',
    operateDir: resolve(flags['operate-dir'] || '/Users/adrianobradley/jinn-nodes/jinn-node/.operate'),
    expectedDeliveryRate: asInt(flags['expected-delivery-rate'], 99),
    runId: flags['run-id'] || `${session}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    runDir: '',
    preSmokeRunId: flags['pre-smoke-run-id'],
    smokeDurationMinutes: Math.max(1, asInt(flags['smoke-duration-minutes'], 30)),
  };

  if (session === 'pre-smoke' && !config.workstream) {
    throw new Error('--workstream is required for pre-smoke session');
  }

  const baseRunDir = resolve(import.meta.dirname, '..', '..', '..', '.tmp', 'railway-canary-e2e');
  config.runDir = resolve(baseRunDir, config.runId);
  await ensureDir(config.runDir);

  const artifactPaths = {
    preflight: join(config.runDir, 'preflight.json'),
    deploy: join(config.runDir, 'deploy.json'),
    dispatch: join(config.runDir, 'dispatch-results.json'),
    credentialMatrix: join(config.runDir, 'credential-matrix.json'),
    logs: join(config.runDir, 'logs-security.json'),
    checkpoint: join(config.runDir, 'checkpoint.md'),
    finalReport: join(config.runDir, 'final-report.md'),
    summary: join(config.runDir, 'summary.json'),
  };

  let runResult: { phases: PhaseResult[]; overallPass: boolean; hasSuccessfulDelivery: boolean };
  if (session === 'pre-smoke') {
    runResult = await runPreSmoke(config, artifactPaths);
  } else {
    runResult = await runSmoke(config, artifactPaths);
  }

  const checkpoint = renderCheckpoint(runResult.phases);
  await writeFile(artifactPaths.checkpoint, checkpoint, 'utf-8');

  const finalReport = renderFinalReport({
    config,
    phases: runResult.phases,
    artifactPaths,
    overallPass: runResult.overallPass,
  });
  await writeFile(artifactPaths.finalReport, finalReport, 'utf-8');

  await writeJson(artifactPaths.summary, {
    session,
    runId: config.runId,
    runDir: config.runDir,
    generatedAt: nowIso(),
    overallPass: runResult.overallPass,
    hasSuccessfulDelivery: runResult.hasSuccessfulDelivery,
  });

  console.log(finalReport);
  if (!runResult.overallPass) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`canary-harness failed: ${summarizeError(err)}`);
  process.exit(1);
});
