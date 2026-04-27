import { formatUnits, http, type Address, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { createPublicClient } from 'viem';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig as defaultLoadConfig, getConfigPathFromArgs as defaultGetConfigPathFromArgs } from '../../config.js';
import { FleetBootstrapper } from '../../earning/bootstrap.js';
import { getChainConfig as defaultGetChainConfig } from '../../earning/contracts.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';

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

function formatAmount(wei: string, symbol: string): string {
  try {
    // All three asset roles (native, bond, reward) use 18 decimals in Phase 1b.
    return `${formatUnits(BigInt(wei), 18)} ${symbol}`;
  } catch {
    return `${wei} wei (${symbol})`;
  }
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
    const need = formatAmount(r.needWei, r.details.tokenSymbol);
    const have = formatAmount(r.haveWei, r.details.tokenSymbol);
    lines.push(`- ${r.role} @ ${r.address}: need ${need}, have ${have}`);
  }
  return lines.join('\n');
}

export interface FundRequirementsDeps extends BaseCommandDeps {
  bootstrapperFactory: (cfg: ReturnType<typeof defaultLoadConfig>) => FleetBootstrapper;
  resolveCliPassword: typeof defaultResolveCliPassword;
  getChainConfig: typeof defaultGetChainConfig;
  publicClientFactory: (rpcUrl: string, chainKey: 'base' | 'base-sepolia') => PublicClient;
}

const PRODUCTION_DEPS: FundRequirementsDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  bootstrapperFactory: (config) => new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: config.network === 'testnet' ? 'base-sepolia' : 'base',
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
    debug: config.debug,
    pollIntervalMs: config.pollIntervalMs,
  }),
  resolveCliPassword: defaultResolveCliPassword,
  getChainConfig: defaultGetChainConfig,
  publicClientFactory: (rpcUrl, chainKey) => {
    const viemChain = chainKey === 'base' ? base : baseSepolia;
    return createPublicClient({ chain: viemChain, transport: http(rpcUrl) }) as unknown as PublicClient;
  },
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

    const password = deps.resolveCliPassword(ctx.argv, ctx.env);
    if (!password.ok) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: password.message,
          hint: 'Set JINN_PASSWORD or pass --password-fd N, then re-run.',
          exampleCli: 'jinn fund-requirements --json',
          details: { field: 'keystore password', expected: 'non-empty string via environment or fd' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = deps.loadConfig(configPath);
    const bootstrapper = deps.bootstrapperFactory(config);

    let result: Awaited<ReturnType<FleetBootstrapper['bootstrap']>>;
    try {
      result = await bootstrapper.bootstrap(password.password);
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
    } else {
      // Bootstrap is satisfied. Still probe per-Safe native ETH: the daemon's
      // balance-topup-loop auto-tops from master at runtime, but operators
      // running in tooling contexts (acceptance gate, CI, bare `submit-intent`)
      // hit the mech-fee path before any topup tick fires. A Safe that holds
      // less than the per-service `minSafeEth` threshold will silently fail on
      // `createEvaluationJob`, wrapped as `GS013` at the Safe layer — surface
      // it here so ops see the gap before running.
      const chainKey = config.network === 'testnet' ? 'base-sepolia' : 'base';
      const chainCfg = deps.getChainConfig(chainKey, {
        testnetL2DeploymentPath: config.testnetL2DeploymentPath,
        testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
        testnetMechDeploymentPath: config.testnetMechDeploymentPath,
        testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
        testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
      });
      const publicClient = deps.publicClientFactory(config.rpcUrl, chainKey);
      const probeRows = await Promise.all(
        result.fleet_state.services
          .filter(svc => svc.step === 'complete' && svc.safe_address)
          .map(async (svc): Promise<FundRequirementRow | null> => {
            const address = svc.safe_address as string;
            try {
              const bal = await publicClient.getBalance({ address: address as Address });
              if (bal >= chainCfg.minSafeEth) return null;
              return {
                role: `service_${svc.index}_safe`,
                address,
                asset: 'native',
                haveWei: bal.toString(),
                needWei: (chainCfg.minSafeEth - bal).toString(),
                reason:
                  `Service ${svc.index} Safe needs native ETH to pay mech fees (each evaluation job sends 99 wei). ` +
                  `The daemon's balance-topup-loop auto-refills from master at runtime; funding it manually is ` +
                  `required only when running CLI verbs (submit-intent, acceptance gate) outside the daemon.`,
                blocks: 'run',
                details: { tokenAddress: null, tokenSymbol: 'ETH' },
              };
            } catch (err) {
              // Probe failures are not a funding gap on their own; emit a warning
              // so operators can distinguish "Safe OK" from "couldn't tell".
              const message = err instanceof Error ? err.message : String(err);
              process.stderr.write(
                `[warn] fund-requirements: failed to probe Safe ${address} for service ${svc.index}: ${message}\n`,
              );
              return null;
            }
          }),
      );
      for (const row of probeRows) {
        if (row) requirements.push(row);
      }
    }

    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      requirements,
      satisfied: requirements.length === 0,
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

Returns a JSON object listing every wallet that needs additional
funding before the state machine can advance. Each entry names the
wallet role (never the internal address alone), the asset role
(native / bond / reward), the amount needed, and a token symbol
lookup for operators that need to bridge or faucet.

When \`satisfied\` is true, the \`requirements\` array is empty and
no funding is needed right now.

Examples:
  jinn fund-requirements
  jinn fund-requirements --human
`,
    run,
  };
}

const command: CommandModule = createFundRequirementsCommand();
export default command;
