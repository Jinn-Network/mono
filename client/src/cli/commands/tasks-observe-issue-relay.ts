import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { getAddress } from 'viem';
import { z } from 'zod';
import {
  IssueRelayRoundV1Schema,
  IssueRelayVerdictV1Schema,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  createIssueRelayDeliveryObserver,
  parseIssueRelayTaskCid,
  type IssueRelayDeliveryExpectation,
  type IssueRelayDeliveryObservation,
} from '../../issue-relay/delivery-observer.js';
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
  try { parseIssueRelayTaskCid(value); return true; } catch { return false; }
}, 'Task CID must be a canonical raw sha2-256 CIDv1');
const round = z.unknown().transform((value, ctx) => {
  const parsed = IssueRelayRoundV1Schema.safeParse(value);
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'invalid Relay round' }); return z.NEVER; }
  return parsed.data;
});

export const IssueRelayDeliveryExpectationSchema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-delivery-expectation.v1'),
  role: z.enum(['solution', 'verdict']), taskId, taskCid,
  creationBlockNumber: z.number().int().safe().nonnegative(), round,
  attemptIndex: z.number().int().safe().nonnegative().optional(), requestId: requestId.optional(),
  deliveryEnvelopeCid: z.string().min(1).optional(), solutionOperatorSafe: address.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.attemptIndex === undefined) !== (value.requestId === undefined)) ctx.addIssue({ code: 'custom', path: ['attemptIndex'], message: 'attemptIndex and requestId must appear together' });
  if (value.role === 'verdict' && (value.solutionOperatorSafe === undefined || value.attemptIndex === undefined || value.deliveryEnvelopeCid === undefined)) ctx.addIssue({ code: 'custom', path: ['solutionOperatorSafe'], message: 'verdict observation requires authoritative solution correlation and Safe' });
});

