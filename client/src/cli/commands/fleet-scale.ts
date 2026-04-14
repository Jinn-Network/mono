import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { resolveCliPassword } from '../password.js';
import { createCliSignerContext } from '../execution-context.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { retireFleetServiceOnChain, findFleetService } from '../../earning/fleet-retire.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';

async function runScale(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        to: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
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
    description = `Would retire services ${indices.join(', ')} (fleet index field) to shrink fleet from ${current} to ${to}.`;
  }

  if (dryRun) {
    emitDryRun(ctx, { verb: 'fleet scale', description, plan });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  if (to === current) {
    ctx.writer.write(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'fleet scale',
        from: current,
        to,
        action: 'none',
      }) + '\n',
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

  const { config, networkChain, chainConfig, fleetStore, masterSigner, provider } = built.ctx;

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
    ctx.writer.write(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'fleet scale',
        action: 'grow',
        from: current,
        to,
        servicesComplete: state.services.filter(s => s.step === 'complete').length,
        message: result.message,
      }) + '\n',
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
        provider,
        masterSigner,
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

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'fleet scale',
      action: 'shrink',
      from: current,
      to,
      retired,
    }) + '\n',
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
        details: { field: '<index>', expected: 'non-negative integer (service.index from fleet JSON)' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const index = parseInt(indexArg, 10);
  if (!Number.isFinite(index) || index < 0) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Invalid service index: ${indexArg}`,
        exampleCli: 'jinn fleet retire 2 --dry-run',
        details: { field: '<index>', expected: 'non-negative integer (service.index from fleet JSON)' },
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
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
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
  const svc = fleet ? findFleetService(fleet, index) : undefined;
  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  let plan: Array<{ action: 'retire'; index: number; txCount: number }>;
  let description: string;
  if (!svc) {
    plan = [];
    description = `Service index ${index} is not in fleet state (already retired or never existed). No action.`;
  } else {
    plan = [{ action: 'retire', index, txCount: 1 }];
    description = `Would call distributor.unstakeAndWithdraw for service.index=${index}, then remove the row from earning_state.json.`;
  }

  if (dryRun) {
    emitDryRun(ctx, { verb: 'fleet retire', description, plan });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  if (!svc) {
    ctx.writer.write(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'fleet retire',
        index,
        action: 'none',
      }) + '\n',
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

  const { networkChain, chainConfig, fleetStore, masterSigner, provider } = built.ctx;

  try {
    const r = await retireFleetServiceOnChain({
      provider,
      masterSigner,
      distributorAddress: chainConfig.distributorAddress,
      fleetStore,
      chain: networkChain,
      serviceIndex: index,
    });
    if (!r.ok) {
      emitEnvelope(
        {
          code: 'fatal',
          message: r.message,
          details: { index },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    ctx.writer.write(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'fleet retire',
        index,
        ok: r.ok,
        txHash: r.txHash ?? null,
        message: r.message,
      }) + '\n',
    );
  } catch (e) {
    if (isRecoverableTransactionError(e)) {
      emitEnvelope(
        {
          code: 'transient_error',
          message: e instanceof Error ? e.message : String(e),
          details: { index },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    emitEnvelope(
      {
        code: 'fatal',
        message: e instanceof Error ? e.message : String(e),
        details: { index },
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

Index: use the persisted fleet field service.index (see \`jinn status --json\` → fleet.services[].index),
not an array offset.

Examples:
  jinn fleet scale --to 3 --dry-run
  jinn fleet scale --to 3 --yes
  jinn fleet retire 2 --dry-run
`,
  run,
};

export default command;
