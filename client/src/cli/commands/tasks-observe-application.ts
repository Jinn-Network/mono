import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { getAddress } from 'viem';
import { z } from 'zod';

import {
  createApplicationDeliveryObserver,
  parseApplicationTaskCid,
  type ApplicationDeliveryExpectation,
  type ApplicationDeliveryObservation,
} from '../../application-delivery/delivery-observer.js';
import { fetchRawBytesFromIpfs } from '../../adapters/mech/ipfs.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import { getJinnRouterAddress } from '../../contracts/addresses.js';
import { createHttpDiscoveryAPI } from '../../discovery/http.js';
import { getChainConfig } from '../../earning/contracts.js';
import { createJinnPublicClient } from '../../earning/viem-clients.js';
import { createPublisherSafeResolver } from '../../erc8004/publisher-safe-resolver.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { COMMON_FLAGS, type CommandContext } from '../command.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const requestId = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const taskId = z.string().regex(/^(0|[1-9][0-9]*)$/);
const taskCid = z.string().min(1).refine((value) => {
  try { parseApplicationTaskCid(value); return true; } catch { return false; }
}, 'Task CID must be a canonical raw sha2-256 CIDv1');
const applicationRef = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  version: z.string().regex(/^v[1-9][0-9]*$/),
}).strict();

export const ApplicationDeliveryExpectationSchema = z.object({
  schemaVersion: z.literal('jinn-application-delivery-expectation.v1'),
  role: z.enum(['solution', 'verdict']),
  taskId,
  taskCid,
  creationBlockNumber: z.number().int().safe().nonnegative(),
  application: applicationRef,
  taskSpec: z.record(z.string(), z.unknown()),
  attemptIndex: z.number().int().safe().nonnegative().optional(),
  requestId: requestId.optional(),
  deliveryEnvelopeCid: z.string().min(1).optional(),
  solutionOperatorSafe: address.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.attemptIndex === undefined) !== (value.requestId === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['attemptIndex'],
      message: 'attemptIndex and requestId must appear together',
    });
  }
  if (
    value.role === 'verdict'
    && (
      value.solutionOperatorSafe === undefined
      || value.attemptIndex === undefined
      || value.deliveryEnvelopeCid === undefined
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['solutionOperatorSafe'],
      message: 'verdict observation requires authoritative solution correlation',
    });
  }
});

const observation = z.union([
  z.object({
    status: z.literal('pending'),
    reason: z.string().min(1),
    detail: z.string().min(1).optional(),
  }).strict(),
  z.object({
    status: z.literal('contradiction'),
    reason: z.string().min(1),
    detail: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal('verified'),
    role: z.enum(['solution', 'verdict']),
    task: z.object({ taskId, taskCid: z.string().min(1) }).strict(),
    attempt: z.object({
      attemptIndex: z.number().int().safe().nonnegative(),
      requestId,
      operator: address,
    }).strict(),
    delivery: z.object({
      envelopeCid: z.string().min(1),
      transactionHash: requestId,
      blockNumber: z.number().int().safe().nonnegative(),
    }).strict(),
    payload: z.union([
      z.object({
        schemaVersion: z.literal('jinn-repo-application-payload.v1'),
        application: applicationRef,
        role: z.literal('solution'),
        payload: z.record(z.string(), z.unknown()),
      }).strict(),
      z.object({
        schemaVersion: z.literal('jinn-repo-application-payload.v1'),
        application: applicationRef,
        role: z.literal('verdict'),
        projection: z.enum(['pass', 'fail', 'unresolved']),
        payload: z.record(z.string(), z.unknown()),
      }).strict(),
    ]),
  }).strict(),
]);

const resultSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  verb: z.literal('tasks observe-application-delivery'),
  observation,
}).strict();

export type ApplicationDeliveryCommandResult = z.infer<typeof resultSchema>;

