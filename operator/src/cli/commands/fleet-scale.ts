import { parseArgs } from 'node:util';
import { COMMON_FLAGS, type BaseCommandDeps, type CommandContext, type CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw as defaultGatherIntrospectionRaw } from '../introspection-context.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import {
  createCliSignerContext as defaultCreateCliSignerContext,
} from '../execution-context.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { retireFleetServiceOnChain as defaultRetireFleetServiceOnChain } from '../../earning/fleet-retire.js';
import { findServiceByDisplayIndex as defaultFindServiceByDisplayIndex } from '../../earning/fleet-display-index.js';
import { isRecoverableTransactionError as defaultIsRecoverableTransactionError } from '../../tx-retry.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { isOperationalServiceStep } from '../../earning/types.js';
import {
  checkDaemonGuard as defaultCheckDaemonGuard,
  daemonGuardEnvelope,
} from '../daemon-guard.js';

export interface FleetScaleDeps extends BaseCommandDeps {
  gatherIntrospectionRaw: typeof defaultGatherIntrospectionRaw;
  resolveCliPassword: typeof defaultResolveCliPassword;
  signerContextFactory: typeof defaultCreateCliSignerContext;
  bootstrapperFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => FleetBootstrapper;
  retireFleetServiceOnChain: typeof defaultRetireFleetServiceOnChain;
  findServiceByDisplayIndex: typeof defaultFindServiceByDisplayIndex;
  isRecoverableTransactionError: typeof defaultIsRecoverableTransactionError;
  checkDaemonGuard: typeof defaultCheckDaemonGuard;
}

const PRODUCTION_DEPS: FleetScaleDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  gatherIntrospectionRaw: defaultGatherIntrospectionRaw,
  resolveCliPassword: defaultResolveCliPassword,
  signerContextFactory: defaultCreateCliSignerContext,
  checkDaemonGuard: defaultCheckDaemonGuard,
  bootstrapperFactory: (config) => new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: (config as any).networkChain ?? (config.network === 'testnet' ? 'base-sepolia' : 'base'),
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    debug: config.debug,
    masterEthDailyEstimateWei: (config as any).masterEthDailyEstimateWei,
    minEoaGasWei: config.minEoaGasWei,
    minSafeEthWei: config.minSafeEthWei,
    pollIntervalMs: config.pollIntervalMs,
  }),
  retireFleetServiceOnChain: defaultRetireFleetServiceOnChain,
  findServiceByDisplayIndex: defaultFindServiceByDisplayIndex,
  isRecoverableTransactionError: defaultIsRecoverableTransactionError,
};

