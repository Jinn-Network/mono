import { formatUnits } from 'viem';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig as defaultLoadConfig, getConfigPathFromArgs as defaultGetConfigPathFromArgs } from '../../config.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import {
  planFleetFunding as defaultPlanFleetFunding,
  type FundingPlan,
  type FundingPlanPartialReason,
} from '../../earning/funding-plan.js';

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
  blocks: 'bootstrap' | 'run' | 'tasks-submit' | 'claim-rewards';
  details: { tokenAddress: string | null; tokenSymbol: string };
}

function formatAmount(wei: string, symbol: string): string {
  try {
    // All three asset roles (native, bond, reward) use 18 decimals in Phase 1b.
    return `${formatUnits(BigInt(wei), 18)} ${symbol}`;
  } catch {
    return `${wei} wei (${symbol})`;
  }
}

function describePartialReason(reason: FundingPlanPartialReason): string {
  switch (reason) {
    case 'no_keystore':
      return 'no master keystore — run `jinn init` to create one';
    case 'password_missing':
      return 'keystore password missing — set JINN_PASSWORD or pass --password-fd';
    case 'password_invalid':
      return 'keystore password rejected — check JINN_PASSWORD';
    case 'rpc_unreachable':
      return 'RPC could not be reached — check JINN_RPC_URL / network';
    case 'fleet_state_missing':
      return 'no persisted fleet state yet — run `jinn bootstrap` to create one';
    case 'fleet_state_invalid':
      return 'fleet state file failed validation — see `jinn doctor`';
    default:
      return reason;
  }
}

function humanFundRequirements(payload: {
  satisfied: boolean;
  partial: boolean;
  reasons: FundingPlanPartialReason[];
  requirements: FundRequirementRow[];
}): string {
  const lines: string[] = [];
  if (payload.satisfied) {
    lines.push('Funding requirements satisfied. Nothing needed right now.');
  } else if (payload.requirements.length === 0 && payload.partial) {
    lines.push('Funding requirements unknown — answer is partial.');
  } else {
    lines.push('Funding required before bootstrap can advance:');
    for (const r of payload.requirements) {
      const need = formatAmount(r.needWei, r.details.tokenSymbol);
      const have = formatAmount(r.haveWei, r.details.tokenSymbol);
      lines.push(`- ${r.role} @ ${r.address}: need ${need}, have ${have}`);
    }
  }
  if (payload.partial && payload.reasons.length > 0) {
    lines.push('');
    lines.push('Partial answer; could not fully evaluate funding:');
    for (const r of payload.reasons) {
      lines.push(`- ${describePartialReason(r)}`);
    }
  }
  return lines.join('\n');
}

export interface FundRequirementsDeps extends BaseCommandDeps {
  resolveCliPassword: typeof defaultResolveCliPassword;
  /**
   * Read-only funding plan probe. Production wires this to
   * {@link planFleetFunding}. The contract for this command is that the
   * function it calls MUST NOT mutate fleet state, request faucet funds,
   * or send any chain transactions. Tests assert exactly that.
   */
  planFleetFunding: typeof defaultPlanFleetFunding;
}

const PRODUCTION_DEPS: FundRequirementsDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  resolveCliPassword: defaultResolveCliPassword,
  planFleetFunding: defaultPlanFleetFunding,
};

export function createFundRequirementsCommand(deps: FundRequirementsDeps = PRODUCTION_DEPS): CommandModule {
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
          hint: 'Run `jinn fund-requirements --help` for supported flags.',
          exampleCli: 'jinn fund-requirements --json',
          details: { field: 'argv', expected: message },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    // Password is *optional* for the read-only path. When absent we still
    // produce a partial plan that lists what we could not learn — see
    // docs/reviews/2026-04-28-operator-experience-audit.md (W1).
    const password = deps.resolveCliPassword(ctx.argv, ctx.env);
    const passwordValue = password.ok ? password.password : undefined;

    const config = deps.loadConfig(configPath);
    const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';

    let plan: FundingPlan;
    try {
      plan = await deps.planFleetFunding({
        earningDir: config.earningDir,
        chain,
        rpcUrl: config.rpcUrl,
        stakingMode: config.stakingMode,
        targetServices: config.targetServices,
        testnetL2DeploymentPath: config.testnetL2DeploymentPath,
        testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
        testnetMechDeploymentPath: config.testnetMechDeploymentPath,
        testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
        minEoaGasWei: config.minEoaGasWei,
        minSafeEthWei: config.minSafeEthWei,
        password: passwordValue,
      });
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

    const reasons: FundingPlanPartialReason[] = [...plan.reasons];
    // If the user did not supply a password and we don't have a master
    // address from persisted state, surface that in `reasons` exactly once.
    if (!password.ok && !reasons.includes('password_missing')) {
      reasons.push('password_missing');
    }

    const requirements: FundRequirementRow[] = [];
    if (plan.master) {
      requirements.push({
        role: 'master',
        address: plan.master.master_address,
        asset: 'native',
        haveWei: plan.master.eth_balance,
        needWei: plan.master.eth_required,
        reason:
          `Master wallet needs ETH to advance bootstrap (currently ${plan.master.eth_balance} wei, ` +
          `needs ${plan.master.eth_required} wei more).`,
        blocks: 'bootstrap',
        details: { tokenAddress: null, tokenSymbol: 'ETH' },
      });
    }
    for (const safe of plan.safes) {
      requirements.push({
        role: `service_${safe.serviceIndex}_safe`,
        address: safe.safeAddress,
        asset: safe.asset,
        haveWei: safe.haveWei,
        needWei: safe.needWei,
        reason: safe.reason,
        blocks: 'run',
        details: { tokenAddress: null, tokenSymbol: 'ETH' },
      });
    }

    const partial = plan.partial || !password.ok;
    const satisfied = requirements.length === 0 && !partial;

    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      requirements,
      satisfied,
      partial,
      reasons: Array.from(new Set(reasons)),
    };

    emitResult(payload, (v) => humanFundRequirements(v as typeof payload), {
      json,
      human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    ctx.exit(0);
  }

  return {
    name: 'fund-requirements',
    summary: 'List addresses that need funding before the next bootstrap step',
    helpText: `Usage: jinn fund-requirements [--human] [--config <path>] [--password-fd <fd>]

Read-only inspection: returns a JSON object listing every wallet that
needs additional funding before the state machine can advance. This
command never writes earning state, never requests faucet funds, and
never sends chain transactions.

Each entry names the wallet role (never the internal address alone),
the asset role (native / bond / reward), the amount needed, and a token
symbol lookup for operators that need to bridge or faucet.

When \`satisfied\` is true, the \`requirements\` array is empty and no
funding is needed right now.

When \`partial\` is true, the answer is best-effort — for example because
no keystore exists yet, the keystore password was not provided, or the
RPC was unreachable. The \`reasons\` array enumerates what could not be
evaluated so a host agent or operator can fix the gap and re-run.

Examples:
  jinn fund-requirements
  jinn fund-requirements --human
`,
    run,
  };
}

const command: CommandModule = createFundRequirementsCommand();
export default command;
