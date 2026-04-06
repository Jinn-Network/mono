#!/usr/bin/env tsx
/**
 * Ephemeral Canary Service Lifecycle
 *
 * Creates and tears down ephemeral Railway services for canary testing.
 * Uses the Railway GraphQL API via scripts/shared/railway.ts.
 *
 * Usage:
 *   yarn test:pipeline:canary:create  --branch <name> [--worker-project X] [--gateway-project Y]
 *   yarn test:pipeline:canary:teardown --worker-service <name> --gateway-service <name> [--worker-project X] [--gateway-project Y]
 *   yarn test:pipeline:canary:cleanup  --max-age-hours 2
 */
import {
  createRailwayProject,
  createRailwayService,
  getProjectEnvironments,
  setRailwayVariables,
} from '../../shared/railway.js';
import { parseArgs, runCommand, withRailwayContext, sleep } from '../railway/common.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_PROJECT = 'jinn-worker';
const DEFAULT_GATEWAY_PROJECT = 'jinn-shared';
const DEFAULT_WORKER_ENV = 'production';
const DEFAULT_GATEWAY_ENV = 'production';

// Service name template
function serviceName(prefix: string, branch: string): string {
  const slug = branch.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
  const ts = Date.now().toString(36).slice(-4);
  return `${prefix}-${slug}-${ts}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EphemeralServices {
  workerService: string;
  gatewayService: string;
  workerProject: string;
  gatewayProject: string;
  workerEnv: string;
  gatewayEnv: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function createEphemeralCanary(opts: {
  branch: string;
  workerProject?: string;
  gatewayProject?: string;
  workerEnv?: string;
  gatewayEnv?: string;
  envFromWorker?: string;
  envFromGateway?: string;
  dryRun?: boolean;
}): Promise<EphemeralServices> {
  const workerProject = opts.workerProject ?? DEFAULT_WORKER_PROJECT;
  const gatewayProject = opts.gatewayProject ?? DEFAULT_GATEWAY_PROJECT;
  const workerEnv = opts.workerEnv ?? DEFAULT_WORKER_ENV;
  const gatewayEnv = opts.gatewayEnv ?? DEFAULT_GATEWAY_ENV;
  const workerName = serviceName('canary-w', opts.branch);
  const gatewayName = serviceName('canary-gw', opts.branch);

  console.log(`\n=== Creating Ephemeral Canary Services ===`);
  console.log(`  Branch:          ${opts.branch}`);
  console.log(`  Worker:          ${workerName} (${workerProject}/${workerEnv})`);
  console.log(`  Gateway:         ${gatewayName} (${gatewayProject}/${gatewayEnv})\n`);

  if (opts.dryRun) {
    console.log('[DRY RUN] Would create services. Exiting.');
    return {
      workerService: workerName,
      gatewayService: gatewayName,
      workerProject,
      gatewayProject,
      workerEnv,
      gatewayEnv,
      branch: opts.branch,
    };
  }

  // Copy env vars from source services if specified
  const workerVars = opts.envFromWorker
    ? await copyServiceVars(workerProject, workerEnv, opts.envFromWorker)
    : {};
  const gatewayVars = opts.envFromGateway
    ? await copyServiceVars(gatewayProject, gatewayEnv, opts.envFromGateway)
    : {};

  // Create worker service
  console.log(`Creating worker service: ${workerName}...`);
  await createServiceInProject(workerProject, workerEnv, workerName, workerVars);

  // Create gateway service
  console.log(`Creating gateway service: ${gatewayName}...`);
  await createServiceInProject(gatewayProject, gatewayEnv, gatewayName, gatewayVars);

  // Deploy from branch
  console.log(`\nDeploying from branch ${opts.branch}...`);
  await deployService(workerProject, workerEnv, workerName);
  await deployService(gatewayProject, gatewayEnv, gatewayName);

  const result: EphemeralServices = {
    workerService: workerName,
    gatewayService: gatewayName,
    workerProject,
    gatewayProject,
    workerEnv,
    gatewayEnv,
    branch: opts.branch,
  };

  console.log(`\n=== Ephemeral Services Created ===`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function teardownEphemeralCanary(opts: {
  workerService: string;
  gatewayService: string;
  workerProject?: string;
  gatewayProject?: string;
  workerEnv?: string;
  gatewayEnv?: string;
}): Promise<void> {
  const workerProject = opts.workerProject ?? DEFAULT_WORKER_PROJECT;
  const gatewayProject = opts.gatewayProject ?? DEFAULT_GATEWAY_PROJECT;
  const workerEnv = opts.workerEnv ?? DEFAULT_WORKER_ENV;
  const gatewayEnv = opts.gatewayEnv ?? DEFAULT_GATEWAY_ENV;

  console.log(`\n=== Tearing Down Ephemeral Canary Services ===`);
  console.log(`  Worker:  ${opts.workerService} (${workerProject})`);
  console.log(`  Gateway: ${opts.gatewayService} (${gatewayProject})\n`);

  await deleteService(workerProject, workerEnv, opts.workerService);
  await deleteService(gatewayProject, gatewayEnv, opts.gatewayService);

  console.log('\n=== Teardown Complete ===');
}

// ---------------------------------------------------------------------------
// Cleanup orphans
// ---------------------------------------------------------------------------

async function cleanupOrphans(opts: {
  maxAgeHours: number;
  workerProject?: string;
  gatewayProject?: string;
}): Promise<void> {
  const maxAge = opts.maxAgeHours * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAge;
  console.log(`\n=== Cleaning Up Orphaned Canary Services (older than ${opts.maxAgeHours}h) ===\n`);

  for (const project of [
    opts.workerProject ?? DEFAULT_WORKER_PROJECT,
    opts.gatewayProject ?? DEFAULT_GATEWAY_PROJECT,
  ]) {
    console.log(`Scanning project: ${project}`);
    const services = await listCanaryServices(project);
    for (const svc of services) {
      // Extract timestamp from service name (last 4 chars of base36)
      const match = svc.name.match(/canary-(?:w|gw)-.*-([a-z0-9]{4})$/);
      if (!match) continue;

      // We can't decode exact creation time from truncated base36,
      // so rely on Railway deployment age instead
      const age = await getServiceAge(project, DEFAULT_WORKER_ENV, svc.name);
      if (age !== null && age > maxAge) {
        console.log(`  Deleting orphan: ${svc.name} (age: ${Math.round(age / 3600000)}h)`);
        await deleteService(project, DEFAULT_WORKER_ENV, svc.name);
      }
    }
  }

  console.log('\n=== Cleanup Complete ===');
}

// ---------------------------------------------------------------------------
// Railway helpers
// ---------------------------------------------------------------------------

async function copyServiceVars(
  project: string,
  environment: string,
  sourceService: string,
): Promise<Record<string, string>> {
  try {
    const result = await withRailwayContext({
      project,
      environment,
      service: sourceService,
      work: async (cwd) => {
        const res = runCommand({
          cmd: 'railway',
          argv: ['variables', '--json', '-s', sourceService, '-e', environment],
          cwd,
          timeoutMs: 30_000,
        });
        if (!res.ok) {
          console.warn(`Warning: Could not copy vars from ${sourceService}: ${res.stderr}`);
          return {};
        }
        return JSON.parse(res.stdout) as Record<string, string>;
      },
    });
    console.log(`  Copied ${Object.keys(result).length} vars from ${sourceService}`);
    return result;
  } catch (err) {
    console.warn(`Warning: Failed to copy vars from ${sourceService}:`, err);
    return {};
  }
}

async function createServiceInProject(
  project: string,
  environment: string,
  name: string,
  variables: Record<string, string>,
): Promise<void> {
  // Use Railway CLI for service creation (it handles linking automatically)
  const result = await withRailwayContext({
    project,
    environment,
    work: async (cwd) => {
      // Create the service
      const create = runCommand({
        cmd: 'railway',
        argv: ['service', 'create', name],
        cwd,
        timeoutMs: 60_000,
      });
      if (!create.ok) {
        throw new Error(`Failed to create service ${name}: ${create.stderr}`);
      }
      console.log(`  Created service: ${name}`);

      // Set variables if any
      if (Object.keys(variables).length > 0) {
        for (const [key, value] of Object.entries(variables)) {
          const set = runCommand({
            cmd: 'railway',
            argv: ['variables', 'set', `${key}=${value}`, '-s', name],
            cwd,
            timeoutMs: 15_000,
          });
          if (!set.ok) {
            console.warn(`  Warning: Failed to set ${key}: ${set.stderr}`);
          }
        }
        console.log(`  Set ${Object.keys(variables).length} variables`);
      }

      return null;
    },
  });
}

async function deployService(
  project: string,
  environment: string,
  service: string,
): Promise<void> {
  const result = await withRailwayContext({
    project,
    environment,
    service,
    work: async (cwd) => {
      const deploy = runCommand({
        cmd: 'railway',
        argv: ['redeploy', '-s', service, '-y'],
        cwd,
        timeoutMs: 120_000,
      });
      if (!deploy.ok) {
        console.warn(`Warning: Deploy trigger for ${service}: ${deploy.stderr}`);
      } else {
        console.log(`  Deploy triggered for ${service}`);
      }
      return null;
    },
  });
}

async function deleteService(
  project: string,
  environment: string,
  service: string,
): Promise<void> {
  try {
    const result = await withRailwayContext({
      project,
      environment,
      work: async (cwd) => {
        const del = runCommand({
          cmd: 'railway',
          argv: ['service', 'delete', service, '-y'],
          cwd,
          timeoutMs: 60_000,
        });
        if (!del.ok) {
          console.warn(`  Warning: Could not delete ${service}: ${del.stderr}`);
        } else {
          console.log(`  Deleted: ${service}`);
        }
        return null;
      },
    });
  } catch (err) {
    console.warn(`  Warning: Teardown failed for ${service}:`, err);
  }
}

async function listCanaryServices(project: string): Promise<{ name: string; id: string }[]> {
  try {
    const result = await withRailwayContext({
      project,
      environment: DEFAULT_WORKER_ENV,
      work: async (cwd) => {
        const res = runCommand({
          cmd: 'railway',
          argv: ['status', '--json'],
          cwd,
          timeoutMs: 30_000,
        });
        if (!res.ok) return [];
        const data = JSON.parse(res.stdout);
        const services = data?.services ?? [];
        return services
          .filter((s: any) => /^canary-(w|gw)-/.test(s.name))
          .map((s: any) => ({ name: s.name, id: s.id }));
      },
    });
    return result;
  } catch {
    return [];
  }
}

async function getServiceAge(
  project: string,
  environment: string,
  service: string,
): Promise<number | null> {
  try {
    const result = await withRailwayContext({
      project,
      environment,
      service,
      work: async (cwd) => {
        const res = runCommand({
          cmd: 'railway',
          argv: ['service', 'status', '-s', service, '--json'],
          cwd,
          timeoutMs: 15_000,
        });
        if (!res.ok) return null;
        const data = JSON.parse(res.stdout);
        const created = data?.createdAt ?? data?.updatedAt;
        if (!created) return null;
        return Date.now() - new Date(created).getTime();
      },
    });
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const subcommand = process.argv[2];
  const { flags } = parseArgs(process.argv.slice(3));

  switch (subcommand) {
    case 'create': {
      const branch = flags['branch'];
      if (!branch) {
        console.error('Usage: ephemeral-canary.ts create --branch <name>');
        process.exit(1);
      }
      const result = await createEphemeralCanary({
        branch,
        workerProject: flags['worker-project'],
        gatewayProject: flags['gateway-project'],
        workerEnv: flags['worker-env'],
        gatewayEnv: flags['gateway-env'],
        envFromWorker: flags['env-from-worker'] ?? 'canary-worker-2',
        envFromGateway: flags['env-from-gateway'] ?? 'x402-gateway-canary',
        dryRun: flags['dry-run'] === 'true',
      });
      // Output as JSON for other scripts to consume
      console.log(`\n__RESULT__${JSON.stringify(result)}`);
      break;
    }

    case 'teardown': {
      const workerService = flags['worker-service'];
      const gatewayService = flags['gateway-service'];
      if (!workerService || !gatewayService) {
        console.error('Usage: ephemeral-canary.ts teardown --worker-service <name> --gateway-service <name>');
        process.exit(1);
      }
      await teardownEphemeralCanary({
        workerService,
        gatewayService,
        workerProject: flags['worker-project'],
        gatewayProject: flags['gateway-project'],
      });
      break;
    }

    case 'cleanup': {
      const maxAge = Number(flags['max-age-hours'] ?? 2);
      await cleanupOrphans({
        maxAgeHours: maxAge,
        workerProject: flags['worker-project'],
        gatewayProject: flags['gateway-project'],
      });
      break;
    }

    default:
      console.error('Usage: ephemeral-canary.ts <create|teardown|cleanup> [options]');
      console.error('  create   --branch <name> [--env-from-worker <service>] [--env-from-gateway <service>]');
      console.error('  teardown --worker-service <name> --gateway-service <name>');
      console.error('  cleanup  --max-age-hours <N>');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Ephemeral canary error:', err);
  process.exit(2);
});
