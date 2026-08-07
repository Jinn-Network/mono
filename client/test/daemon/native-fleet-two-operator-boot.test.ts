/**
 * A TWO-OPERATOR native boot (issue #2519, umbrella #2461, DR-2026-08-05).
 *
 * This is the coverage gap that let the one-swap collapse ship a fleet daemon nobody could boot in
 * native mode. Every existing native test drives one operator, or one leg of one operator; the
 * DR-2026-08-05 G-loop needs two daemons that SERVE and CONSUME each other's signed archives, and
 * that pairing had no test at all. The live gate run on 2026-08-07 found it instead.
 *
 * What this file drives is the real boot path, not a mock of it:
 *
 *  - two operators' real archives — `buildFleetRequesterWrite`'s requester source, a real
 *    `openNativeSolutionPublisher`, and (operator A) a real `openNativeEvaluatorPublisher`;
 *  - the real serving plane (`buildFleetArchiveHandler`) behind the real listener
 *    (`startPublicArchiveServer`), on loopback, one origin per operator — the shape `main.ts`
 *    mounts;
 *  - the real fleet boot call, `buildFleetNativeDiscovery`, over the real HTTP transport and the
 *    real `buildNativeDiscoverySources` introduction resolution, plus the second pair of
 *    `buildNativeDiscoverySources` calls `buildNativeEvaluatorOpportunityReader` makes for the
 *    evaluator leg.
 *
 * The chain, custody and trust catalog are the parts deliberately doubled: boot-time source
 * resolution never touches them (it fetches `.well-known` and constructs verifiers), and the whole
 * point is to test the serving/consuming pairing at the layer where it broke.
 *
 * The first `describe` is the DEFECT, asserted rather than described: mount what one-swap M6
 * mounted — the solver publisher alone — and neither operator boots.
 */
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryMarketplaceObserveStore,
  createInMemoryPostingIntentStore,
} from '@jinn-network/marketplace-binding';
import { WELL_KNOWN_PATH } from '@jinn-network/record-discovery-protocol';
import type { BindingResolver, DsseChainVerifier, PolicyCheckInput, WitnessVerifier } from '@jinn-network/trust-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startPublicArchiveServer, type PublicArchiveServer } from '../../src/api/public-archive-server.js';
import { createFileAdoptionReceiptStore } from '../../src/daemon/native-adoption-receipt-store.js';
import { buildFleetNativeDiscovery } from '../../src/daemon/native-fleet-discovery.js';
import { buildFleetRequesterWrite } from '../../src/daemon/native-fleet-requester-write.js';
import {
  buildFleetArchiveHandler,
  fleetServedSource,
  type FleetServedSource,
} from '../../src/daemon/native-fleet-serving-plane.js';
import { buildNativeDiscoverySources } from '../../src/daemon/native-discovery-trust.js';
import { openNativeEvaluatorPublisher } from '../../src/daemon/native-evaluator-publisher.js';
import { openNativeSolutionPublisher } from '../../src/daemon/native-solution-publisher.js';
import type { NativeTrustAuthority } from '../../src/daemon/native-trust-catalog.js';
import type { NativeRecordSource } from '../../src/config/native-sections.js';
import type { NativeRequesterRoles } from '../../src/native-requester/requester.js';
import { Store } from '../../src/store/store.js';

/** The live gate's own identities (DR-2026-08-05 artifact (i)) — realism, not coupling. */
const OPERATOR_A_IRI = 'urn:uuid:44cfb891-1c0b-4e4f-825b-e8b4f10a5520';
const OPERATOR_B_IRI = 'urn:uuid:e694ec79-8162-45d2-a4f8-6d785b5e28cb';
const ADMISSION_A_IRI = 'urn:uuid:44cfb891-1c0b-4e4f-825b-e8b4f10a5521';
const ADMISSION_B_IRI = 'urn:uuid:e694ec79-8162-45d2-a4f8-6d785b5e28cc';
const CREATOR_SAFE = '0x1111111111111111111111111111111111111111' as const;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function trackServer(server: PublicArchiveServer): PublicArchiveServer {
  cleanups.push(() => server.close());
  return server;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function realSigner(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    publicKey,
    sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, privateKey)),
    verify: (payload: Uint8Array, signature: Uint8Array) => cryptoVerify(null, payload, publicKey, signature),
  };
}

function requesterRoles(): NativeRequesterRoles {
  const byRole = new Map(
    (['requester-submission', 'admission', 'requester-discovery'] as const).map((role) => [
      role,
      realSigner(`did:key:${role}`),
    ]),
  );
  return {
    get(role) {
      const identity = byRole.get(role);
      if (identity === undefined) throw new Error(`missing test role ${role}`);
      return identity;
    },
  };
}

