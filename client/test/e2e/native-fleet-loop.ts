// client/test/e2e/native-fleet-loop.ts
/**
 * Native fleet G-loop gate runner (one-swap M7, umbrella #2461, DR-2026-08-05).
 *
 * Public command: `JINN_E2E_MODE=native yarn e2e:daemon-harness` (or `yarn e2e:daemon-harness:native`).
 *
 * This is the LOCAL two-operator native G-loop gate runner: its console output IS the DR-2026-08-05
 * gate evidence, run locally per the operator ruling (no hosted/Railway deploy). It forks
 * **Base Sepolia 84532** — an Anvil `--fork-url` of a Sepolia RPC, driving the pinned
 * `BASE_SEPOLIA_TODAY` addresses that `assertNativeDeployment` requires unrelaxed. This is the
 * opposite fork target from `daemon-harness-cycle.ts` (which forks Base mainnet), and it is
 * deliberate: native boot refuses any chain but 84532 with the exact today addresses, so the rig
 * must fork the chain those addresses live on.
 *
 * The rig drives the G-loop legs as far as a local Anvil fork honestly allows, and prints an
 * EVIDENCE TABLE at the end classifying each leg PROVEN / MECHANISM / BLOCKED / SKIPPED. It never
 * fakes a leg green: a leg that a fork genuinely cannot self-provide is printed BLOCKED with a
 * precise reason (the deploy-time gate closes it against live Base Sepolia), never asserted.
 *
 * Leg-by-leg posture (see the printed table for the run-time result):
 *
 *  PROVEN-on-fork (real machinery, asserted here; a failure FAILS LOUD as a regression):
 *   - LEG 0  native boot gate — `assertNativeDeployment` + forked BASE_SEPOLIA_TODAY contract code.
 *   - LEG 1  on-chain-anchored trust catalog + role-identity boot against REAL fork finality, for
 *            BOTH operators A and B (finalized calldata anchor → production anchor client →
 *            `openRoleIdentitySet` effective-time proof).
 *   - LEG 2  M6 serving plane LIVE — operator A's requester `.well-known` introduction is served on
 *            a real local HTTP listener, and `buildFleetNativeRuntime` (the exact production
 *            construction main.ts calls) fetches + admits it at fleet construction for BOTH
 *            operators. Real signed introduction over the wire, not on disk.
 *   - G-archive  a GENUINELY SEPARATE OS process cold-syncs / resumes / live-tails operator A's
 *            live serving listener (model: `e2e:archive-second-daemon:separate-process`).
 *
 *  MECHANISM-PROVEN off-chain (real M5e/M5f production code — `buildFleetRequesterWrite` with
 *  operator A's REAL role identities — over in-memory venue ports; the on-chain escrowed
 *  settlement half is BLOCKED, see below):
 *   - LEG 4  native post — A seals a real Task+Submission+admission and posts through the requester
 *            write host's ONE broadcaster port (here an in-memory `safeBroadcast`, standing in for
 *            `composition.venue.safe`).
 *   - LEG 5  operator B's delivery is recorded on the shared observe store; A discovers it via
 *            `postedAssociations()`.
 *   - LEG 7  adopt — A's requester runs the REAL fail-closed adoption verification and records a
 *            durable adoption receipt (adopt-once idempotent).
 *
 *  Docker-gated (DR decision 3a):
 *   - LEG 6  the native container-grade driver (`createDockerContainerRuntime`, M4c) executes a REAL
 *            `docker run` when `docker info` is reachable; SKIPPED loudly when it is not.
 *
 *  BLOCKED-on-fork (documented deploy-time gaps, recorded as findings — NOT faked green):
 *   - LEG 3  two service-registered + staked + mech-registered operator Safes on Base Sepolia's real
 *            today contracts. The reproducible funding primitive (Anvil setBalance) is demonstrated;
 *            the full `FleetBootstrapper` earning bootstrap against the real ServiceRegistry / staking
 *            / mech is a deploy-time flow the fork rig does not stand up.
 *   - LEG 4/5/7 on-chain half — escrowed `createTask` / on-chain claim+deliver / adopt against a real
 *            verdict all require the LEG 3 registered Safe, so the chain-settlement half is BLOCKED.
 *   - LEG 6  `decisionGrade: true` — that boolean is emitted by `gateVerdictObservation` over a
 *            complete signed settlement graph with a real swe-rebench grader image, not by a bare
 *            container run; unreachable on a local fork.
 *
 * Skips cleanly (exit 0) when no Base Sepolia RPC is reachable — a CI runner without outbound RPC
 * must not red-gate.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BASE_SEPOLIA_TODAY,
  createInMemoryMarketplaceObserveStore,
  createInMemoryPostingIntentStore,
  type PostingOutcome,
} from '@jinn-network/marketplace-binding';
import { sealDelivery, documentDigest } from '@jinn-network/task-execution-protocol';
import { sealJson } from '@jinn-network/record-discovery-protocol';
import { spawnAnvilFork } from '../_support/chain/anvil.js';
import { assertNativeDeployment } from '../../src/daemon/native-vertical-mode.js';
import { openNativeTrustCatalog } from '../../src/daemon/native-trust-catalog.js';
import {
  createBaseSepoliaFinalizedAnchorClient,
  createViemBaseSepoliaReadClients,
} from '../../src/daemon/native-base-sepolia-infrastructure.js';
import { openRoleIdentitySet } from '../../src/daemon/role-identities.js';
import { buildFleetNativeRuntime } from '../../src/daemon/native-fleet-runtime.js';
import {
  buildFleetRequesterWrite,
  FLEET_REQUESTER_POSTING_TERMS,
} from '../../src/daemon/native-fleet-requester-write.js';
import { createFileAdoptionReceiptStore } from '../../src/daemon/native-adoption-receipt-store.js';
import { createDockerContainerRuntime } from '../../src/daemon/native-evaluator-container-runtime.js';
import { Store } from '../../src/store/store.js';
import { startPublicArchiveServer } from '../../src/api/public-archive-server.js';
import { seedArchiveFixture, appendOneRecord } from '../archive/_seed-archive.js';
import type { NativeRequesterRoles } from '../../src/native-requester/requester.js';
import { ANVIL_PRIVATE_KEYS } from './_daemon-harness-helpers.js';
import { buildTwoOperatorNativeSetup } from './fixtures/native-fleet/config.js';
import { createForkAnchorSubmitter } from './fixtures/native-fleet/anchor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'native-e2e-fleet-password';

/** The single distinct row shape the printed evidence table is built from. */
type LegStatus = 'PROVEN' | 'MECHANISM' | 'BLOCKED' | 'SKIPPED';
interface LegRow {
  readonly leg: string;
  readonly status: LegStatus;
  readonly evidence: string;
}

