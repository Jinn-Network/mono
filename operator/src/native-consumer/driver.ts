/**
 * The independent native-vertical consumer driver. Given only public base URLs, a public trust
 * catalog, and an RPC URL, it: (1) cold/returning-syncs the signed announcement chain for each of
 * the requester/solver/evaluator sources into its own state directory, (2) discovers and retrieves
 * the complete public evidence graph for one run, (3) independently derives the on-chain settlement
 * facts, (4) runs the full decision-grade verification, and (5) writes the canonical report into
 * its own state directory. It never opens, reads, or references a producer's state, identity, or
 * database path -- the only filesystem writes are inside `config.stateDir`.
 *
 * Scope limit -- EOA ceremonies only: the production trust catalog (`openNativeTrustCatalog`,
 * `operator/src/daemon/native-trust-catalog.ts`) wires a `CLOSED_WITNESS_VERIFIER` that always
 * returns `verified: false`. This driver therefore cannot verify a Safe/ERC-1271-witnessed key
 * binding for any of the four signing roles -- any role bound only via a Safe ceremony is
 * correctly *rejected*, not silently accepted or skipped. Every role identity in this vertical
 * must be bound via an offline-verifiable EOA (SIWE-style) ceremony. This is fail-closed and
 * intentional, not a gap to route around; see `docs/runbooks/phase-b-native-vertical.md` for the
 * operator-facing statement of this limit.
 */
import { createTrustAdapter, type SourceEndpoint, type Transport } from '@jinn-network/record-discovery-client';
import {
  WELL_KNOWN_PATH,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import { parseWellKnownDocument } from '@jinn-network/record-discovery-serve';
import type { MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import type { NativeTrustAuthority } from '../daemon/native-trust-catalog.js';
import { deriveNativeConsumerVerificationInputs } from './authority.js';
import type { NativeConsumerChainReader } from './chain-facts.js';
import type { NativeConsumerConfig } from './config.js';
import { discoverNativeGraphRoots, retrieveNativePublicGraph, type NativePublicGraph } from './graph.js';
import { ConsumerState } from './state.js';
import { createProtocolSourceVerifier, syncPublicSource, type ConsumerSyncMode } from './sync.js';
import { buildConsumerTrustPorts } from './trust.js';
import {
  verifyNativeVertical,
  writeNativeVerticalVerificationReport,
  type NativeVerticalVerificationReport,
} from './verification.js';

export class NativeConsumerDriverError extends Error {
  override readonly name = 'NativeConsumerDriverError';
}

export interface NativeConsumerPorts {
  readonly trust: NativeTrustAuthority;
  readonly chain: NativeConsumerChainReader;
  /** Defaults to the global `fetch`; tests may inject a fixture-backed transport per source. */
  readonly transportFor?: (publicBaseUrl: string) => Transport;
  readonly now?: () => Date;
}

export interface NativeConsumerRunResult {
  readonly report: NativeVerticalVerificationReport;
  readonly reportPath: string;
  readonly reportDigest: `sha256:${string}`;
  readonly syncModes: Readonly<Record<'requester' | 'solver' | 'evaluator', ConsumerSyncMode>>;
}

function chainConfig(config: NativeConsumerConfig): MarketplaceChainConfig {
  return {
    chainId: config.chain.chainId,
    generation: config.chain.generation,
    taskCoordinator: config.chain.contracts.taskCoordinator as `0x${string}`,
    jinnRouter: config.chain.contracts.jinnRouter as `0x${string}`,
    mechMarketplace: config.chain.contracts.mechMarketplace as `0x${string}`,
    activityChecker: config.chain.contracts.activityChecker as `0x${string}`,
  };
}

function absoluteUrl(base: string, path: string): string {
  return new URL(path, `${base.replace(/\/+$/u, '')}/`).toString();
}

/** Discovers the archive root URL for a public source via its `.well-known` introduction. */
async function resolveSourceEndpoint(input: {
  readonly source: SourceIdentity;
  readonly publicBaseUrl: string;
  readonly transport: Transport;
}): Promise<SourceEndpoint> {
  const base = input.publicBaseUrl.replace(/\/+$/u, '');
  const response = await input.transport.fetch(`${base}${WELL_KNOWN_PATH}`);
  const wellKnown = parseWellKnownDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)));
  const advertised = wellKnown.sources.filter(
    (candidate) => candidate.agent === input.source.agent && candidate.name === input.source.name,
  );
  if (advertised.length !== 1) {
    throw new NativeConsumerDriverError(`public source ${input.source.agent}/${input.source.name} is not uniquely introduced at ${base}`);
  }
  return {
    agent: input.source.agent,
    name: input.source.name,
    servingRoot: base,
    archiveRootUrl: absoluteUrl(base, advertised[0]!.archiveRoot),
  };
}