/**
 * A trust authority double. Boot-time source resolution calls only `resolverFor`; the verifier
 * ports it hands to `createTrustAdapter` are exercised at POLL, which this file does not reach —
 * see the module header for why that separation is the point rather than a shortcut.
 */
function fakeTrust(): NativeTrustAuthority {
  const bindingResolver: BindingResolver = { async resolveBinding() { return null; } };
  const witnessVerifier: WitnessVerifier = {
    async verify1271Witness() { return { verified: false, reason: 'fixture never verifies' }; },
  };
  const dsseVerifier: DsseChainVerifier = () => ({ validSignerKeyids: [] });
  return {
    bindingResolver,
    dsseVerifier,
    witnessVerifier,
    conflicts: [],
    newestPolicyVersion: 1,
    rawSignatureVerifier: { async verify() { return false; } },
    async assertFresh() { /* no-op fixture */ },
    candidateKeys() { return []; },
    policy(purpose) { return { accepted: [`accepted-for-${purpose}`], requiredStrength: 'strong' } as PolicyCheckInput; },
    async verifyRoleBinding() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    async verifyOnchainAuthority() { return { bindingDigest: `sha256:${'0'.repeat(64)}` as const }; },
    resolverFor() { return bindingResolver; },
  };
}

interface Operator {
  readonly agentIri: string;
  readonly baseUrl: string;
  readonly served: readonly FleetServedSource[];
  mount(served: readonly FleetServedSource[]): void;
  /** Exactly what one-swap M6 mounted: the solver publisher's own handler, and nothing else. */
  mountSolverOnlyAsM6Did(): void;
  store(): Store;
}

/**
 * Builds one operator's archives behind one loopback origin, exactly as `main.ts` does: one
 * listener, `publicBaseUrl` = that listener's origin, every source this operator owns behind it.
 *
 * The listener is bound BEFORE the publishers are constructed because each publisher stamps
 * `publicBaseUrl` into the record locations it announces, and the port is only known after bind.
 * The mounted handler is late-bound through `current` for the same reason.
 */
async function buildOperator(input: {
  readonly prefix: string;
  readonly agentIri: string;
  readonly admissionIri: string;
  readonly withEvaluator: boolean;
}): Promise<Operator> {
  const root = await tempRoot(input.prefix);
  let current: (request: Request) => Promise<Response> = async () => new Response(null, { status: 404 });
  const server = trackServer(await startPublicArchiveServer({
    handler: (request) => current(request),
    host: '127.0.0.1',
    port: 0,
  }));
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const intents = createInMemoryPostingIntentStore();
  const requesterWrite = buildFleetRequesterWrite({
    requesterAgent: input.agentIri,
    admissionAgent: input.admissionIri,
    publicBaseUrl: baseUrl,
    requesterStateDir: join(root, 'native-requester'),
    creatorSafe: CREATOR_SAFE,
    roles: requesterRoles(),
    safeBroadcast: { broadcastCreateTask: async () => { throw new Error('this test never broadcasts'); } },
    intents,
    observe: createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY, { intents }),
    ipfsPin: { pin: async () => undefined },
    authorityTime: async () => ({
      chainId: 84532 as const,
      blockNumber: '100',
      blockHash: `0x${'cd'.repeat(32)}` as const,
      timestamp: '2026-08-07T12:00:00.000Z',
      finalized: true as const,
    }),
    canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
    adoptionReceipts: createFileAdoptionReceiptStore({ dir: join(root, 'native-requester', 'adoptions') }),
  });

  const solver = await openNativeSolutionPublisher({
    rootDir: join(root, 'native-public', 'solver'),
    publicBaseUrl: baseUrl,
    source: { agent: input.agentIri, name: 'solver-records' },
    signer: realSigner('did:key:z6MkSolverDiscovery'),
    settlementDeclarationKey: 'did:key:z6MkSolverSettlement',
  });
  cleanups.push(() => solver.close());

  const served: FleetServedSource[] = [requesterWrite.discovery, fleetServedSource(solver)];
  if (input.withEvaluator) {
    const evaluator = await openNativeEvaluatorPublisher({
      rootDir: join(root, 'evaluator', 'public'),
      publicBaseUrl: baseUrl,
      source: { agent: input.agentIri, name: 'evaluator-records' },
      signer: realSigner('did:key:z6MkEvaluatorDiscovery'),
    });
    cleanups.push(() => evaluator.close());
    served.push(fleetServedSource(evaluator));
  }

  const stores: Store[] = [];
  return {
    agentIri: input.agentIri,
    baseUrl,
    served,
    mount(next) { current = buildFleetArchiveHandler(next); },
    mountSolverOnlyAsM6Did() { current = solver.handler; },
    store() {
      const store = new Store(join(root, `discovery-${stores.length}.sqlite`));
      stores.push(store);
      cleanups.push(() => store.close());
      return store;
    },
  };
}

