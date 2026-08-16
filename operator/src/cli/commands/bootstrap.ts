import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig as defaultLoadConfig, getConfigPathFromArgs as defaultGetConfigPathFromArgs, buildConfigProvenance } from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import {
  checkRpcNetwork as defaultCheckRpcNetwork,
  logRpcLocalDevToStderr as defaultLogRpcLocalDevToStderr,
  rpcNetworkFailureHint as defaultRpcNetworkFailureHint,
} from '../../preflight/rpc-network.js';
import {
  checkDaemonGuard as defaultCheckDaemonGuard,
  daemonGuardEnvelope,
} from '../daemon-guard.js';

/** §6.2 — `stack` only when `JINN_DEBUG=1` (exact string). */
function envelopeDebug(env: NodeJS.ProcessEnv): boolean {
  return env['JINN_DEBUG'] === '1';
}

function humanBootstrapSuccess(payload: {
  master: string;
  services: Array<{ index: number; step: string; serviceId: number | null }>;
}): string {
  const lines = [`Bootstrap complete.`, `Master: ${payload.master}`];
  if (payload.services.length === 0) {
    lines.push('Services: (none)');
  } else {
    lines.push('Services:');
    for (const s of payload.services) {
      const id = s.serviceId != null ? ` (id ${s.serviceId})` : '';
      lines.push(`  #${s.index} ${s.step}${id}`);
    }
  }
  return lines.join('\n');
}

export interface BootstrapDeps extends BaseCommandDeps {
  checkRpcNetwork: typeof defaultCheckRpcNetwork;
  rpcNetworkFailureHint: typeof defaultRpcNetworkFailureHint;
  logRpcLocalDevToStderr: typeof defaultLogRpcLocalDevToStderr;
  bootstrapperFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => FleetBootstrapper;
  resolveCliPassword: typeof defaultResolveCliPassword;
  checkDaemonGuard: typeof defaultCheckDaemonGuard;
}

const PRODUCTION_DEPS: BootstrapDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  checkRpcNetwork: defaultCheckRpcNetwork,
  rpcNetworkFailureHint: defaultRpcNetworkFailureHint,
  logRpcLocalDevToStderr: defaultLogRpcLocalDevToStderr,
  checkDaemonGuard: defaultCheckDaemonGuard,
  bootstrapperFactory: (config) => new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: config.network === 'testnet' ? 'base-sepolia' : 'base',
    rpcUrl: config.rpcUrl,
    env: (config as any).env,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    debug: config.debug,
    minEoaGasWei: config.minEoaGasWei,
    minSafeEthWei: config.minSafeEthWei,
    pollIntervalMs: config.pollIntervalMs,
  }),
  resolveCliPassword: defaultResolveCliPassword,
};

export function createBootstrapCommand(deps: BootstrapDeps = PRODUCTION_DEPS): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    let json = false;
    let human = false;
    let configPath: string | undefined;
    try {
      const parsed = parseCommandArgs(ctx.argv, { ...COMMON_FLAGS });
      json = Boolean(parsed.values.json);
      human = Boolean(parsed.values.human);
      configPath =
        typeof parsed.values.config === 'string' && parsed.values.config.length > 0
          ? parsed.values.config
          : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: 'Invalid command-line arguments.',
          hint: 'Run `jinn bootstrap --help` for supported flags.',
          exampleCli: 'jinn bootstrap --json',
          details: { field: 'argv', expected: message },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const password = deps.resolveCliPassword(ctx.argv, ctx.env);
    if (!password.ok) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: password.message,
          hint: 'Set JINN_PASSWORD or pass --password-fd N, then re-run.',
          exampleCli: 'jinn bootstrap --json',
          details: { field: 'keystore password', expected: 'non-empty string via environment or fd' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = deps.loadConfig(configPath);
    const rpcPreflight = await deps.checkRpcNetwork(config);
    if (!rpcPreflight.ok) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: rpcPreflight.message,
          hint: deps.rpcNetworkFailureHint(rpcPreflight),
          exampleCli: 'jinn doctor --human',
          details: {
            field: 'rpcUrl',
            network: rpcPreflight.network,
            expectedChainId: rpcPreflight.expectedChainId,
            actualChainId: rpcPreflight.actualChainId ?? null,
            rpcHost: rpcPreflight.rpcHost,
            reason: rpcPreflight.reason,
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    // Log to real stderr; `ctx.writer` is stdout and must stay a single JSON (or
    // human) line for `emitResult` / `emitEnvelope` contracts.
    deps.logRpcLocalDevToStderr(rpcPreflight);

    // D0a P3 (#525/#562/#897): `bootstrap` signs Safe writes with the agent
    // EOA via `executeSafeTxDirect`/`executeSafeTxBatch`, with no cross-process
    // lock against a concurrently running daemon signing from the same EOA.
    const daemonGuard = deps.checkDaemonGuard({ earningDir: config.earningDir, env: ctx.env });
    if (daemonGuard.blocked) {
      emitEnvelope(
        daemonGuardEnvelope(daemonGuard, 'jinn bootstrap --json'),
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    // Pass env into config so bootstrapperFactory can forward it to FleetBootstrapper.
    const configWithEnv = { ...config, env: ctx.env };
    const bootstrapper = deps.bootstrapperFactory(configWithEnv as any);

    let result: Awaited<ReturnType<FleetBootstrapper['bootstrap']>>;
    try {
      result = await bootstrapper.bootstrap(password.password);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      const message =
        err instanceof Error && err.message.trim().length > 0
          ? err.message
          : 'Bootstrap failed with an unexpected error.';
      const details: Record<string, unknown> = { cause };
      if (envelopeDebug(ctx.env) && err instanceof Error && err.stack) {
        details.stack = err.stack;
      }
      emitEnvelope(
        {
          code: 'fatal',
          message,
          details,
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    if (result.funding) {
      emitEnvelope(
        {
          code: 'funding_required',
          message: result.message,
          hint: 'Fund the listed address and re-run jinn bootstrap.',
          exampleCli: 'jinn fund-requirements --json',
          details: {
            role: 'master',
            address: result.funding.master_address,
            asset: 'native',
            needWei: result.funding.eth_required,
            haveWei: result.funding.eth_balance,
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    if (!result.ok) {
      emitEnvelope(
        {
          code: 'fatal',
          message: result.message,
          hint: 'Bootstrap failed before the fleet reached a runnable state.',
          details: { cause: result.message },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const state = result.fleet_state;
    const provenance = buildConfigProvenance(configPath, config, ctx.env);
    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      master: state.master_address ?? '',
      services: state.services.map((s) => ({
        index: s.index,
        step: s.step,
        serviceId: s.service_id ?? null,
      })),
      config: provenance,
    };

    emitResult(payload, (v) => humanBootstrapSuccess(v as typeof payload), {
      json,
      human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    ctx.exit(0);
  }

  return {
    name: 'bootstrap',
    summary: 'Advance the fleet state machine toward a running daemon',
    helpText: `Usage: jinn bootstrap [--human] [--config <path>] [--password-fd <fd>]

Idempotent. Walks the fleet state machine from wherever it is toward
a complete, running state. Re-run as many times as needed; the
machine picks up where it left off. On funding gates, exits 10 with
a funding_required envelope.

Requires the password environment variable required by the client
(never as a flag).

Examples:
  jinn bootstrap
  jinn bootstrap --human

Failure example (funding gate):
  $ jinn bootstrap
  {"schemaVersion":1,"code":"funding_required","exitCode":10,...}
  $ echo $?
  10
`,
    run,
  };
}

const command: CommandModule = createBootstrapCommand();
export default command;
