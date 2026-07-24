import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getAddress } from 'viem';
import {
  AutopilotDeliveryCommandResultV1Schema,
  AutopilotDeliveryExpectationSchema,
  type AutopilotDeliveryCommandResultV1,
  type AutopilotDeliveryExpectation,
} from '@jinn-network/sdk/autopilot';

import {
  createAutopilotMarketplaceDeliveryObserver,
} from '../../autopilot/marketplace-delivery-observer.js';
import {
  observeAutopilotMarketplaceDelivery,
} from '../../autopilot/marketplace-delivery-command.js';
import { fetchRawBytesFromIpfs } from '../../adapters/mech/ipfs.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import { createHttpDiscoveryAPI } from '../../discovery/http.js';
import { createPublisherSafeResolver } from '../../erc8004/publisher-safe-resolver.js';
import { FleetStateStore } from '../../earning/store.js';
import { createJinnPublicClient } from '../../earning/viem-clients.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { COMMON_FLAGS, type CommandContext } from '../command.js';
import { pickPrimaryMechService } from '../execution-context.js';
import { emitResult } from '../output.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseAutopilotDeliveryCommandResult(
  input: unknown,
): AutopilotDeliveryCommandResultV1 {
  return AutopilotDeliveryCommandResultV1Schema.parse(input);
}

export async function runObserveAutopilotDelivery(
  ctx: CommandContext,
): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'expectation-file': { type: 'string' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: message(error),
      exampleCli:
        'jinn tasks observe-autopilot-delivery --expectation-file request.json --json',
    }, { writer: ctx.writer, exit: ctx.exit });
    return;
  }
  if (parsed.values.json !== true || parsed.values.human === true) {
    const human = parsed.values.human === true;
    emitEnvelope({
      code: 'invalid_invocation',
      message: human
        ? '--human is not supported for Autopilot delivery observation'
        : '--json is required for Autopilot delivery observation',
      exampleCli:
        'jinn tasks observe-autopilot-delivery --expectation-file request.json --json',
      details: {
        field: human ? '--human' : '--json',
        expected: human ? 'omit --human' : '--json',
      },
    }, { writer: ctx.writer, exit: ctx.exit });
    return;
  }
  const expectationFile = parsed.values['expectation-file'];
  if (typeof expectationFile !== 'string' || expectationFile.length === 0) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: '--expectation-file is required',
      exampleCli:
        'jinn tasks observe-autopilot-delivery --expectation-file request.json --json',
      details: { field: '--expectation-file' },
    }, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  let request: AutopilotDeliveryExpectation;
  try {
    request = AutopilotDeliveryExpectationSchema.parse(
      JSON.parse(readFileSync(resolve(expectationFile), 'utf8')),
    );
  } catch (error) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: `Invalid expectation file: ${message(error)}`,
      details: { field: '--expectation-file' },
    }, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  try {
    const config = loadConfig(getConfigPathFromArgs(ctx.argv));
    if (config.discovery?.mode !== 'http' || !config.discovery.url) {
      throw new Error(
        'Exact HTTP discovery indexer is required for Autopilot delivery observation',
      );
    }
    const fleet = await new FleetStateStore(config.earningDir).tryLoadExisting();
    const service = fleet === null
      ? undefined
      : pickPrimaryMechService(fleet.services);
    if (!service?.mech_address) {
      throw new Error(
        'Existing Jinn Mech configuration is required for delivery observation',
      );
    }
    const network = config.network === 'testnet' ? 'base-sepolia' : 'base';
    const chainId = config.network === 'testnet' ? 84532 : 8453;
    const publicClient = createJinnPublicClient(config.rpcUrls, network);
    const observer = createAutopilotMarketplaceDeliveryObserver({
      discovery: createHttpDiscoveryAPI({ url: config.discovery.url }),
      publicClient,
      mechContractAddress: getAddress(service.mech_address),
      fetchEnvelopeBytes: (cid) =>
        fetchRawBytesFromIpfs(config.ipfsGatewayUrl, cid),
      resolvePublisherSafe: createPublisherSafeResolver({
        rpcUrl: config.rpcUrls[0]!,
        fallbackRpcUrls: config.rpcUrls.slice(1),
        expectedChainId: chainId,
        ...(config.identityRegistryAddress === undefined
          ? {}
          : { identityRegistry: config.identityRegistryAddress }),
      }),
    });
    const observation = await observeAutopilotMarketplaceDelivery(request, {
      chainId,
      observer,
      latestBlockNumber: () => publicClient.getBlockNumber(),
    });
    const result = parseAutopilotDeliveryCommandResult({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'tasks observe-autopilot-delivery',
      observation,
    });
    emitResult(result, (value) => JSON.stringify(value, null, 2), {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env.NO_COLOR),
    });
  } catch (error) {
    emitEnvelope({
      code: 'transient_error',
      message: message(error),
      hint: 'Retry after the exact indexer, RPC, Mech, and IPFS paths recover.',
      exampleCli:
        'jinn tasks observe-autopilot-delivery --expectation-file request.json --json',
      details: { cause: message(error) },
    }, { writer: ctx.writer, exit: ctx.exit });
  }
}