/** The exact fleet boot call `buildFleetNativeRuntime` makes (`native-fleet-runtime.ts:396`). */
async function bootFleetDiscovery(operator: Operator, recordSources: readonly NativeRecordSource[]) {
  return buildFleetNativeDiscovery({
    store: operator.store(),
    trust: fakeTrust(),
    recordSources,
    verifyAuthorityTime: async () => true,
    recordByLocation: async () => new Uint8Array(),
    canonicalTaskCreated: async () => null,
  });
}

/**
 * The evaluator leg's own source resolution — the two `buildNativeDiscoverySources` calls
 * `buildNativeEvaluatorOpportunityReader` makes over its exactly-one-requester + exactly-one-solver
 * pair (#2519 F3). Driven directly rather than through the reader, which additionally wants chain
 * reads, evidence and a pinned Node launcher.
 */
async function bootEvaluatorSources(operator: Operator, recordSources: readonly NativeRecordSource[]) {
  const { createHttpTransport } = await import('@jinn-network/record-discovery-transport-http');
  const store = operator.store();
  const transport = createHttpTransport('');
  const trust = fakeTrust();
  const requester = recordSources.filter(({ role }) => role === 'requester');
  const solver = recordSources.filter(({ role }) => role === 'solver');
  expect(requester).toHaveLength(1);
  expect(solver).toHaveLength(1);
  return {
    requester: await buildNativeDiscoverySources({ configured: requester, store, transport, trust }),
    solver: await buildNativeDiscoverySources({ configured: solver, store, transport, trust }),
  };
}

/**
 * The gate topology: A posts and evaluates, B solves. So B consumes A's requester source, A
 * consumes its OWN requester source plus B's solver source, and A's evaluator consumes both.
 * Both directions are cold — neither operator has published anything.
 */
function sourcesFor(a: Operator, b: Operator): {
  readonly a: readonly NativeRecordSource[];
  readonly b: readonly NativeRecordSource[];
} {
  const requesterOfA: NativeRecordSource = {
    role: 'requester', agent: a.agentIri, name: 'requester', baseUrl: a.baseUrl,
  };
  const solverOfB: NativeRecordSource = {
    role: 'solver', agent: b.agentIri, name: 'solver-records', baseUrl: b.baseUrl,
  };
  return { a: [requesterOfA, solverOfB], b: [requesterOfA, solverOfB] };
}

async function operators(): Promise<{ a: Operator; b: Operator }> {
  return {
    a: await buildOperator({
      prefix: 'jinn-fleet-op-a-',
      agentIri: OPERATOR_A_IRI,
      admissionIri: ADMISSION_A_IRI,
      withEvaluator: true,
    }),
    b: await buildOperator({
      prefix: 'jinn-fleet-op-b-',
      agentIri: OPERATOR_B_IRI,
      admissionIri: ADMISSION_B_IRI,
      withEvaluator: false,
    }),
  };
}

describe('#2519 — the defect: the fleet daemon served only the solver archive', () => {
  it('refuses both operators when only the solver publisher is mounted', async () => {
    const { a, b } = await operators();
    a.mountSolverOnlyAsM6Did();
    b.mountSolverOnlyAsM6Did();
    const configured = sourcesFor(a, b);

    // The requester source has no serving plane at all, so its `.well-known` introduction cannot
    // be resolved — and neither daemon gets past `buildNativeDiscoverySources`. This is verbatim
    // what the live gate hit on 2026-08-07, and it is the reason this file exists.
    const wellKnown = new RegExp(`${WELL_KNOWN_PATH} failed with HTTP 404`, 'u');
    await expect(bootFleetDiscovery(a, configured.a)).rejects.toThrow(wellKnown);
    await expect(bootFleetDiscovery(b, configured.b)).rejects.toThrow(wellKnown);
  });

  it('leaves a mounted-but-never-published archive unintroduced (the cold-start deadlock)', async () => {
    const { a } = await operators();

    // Surfacing and mounting the handler is necessary but NOT sufficient: each archive's own
    // handler serves a well-known document only after its publish path has written one, and
    // publishing needs a booted daemon. Every source this operator owns is in that state at boot.
    for (const { source, handler } of a.served) {
      const response = await handler(new Request(`${a.baseUrl}${WELL_KNOWN_PATH}`));
      expect(response.status, `${source.name} served a well-known before publishing`).toBe(404);
    }
  });
});

