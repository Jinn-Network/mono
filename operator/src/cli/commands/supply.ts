import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
  loadConfig as defaultLoadConfig,
} from '../../config.js';
import {
  createHttpDiscoveryClient,
  type HttpDiscoveryClientOptions,
} from '../../discovery-client/http.js';
import type { CurrentSupplyResponse, DiscoveryClient } from '../../discovery-client/types.js';

const CHAIN_ID_BY_NETWORK = { testnet: 84532, mainnet: 8453 } as const;

export interface SupplyCommandDeps extends BaseCommandDeps {
  createDiscoveryClient: (
    options: HttpDiscoveryClientOptions,
  ) => Pick<DiscoveryClient, 'getCurrentSupply'>;
}

const PRODUCTION_DEPS: SupplyCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  createDiscoveryClient: createHttpDiscoveryClient,
};

function humanSupply(result: CurrentSupplyResponse): string {
  const window = `${result.window.start} to ${result.window.end}`;
  if (result.status === 'unknown') {
    return [
      'Supply could not be determined from complete indexer evidence.',
      'Do not treat this result as zero supply.',
      `Window: ${window}`,
    ].join('\n');
  }
  if (result.status === 'zero_supply') {
    return [
      'No proven live supply.',
      `Reason: ${result.reason}`,
      `Window: ${window}`,
      'Do not post work in this class yet.',
    ].join('\n');
  }

  const lines = ['Live supply is available.', `Window: ${window}`];
  for (const entry of result.classes) {
    lines.push(
      `${entry.workClass}: ${entry.acceptingSolverNets} accepting SolverNet(s), `
      + `${entry.claimingOperators} recent operator(s), `
      + `${entry.verifiedDeliveries} recent verdict delivery(ies)`,
    );
  }
  return lines.join('\n');
}

export function createSupplyCommand(deps: SupplyCommandDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'supply',
    summary: 'Show current requestable SolverNet supply from indexed native evidence',
    helpText: `Usage: jinn supply [--config <path>] [--json|--human]

Reports requestable SolverNet work classes backed by an accepting network,
recent claiming operators, and recent native verdict deliveries. The window is
the last eight completed six-hour UTC buckets.

The result distinguishes proven zero supply from incomplete evidence. This
read requires the configured HTTP discovery indexer and never substitutes a
different data source.

Examples:
  jinn supply
  jinn supply --human
  jinn supply --config ./operator.json
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseCommandArgs(ctx.argv, { ...COMMON_FLAGS });
        if (parsed.positionals.length > 0) {
          throw new Error(`unexpected positional argument: ${parsed.positionals[0]}`);
        }
      } catch (error) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: error instanceof Error ? error.message : String(error),
            hint: 'Run `jinn supply --help` for supported flags.',
            exampleCli: 'jinn supply --human',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const configPath = typeof parsed.values.config === 'string'
        ? parsed.values.config
        : deps.getConfigPathFromArgs(ctx.argv);
      const config = deps.loadConfig(configPath);
      if (config.discovery?.mode !== 'http' || !config.discovery.url) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: 'jinn supply requires discovery.mode "http" and discovery.url.',
            hint: 'Configure an HTTP discovery indexer; this command does not substitute another source.',
            exampleCli: 'jinn supply --human',
            details: {
              field: 'discovery.mode',
              expected: 'http',
              actual: config.discovery?.mode ?? null,
            },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const chainId = CHAIN_ID_BY_NETWORK[config.network];
      let result: CurrentSupplyResponse;
      try {
        result = await deps.createDiscoveryClient({ url: config.discovery.url })
          .getCurrentSupply({ chainId });
      } catch (error) {
        emitEnvelope(
          {
            code: 'transient_error',
            message: `Supply lookup failed: ${error instanceof Error ? error.message : String(error)}`,
            hint: 'Retry when the configured discovery indexer is reachable and current.',
            exampleCli: 'jinn supply',
            details: { chainId },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      emitResult(result, (value) => humanSupply(value as CurrentSupplyResponse), {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

export default createSupplyCommand();
