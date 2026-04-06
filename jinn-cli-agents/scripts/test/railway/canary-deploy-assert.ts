#!/usr/bin/env npx tsx
import { resolve } from 'node:path';
import {
  parseArgs,
  runCommand,
  runRailwayJson,
  summarizeError,
  withRailwayContext,
  writeJson,
  nowIso,
} from './common.js';

interface TargetConfig {
  label: 'worker' | 'gateway';
  project: string;
  environment: string;
  service: string;
  requiredKeys: string[];
  optionalAnyOf?: string[];
}

interface ServiceCheckResult {
  label: string;
  project: string;
  environment: string;
  service: string;
  redeployed: boolean;
  status: 'PASS' | 'FAIL';
  checks: Array<{ name: string; pass: boolean; detail?: string }>;
  source: {
    sourceRepo: string | null;
    metaRepo: string | null;
    branch: string | null;
    deploymentId: string | null;
    deploymentStatus: string | null;
  };
  variablePresence: Record<string, boolean>;
}

function usage(exitCode: number = 1): never {
  console.error(
    [
      'Usage: yarn tsx scripts/test/railway/canary-deploy-assert.ts [options]',
      '',
      'Options:',
      '  --repo <owner/repo>             Expected repo (default: Jinn-Network/jinn-node)',
      '  --branch <name>                 Expected branch (required for strict assertion)',
      '  --worker-project <name>         Default: jinn-worker',
      '  --worker-env <name>             Default: production',
      '  --worker-service <name>         Default: canary-worker-2',
      '  --gateway-project <name>        Default: jinn-shared',
      '  --gateway-env <name>            Default: production',
      '  --gateway-service <name>        Default: x402-gateway-canary',
      '  --artifact <path>               Write JSON report',
      '  --assert-only                   Skip redeploy; assert current state only',
      '',
      'Exit code is non-zero on any failed check.',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function matchesRepo(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const normalizedExpected = expected.toLowerCase();
  const normalizedActual = actual.toLowerCase();
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.endsWith(`/${normalizedExpected}`) ||
    normalizedActual.endsWith(`${normalizedExpected}.git`) ||
    normalizedActual.includes(normalizedExpected)
  );
}

function findServiceNode(statusPayload: any, envName: string, serviceName: string): any | null {
  const envEdges = statusPayload?.environments?.edges;
  if (!Array.isArray(envEdges)) return null;

  for (const envEdge of envEdges) {
    const envNode = envEdge?.node;
    if (!envNode || envNode?.name !== envName) continue;
    const serviceEdges = envNode?.serviceInstances?.edges;
    if (!Array.isArray(serviceEdges)) return null;

    for (const serviceEdge of serviceEdges) {
      const node = serviceEdge?.node;
      if (node?.serviceName === serviceName) return node;
    }
  }

  return null;
}

async function evaluateTarget(args: {
  target: TargetConfig;
  expectedRepo: string;
  expectedBranch: string;
  redeploy: boolean;
}): Promise<ServiceCheckResult> {
  return withRailwayContext({
    project: args.target.project,
    environment: args.target.environment,
    service: args.target.service,
    work: async (cwd) => {
      let redeployed = false;
      if (args.redeploy) {
        const redeployResult = runCommand({
          cmd: 'railway',
          argv: ['redeploy', '-s', args.target.service, '-y'],
          cwd,
          timeoutMs: 300_000,
        });

        if (!redeployResult.ok) {
          return {
            label: args.target.label,
            project: args.target.project,
            environment: args.target.environment,
            service: args.target.service,
            redeployed: false,
            status: 'FAIL' as const,
            checks: [
              {
                name: 'redeploy',
                pass: false,
                detail: redeployResult.stderr || redeployResult.stdout,
              },
            ],
            source: {
              sourceRepo: null,
              metaRepo: null,
              branch: null,
              deploymentId: null,
              deploymentStatus: null,
            },
            variablePresence: {},
          };
        }
        redeployed = true;
      }

      const serviceStatus = await runRailwayJson<{ id: string; name: string; status: string }>({
        cwd,
        argv: ['service', 'status', '-s', args.target.service, '-e', args.target.environment, '--json'],
      });

      const projectStatus = await runRailwayJson<any>({
        cwd,
        argv: ['status', '--json'],
      });

      const vars = await runRailwayJson<Record<string, string>>({
        cwd,
        argv: ['variables', '--json', '-s', args.target.service, '-e', args.target.environment],
      });

      const node = findServiceNode(projectStatus, args.target.environment, args.target.service);
      const latest = node?.latestDeployment;
      const meta = latest?.meta;
      const sourceRepo = typeof node?.source?.repo === 'string' ? node.source.repo : null;
      const metaRepo = typeof meta?.repo === 'string' ? meta.repo : null;
      const branch = typeof meta?.branch === 'string' ? meta.branch : null;

      const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

      checks.push({
        name: 'service_status_success',
        pass: serviceStatus?.status === 'SUCCESS',
        detail: `status=${serviceStatus?.status ?? 'unknown'}`,
      });

      const resolvedRepo = sourceRepo || metaRepo;
      checks.push({
        name: 'source_repo_present',
        pass: Boolean(resolvedRepo),
        detail: `source.repo=${sourceRepo ?? 'null'} meta.repo=${metaRepo ?? 'null'}`,
      });

      checks.push({
        name: 'source_repo_matches_expected',
        pass: matchesRepo(resolvedRepo, args.expectedRepo),
        detail: `expected=${args.expectedRepo} actual=${resolvedRepo ?? 'null'}`,
      });

      checks.push({
        name: 'source_branch_present',
        pass: Boolean(branch),
        detail: `branch=${branch ?? 'null'}`,
      });

      checks.push({
        name: 'source_branch_matches_expected',
        pass: branch === args.expectedBranch,
        detail: `expected=${args.expectedBranch} actual=${branch ?? 'null'}`,
      });

      const variablePresence: Record<string, boolean> = {};
      for (const key of args.target.requiredKeys) {
        variablePresence[key] = typeof vars[key] === 'string' && vars[key].length > 0;
        checks.push({
          name: `variable_present:${key}`,
          pass: variablePresence[key],
        });
      }

      if (args.target.optionalAnyOf && args.target.optionalAnyOf.length > 0) {
        const anyPresent = args.target.optionalAnyOf.some((key) => typeof vars[key] === 'string' && vars[key].length > 0);
        checks.push({
          name: `variable_any_present:${args.target.optionalAnyOf.join('|')}`,
          pass: anyPresent,
        });
        for (const key of args.target.optionalAnyOf) {
          variablePresence[key] = typeof vars[key] === 'string' && vars[key].length > 0;
        }
      }

      const status = checks.every((check) => check.pass) ? 'PASS' : 'FAIL';

      return {
        label: args.target.label,
        project: args.target.project,
        environment: args.target.environment,
        service: args.target.service,
        redeployed,
        status,
        checks,
        source: {
          sourceRepo,
          metaRepo,
          branch,
          deploymentId: latest?.id ?? null,
          deploymentStatus: latest?.status ?? null,
        },
        variablePresence,
      };
    },
  });
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  if (bools.has('help') || bools.has('h')) usage(0);

  const expectedRepo = (flags.repo || 'Jinn-Network/jinn-node').trim();
  const expectedBranch = (flags.branch || '').trim();
  if (!expectedBranch) {
    throw new Error('--branch is required for strict deploy assertion.');
  }

  const workerTarget: TargetConfig = {
    label: 'worker',
    project: flags['worker-project'] || 'jinn-worker',
    environment: flags['worker-env'] || 'production',
    service: flags['worker-service'] || 'canary-worker-2',
    requiredKeys: [
      'RPC_URL',
      'CHAIN_ID',
      'OPERATE_PASSWORD',
      'PONDER_GRAPHQL_URL',
      'CONTROL_API_URL',
      'X402_GATEWAY_URL',
      'WORKSTREAM_FILTER',
    ],
  };

  const gatewayTarget: TargetConfig = {
    label: 'gateway',
    project: flags['gateway-project'] || 'jinn-shared',
    environment: flags['gateway-env'] || 'production',
    service: flags['gateway-service'] || 'x402-gateway-canary',
    requiredKeys: [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ADMIN_ADDRESSES',
      'PONDER_GRAPHQL_URL',
    ],
    optionalAnyOf: ['CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY', 'PRIVATE_KEY'],
  };

  const artifactPath = flags.artifact ? resolve(flags.artifact) : undefined;
  const redeploy = !bools.has('assert-only');

  const startedAt = nowIso();
  const results = await Promise.all([
    evaluateTarget({ target: workerTarget, expectedRepo, expectedBranch, redeploy }),
    evaluateTarget({ target: gatewayTarget, expectedRepo, expectedBranch, redeploy }),
  ]);

  const passed = results.every((result) => result.status === 'PASS');
  const report = {
    startedAt,
    finishedAt: nowIso(),
    expectedRepo,
    expectedBranch,
    redeploy,
    summary: {
      pass: passed,
      totalTargets: results.length,
      passedTargets: results.filter((result) => result.status === 'PASS').length,
      failedTargets: results.filter((result) => result.status === 'FAIL').length,
    },
    results,
  };

  if (artifactPath) {
    await writeJson(artifactPath, report);
  }

  console.log(JSON.stringify(report, null, 2));

  if (!passed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`canary-deploy-assert failed: ${summarizeError(err)}`);
  process.exit(1);
});