describe('#2519 — two-operator native boot', () => {
  it('boots both operators against each other cold, before either has published', async () => {
    const { a, b } = await operators();
    a.mount(a.served);
    b.mount(b.served);
    const configured = sourcesFor(a, b);

    const [discoveryA, discoveryB] = await Promise.all([
      bootFleetDiscovery(a, configured.a),
      bootFleetDiscovery(b, configured.b),
    ]);

    expect(discoveryA).toBeDefined();
    expect(discoveryB).toBeDefined();

    // A also runs the evaluator leg, which resolves its own requester + B's solver source.
    const evaluatorSources = await bootEvaluatorSources(a, configured.a);
    expect(evaluatorSources.requester[0]!.endpoint).toMatchObject({
      agent: OPERATOR_A_IRI,
      name: 'requester',
      servingRoot: a.baseUrl,
      archiveRootUrl: `${a.baseUrl}/sources/requester/entries/0000000000000001`,
    });
    expect(evaluatorSources.solver[0]!.endpoint).toMatchObject({
      agent: OPERATOR_B_IRI,
      name: 'solver-records',
      servingRoot: b.baseUrl,
      archiveRootUrl: `${b.baseUrl}/sources/solver-records/entries/0000000000000001`,
    });
  });

  it('introduces every source each operator owns under its one origin', async () => {
    const { a, b } = await operators();
    a.mount(a.served);
    b.mount(b.served);

    const read = async (operator: Operator) => {
      const response = await fetch(`${operator.baseUrl}${WELL_KNOWN_PATH}`);
      expect(response.status).toBe(200);
      return (await response.json() as { sources: { agent: string; name: string }[] }).sources;
    };

    expect((await read(a)).map(({ agent, name }) => `${agent}/${name}`)).toEqual([
      `${OPERATOR_A_IRI}/requester`,
      `${OPERATOR_A_IRI}/solver-records`,
      `${OPERATOR_A_IRI}/evaluator-records`,
    ]);
    expect((await read(b)).map(({ agent, name }) => `${agent}/${name}`)).toEqual([
      `${OPERATOR_B_IRI}/requester`,
      `${OPERATOR_B_IRI}/solver-records`,
    ]);
  });

  it('still refuses a peer that serves nothing, and a peer that introduces another identity', async () => {
    const { a, b } = await operators();
    a.mount(a.served);
    b.mount(b.served);

    // A peer origin with no archive behind it: unchanged refusal. Cold-start introduction is a
    // SERVING-side courtesy for sources this operator owns, never a consuming-side tolerance.
    const dead = trackServer(await startPublicArchiveServer({
      handler: async () => new Response(null, { status: 404 }),
      host: '127.0.0.1',
      port: 0,
    }));
    await expect(bootFleetDiscovery(a, [{
      role: 'requester', agent: OPERATOR_B_IRI, name: 'requester', baseUrl: `http://127.0.0.1:${dead.port}`,
    }])).rejects.toThrow();

    // B serves a real archive, but not under the identity A asked for.
    await expect(bootFleetDiscovery(a, [{
      role: 'requester', agent: OPERATOR_A_IRI, name: 'requester', baseUrl: b.baseUrl,
    }])).rejects.toThrow(/not uniquely introduced/u);
  });

  it('serves each source only from its own archive, and 404s anything else', async () => {
    const { a } = await operators();
    a.mount(a.served);

    // Nothing has published, so every chain object is genuinely absent — the introduction promises
    // a source, it does not fabricate a history.
    expect((await fetch(`${a.baseUrl}/sources/requester/head`)).status).toBe(404);
    expect((await fetch(`${a.baseUrl}/sources/solver-records/head`)).status).toBe(404);
    // Not one of the five admitted archive shapes: the composite adds no route.
    expect((await fetch(`${a.baseUrl}/v1/status`)).status).toBe(404);
    expect((await fetch(`${a.baseUrl}/records/not-a-digest`)).status).toBe(404);
  });
});

describe('#2519 — the fleet daemon mounts every archive it owns', () => {
  /**
   * `main.ts` is not callable from a unit test (it boots a daemon against a chain), so the wiring
   * itself is asserted structurally — the same technique `native-fleet-posting.test.ts` uses. This
   * is what keeps the behavioural test above honest about the DAEMON rather than only about the
   * serving plane it exercises directly.
   */
  const main = readFileSync(
    fileURLToPath(new URL('../../src/main.ts', import.meta.url)),
    'utf8',
  );

  it('composes the requester, solver and evaluator archives behind the one archive listener', () => {
    expect(main).toContain('buildFleetArchiveHandler');
    expect(main).toContain('fleetRequesterDiscovery');
    expect(main).toContain('fleetServedSource(composition.nativeSolutionPublisher)');
    expect(main).toContain('fleetServedSource(fleetEvaluator.composition.publisher)');
  });

  it('starts exactly one archive listener', () => {
    expect(main.match(/startPublicArchiveServer\(\{/gu) ?? []).toHaveLength(1);
  });
});