const SOURCE_ROLES = ['requester', 'solver', 'evaluator'] as const;

export async function runNativeConsumer(
  config: NativeConsumerConfig,
  ports: NativeConsumerPorts,
): Promise<NativeConsumerRunResult> {
  const now = ports.now ?? (() => new Date());
  const transportFor = ports.transportFor ?? ((publicBaseUrl: string) => createHttpTransport(publicBaseUrl));
  const state = await ConsumerState.open(config.stateDir);
  try {
    const transports: Record<(typeof SOURCE_ROLES)[number], Transport> = {
      requester: transportFor(config.sources.requester.publicBaseUrl),
      solver: transportFor(config.sources.solver.publicBaseUrl),
      evaluator: transportFor(config.sources.evaluator.publicBaseUrl),
    };

    const syncModes: Record<(typeof SOURCE_ROLES)[number], ConsumerSyncMode> = {} as never;
    for (const role of SOURCE_ROLES) {
      const configured = config.sources[role];
      const source: SourceIdentity = { agent: configured.agent, name: configured.name };
      const trustAdapter = createTrustAdapter({
        bindingResolver: ports.trust.resolverFor({ family: 'observations', purpose: `native:${role}-discovery` }),
        keyCatalog: { candidateKeys: (agent: string) => Promise.resolve([...ports.trust.candidateKeys(agent)]) },
        verifier: ports.trust.rawSignatureVerifier,
      });
      const verifier = createProtocolSourceVerifier({
        state, keys: trustAdapter.keys, sigs: trustAdapter.sigs, fresh: trustAdapter.fresh, now,
      });
      const endpoint = await resolveSourceEndpoint({
        source, publicBaseUrl: configured.publicBaseUrl, transport: transports[role],
      });
      const result = await syncPublicSource({ endpoint, transport: transports[role], state, verifier });
      syncModes[role] = result.mode;
    }

    const roots = discoverNativeGraphRoots({
      state,
      runId: config.runId,
      sources: {
        requester: { source: { agent: config.sources.requester.agent, name: config.sources.requester.name }, publicBaseUrl: config.sources.requester.publicBaseUrl },
        solver: { source: { agent: config.sources.solver.agent, name: config.sources.solver.name }, publicBaseUrl: config.sources.solver.publicBaseUrl },
        evaluator: { source: { agent: config.sources.evaluator.agent, name: config.sources.evaluator.name }, publicBaseUrl: config.sources.evaluator.publicBaseUrl },
      },
      actors: { solverAgent: config.actors.solverAgent, evaluatorAgent: config.actors.evaluatorAgent },
    });
    const graph: NativePublicGraph = await retrieveNativePublicGraph({ roots, state, transports });

    const chain = chainConfig(config);
    const { authority, taskCreated, solutionSettlement, verdictSettlement } = await deriveNativeConsumerVerificationInputs({
      graph, trust: ports.trust, chain: ports.chain, chainConfig: chain, actors: config.actors,
    });

    const report = await verifyNativeVertical({
      graph,
      state,
      authority,
      trust: buildConsumerTrustPorts(ports.trust),
      taskCreated,
      solutionSettlement,
      verdictSettlement,
      packages: config.packages.map((entry) => ({
        package: entry.package,
        version: entry.version,
        tarballDigest: entry.tarballDigest as `sha256:${string}`,
      })),
      authorityTime: { verifyFinalized: (anchor) => ports.chain.verifyFinalized(anchor) },
    });
    const written = await writeNativeVerticalVerificationReport({ state, report });

    return { report, reportPath: written.path, reportDigest: written.digest, syncModes };
  } finally {
    state.close();
  }
}