export function parseApplicationDeliveryCommandResult(
  input: unknown,
): ApplicationDeliveryCommandResult {
  return resultSchema.parse(input);
}

export function emitApplicationObservationResult(
  ctx: CommandContext,
  value: ApplicationDeliveryObservation,
): void {
  const result = parseApplicationDeliveryCommandResult({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'tasks observe-application-delivery',
    observation: value,
  });
  ctx.writer.write(`${JSON.stringify(result)}\n`);
  if (value.status === 'pending') ctx.exit(30);
  if (value.status === 'contradiction') ctx.exit(50);
}

const example =
  'jinn tasks observe-application-delivery --expectation-file /absolute/path.json --json';
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function runObserveApplicationDelivery(ctx: CommandContext): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        'expectation-file': { type: 'string' },
        yes: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    emitEnvelope(
      { code: 'invalid_invocation', message: errorText(error), exampleCli: example },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const file = parsed.values['expectation-file'];
  if (
    parsed.values.json !== true
    || parsed.values.human === true
    || typeof file !== 'string'
    || !isAbsolute(file)
    || parsed.values.yes === true
    || parsed.values['dry-run'] === true
  ) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: 'Application delivery observation requires --json and an absolute --expectation-file',
      exampleCli: example,
    }, { writer: ctx.writer, exit: ctx.exit });
    return;
  }
  let expected: ApplicationDeliveryExpectation;
  try {
    expected = ApplicationDeliveryExpectationSchema.parse(
      JSON.parse(readFileSync(file, 'utf8')),
    ) as ApplicationDeliveryExpectation;
  } catch (error) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: `Invalid expectation file: ${errorText(error)}`,
      exampleCli: example,
    }, { writer: ctx.writer, exit: ctx.exit });
    return;
  }
  try {
    const config = loadConfig(getConfigPathFromArgs(ctx.argv));
    if (config.discovery?.mode !== 'http' || !config.discovery.url) {
      throw new Error('Exact HTTP discovery indexer is required');
    }
    const network = config.network === 'testnet' ? 'base-sepolia' : 'base';
    const chain = getChainConfig(network, {
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    });
    const router = chain.jinnRouter ?? getJinnRouterAddress(chain.chainId);
    if (!router) throw new Error(`No Jinn Router address is configured for ${chain.chainId}`);
    const publicClient = createJinnPublicClient(config.rpcUrls, network);
    const observer = createApplicationDeliveryObserver({
      discovery: createHttpDiscoveryAPI({ url: config.discovery.url }),
      publicClient,
      mechMarketplaceAddress: getAddress(chain.mechMarketplace),
      routerAddress: getAddress(router),
      fetchEnvelopeBytes: (cid) => fetchRawBytesFromIpfs(config.ipfsGatewayUrl, cid),
      fetchTaskBytes: (cid) => fetchRawBytesFromIpfs(config.ipfsGatewayUrl, cid),
      resolvePublisherSafe: createPublisherSafeResolver({
        rpcUrl: config.rpcUrls[0]!,
        fallbackRpcUrls: config.rpcUrls.slice(1),
        expectedChainId: chain.chainId,
        ...(config.identityRegistryAddress === undefined
          ? {}
          : { identityRegistry: config.identityRegistryAddress }),
      }),
    });
    const toBlock = await publicClient.getBlockNumber();
    if (toBlock < BigInt(expected.creationBlockNumber)) {
      throw new Error('Latest chain block predates the marketplace Task');
    }
    emitApplicationObservationResult(ctx, await observer.observe({
      ...expected,
      chainId: chain.chainId,
      fromBlock: BigInt(expected.creationBlockNumber),
      toBlock,
    }));
  } catch (error) {
    emitEnvelope({
      code: 'transient_error',
      message: errorText(error),
      hint: 'Retry after exact indexer, RPC, Mech, and IPFS paths recover.',
      exampleCli: example,
    }, { writer: ctx.writer, exit: ctx.exit });
  }
}
