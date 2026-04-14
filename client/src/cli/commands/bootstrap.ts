import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { formatBootstrapOperatorMessage } from '../../operator-errors.js';

async function run(ctx: CommandContext): Promise<void> {
  const password = ctx.env['JINN_PASSWORD'];
  if (!password) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'JINN_PASSWORD is required to encrypt/decrypt the keystore.',
        hint: 'Set JINN_PASSWORD in the environment before running jinn bootstrap.',
        exampleCli: 'JINN_PASSWORD=... jinn bootstrap',
        details: { field: 'JINN_PASSWORD', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig();
  const bootstrapper = new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: config.network === 'testnet' ? 'base-sepolia' : 'base',
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    debug: config.debug,
    pollIntervalMs: config.pollIntervalMs,
  });

  let result: Awaited<ReturnType<FleetBootstrapper['bootstrap']>>;
  try {
    result = await bootstrapper.bootstrap(password);
  } catch (err) {
    const { summary, hint } = formatBootstrapOperatorMessage(err);
    const cause = err instanceof Error ? (err.stack ?? err.message) : String(err);
    emitEnvelope(
      {
        code: 'fatal',
        message: summary,
        ...(hint !== undefined ? { hint } : {}),
        details: { stage: 'bootstrap', cause },
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
          masterAddress: result.funding.master_address,
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
        details: { stage: 'bootstrap' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // Success — emit a minimal JSON result and exit 0.
  const state = result.fleet_state;
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    master: state.master_address,
    services: state.services.map((s) => ({
      index: s.index,
      step: s.step,
      serviceId: s.service_id ?? null,
    })),
  }) + '\n');
}

const command: CommandModule = {
  name: 'bootstrap',
  summary: 'Advance the fleet state machine toward a running daemon',
  helpText: `Usage: JINN_PASSWORD=... jinn bootstrap [--json]

Idempotent. Walks the fleet state machine from wherever it is toward
a complete, running state. Re-run as many times as needed; the
machine picks up where it left off. On funding gates, exits 10 with
a funding_required envelope.

Requires JINN_PASSWORD in the environment (never as a flag).

Examples:
  JINN_PASSWORD=secret jinn bootstrap
  JINN_PASSWORD=secret jinn bootstrap --json

Failure example (funding gate):
  $ JINN_PASSWORD=secret jinn bootstrap
  {"schemaVersion":1,"code":"funding_required","exitCode":10,...}
  $ echo $?
  10
`,
  run,
};

export default command;