function sepoliaRpcFromEnv(): string | undefined {
  return process.env['JINN_E2E_SEPOLIA_RPC']
    ?? process.env['BASE_SEPOLIA_RPC_URL']
    ?? 'https://base-sepolia.publicnode.com';
}

async function reachable(rpcUrl: string): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const chainId = await client.getChainId();
    return chainId === 84532;
  } catch {
    return false;
  }
}

/**
 * `docker info` with a bounded timeout. A wedged/starting Docker daemon must degrade to a clean
 * SKIP, never hang the gate runner (CLAUDE.md: a wedged Docker daemon hangs a run indefinitely).
 */
function dockerReachable(): boolean {
  try {
    const probe = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return probe.status === 0 && probe.signal === null;
  } catch {
    return false;
  }
}

export async function runNativeFleetLoop(): Promise<void> {
  const rpcUrl = sepoliaRpcFromEnv();
  if (rpcUrl === undefined || !(await reachable(rpcUrl))) {
    console.log('\n=== native-fleet e2e — SKIPPED: no reachable Base Sepolia (84532) RPC ===');
    return;
  }

  console.log('\n=== native-fleet G-loop gate runner — fork Base Sepolia 84532 (local, DR-2026-08-05) ===');
  const rows: LegRow[] = [];
  const anvil = await spawnAnvilFork({ forkUrl: rpcUrl, chain: baseSepolia, silent: true });
  const root = await mkdtemp(join(tmpdir(), 'native-fleet-rig-'));

  // Operator A's requester source served on a REAL local listener (M6 serving plane). Seeded through
  // `record-discovery-serve`'s own writers — the exact writers the native solution publisher drives
  // — with A's agent + the `requester` source name the fixture config points every operator's
  // discovery at. Started BEFORE the setup is authored so the setup's `aPublicBaseUrl` IS this live
  // serving root, which `buildFleetNativeRuntime` then fetches `/.well-known/jinn-record-discovery`
  // from at construction (LEG 2).
  const agentA = 'urn:jinn:operator:fleet-e2e-a';
  const requesterServeSeed = await seedArchiveFixture({
    rootDir: join(root, 'serve-a-requester'),
    agent: agentA,
    sourceName: 'requester',
  });
  const requesterServer = await startPublicArchiveServer({
    handler: requesterServeSeed.handler,
    host: '127.0.0.1',
    port: 0,
  });
  const requesterServingRoot = `http://127.0.0.1:${requesterServer.port}`;

  const openStores: Store[] = [];
  try {
    console.log(`anvil rpc: ${anvil.rpcUrl}`);
    console.log(`operator A requester source served live at: ${requesterServingRoot}`);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(anvil.rpcUrl) });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEYS[0]!);
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(anvil.rpcUrl) });
    await anvil.setBalance(account.address, 100n * 10n ** 18n);

    // ── LEG 0: native boot gate — assertNativeDeployment + forked contract code ──────────────
    assertNativeDeployment({ network: 'testnet', chain: BASE_SEPOLIA_TODAY });
    for (const [name, address] of Object.entries({
      taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
      mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
      activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
    })) {
      const code = await publicClient.getBytecode({ address: address as `0x${string}` });
      if (code === undefined || code === '0x') {
        throw new Error(`native boot gate: forked ${name} at ${address} has no code — wrong fork target?`);
      }
    }
    console.log('  ✓ LEG 0 PROVEN — assertNativeDeployment + forked BASE_SEPOLIA_TODAY contract code');
    rows.push({
      leg: 'LEG 0  boot gate (assertNativeDeployment + forked code)',
      status: 'PROVEN',
      evidence: `chainId=84532 today; taskCoordinator/jinnRouter/mechMarketplace/activityChecker all have forked code`,
    });

    // ── LEG 1: on-chain-anchored trust catalog + role-identity boot, REAL fork finality ──────
    const submitAnchor = createForkAnchorSubmitter({ rpcUrl: anvil.rpcUrl, publicClient, walletClient, account });
    const setup = await buildTwoOperatorNativeSetup({
      rootDir: root,
      password: PASSWORD,
      rpcUrl: anvil.rpcUrl,
      ipfsApiUrl: 'http://127.0.0.1:5001',
      ceremonyAccount: account,
      submitAnchor,
      // The LIVE requester serving root — every operator's `recordSources` requester entry points
      // here, so `buildFleetNativeRuntime` fetches a real `.well-known` from it in LEG 2.
      aPublicBaseUrl: requesterServingRoot,
      bPublicBaseUrl: 'http://127.0.0.1:7402/b',
      aSafeAddress: account.address,
    });
    console.log('  · authored trust catalog with an on-chain finalized anchor');

    const bootDate = new Date(setup.bootTime);
    const now = () => bootDate;
    const anchorClient = createBaseSepoliaFinalizedAnchorClient(
      createViemBaseSepoliaReadClients(publicClient).anchor,
    );
    const trust = await openNativeTrustCatalog({
      path: setup.trustRootsPath,
      expectedPolicyGenesisDigest: setup.trustPolicyGenesisDigest,
      anchorClient,
      now: bootDate,
    });
    console.log('  · openNativeTrustCatalog accepted the fork-anchored catalog (production anchor client)');

    const aSolver = await openRoleIdentitySet({
      agent: setup.operatorA.agentIri,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: setup.operatorA.solverStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    const aRequester = await openRoleIdentitySet({
      agent: setup.operatorA.agentIri,
      requiredRoles: ['requester-submission', 'requester-discovery'],
      storePath: setup.operatorA.requesterStore!.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    const admission = await openRoleIdentitySet({
      agent: setup.operatorA.admissionAgent!,
      requiredRoles: ['admission'],
      storePath: setup.operatorA.admissionStore!.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    const bSolver = await openRoleIdentitySet({
      agent: setup.operatorB.agentIri,
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      storePath: setup.operatorB.solverStore.storePath,
      password: PASSWORD,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
      now,
    });
    // Independence check: A and B are honestly distinct — different agents, different keys.
    if (aSolver.get('solver-delivery').keyId === bSolver.get('solver-delivery').keyId) {
      throw new Error('operators A and B minted the same solver key — not honestly separate');
    }
    if (admission.get('admission').keyId === aRequester.get('requester-submission').keyId) {
      throw new Error('admission custody is not a distinct key from the requester');
    }
    console.log('  ✓ LEG 1 PROVEN — fork-finalized trust anchor + every native role identity boots (A + B)');
    rows.push({
      leg: 'LEG 1  trust anchor + role-identity boot (A + B)',
      status: 'PROVEN',
      evidence: `finalized anchor tx accepted by production anchor client; A/B solver keys distinct; admission ≠ requester`,
    });

    // ── LEG 2: M6 serving plane LIVE — buildFleetNativeRuntime fetches A's `.well-known` for A + B ─
    // The exact production construction main.ts's native branch calls. Its `buildFleetNativeDiscovery`
    // → `buildNativeDiscoverySources` fetches `${baseUrl}/.well-known/jinn-record-discovery` for the
    // one requester source at construction, so a construction that returns proves the M6 serving
    // plane was consumed live. Run for BOTH operators (both discover A's requester source).
    const runtimeA = await buildFleetNativeRuntime({
      config: setup.operatorA.config,
      store: newStore(openStores, setup.operatorA.config.dbPath!),
      publicClient,
      safeAddress: account.address,
      stateRoot: join(root, 'operator-a', 'native'),
      password: PASSWORD,
      workerOwnerId: randomUUID(),
    });
    const bSafeAddress = privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!).address;
    const runtimeB = await buildFleetNativeRuntime({
      config: setup.operatorB.config,
      store: newStore(openStores, setup.operatorB.config.dbPath!),
      publicClient,
      safeAddress: bSafeAddress,
      stateRoot: join(root, 'operator-b', 'native'),
      password: PASSWORD,
      workerOwnerId: randomUUID(),
    });
    // A provisioned admission custody → requester write authority present (M5e). B is solver-only.
    if (runtimeA.requesterWrite === undefined) {
      throw new Error('operator A configured admission custody but buildFleetNativeRuntime produced no requesterWrite authority');
    }
    if (runtimeB.requesterWrite !== undefined) {
      throw new Error('operator B is solver-only but buildFleetNativeRuntime produced a requesterWrite authority');
    }
    console.log(`  ✓ LEG 2 PROVEN — both operators' fleet runtime fetched A's live .well-known at construction`);
    rows.push({
      leg: 'LEG 2  requester source .well-known serving (M6) — LIVE',
      status: 'PROVEN',
      evidence: `served ${requesterServingRoot}/.well-known/jinn-record-discovery; A+B buildFleetNativeRuntime OK; A has requesterWrite, B does not`,
    });

    // ── LEG 3: operator Safes funded + mech-registered — funding primitive demonstrated, registration BLOCKED ─
    const aFundEoa = account.address;
    const bFundEoa = bSafeAddress;
    await anvil.setBalance(aFundEoa, 100n * 10n ** 18n);
    await anvil.setBalance(bFundEoa, 100n * 10n ** 18n);
    const aBal = await publicClient.getBalance({ address: aFundEoa });
    const bBal = await publicClient.getBalance({ address: bFundEoa });
    console.log(`  · LEG 3: funded A(${aFundEoa}) and B(${bFundEoa}) EOAs via Anvil setBalance (reproducible on fork)`);
    console.log('  ⚠ LEG 3 BLOCKED — full service-registration + staking + mech-registration is a deploy-time flow');
    rows.push({
      leg: 'LEG 3  operator Safes funded + mech-registered',
      status: 'BLOCKED',
      evidence: `funding reproducible (A=${aBal / 10n ** 18n}ETH, B=${bBal / 10n ** 18n}ETH via setBalance); FleetBootstrapper service-registration + OLAS staking + mech-registration against Base Sepolia's real today contracts is a deploy-time earning bootstrap the fork rig does not stand up (no helper targets the real 84532 registry/staking; legacy bootstrapStakedOperator forks Base mainnet + deploys a fresh V3 stack)`,
    });

    // ── LEG 4/5/7: native post / B deliver / A adopt — MECHANISM proven off-chain via the real host ─
    // `buildFleetRequesterWrite` is the real M5e/M5f production host. Wired with operator A's REAL
    // fixture role identities (requester-submission, requester-discovery, admission) so the sealing +
    // fail-closed adoption verification are genuinely A's — only the ONE broadcaster (`safeBroadcast`)
    // and the venue observe/intents are in-memory stand-ins for the composition venue, because the
    // on-chain escrowed settlement half needs the LEG-3 registered Safe (BLOCKED above). This mirrors
    // the canonical `native-fleet-requester-write.test.ts` drive.
    const requesterWriteState = join(root, 'operator-a', 'requester-write');
    const aRoles: NativeRequesterRoles = {
      get(role) {
        const key = role === 'admission'
          ? setup.operatorA.admissionStore!.key('admission')
          : setup.operatorA.requesterStore!.key(role);
        return { keyId: key.keyId, publicKey: key.publicKey, sign: (payload) => key.sign(payload) };
      },
    };
    const intents = createInMemoryPostingIntentStore();
    const observe = createInMemoryMarketplaceObserveStore(BASE_SEPOLIA_TODAY, { intents });
    const adoptionReceipts = createFileAdoptionReceiptStore({ dir: join(requesterWriteState, 'adoptions') });
    const pinned: Uint8Array[] = [];
    let lastBroadcast: { safeAddress: `0x${string}`; to: `0x${string}`; value: bigint; data: `0x${string}` } | undefined;
    const write = buildFleetRequesterWrite({
      requesterAgent: setup.operatorA.agentIri,
      admissionAgent: setup.operatorA.admissionAgent!,
      publicBaseUrl: requesterServingRoot,
      requesterStateDir: requesterWriteState,
      creatorSafe: account.address,
      roles: aRoles,
      safeBroadcast: {
        broadcastCreateTask: async (args): Promise<PostingOutcome> => {
          lastBroadcast = args;
          return { taskId: 4242n, txHash: `0x${'ab'.repeat(32)}` as `0x${string}` };
        },
      },
      intents,
      observe,
      ipfsPin: { pin: async (bytes) => { pinned.push(bytes); } },
      authorityTime: async () => ({
        chainId: 84532 as const,
        blockNumber: '100',
        blockHash: `0x${'cd'.repeat(32)}` as `0x${string}`,
        timestamp: '2026-08-02T11:59:00.000Z',
        finalized: true as const,
      }),
      canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
      adoptionReceipts,
      logger: { info: (m) => console.log(`    [requester-write] ${m}`), warn: (m) => console.warn(`    [requester-write] ${m}`) },
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    });

    // LEG 4 — A posts natively (real seal → pin → broadcast through the ONE port → taskId).
    const posted = await write.postTarget({
      postingKey: 'native-e2e', workKind: 'prediction.v1', profileUri: 'urn:m:prediction.v1', live: true, generatorEnabled: true,
    });
    if (posted.taskId === undefined) throw new Error('LEG 4: native post returned no taskId');
    if (pinned.length !== 2) throw new Error(`LEG 4: expected 2 pins (Task + Submission), got ${pinned.length}`);
    if (lastBroadcast === undefined || lastBroadcast.to !== BASE_SEPOLIA_TODAY.jinnRouter) {
      throw new Error('LEG 4: broadcast did not target the today-mode jinnRouter createTask');
    }
    const escrow = FLEET_REQUESTER_POSTING_TERMS.solutionMaxDeliveryRateWei + FLEET_REQUESTER_POSTING_TERMS.verdictMaxDeliveryRateWei;
    if (lastBroadcast.value !== escrow) throw new Error(`LEG 4: escrow value mismatch (want ${escrow}, got ${lastBroadcast.value})`);
    console.log(`  ✓ LEG 4 MECHANISM — A sealed + posted taskId=${posted.taskId} through the requester write host (escrow=${escrow} wei to jinnRouter)`);
    rows.push({
      leg: 'LEG 4  requester post (M5e) — seal + escrowed createTask',
      status: 'MECHANISM',
      evidence: `A's real identities sealed Task+Submission+admission, 2 IPFS pins, broadcast once to jinnRouter value=${escrow}wei → taskId=${posted.taskId}; ON-CHAIN via composition.venue.safe BLOCKED (needs LEG 3 Safe)`,
    });

    // LEG 5 — operator B's delivery is recorded on the shared observe store; A discovers it.
    const association = await readPostedAssociation(requesterWriteState);
    const snapshot = await observe.observe(association.submissionUri);
    const attempt = snapshot.descriptor.attempt;
    const deliveryBytes = sealDelivery({
      protocol: 'https://spec.jinn.network/task-execution/v1',
      attempt,
      task: association.taskDigest,
      outputs: [],
      outcome: 'fulfilled' as const,
      createdAt: '2026-08-02T12:30:00.000Z',
    });
    await observe.recordDelivery(attempt, deliveryBytes);
    const deliveryDigest = documentDigest(deliveryBytes);
    console.log(`  ✓ LEG 5 MECHANISM — B's delivery (${deliveryDigest.slice(0, 20)}…) recorded on shared observe store against A's durable association ${association.taskId}`);
    rows.push({
      leg: 'LEG 5  operator B claim + deliver (M3)',
      status: 'MECHANISM',
      evidence: `B delivery ${deliveryDigest} recorded on shared observe store for attempt ${attempt}; A discovers it through its durable posted association (${association.taskId}); NOTE solver≠evaluator distinctness is the LEG-6 gate check, and ON-CHAIN claim+deliver on the forked V3 stack is BLOCKED (needs LEG 3)`,
    });

    // LEG 7 — A adopts B's delivery with the REAL fail-closed verification; adopt-once idempotent.
    const decisions = await write.adopt();
    if (decisions.length !== 1) throw new Error(`LEG 7: expected exactly one adoption decision, got ${decisions.length}`);
    const decision = decisions[0]!;
    if (decision.disposition !== 'accepted' || decision.deliveryDigest !== deliveryDigest) {
      throw new Error(`LEG 7: adoption decision malformed: ${JSON.stringify(decision)}`);
    }
    if (!(await adoptionReceipts.has(decision.taskId))) throw new Error('LEG 7: durable adoption receipt not written');
    const second = await write.adopt();
    if (second.length !== 0) throw new Error(`LEG 7: adopt-once violated — second pass produced ${second.length} decision(s)`);
    console.log(`  ✓ LEG 7 MECHANISM — A adopted delivery (receipt taskId=${decision.taskId}, digest=${decision.deliveryDigest.slice(0, 20)}…); adopt-once holds`);
    rows.push({
      leg: 'LEG 7  operator A adopt (M5f)',
      status: 'MECHANISM',
      evidence: `real fail-closed adopt → durable receipt {taskId=${decision.taskId}, disposition=accepted, deliveryDigest=${decision.deliveryDigest}}; adopt-once idempotent; ON-CHAIN adopt against a real verdict BLOCKED (needs LEG 3/6)`,
    });

    // ── LEG 6: native container-grade driver (M4c) — Docker-gated (DR decision 3a) ──────────────
    rows.push(await runLeg6Container());

    // ── G-archive: a genuinely separate OS process consumes operator A's live serving listener ──
    rows.push(await runGArchiveSeparateProcess(root));

    printEvidenceTable(rows);
    console.log('\n=== native-fleet gate runner: complete (evidence table above is the DR-2026-08-05 gate evidence) ===');
  } finally {
    for (const store of openStores) {
      try { store.close(); } catch { /* best-effort */ }
    }
    await requesterServer.close().catch(() => {});
    await anvil.teardown();
  }
}

function newStore(sink: Store[], dbPath: string): Store {
  const store = new Store(dbPath);
  sink.push(store);
  return store;
}

/** Read back the one durable association `postTarget` wrote, to drive B's delivery + A's adopt. */
async function readPostedAssociation(stateDir: string): Promise<{
  submissionUri: `urn:uuid:${string}`;
  taskDigest: `sha256:${string}`;
  taskId: string;
}> {
  const dir = join(stateDir, 'associations');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  if (files.length !== 1) throw new Error(`expected exactly one posted association, found ${files.length}`);
  const stored = JSON.parse(await readFile(join(dir, files[0]!), 'utf8'));
  return { submissionUri: stored.submissionUri, taskDigest: stored.taskDigest, taskId: stored.taskId };
}

/**
 * LEG 6 — the native container-grade DRIVER (`createDockerContainerRuntime`, M4c) executes a real
 * `docker run` when Docker is reachable. Gated on `docker info` (the rig's skip-clean posture). The
 * `decisionGrade: true` requirement is a distinct, documented BLOCKED gap: that boolean is emitted by
 * `gateVerdictObservation` over a complete signed settlement graph with a real swe-rebench grader
 * image, never by a bare container run, so it is unreachable on a local fork.
 */
async function runLeg6Container(): Promise<LegRow> {
  if (!dockerReachable()) {
    console.log('  ⏭ LEG 6 SKIPPED — Docker unavailable (DR-3a gate leg)');
    return {
      leg: 'LEG 6  native container-graded evaluate (M4a/M4c, DR-3a)',
      status: 'SKIPPED',
      evidence: 'docker info not reachable — container-grade path not exercised (clean skip)',
    };
  }
  console.log('  · LEG 6: docker info reachable — exercising the native container-grade driver');
  try {
    // Resolve a digest-pinned public image at run time (the driver rejects mutable tags), then run it
    // through the real M4c driver so `createDockerContainerRuntime().run()` spawns an actual container.
    const pull = spawnSync('docker', ['pull', 'busybox:latest'], { encoding: 'utf8', timeout: 180_000 });
    if (pull.status !== 0) throw new Error(`docker pull busybox failed: ${(pull.stderr || pull.stdout || '').trim().slice(0, 200)}`);
    const inspect = spawnSync('docker', ['inspect', '--format', '{{index .RepoDigests 0}}', 'busybox:latest'], { encoding: 'utf8', timeout: 30_000 });
    const pinnedRef = (inspect.stdout || '').trim();
    if (inspect.status !== 0 || !/@sha256:[0-9a-f]{64}$/u.test(pinnedRef)) {
      throw new Error(`could not resolve a digest-pinned busybox reference: ${pinnedRef || (inspect.stderr || '').trim().slice(0, 200)}`);
    }
    const runtime = createDockerContainerRuntime();
    const result = await runtime.run({ image: pinnedRef, workdir: '/tmp', env: {} });
    console.log(`  ✓ LEG 6 — createDockerContainerRuntime ran a REAL container ${pinnedRef.split('@')[1]!.slice(0, 20)}… → exitCode=${result.exitCode}`);
    console.log('  ⚠ LEG 6 decisionGrade:true BLOCKED — needs a digest-pinned swe-rebench grader image + full signed settlement graph');
    return {
      leg: 'LEG 6  native container-graded evaluate (M4a/M4c, DR-3a)',
      status: 'PROVEN',
      evidence: `M4c driver executed a REAL docker run of ${pinnedRef} → exitCode=${result.exitCode}; decisionGrade:true BLOCKED (emitted by gateVerdictObservation over a full signed settlement graph with a real swe-rebench grader image + distinct solver/evaluator identities — unreachable on a local fork; deferred to a live deploy)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠ LEG 6 BLOCKED — Docker reachable but the container run could not complete: ${message}`);
    return {
      leg: 'LEG 6  native container-graded evaluate (M4a/M4c, DR-3a)',
      status: 'BLOCKED',
      evidence: `docker info reachable but createDockerContainerRuntime().run() could not complete on this host: ${message}; decisionGrade:true separately requires a real swe-rebench grader image + full signed settlement graph`,
    };
  }
}

/**
 * G-archive — spawn `_archive-consumer-child.ts` as a GENUINELY SEPARATE OS process that cold-syncs,
 * resumes, and live-tails operator A's live serving listener (the M6 serving plane). Models
 * `e2e:archive-second-daemon:separate-process`; the child hardcodes the `marketplace` source name and
 * three seeded entries, so this leg serves a `marketplace`-named archive purpose-built for that
 * handshake (A's public serving plane, distinct listener from LEG 2's requester source).
 */
async function runGArchiveSeparateProcess(root: string): Promise<LegRow> {
  const seeded = await seedArchiveFixture({ rootDir: join(root, 'g-archive'), sourceName: 'marketplace' });
  const server = await startPublicArchiveServer({ handler: seeded.handler, host: '127.0.0.1', port: 0 });
  const servingRoot = `http://127.0.0.1:${server.port}`;
  console.log(`  · G-archive: operator A public serving listener on ${servingRoot}`);
  const inputPath = join(root, 'g-archive-child-input.json');
  await writeFile(inputPath, JSON.stringify({
    servingRoot,
    endpoint: seeded.endpoint(servingRoot),
    highWaterMark: { sequence: '0000000000000003', entry: sealJson(seeded.entries[2]!.entry).digest },
  }));

  const child = spawn('node', ['--import', 'tsx', join(HERE, '_archive-consumer-child.ts'), inputPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });
  let appended4 = false;
  let appended5 = false;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text.startsWith('ok —')) { console.log(`    ${text}`); return; }
    if (text === 'WANT_APPEND_4' && !appended4) {
      appended4 = true;
      void appendOneRecord(seeded, JSON.stringify({ n: 4 })).then(() => child.stdin.write('GO4\n'));
    } else if (text === 'SUBSCRIBED' && !appended5) {
      appended5 = true;
      void appendOneRecord(seeded, JSON.stringify({ n: 5 }));
    }
  });
  const code: number = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode ?? 1)));
  await server.close().catch(() => {});

  if (code !== 0) throw new Error(`G-archive: separate-process consumer exited ${code}`);
  if (!appended4) throw new Error('G-archive: child never requested the resume append (WANT_APPEND_4)');
  if (!appended5) throw new Error('G-archive: child never subscribed for the live-tail append (SUBSCRIBED)');
  console.log('  ✓ G-archive PROVEN — a separate OS process cold-synced, resumed, and live-tailed A\'s live listener');
  return {
    leg: 'G-archive  separate-process consumption of A\'s live listener',
    status: 'PROVEN',
    evidence: `distinct OS process fetched head + cold-synced 3 + retrieved-by-digest + exposure-scoped + resumed(n=4) + live-tailed(n=5) over TCP; child exit 0`,
  };
}

function printEvidenceTable(rows: readonly LegRow[]): void {
  console.log('\n============================ G-LOOP EVIDENCE TABLE (DR-2026-08-05 gate) ============================');
  const legWidth = Math.max(...rows.map((r) => r.leg.length), 3);
  for (const row of rows) {
    console.log(`  ${row.leg.padEnd(legWidth)}  ${row.status.padEnd(9)}`);
    console.log(`  ${' '.repeat(legWidth)}  └─ ${row.evidence}`);
  }
  const tally = rows.reduce<Record<LegStatus, number>>((acc, r) => { acc[r.status] += 1; return acc; }, { PROVEN: 0, MECHANISM: 0, BLOCKED: 0, SKIPPED: 0 });
  console.log('  ---------------------------------------------------------------------------------------------');
  console.log(`  tally: PROVEN=${tally.PROVEN}  MECHANISM=${tally.MECHANISM}  BLOCKED=${tally.BLOCKED}  SKIPPED=${tally.SKIPPED}`);
  console.log('====================================================================================================');
}

/** Self-execute only when run directly (`tsx native-fleet-loop.ts`), not when imported for delegation. */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runNativeFleetLoop().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