const relayVerdict = z.unknown().refine(
  (value) => IssueRelayVerdictV1Schema.safeParse(value).success,
  'invalid Issue Relay verdict payload',
);
const verifiedCommon = {
  status: z.literal('verified'),
  task: z.object({ taskId, taskCid: z.string().min(1) }).strict(),
  attempt: z.object({ attemptIndex: z.number().int().safe().nonnegative(), requestId, operator: address }).strict(),
  delivery: z.object({ envelopeCid: z.string().min(1), transactionHash: requestId, blockNumber: z.number().int().safe().nonnegative() }).strict(),
  round,
};
const observation = z.union([
  z.object({ status: z.literal('pending'), reason: z.string().min(1), detail: z.string().min(1).optional() }).strict(),
  z.object({ status: z.literal('contradiction'), reason: z.string().min(1), detail: z.string().min(1) }).strict(),
  z.object({
    ...verifiedCommon,
    role: z.literal('solution'),
    payload: z.object({
      schemaVersion: z.literal('jinn-repo-solution.v1'),
      patch: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({
    ...verifiedCommon,
    role: z.literal('verdict'),
    payload: relayVerdict,
  }).strict(),
]);
const resultSchema = z.object({ schemaVersion: z.literal(1), generatedAt: z.string().datetime({ offset: true }), verb: z.literal('tasks observe-issue-relay-delivery'), observation }).strict();
export type IssueRelayDeliveryCommandResult = z.infer<typeof resultSchema>;

export function parseIssueRelayDeliveryCommandResult(input: unknown): IssueRelayDeliveryCommandResult { return resultSchema.parse(input); }

export function emitIssueRelayObservationResult(ctx: CommandContext, observationValue: IssueRelayDeliveryObservation): void {
  const result = parseIssueRelayDeliveryCommandResult({ schemaVersion: 1, generatedAt: new Date().toISOString(), verb: 'tasks observe-issue-relay-delivery', observation: observationValue });
  ctx.writer.write(JSON.stringify(result) + '\n');
  if (observationValue.status === 'pending') ctx.exit(30);
  if (observationValue.status === 'contradiction') ctx.exit(50);
}

const example = 'jinn tasks observe-issue-relay-delivery --expectation-file /absolute/path.json --json';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function runObserveIssueRelayDelivery(ctx: CommandContext): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args: ctx.argv, options: { ...COMMON_FLAGS, 'expectation-file': { type: 'string' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, allowPositionals: false }); } catch (error) { emitEnvelope({ code: 'invalid_invocation', message: errorText(error), exampleCli: example }, { writer: ctx.writer, exit: ctx.exit }); return; }
  const file = parsed.values['expectation-file'];
  if (parsed.values.json !== true || parsed.values.human === true || typeof file !== 'string' || !isAbsolute(file) || parsed.values.yes === true || parsed.values['dry-run'] === true) {
    const message = parsed.values.json !== true ? '--json is required for Issue Relay delivery observation' : parsed.values.human === true ? '--human is not supported for Issue Relay delivery observation' : typeof file !== 'string' ? '--expectation-file is required' : !isAbsolute(file) ? '--expectation-file must be an absolute path' : 'ambient write flags are not supported for Issue Relay delivery observation';
    emitEnvelope({ code: 'invalid_invocation', message, exampleCli: example }, { writer: ctx.writer, exit: ctx.exit }); return;
  }
  let expected: IssueRelayDeliveryExpectation;
  try { expected = IssueRelayDeliveryExpectationSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) as IssueRelayDeliveryExpectation; } catch (error) { emitEnvelope({ code: 'invalid_invocation', message: `Invalid expectation file: ${errorText(error)}`, exampleCli: example }, { writer: ctx.writer, exit: ctx.exit }); return; }
  try {
    const config = loadConfig(getConfigPathFromArgs(ctx.argv));
    if (config.discovery?.mode !== 'http' || !config.discovery.url) throw new Error('Exact HTTP discovery indexer is required for Issue Relay delivery observation');
    const network = config.network === 'testnet' ? 'base-sepolia' : 'base';
    const chain = getChainConfig(network, { testnetL2DeploymentPath: config.testnetL2DeploymentPath, testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath, testnetMechDeploymentPath: config.testnetMechDeploymentPath, testnetStolasDeploymentPath: config.testnetStolasDeploymentPath });
    const router = chain.jinnRouter ?? getJinnRouterAddress(chain.chainId); if (!router) throw new Error(`No Jinn Router address is configured for chain ${chain.chainId}`);
    const publicClient = createJinnPublicClient(config.rpcUrls, network);
    const observer = createIssueRelayDeliveryObserver({ discovery: createHttpDiscoveryAPI({ url: config.discovery.url }), publicClient, mechMarketplaceAddress: getAddress(chain.mechMarketplace), routerAddress: getAddress(router), fetchEnvelopeBytes: (cid) => fetchRawBytesFromIpfs(config.ipfsGatewayUrl, cid), fetchTaskBytes: (cid) => fetchRawBytesFromIpfs(config.ipfsGatewayUrl, cid), resolvePublisherSafe: createPublisherSafeResolver({ rpcUrl: config.rpcUrls[0]!, fallbackRpcUrls: config.rpcUrls.slice(1), expectedChainId: chain.chainId, ...(config.identityRegistryAddress === undefined ? {} : { identityRegistry: config.identityRegistryAddress }) }) });
    const toBlock = await publicClient.getBlockNumber();
    if (toBlock < BigInt(expected.creationBlockNumber)) throw new Error('Latest chain block predates the marketplace Task');
    emitIssueRelayObservationResult(ctx, await observer.observe({ ...expected, chainId: chain.chainId, fromBlock: BigInt(expected.creationBlockNumber), toBlock }));
  } catch (error) { emitEnvelope({ code: 'transient_error', message: errorText(error), hint: 'Retry after exact indexer, RPC, Mech, and IPFS paths recover.', exampleCli: example }, { writer: ctx.writer, exit: ctx.exit }); }
}
