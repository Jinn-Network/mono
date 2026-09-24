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
import {
  DiscoveryUnavailableError,
  type CurrentSupplyResponse,
  type DiscoveryClient,
} from '../../discovery-client/types.js';

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

function sanitizeHumanIdentifier(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, '');
}

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
  if (result.incompleteManifestRows !== undefined) {
    // The listed classes are proven; the LIST may be short. Without this line a
    // reader would take an absent class as absent supply.
    lines.push(
      `Note: ${result.incompleteManifestRows} launched SolverNet(s) had incomplete indexer `
      + 'evidence and are not represented below. A class missing here is unproven, not absent.',
    );
  }
  if (result.incompleteActivityRows !== undefined) {
    lines.push(
      `Note: ${result.incompleteActivityRows} activity row(s) had no matching task `
      + 'and are not represented below. A class missing here is unproven, not absent.',
    );
  }
  for (const entry of result.classes) {
    lines.push(
      `${sanitizeHumanIdentifier(entry.workClass)}: ${entry.acceptingSolverNets} accepting SolverNet(s), `
      + `${entry.claimingOperators} recent operator(s), `
      + `${entry.verdictDeliveries} recent verdict delivery(ies)`,
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
        const code = error instanceof DiscoveryUnavailableError ? error.code : undefined;
        // `invalid_response` (a decode rejection) means the indexer answered
        // and is current; the operator's own client schema is the stale
        // side, so the hint must point at upgrading the client, not at the
        // indexer or its config. `invalid_request` covers a malformed
        // discovery.url, a non-positive chainId, or the indexer's own 4xx
        // refusal — a caller/config problem, so the hint names both
        // discovery.url and the configured network (chainId is derived from
        // network, never set directly).
        const invalid = code === 'invalid_request' || code === 'invalid_response';
        const hint = code === 'invalid_response'
          ? 'Upgrade @jinn-network/operator to match this indexer, or point discovery.url at an indexer on the same release.'
          : invalid
            ? 'Fix discovery.url or the configured network; this indexer will not answer that request for the chain network derives.'
            : 'Retry when the configured discovery indexer is reachable and current.';
        emitEnvelope(
          {
            code: invalid ? 'invalid_invocation' : 'transient_error',
            message: `Supply lookup failed: ${error instanceof Error ? error.message : String(error)}`,
            hint,
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