export function createFleetScaleCommand(deps: FleetScaleDeps = PRODUCTION_DEPS): CommandModule {
  async function runScale(ctx: CommandContext, rest: string[]): Promise<void> {
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: {
          ...COMMON_FLAGS,
          to: { type: 'string' },
          'dry-run': { type: 'boolean', default: false },
          yes: { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: 'jinn fleet scale --to 3 --dry-run',
          details: { field: 'flags' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const to = parseInt(parsed.values.to as string, 10);
    if (!Number.isFinite(to) || to < 0) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: '--to must be a non-negative integer',
          exampleCli: 'jinn fleet scale --to 3 --dry-run',
          details: { field: '--to', expected: 'non-negative integer' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
    const sorted = [...(raw.fleet?.services ?? [])].sort((a, b) => a.index - b.index);
    const current = sorted.length;
    const dryRun = parsed.values['dry-run'] as boolean;
    const yes = parsed.values.yes as boolean;

    let plan: Array<{ action: string; from: number; to: number; indices?: number[] }> = [];
    let description: string;
    if (to === current) {
      plan = [];
      description = `Fleet is already at size ${current}. No action.`;
    } else if (to > current) {
      plan = [{ action: 'grow', from: current, to }];
      description = `Would grow fleet from ${current} to ${to} via bootstrap with targetServices=${to}.`;
    } else {
      const indices = sorted.slice(to).map(s => s.index);
      plan = [{ action: 'retire', from: current, to, indices }];
      description = `Would retire services with HD service.index ${indices.join(', ')} (on-chain slot; shrink path) to shrink fleet from ${current} to ${to}.`;
    }

    if (dryRun) {
      emitDryRun(ctx, { verb: 'fleet scale', description, plan });
      return;
    }

    if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

    if (to === current) {
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'fleet scale',
          from: current,
          to,
          action: 'none',
        },
        (v) => {
          const value = v as { from: number; to: number };
          return `Fleet already at target size ${value.to}.`;
        },
        {
          json: Boolean(parsed.values.json),
          human: Boolean(parsed.values.human),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
      return;
    }

    const pw = deps.resolveCliPassword(ctx.argv, ctx.env);
    if (!pw.ok) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: pw.message,
          exampleCli: 'jinn fleet scale --to 3 --yes',
          details: { field: 'keystore password' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const built = await deps.signerContextFactory({ argv: ctx.argv, env: ctx.env });
    if (!built.ok) {
      emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
      return;
    }

    const { config, networkChain, chainConfig, fleetStore, masterWallet, publicClient } = built.ctx;

    // D0a P3 (#525/#562/#897): both the grow (bootstrap) and shrink
    // (retireFleetServiceOnChain) paths below sign Safe writes with the
    // fleet's agent EOA / master signer, with no cross-process lock against a
    // concurrently running daemon signing from the same EOA.
    const daemonGuard = deps.checkDaemonGuard({ earningDir: config.earningDir, env: ctx.env });
    if (daemonGuard.blocked) {
      emitEnvelope(
        daemonGuardEnvelope(daemonGuard, 'jinn fleet scale --to 3 --yes'),
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    if (to > current) {
      const bootstrapper = deps.bootstrapperFactory({ ...config, networkChain } as any);

      let result: Awaited<ReturnType<FleetBootstrapper['bootstrap']>>;
      try {
        result = await bootstrapper.bootstrap(pw.password);
      } catch (e) {
        if (deps.isRecoverableTransactionError(e)) {
          emitEnvelope(
            {
              code: 'transient_error',
              message: e instanceof Error ? e.message : String(e),
              exampleCli: 'jinn fleet scale --to 3 --yes',
              details: { cause: e instanceof Error ? e.message : String(e) },
            },
            { writer: ctx.writer, exit: ctx.exit },
          );
          return;
        }
        emitEnvelope(
          {
            code: 'fatal',
            message: e instanceof Error ? e.message : String(e),
            details: { cause: e instanceof Error ? e.message : String(e) },
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
            hint: 'Fund the listed address and re-run.',
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
            hint: 'Bootstrap failed before the fleet reached the target size.',
            details: { cause: result.message },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const state = result.fleet_state;
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'fleet scale',
          action: 'grow',
          from: current,
          to,
          servicesComplete: state.services.filter(s => isOperationalServiceStep(s.step)).length,
          message: result.message,
        },
        (v) => {
          const value = v as { from: number; to: number; servicesComplete: number };
          return `Fleet grow complete.\nFrom: ${value.from}\nTo: ${value.to}\nComplete services: ${value.servicesComplete}`;
        },
        {
          json: Boolean(parsed.values.json),
          human: Boolean(parsed.values.human),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
      return;
    }

    const indices = sorted
      .slice(to)
      .map(s => s.index)
      .sort((a, b) => b - a);
    const retired: Array<{ index: number; txHash?: string; message: string }> = [];
    for (const index of indices) {
      try {
        const r = await deps.retireFleetServiceOnChain({
          publicClient,
          masterWallet,
          distributorAddress: chainConfig.distributorAddress,
          fleetStore,
          chain: networkChain,
          serviceIndex: index,
        });
        retired.push({ index, txHash: r.txHash, message: r.message });
        if (!r.ok) {
          emitEnvelope(
            {
              code: 'fatal',
              message: r.message,
              hint: 'Fix the on-chain or fleet state issue, then retry shrink.',
              details: { index, partialRetire: retired },
            },
            { writer: ctx.writer, exit: ctx.exit },
          );
          return;
        }
      } catch (e) {
        if (deps.isRecoverableTransactionError(e)) {
          emitEnvelope(
            {
              code: 'transient_error',
              message: e instanceof Error ? e.message : String(e),
              details: { index, partialRetire: retired },
            },
            { writer: ctx.writer, exit: ctx.exit },
          );
          return;
        }
        emitEnvelope(
          {
            code: 'fatal',
            message: e instanceof Error ? e.message : String(e),
            details: { index, partialRetire: retired },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
    }

    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'fleet scale',
        action: 'shrink',
        from: current,
        to,
        retired,
      },
      (v) => {
        const value = v as { from: number; to: number; retired: Array<{ index: number }> };
        return `Fleet shrink complete.\nFrom: ${value.from}\nTo: ${value.to}\nRetired chain indices: ${value.retired.map((r) => r.index).join(', ')}`;
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
  }

  async function runRetire(ctx: CommandContext, rest: string[]): Promise<void> {
    const [indexArg, ...flagArgs] = rest;
    if (!indexArg || indexArg.startsWith('--')) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: 'jinn fleet retire requires a service index',
          exampleCli: 'jinn fleet retire 2 --dry-run',
          details: {
            field: '<index>',
            expected: 'non-negative display index (same as services[].index in jinn fleet JSON)',
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const displayIndex = parseInt(indexArg, 10);
    if (!Number.isFinite(displayIndex) || displayIndex < 0) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Invalid service index: ${indexArg}`,
          exampleCli: 'jinn fleet retire 2 --dry-run',
          details: {
            field: '<index>',
            expected: 'non-negative display index (same as services[].index in jinn fleet JSON)',
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    let parsed;
    try {
      parsed = parseArgs({
        args: flagArgs,
        options: {
          ...COMMON_FLAGS,
          'dry-run': { type: 'boolean', default: false },
          yes: { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          exampleCli: 'jinn fleet retire 2 --dry-run',
          details: { field: 'flags' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const raw = await deps.gatherIntrospectionRaw({ argv: ctx.argv });
    const fleet = raw.fleet;
    const svc = fleet ? deps.findServiceByDisplayIndex(fleet.services, displayIndex) : undefined;
    const dryRun = parsed.values['dry-run'] as boolean;
    const yes = parsed.values.yes as boolean;

    let plan: Array<{ action: 'retire'; index: number; chainIndex: number; txCount: number }>;
    let description: string;
    if (!svc) {
      plan = [];
      description = `Display index ${displayIndex} is not in fleet state (already retired or never existed). No action.`;
    } else {
      plan = [{ action: 'retire', index: displayIndex, chainIndex: svc.index, txCount: 1 }];
      description = `Would retire display index ${displayIndex} (HD service.index=${svc.index}): distributor.unstakeAndWithdraw, then remove row from earning_state.json.`;
    }

    if (dryRun) {
      emitDryRun(ctx, { verb: 'fleet retire', description, plan });
      return;
    }

    if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

    if (!svc) {
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'fleet retire',
          index: displayIndex,
          action: 'none',
        },
        (v) => `Service ${String((v as { index: number }).index)} is already absent from fleet state.`,
        {
          json: Boolean(parsed.values.json),
          human: Boolean(parsed.values.human),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
      return;
    }

    const pw = deps.resolveCliPassword(ctx.argv, ctx.env);
    if (!pw.ok) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: pw.message,
          exampleCli: 'jinn fleet retire 2 --yes',
          details: { field: 'keystore password' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const built = await deps.signerContextFactory({ argv: ctx.argv, env: ctx.env });
    if (!built.ok) {
      emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
      return;
    }

    const { networkChain, chainConfig, fleetStore, masterWallet, publicClient } = built.ctx;

    try {
      const r = await deps.retireFleetServiceOnChain({
        publicClient,
        masterWallet,
        distributorAddress: chainConfig.distributorAddress,
        fleetStore,
        chain: networkChain,
        serviceIndex: svc.index,
      });
      if (!r.ok) {
        emitEnvelope(
          {
            code: 'fatal',
            message: r.message,
            details: { displayIndex, chainIndex: svc.index },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      emitResult(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'fleet retire',
          index: displayIndex,
          chainIndex: svc.index,
          ok: r.ok,
          txHash: r.txHash ?? null,
          message: r.message,
        },
        (v) => {
          const value = v as { index: number; chainIndex: number; txHash: string | null };
          return `Service retired.\nDisplay index: ${value.index}\nChain index: ${value.chainIndex}\nTx: ${value.txHash ?? 'n/a'}`;
        },
        {
          json: Boolean(parsed.values.json),
          human: Boolean(parsed.values.human),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
    } catch (e) {
      if (deps.isRecoverableTransactionError(e)) {
        emitEnvelope(
          {
            code: 'transient_error',
            message: e instanceof Error ? e.message : String(e),
            details: { displayIndex, chainIndex: svc.index },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      emitEnvelope(
        {
          code: 'fatal',
          message: e instanceof Error ? e.message : String(e),
          details: { displayIndex, chainIndex: svc.index },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
    }
  }

  async function run(ctx: CommandContext): Promise<void> {
    const [subverb, ...rest] = ctx.argv;
    if (!subverb) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: 'jinn fleet requires a subverb: scale | retire',
          exampleCli: 'jinn fleet scale --to 3 --dry-run',
          details: { field: 'subverb', expected: 'scale | retire' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    if (subverb === 'scale') return runScale(ctx, rest);
    if (subverb === 'retire') return runRetire(ctx, rest);
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown fleet subverb: ${subverb}`,
        exampleCli: 'jinn fleet --help',
        details: { field: 'subverb', expected: 'scale | retire' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
  }

  return {
    name: 'fleet-manage',
    summary: 'Fleet management: scale | retire <index>',
    helpText: `Usage: jinn fleet <subverb> [flags...]

Subverbs:
  scale --to N [--dry-run] [--yes]       Grow or shrink the fleet to N services (idempotent)
  retire <index> [--dry-run] [--yes]     Retire one service (standard mode: unstake via distributor)

For \`fleet retire\`, <index> is the display index — the same \`index\` field as \`jinn fleet\` / status fleet JSON
(\`services[].index\`), not the HD derivation slot (\`service.index\` in store).

Examples:
  jinn fleet scale --to 3 --dry-run
  jinn fleet scale --to 3 --yes
  jinn fleet retire 1 --dry-run
`,
    run,
  };
}

const command: CommandModule = createFleetScaleCommand();
export default command;
