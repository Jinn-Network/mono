import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';

/** §6.2 — `stack` only when `JINN_DEBUG=1` (exact string). */
function envelopeDebug(env: NodeJS.ProcessEnv): boolean {
  return env['JINN_DEBUG'] === '1';
}

type AssetRole = 'native' | 'bond' | 'reward';

interface FundRequirementRow {
  role: string;
  address: string;
  asset: AssetRole;
  haveWei: string;
  needWei: string;
  reason: string;
  blocks: 'bootstrap' | 'run' | 'submit-intent' | 'claim-rewards';
  details: { tokenAddress: string | null; tokenSymbol: string };
}

function humanFundRequirements(payload: {
  satisfied: boolean;
  requirements: FundRequirementRow[];
}): string {
  if (payload.satisfied) {
    return 'Funding requirements satisfied. Nothing needed right now.';
  }
  const lines = ['Funding required before bootstrap can advance:'];
  for (const r of payload.requirements) {
    lines.push(
      `- ${r.role} @ ${r.address}: asset role ${r.asset}, need ${r.needWei} wei, have ${r.haveWei} wei`,
    );
  }
  return lines.join('\n');
}

async function run(ctx: CommandContext): Promise<void> {
  let json = false;
  let configPath: string | undefined;
  try {
    const parsed = parseCommandArgs(ctx.argv, { ...COMMON_FLAGS });
    json = Boolean(parsed.values.json);
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
        hint: 'Run `jinn fund-requirements --help` for supported flags.',
        exampleCli: 'jinn fund-requirements --json',
        details: { field: 'argv', expected: message },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const password = ctx.env['JINN_PASSWORD'];
  if (!password) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'A password is required to read the keystore.',
        hint: 'Set the password environment variable required by the client, then re-run.',
        exampleCli: 'jinn fund-requirements --json',
        details: { field: 'keystore password', expected: 'non-empty string via environment' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig(configPath);
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
    const cause = err instanceof Error ? err.message : String(err);
    const message =
      err instanceof Error && err.message.trim().length > 0
        ? err.message
        : 'Could not evaluate funding requirements.';
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

  const requirements: FundRequirementRow[] = [];
  if (result.funding) {
    requirements.push({
      role: 'master',
      address: result.funding.master_address,
      asset: 'native',
      haveWei: result.funding.eth_balance,
      needWei: result.funding.eth_required,
      reason: result.message,
      blocks: 'bootstrap',
      details: { tokenAddress: null, tokenSymbol: 'ETH' },
    });
  }

  const payload = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    requirements,
    satisfied: requirements.length === 0,
  };

  emitResult(payload, (v) => humanFundRequirements(v as typeof payload), {
    json,
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
  ctx.exit(0);
}

const command: CommandModule = {
  name: 'fund-requirements',
  summary: 'List addresses that need funding before the next bootstrap step',
  helpText: `Usage: jinn fund-requirements [--json] [--config <path>]

Returns a JSON object listing every wallet that needs additional
funding before the state machine can advance. Each entry names the
wallet role (never the internal address alone), the asset role
(native / bond / reward), the amount needed, and a token symbol
lookup for operators that need to bridge or faucet.

When \`satisfied\` is true, the \`requirements\` array is empty and
no funding is needed right now.

Examples:
  jinn fund-requirements
  jinn fund-requirements --json | jq '.requirements[]'
`,
  run,
};

export default command;
