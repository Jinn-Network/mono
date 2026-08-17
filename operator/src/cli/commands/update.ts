import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  DEFAULT_CONFIG_PATH,
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { FleetStateStore } from '../../earning/store.js';
import type { FleetState, ServiceState } from '../../earning/types.js';
import { Store } from '../../store/store.js';
import integrationsCommand from './integrations.js';

class StringWriter {
  private chunks: string[] = [];
  write(s: string): boolean { this.chunks.push(s); return true; }
  toString(): string { return this.chunks.join(''); }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(HERE, '..', '..', '..', 'package.json');

function readClientVersion(): string {
  try {
    const raw = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    // Fallback differs deliberately from `version.ts`'s `readClientVersion`
    // ('0.0.0'): this value is interpolated into a human-readable success line,
    // so 'unknown' reads more honestly than a fake semver. Not extracted to a
    // shared util on purpose.
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Formats the final all-good indicator line for `jinn update`.
 * Green when stderr is a TTY and NO_COLOR is unset; plain text otherwise.
 *
 * Exported for tests; the daemon never imports this directly.
 */
export function formatUpdateSuccessLine(
  version: string,
  opts: { stderrIsTty: boolean; noColor: boolean },
): string {
  const text = `✓ jinn updated to v${version}`;
  if (opts.stderrIsTty && !opts.noColor) {
    return `\x1b[32m${text}\x1b[0m`;
  }
  return text;
}

interface IntegrationInstallResultEntry {
  target: string;
  mcp: { status: string; detail: string };
  skill: { status: string; detail: string };
  // Optional: older `integrations install` builds (before the stop-hook
  // installer wiring) don't emit this axis. Absent must never be conflated
  // with `ok` — see the flatMap below, which only inspects it when present.
  hook?: { status: string; detail: string };
}

function summarizeIntegrationInstall(
  output: string,
  exitCode: number | null,
): { status: 'ok' | 'error'; detail: string } {
  if (exitCode !== null && exitCode !== 0) {
    return { status: 'error', detail: output || `integrations install exited with code ${exitCode}` };
  }

  try {
    const parsed = JSON.parse(output) as { results?: IntegrationInstallResultEntry[] };
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const failures = results.flatMap((result) => {
      const failedParts: string[] = [];
      if (result.mcp.status === 'error') failedParts.push(`MCP: ${result.mcp.detail}`);
      if (result.skill.status === 'error') failedParts.push(`Skill: ${result.skill.detail}`);
      if (result.hook?.status === 'error') failedParts.push(`Hook: ${result.hook.detail}`);
      if (failedParts.length === 0) return [];
      return [`${result.target} (${failedParts.join('; ')})`];
    });
    if (failures.length > 0) {
      return { status: 'error', detail: failures.join(' | ') };
    }
    return { status: 'ok', detail: 'Integrations updated' };
  } catch {
    return { status: 'error', detail: output || 'Unexpected integrations install output' };
  }
}

export interface UpdateDeps {
  integrationsRun: typeof integrationsCommand.run;
  loadConfig: typeof defaultLoadConfig;
  getConfigPathFromArgs: typeof defaultGetConfigPathFromArgs;
  fleetStateStoreFactory: (earningDir: string) => Pick<FleetStateStore, 'dir' | 'hasStateFile' | 'tryLoadExisting' | 'save'>;
  storeFactory: (dbPath: string) => Pick<Store, 'close'>;
}

const PRODUCTION_DEPS: UpdateDeps = {
  integrationsRun: integrationsCommand.run.bind(integrationsCommand),
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  fleetStateStoreFactory: (earningDir) => new FleetStateStore(earningDir),
  storeFactory: (dbPath) => new Store(dbPath),
};

type UpdateStepStatus = 'ok' | 'error' | 'skipped' | 'warning' | 'state-integrity';

interface UpdateStep {
  step: string;
  status: UpdateStepStatus;
  detail: string;
}

interface LocalEarningAssessment {
  status: Extract<UpdateStepStatus, 'ok' | 'skipped' | 'warning' | 'state-integrity'>;
  detail: string;
}

const NO_CHAIN_IO_NOTE = 'No chain readback or writes were performed.';
const PRESERVED_FIELDS =
  'Preserved locally recorded wallet, agent, Safe, service, Mech, and ERC-8004 binding fields.';
const LEGACY_REQUEST_FIRST_CONFIG_KEYS = [
  'testnetClaimRegistryDeploymentPath',
  'claimRegistryDeploymentPath',
  'claimRegistryAddress',
  'claimRegistry',
  'testnetClaimRegistry',
  'requestRegistryDeploymentPath',
  'requestRegistryAddress',
  'requestRegistry',
] as const;
const LEGACY_REQUEST_FIRST_ENV_VARS = [
  'JINN_TESTNET_CLAIM_REGISTRY_DEPLOYMENT',
  'JINN_CLAIM_REGISTRY_ADDRESS',
  'JINN_REQUEST_REGISTRY_ADDRESS',
] as const;

function isTaskReadyService(svc: ServiceState): boolean {
  return svc.step === 'complete' || svc.step === 'safe_binding_pending';
}

function missingTaskReadyFields(svc: ServiceState): string[] {
  const missing: string[] = [];
  if (!svc.agent_address) missing.push('agent EOA');
  if (!svc.safe_address) missing.push('Safe');
  if (svc.service_id === null) missing.push('service id');
  if (!svc.staking_address) missing.push('staking contract');
  if (!svc.mech_address) missing.push('Mech');
  return missing;
}

function missingOptionalErc8004Fields(svc: ServiceState): string[] {
  const missing: string[] = [];
  if (!svc.agent_id) missing.push('ERC-8004 agent id');
  if (!svc.identity_registry_address) missing.push('Identity Registry');
  return missing;
}

function assessLocalEarningState(state: FleetState): LocalEarningAssessment {
  if (state.services.length === 0) {
    return {
      status: 'skipped',
      detail: `Local earning state exists but no services are recorded yet; node is not bootstrapped. ${NO_CHAIN_IO_NOTE}`,
    };
  }

  const readyServices = state.services.filter(isTaskReadyService);
  const integrityIssues = readyServices
    .map((svc) => ({ index: svc.index, missing: missingTaskReadyFields(svc) }))
    .filter((issue) => issue.missing.length > 0);

  if (integrityIssues.length > 0) {
    const issueText = integrityIssues
      .map((issue) => `service #${issue.index} missing ${issue.missing.join(', ')}`)
      .join('; ');
    return {
      status: 'state-integrity',
      detail:
        `State-integrity issue: ${issueText}. Run doctor/recovery; update preserved local state and did not repair from RPC. ${NO_CHAIN_IO_NOTE}`,
    };
  }

  const optionalErc8004Warnings = readyServices
    .map((svc) => ({ index: svc.index, missing: missingOptionalErc8004Fields(svc) }))
    .filter((issue) => issue.missing.length > 0);

  if (readyServices.length !== state.services.length) {
    return {
      status: 'warning',
      detail:
        `Task-native local preflight found ${readyServices.length}/${state.services.length} services ready; ` +
        `remaining services are still bootstrapping. ${PRESERVED_FIELDS} ${NO_CHAIN_IO_NOTE}`,
    };
  }

  if (optionalErc8004Warnings.length > 0) {
    const warningText = optionalErc8004Warnings
      .map((issue) => `service #${issue.index} missing ${issue.missing.join(', ')}`)
      .join('; ');
    return {
      status: 'warning',
      detail:
        `Task-native local preflight found optional ERC-8004 metadata not recorded locally: ${warningText}. ` +
        `${PRESERVED_FIELDS} Run doctor or migrate-agent-id if participation requires agent registry metadata. ${NO_CHAIN_IO_NOTE}`,
    };
  }

  return {
    status: 'ok',
    detail:
      `Task-native local preflight passed for ${state.services.length} service${state.services.length === 1 ? '' : 's'}; ` +
      `${PRESERVED_FIELDS} ${NO_CHAIN_IO_NOTE}`,
  };
}

function timestampForBackup(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function runLegacyRequestFirstConfigMigration(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv,
): UpdateStep {
  const effectivePath = configPath ?? DEFAULT_CONFIG_PATH;
  const legacyEnvVars = LEGACY_REQUEST_FIRST_ENV_VARS.filter((name) => env[name] !== undefined);
  const envNote = legacyEnvVars.length > 0
    ? ` Legacy env var(s) ignored by runtime: ${legacyEnvVars.join(', ')}.`
    : '';

  if (!existsSync(effectivePath)) {
    return {
      step: 'config-migration',
      status: legacyEnvVars.length > 0 ? 'warning' : 'skipped',
      detail: `No config file found; no legacy ClaimRegistry/request-first fields to rewrite.${envNote}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(effectivePath, 'utf8'));
  } catch (err) {
    return {
      step: 'config-migration',
      status: 'error',
      detail: `Could not parse config for legacy ClaimRegistry/request-first migration: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      step: 'config-migration',
      status: 'error',
      detail: 'Config file root is not an object; legacy ClaimRegistry/request-first migration skipped.',
    };
  }

  const values = parsed as Record<string, unknown>;
  const removed = LEGACY_REQUEST_FIRST_CONFIG_KEYS.filter((key) => key in values);
  if (removed.length === 0) {
    return {
      step: 'config-migration',
      status: legacyEnvVars.length > 0 ? 'warning' : 'ok',
      detail:
        `No legacy ClaimRegistry/request-first config fields found; runtime ignores removed request-first knobs.${envNote}`,
    };
  }

  const next: Record<string, unknown> = { ...values };
  for (const key of removed) {
    delete next[key];
  }

  const backupPath = `${effectivePath}.bak.${timestampForBackup()}`;
  copyFileSync(effectivePath, backupPath);
  writeFileSync(effectivePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return {
    step: 'config-migration',
    status: 'ok',
    detail:
      `Removed legacy ClaimRegistry/request-first config field(s): ${removed.join(', ')}; ` +
      `backup written to ${backupPath}. Runtime uses TaskCoordinator/JinnRouterV3 readiness instead.${envNote}`,
  };
}

async function runLocalTaskNativePreflight(
  ctx: CommandContext,
  deps: UpdateDeps,
): Promise<UpdateStep[]> {
  const steps: UpdateStep[] = [];

  try {
    const configPath =
      deps.getConfigPathFromArgs(ctx.argv ?? []) ??
      (typeof process !== 'undefined' ? deps.getConfigPathFromArgs(process.argv.slice(2)) : undefined);
    steps.push(runLegacyRequestFirstConfigMigration(configPath, ctx.env));
    const config = deps.loadConfig(configPath);

    let localStore: Pick<Store, 'close'> | null = null;
    try {
      localStore = deps.storeFactory(config.dbPath);
      steps.push({
        step: 'task-native-store',
        status: 'ok',
        detail: 'Task-native local store preflight complete: task post records support protocol task ids and task CIDs.',
      });
    } finally {
      localStore?.close();
    }

    const fleetStore = deps.fleetStateStoreFactory(config.earningDir);
    if (!fleetStore.hasStateFile()) {
      steps.push({
        step: 'earning-state',
        status: 'skipped',
        detail: `No local earning state found in ${fleetStore.dir}; node is not bootstrapped. Nothing to migrate. ${NO_CHAIN_IO_NOTE}`,
      });
      return steps;
    }

    const state = await fleetStore.tryLoadExisting();
    if (!state) {
      steps.push({
        step: 'earning-state',
        status: 'state-integrity',
        detail:
          `Local earning state exists in ${fleetStore.dir} but is not readable as current fleet state. ` +
          `Run doctor/recovery; update did not reset it or repair from RPC. ${NO_CHAIN_IO_NOTE}`,
      });
      return steps;
    }

    await fleetStore.save(state);
    const assessment = assessLocalEarningState(state);
    steps.push({
      step: 'earning-state',
      status: assessment.status,
      detail: assessment.detail,
    });
    return steps;
  } catch (err) {
    steps.push({
      step: 'task-native-preflight',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    return steps;
  }
}

export function createUpdateCommand(overrides: Partial<UpdateDeps> = {}): CommandModule {
  const deps: UpdateDeps = { ...PRODUCTION_DEPS, ...overrides };
  return {
    name: 'update',
    summary: 'Update the client package, run local Task-native preflight, and refresh integrations',
    helpText: `Usage: jinn update [--human] [--skip-npm] [--skip-plugins]

Steps:
  1. npm update -g @jinn-network/operator  (updates binary + MCP server + skill source)
  2. local Task-native preflight          (migrates local SQLite schema and validates earning state)
  3. jinn integrations install            (refreshes skills in all configured tools)

The MCP server updates automatically (it's a binary on PATH).
Skills need re-installation because they are copied into each tool's
config directory.

Task-native preflight is local-only: it preserves recorded wallet/agent/Safe/
service/Mech/ERC-8004 fields and reports state-integrity issues for
doctor/recovery. It does not read from or write to chain.

Flags:
  --skip-npm        Skip the npm update step
  --skip-plugins    Skip the integrations refresh step

Examples:
  jinn update
  jinn update --human
  jinn update --skip-npm          # just refresh integrations with current version
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            ...COMMON_FLAGS,
            'skip-npm': { type: 'boolean', default: false },
            'skip-plugins': { type: 'boolean', default: false },
          },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn update',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const skipNpm = parsed.values['skip-npm'] as boolean;
      const skipPlugins = parsed.values['skip-plugins'] as boolean;

      const steps: UpdateStep[] = [];

      // ── Step 1: Update the npm package ──
      if (!skipNpm) {
        console.error('[update] Updating @jinn-network/operator...');
        try {
          const output = execSync('npm update -g @jinn-network/operator 2>&1', {
            encoding: 'utf-8',
            timeout: 120_000,
          });
          steps.push({ step: 'npm-update', status: 'ok', detail: output.trim() || 'Package updated' });
          console.error('[update] Package updated.');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          steps.push({ step: 'npm-update', status: 'error', detail: message });
          console.error(`[update] npm update failed: ${message}`);
          // Continue — integrations refresh may still be useful even if npm update failed
        }
      } else {
        steps.push({ step: 'npm-update', status: 'skipped', detail: '--skip-npm' });
      }

      // ── Step 2: Local-only Task-native migration/preflight ──
      console.error('[update] Running local Task-native preflight...');
      const localSteps = await runLocalTaskNativePreflight(ctx, deps);
      steps.push(...localSteps);
      if (localSteps.some((step) => step.status === 'error' || step.status === 'state-integrity')) {
        console.error('[update] Local Task-native preflight found issues.');
      } else {
        console.error('[update] Local Task-native preflight complete.');
      }

      // ── Step 3: Re-install integrations (propagates skill updates) ──
      if (!skipPlugins) {
        console.error('[update] Updating integrations...');
        const integrationWriter = new StringWriter();
        let integrationExitCode: number | null = null;
        await deps.integrationsRun({
          argv: ['install', '--json'],
          stdoutIsTty: false,
          writer: integrationWriter,
          exit: (code: number) => { integrationExitCode = code; },
          env: ctx.env,
        });

        const integrationOutput = integrationWriter.toString().trim();
        const integrationResult = summarizeIntegrationInstall(integrationOutput, integrationExitCode);
        if (integrationResult.status === 'ok') {
          steps.push({ step: 'integrations-install', status: 'ok', detail: integrationResult.detail });
          console.error('[update] Integrations updated.');
        } else {
          steps.push({ step: 'integrations-install', status: 'error', detail: integrationResult.detail });
          console.error('[update] Integration update had issues.');
        }
      } else {
        steps.push({ step: 'integrations-install', status: 'skipped', detail: '--skip-plugins' });
      }

      const allOk = steps.every((s) => s.status === 'ok' || s.status === 'skipped' || s.status === 'warning');

      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'update',
          ok: allOk,
          steps,
        },
        (v) => {
          const value = v as { ok: boolean; steps: UpdateStep[] };
          const lines = value.steps.map(
            (s) => `  ${s.step.padEnd(20)} ${s.status}: ${s.detail}`,
          );
          return `Update ${value.ok ? 'complete' : 'completed with errors'}:\n${lines.join('\n')}`;
        },
        {
          json: Boolean(parsed.values.json),
          human: Boolean(parsed.values.human),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );

      // All-good indicator (#337): on happy path, end terminal output with a
      // clear success line on stderr so it appears last regardless of JSON or
      // human mode and never pollutes the structured stdout payload. Failure
      // path is unchanged — existing error lines already make the state legible.
      if (allOk) {
        const noColor = Boolean(ctx.env['NO_COLOR']);
        const stderrIsTty = Boolean(process.stderr.isTTY);
        // NB: `readClientVersion()` reports the currently-running process's
        // build, not the freshly-installed one — the new binary takes effect on
        // the next launch, so this line reflects the version that just ran the
        // update, not the version the operator just updated TO.
        console.error(
          formatUpdateSuccessLine(readClientVersion(), { stderrIsTty, noColor }),
        );
      }
    },
  };
}

const command: CommandModule = createUpdateCommand();
export default command;
