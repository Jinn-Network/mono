import { parseArgs } from 'node:util';
import { COMMON_FLAGS, type CommandContext, type CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { resolveCliPassword } from '../password.js';
import { createCliSignerContext } from '../execution-context.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { retireFleetServiceOnChain } from '../../earning/fleet-retire.js';
import { findServiceByDisplayIndex } from '../../earning/fleet-display-index.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';

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

  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
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

  const pw = resolveCliPassword(ctx.argv, ctx.env);
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

  const built = await createCliSignerContext({ argv: ctx.argv, env: ctx.env });
  if (!built.ok) {
    emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  const { config, networkChain, chainConfig, fleetStore, masterWallet, publicClient } = built.ctx;

  if (to > current) {
    const bootstrapper = new FleetBootstrapper({
      earningDir: config.earningDir,
      chain: networkChain,
      rpcUrl: config.rpcUrl,
      stakingMode: config.stakingMode,
      targetServices: to,
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
      debug: config.debug,
      masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
      pollIntervalMs: config.pollIntervalMs,
    });

    let result: Awaited<ReturnType<FleetBootstrapper['bootstrap']>>;
    try {
      result = await bootstrapper.bootstrap(pw.password);
    } catch (e) {
      if (isRecoverableTransactionError(e)) {
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
        servicesComplete: state.services.filter(s => s.step === 'complete').length,
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
      const r = await retireFleetServiceOnChain({
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
      if (isRecoverableTransactionError(e)) {
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

  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const fleet = raw.fleet;
  const svc = fleet ? findServiceByDisplayIndex(fleet.services, displayIndex) : undefined;
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

  const pw = resolveCliPassword(ctx.argv, ctx.env);
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

  const built = await createCliSignerContext({ argv: ctx.argv, env: ctx.env });
  if (!built.ok) {
    emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  const { networkChain, chainConfig, fleetStore, masterWallet, publicClient } = built.ctx;

  try {
    const r = await retireFleetServiceOnChain({
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
    if (isRecoverableTransactionError(e)) {
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

const command: CommandModule = {
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

export default command;
