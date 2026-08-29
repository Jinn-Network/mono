/**
 * Hermetic gate — the staking-activity proof, re-homed onto the NATIVE evaluator (issue #2666).
 *
 * Spec: spec/2026-06-30-tokenless-olas-native.md (OLAS staking activity IS the reward path) and
 * docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md §3.1 / §6 Home 1.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Under DR-2026-06-30 the reward path is on-chain OLAS staking activity, and
 * `JinnRouterV3.claimVerdictDelivery` is the ONLY call that credits it
 * (`contracts/src/staking/JinnRouterV3.sol` — `claimSolutionDelivery` explicitly does not).
 * The activity-counter assertion used to ride on the legacy `_runEngineWatcherLoop` verdict leg,
 * deleted in Wave-4 D1 (#2655), which left `test/hermetic/full-loop.test.ts` correctly scoped to
 * the SOLUTION leg only and left the reward path with no hermetic proof at all. This gate restores
 * that proof on the ratified replacement: the native evaluator's settlement state machine.
 *
 * WHAT IS REAL HERE (the proof)
 * -----------------------------
 *  - Anvil loaded from the committed `--dump-state` snapshot — real V3 bytecode, no live RPC.
 *  - TWO staked operators bootstrapped by the real `FleetBootstrapper`: a solver and a separate
 *    evaluator. Two operators is not decoration — `mapFinalizedSolutionDeliveryObservation`
 *    (`src/evaluator/opportunities.ts`) SKIPS self-evaluation, so the native evaluator can only
 *    ever evaluate another operator's delivery.
 *  - The production `Daemon` drives the whole solution leg: discover -> claim -> deterministic
 *    `prediction-v1-baseline` harness -> envelope upload -> on-chain deliver ->
 *    `SolutionDeliveryClaimed` on the locally-deployed V3 router.
 *  - The native evaluator's REAL settlement state machine (`NativeEvaluatorCoordinator`) driven by
 *    the REAL `EvaluatorLoop`, over:
 *      * REAL production `VerdictPorts` (`createVerdictPorts` over a real `createSafeBroadcaster`)
 *        bound to the evaluator's Safe, its own mech, and the locally-deployed router — so
 *        `claimEvaluation` / `deliverToMarketplace` / `claimVerdictDelivery` are real Safe-executed
 *        transactions, not fakes;
 *      * REAL native identity stores (`openRoleIdentitySet`, the `evaluator-*` role family) backed
 *        by a real encrypted keystore on disk;
 *      * the REAL committed prediction-evaluator deployment registration, pinned by its committed
 *        module + evaluation-method digests;
 *      * the REAL signed-source publisher (`openNativeEvaluatorPublisher`) signing with the
 *        evaluator-discovery role key;
 *      * REAL chain reads for finality/transaction reconciliation against the loaded snapshot.
 *  - The assertion: `TaskActivityCheckerV3.eligibleActivityWeight` increments for BOTH Safes —
 *    the solver's (credited at attempt finalization inside `claimVerdictDelivery`) and the
 *    evaluator's (credited by `recordVerdictDelivery`).
 *
 * WHAT THIS RIG SEEDS RATHER THAN PROVES (be honest; see the leg table this prints)
 * --------------------------------------------------------------------------------
 * The native evaluator's INGESTION half consumes signed `.well-known` public record sources served
 * by the solver and requester, and its subject-authority / verdict-verification gates verify the
 * DSSE ceremony behind them. A hermetic rig cannot self-provide that serving plane — the same
 * boundary `test/e2e/native-fleet-loop.ts` draws when it labels LEG 2-7 SEEDED / DEPLOY-TIME. So
 * this rig seeds the durable evaluation aggregate directly from the REAL on-chain
 * `SolutionDeliveryClaimed` facts and supplies deterministic stand-ins for the subject-authority
 * claim, the verdict gate, and the grading backend. Everything downstream of that — claim,
 * publication, marketplace delivery, settlement, activity credit — is the real code on a real
 * chain. Restoring the ingestion half hermetically is the native G-loop's own program, not this
 * gate's.
 *
 * SKIP-CLEAN when the committed fixture is absent (the gate asserts its presence separately).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { BindingResolver, ResolvedBinding } from '@jinn-network/trust-core';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
} from '@jinn-network/task-execution-protocol';
import {
  createBroadcastLock,
  createSafeBroadcaster,
  createSubmissionLedger,
  createVerdictPorts,
  openVenueState,
} from '@jinn-network/marketplace-venue-base';
import { Store } from '../../src/store/store.js';
import { EvaluatorLoop } from '../../src/daemon/evaluator-loop.js';
import { NativeEvaluatorCoordinator } from '../../src/daemon/native-evaluator-coordinator.js';
import { NativeEvaluatorStateRepository } from '../../src/daemon/native-evaluator-state.js';
import { openNativeEvaluatorPublisher } from '../../src/daemon/native-evaluator-publisher.js';
import { openRoleIdentitySet } from '../../src/daemon/role-identities.js';
import {
  predictionEvaluatorMethodDigest,
  predictionEvaluatorModuleDigest,
} from '../../src/native-evaluator/deployment-paths.js';
import {
  setupAnvilFixtureFromState,
  bootstrapStakedOperator,
  deployMinimalV3Stack,
  deployOperatorMech,
  startDaemon,
  startMockIpfsServer,
  postPredictionV1Task,
  waitForDaemonClaim,
  waitForDelivery,
  waitForSolutionSettlement,
  waitForVerdict,
  readActivityCount,
  ANVIL_PRIVATE_KEYS,
  type BootstrappedOperator,
  type DaemonHarnessFixture,
  type HarnessSelector,
} from '../e2e/_daemon-harness-helpers.js';
import { jsonRpc as anvilJsonRpc } from '../_support/chain/anvil.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(TEST_DIR, '..', '_support', 'fixtures', 'anvil-base-v3-state');
const SNAPSHOT_STATE = join(SNAPSHOT_DIR, 'state.json');

const SNAPSHOT_PRESENT = existsSync(SNAPSHOT_STATE) || existsSync(SNAPSHOT_DIR);
const describeMaybe = SNAPSHOT_PRESENT ? describe : describe.skip;

if (!SNAPSHOT_PRESENT) {
  // eslint-disable-next-line no-console
  console.error(
    `[hermetic] snapshot fixture absent at ${SNAPSHOT_STATE} — skipping native-evaluator activity ` +
      `suite. Run \`tsx contracts/scripts/build-anvil-snapshot.ts\` (needs BASE_RPC_URL) and commit ` +
      `the fixture to exercise this scenario.`,
  );
}

/** Deterministic: needs no API key and no network (the loop is under test, not the agent). */
const HARNESS: HarnessSelector = 'prediction-v1-baseline';
const EVALUATOR_AGENT = 'urn:jinn:evaluator:hermetic-native-activity-rig';
const EVALUATOR_PASSWORD = 'hermetic-native-evaluator-rig-password';
const EVALUATOR_SIGNER_HANDLE = 'prediction-market-evaluator-verdict';
/**
 * Finality depth the rig's chain port applies. An Anvil state fixture leaves the `finalized` tag
 * pinned at the loaded tip, so a depth rule over `latest` is the only honest local reading — the
 * same shape venue-base's own `chain-log-source` falls back to on a fork.
 */
const LOCAL_FINALITY_DEPTH = 64n;

/**
 * Every scope a native evaluator role can require. The rig resolves bindings deterministically:
 * the DSSE ceremony behind a real catalog is a serving-plane leg this gate seeds (see header).
 */
function binding(key: string): ResolvedBinding {
  return {
    binding: {
      key: { didKey: key, keyid: key },
      scope: [
        'authorizations', 'observations', 'deliveries', 'verdicts', 'settlements',
        'jinn:discovery-announcements',
      ],
      validFrom: '2026-01-01T00:00:00.000Z',
    },
    effectiveStart: '2026-01-01T00:00:00.000Z',
    revocations: [],
  } as ResolvedBinding;
}

function artifactOf(name: string, bytes: Uint8Array) {
  return { name, bytes, digest: documentDigest(bytes) };
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Durable evaluation rows carry bigint chain fields, which `JSON.stringify` refuses outright. */
function describeRow(row: unknown): string {
  return JSON.stringify(row, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value);
}

function printLegTable(): void {
  // eslint-disable-next-line no-console
  console.log('\nNative-evaluator activity rig — leg status:');
  const rows: Array<[string, string]> = [
    ['LEG 0  snapshot Anvil + locally-deployed V3 stack', 'PROVEN-hermetic'],
    ['LEG 1  two staked operators (real FleetBootstrapper)', 'PROVEN-hermetic'],
    ['LEG 2  solution leg via the production Daemon (claim -> deliver -> settle)', 'PROVEN-hermetic'],
    ['LEG 3  native evaluator identity stores (openRoleIdentitySet)', 'PROVEN-hermetic'],
    ['LEG 4  committed prediction-evaluator deployment registration digests', 'PROVEN-hermetic'],
    ['LEG 5  NativeEvaluatorCoordinator + EvaluatorLoop settlement state machine', 'PROVEN-hermetic'],
    ['LEG 6  real VerdictPorts: claimEvaluation -> deliver -> claimVerdictDelivery', 'PROVEN-hermetic'],
    ['LEG 7  eligibleActivityWeight credit for solver + evaluator Safes', 'PROVEN-hermetic'],
    ['LEG 8  signed .well-known record-source ingestion (opportunity discovery)', 'SEEDED (deploy-time serves it live)'],
    ['LEG 9  DSSE subject-authority + verdict gate over a live trust catalog', 'SEEDED (deploy-time verifies it)'],
    ['LEG 10 container-graded evaluation (swe-rebench-v2)', 'DEPLOY-TIME (Docker; DR decision 3a)'],
  ];
  for (const [leg, status] of rows) {
    // eslint-disable-next-line no-console
    console.log(`  - ${leg}: ${status}`);
  }
}

describeMaybe('hermetic native-evaluator verdict settlement credits staking activity (#2666)', () => {
  it(
    'claim -> deliver -> native verdict settlement -> eligibleActivityWeight, on the snapshot',
    async () => {
      const fixture = await setupAnvilFixtureFromState(SNAPSHOT_STATE);
      const mockIpfs = await startMockIpfsServer();
      const rigRoot = await mkdtemp(join(tmpdir(), 'jinn-native-evaluator-activity-'));
      let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
      let evaluatorStore: Store | undefined;
      let venueState: ReturnType<typeof openVenueState> | undefined;
      let publisher: Awaited<ReturnType<typeof openNativeEvaluatorPublisher>> | undefined;

      try {
        // ── LEG 1: two staked operators on the loaded snapshot state ──────────────────────
        const solver = await bootstrapStakedOperator(fixture);
        const evaluator = await bootstrapStakedOperator(fixture);
        expect(solver.safeAddress.toLowerCase()).not.toBe(evaluator.safeAddress.toLowerCase());

        const DEPLOYER_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
        const CREATOR_PRIV_KEY = ANVIL_PRIVATE_KEYS[0]!;
        const deployerAddress = privateKeyToAccount(DEPLOYER_PRIV_KEY).address;
        await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
          deployerAddress,
          '0x56bc75e2d63100000', // 100 ETH
        ]);

        // ── LEG 0: one V3 stack; the evaluator gets its own mech on the same router so the
        //          router's `claimEvaluation` operator check passes for its Safe. ───────────
        const v3Env = await deployMinimalV3Stack(fixture, solver, DEPLOYER_PRIV_KEY);
        const evaluatorV3 = await deployOperatorMech(fixture, evaluator, v3Env, DEPLOYER_PRIV_KEY);

        // The bootstrapper funds an agent EOA for the bootstrap tx only; both daemons/ports run a
        // longer tx stream than that.
        for (const op of [solver, evaluator]) {
          await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_setBalance', [
            op.agentAddress,
            '0x56bc75e2d63100000', // 100 ETH
          ]);
        }

        // The dump-state fixture retains its tip but not arbitrary predecessor blocks. Mine a
        // local finality buffer so the compatibility projector never requests pre-snapshot data.
        await fixture.anvil.mineBlocks(130);

        // ── LEG 2: the production Daemon drives the whole solution leg ────────────────────
        running = await startDaemon(
          fixture,
          solver,
          HARNESS,
          mockIpfs.baseUrl, // ipfsGatewayUrl (task fetch)
          v3Env,
          mockIpfs.baseUrl, // ipfsRegistryUrl (envelope upload)
          { enableComposition: true, instanceLabel: 'solver' },
        );

        const posted = await postPredictionV1Task(fixture, solver, CREATOR_PRIV_KEY, mockIpfs, v3Env);
        expect(posted.taskId, 'task was not posted').toBeGreaterThan(0n);

        const claim = await waitForDaemonClaim(fixture, posted, solver, v3Env);
        expect(claim.requestId, 'daemon did not claim the task').toMatch(/^0x[0-9a-fA-F]+$/);

        const delivered = await waitForDelivery(fixture, claim, v3Env, mockIpfs);
        expect(delivered.deliveryTxHash, 'no on-chain delivery tx').toMatch(/^0x[0-9a-fA-F]+$/);

        const settlement = await waitForSolutionSettlement(fixture, claim, solver, v3Env);
        expect(settlement.requestId.toLowerCase()).toBe(claim.requestId.toLowerCase());
        expect(settlement.operator.toLowerCase()).toBe(solver.safeAddress.toLowerCase());

        // Baseline AFTER the solution settled and BEFORE any verdict: the tokenless-OLAS
        // loop-completion gate means solution delivery alone must not have credited anything.
        const solverActivityBefore = await readActivityCount(fixture, solver, v3Env);
        const evaluatorActivityBefore = await readActivityCount(fixture, evaluator, v3Env);

        // ── LEG 3-6: the native evaluator over real verdict ports ────────────────────────
        const rig = await buildNativeEvaluatorRig({
          fixture,
          evaluator,
          rigRoot,
          routerAddress: v3Env.routerAddress,
          mechAddress: evaluatorV3.mockMechAddress,
          solutionSettlementTxHash: settlement.txHash,
          solverSafeAddress: solver.safeAddress,
          solutionRequestId: claim.requestId,
          taskId: settlement.taskId,
          attemptIndex: settlement.attemptIndex,
        });
        evaluatorStore = rig.store;
        venueState = rig.venueState;
        publisher = rig.publisher;

        // The REAL loop drives the REAL coordinator. Each pass advances one phase and needs the
        // preceding transaction buried past the rig's finality depth, so the rig mines between
        // ticks exactly as wall-clock block production would.
        const loop = new EvaluatorLoop({
          composition: rig.composition,
          store: rig.store,
          pollIntervalMs: 50,
        });
        const deadline = Date.now() + 180_000;
        let complete = false;
        while (Date.now() < deadline && !complete) {
          await loop.tick();
          complete = rig.state.getEvaluation(rig.evaluationId)?.state === 'complete';
          if (!complete) {
            await anvilJsonRpc(fixture.anvil.rpcUrl, 'anvil_mine', ['0x41']); // 65 blocks
          }
        }
        const finalRow = rig.state.getEvaluation(rig.evaluationId);
        expect(finalRow?.state, `evaluation did not complete: ${describeRow(finalRow)}`)
          .toBe('complete');

        // ── LEG 6: the verdict really settled on the locally-deployed router ──────────────
        const verdict = await waitForVerdict(fixture, posted, evaluator, v3Env, 60_000);
        expect(verdict.taskId).toBe(posted.taskId);
        expect(verdict.evaluator.toLowerCase()).toBe(evaluator.safeAddress.toLowerCase());

        // ── LEG 7: the reward path — activity credit for both Safes ───────────────────────
        const solverActivityAfter = await readActivityCount(fixture, solver, v3Env);
        const evaluatorActivityAfter = await readActivityCount(fixture, evaluator, v3Env);
        expect(
          solverActivityAfter,
          `solver activity did not increment (before=${solverActivityBefore} after=${solverActivityAfter})`,
        ).toBeGreaterThan(solverActivityBefore);
        expect(
          evaluatorActivityAfter,
          `evaluator activity did not increment (before=${evaluatorActivityBefore} after=${evaluatorActivityAfter})`,
        ).toBeGreaterThan(evaluatorActivityBefore);

        printLegTable();
      } finally {
        if (running) { try { await running.stop(); } catch { /* best-effort */ } }
        if (publisher) { try { await publisher.close(); } catch { /* best-effort */ } }
        if (evaluatorStore) { try { evaluatorStore.close(); } catch { /* best-effort */ } }
        if (venueState) { try { venueState.close(); } catch { /* best-effort */ } }
        try { await mockIpfs.close(); } catch { /* best-effort */ }
        try { await fixture.teardown(); } catch { /* best-effort */ }
        try { await rm(rigRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
    240_000,
  );
});

interface NativeEvaluatorRigInput {
  readonly fixture: DaemonHarnessFixture;
  readonly evaluator: BootstrappedOperator;
  readonly rigRoot: string;
  readonly routerAddress: Address;
  readonly mechAddress: Address;
  readonly solutionSettlementTxHash: Hex;
  readonly solverSafeAddress: Address;
  readonly solutionRequestId: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
}

/**
 * Assembles the native evaluator over the locally-deployed V3 stack.
 *
 * Real: the identity store, the committed deployment-registration digests, the signed-source
 * publisher, the venue Safe broadcaster + `VerdictPorts`, the chain reads, and the coordinator.
 * Seeded: the opportunity (from the REAL on-chain settlement facts), the subject material, the
 * subject-authority claim, the verdict gate, and the grading backend — see the file header.
 */
async function buildNativeEvaluatorRig(input: NativeEvaluatorRigInput) {
  const { fixture, evaluator, rigRoot } = input;
  const publicClient = fixture.publicClient;

  // ── LEG 3: real native identity stores for the evaluator role family ───────────────────
  const bindingResolver: BindingResolver = { resolveBinding: async (query) => binding(query.key) };
  const roles = await openRoleIdentitySet({
    agent: EVALUATOR_AGENT,
    requiredRoles: ['evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery'],
    storePath: join(rigRoot, 'identity', 'evaluator-roles.enc.json'),
    password: EVALUATOR_PASSWORD,
    bindingResolver,
  });

  // ── LEG 4: the committed prediction-evaluator deployment registration, pinned by digest ──
  // The rig does not spawn the grading child (LEG 9/10 are seeded), but the deployment identity
  // this operator would settle under is the real committed one, read from the real bytes.
  const deploymentModuleDigest = await predictionEvaluatorModuleDigest();
  const evaluationMethodDigest = await predictionEvaluatorMethodDigest();
  expect(deploymentModuleDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(evaluationMethodDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

  // ── LEG 6: REAL production verdict ports over a REAL Safe broadcaster ──────────────────
  const venueState = openVenueState(join(rigRoot, 'venue-state.sqlite'));
  const walletClient = createWalletClient({
    account: privateKeyToAccount(evaluator.agentPrivateKey),
    chain: base,
    transport: http(fixture.anvil.rpcUrl),
  });
  const broadcaster = createSafeBroadcaster({
    chainId: base.id,
    safeAddress: evaluator.safeAddress as Address,
    publicClient,
    walletClient,
    ledger: createSubmissionLedger(venueState),
    lock: createBroadcastLock(venueState),
  });
  const verdictPorts = createVerdictPorts({
    publicClient,
    broadcaster,
    safeAddress: evaluator.safeAddress as Address,
    routerAddress: input.routerAddress,
    mechAddress: input.mechAddress,
  });

  // ── The durable evaluator aggregate, seeded from the REAL on-chain settlement facts ─────
  const store = new Store(join(rigRoot, 'evaluator.sqlite'));
  const state = new NativeEvaluatorStateRepository(store);
  const settlementReceipt = await publicClient.getTransactionReceipt({
    hash: input.solutionSettlementTxHash,
  });

  const subjectResult = utf8(JSON.stringify({ probabilityYes: '0.750000' }));
  const subjectTask = utf8(JSON.stringify({ marketId: 'hermetic-native-activity-rig' }));
  const subjectDelivery = utf8('hermetic-rig-solution-delivery');
  const material = {
    task: artifactOf('task', subjectTask),
    submission: artifactOf('submission', utf8('hermetic-rig-subject-submission')),
    requesterEnvelope: artifactOf('requester-envelope', utf8('hermetic-rig-requester-envelope')),
    admissionReceipt: artifactOf('admission-receipt', utf8('hermetic-rig-admission-receipt')),
    delivery: artifactOf('delivery', subjectDelivery),
    deliveryEnvelope: artifactOf('delivery-envelope', utf8('hermetic-rig-delivery-envelope')),
    evidenceRecords: [artifactOf('solution-evidence', utf8('hermetic-rig-solution-evidence'))],
    results: [artifactOf('result.json', subjectResult)],
    evaluationSpec: artifactOf('evaluation-spec', utf8('hermetic-rig-evaluation-spec')),
  };

  const admitted = state.admitOpportunity({
    opportunity: {
      source: 'urn:jinn:solver:hermetic-native-activity-rig/solver-records',
      sourceSequence: '0000000000000001',
      sourceEntryDigest: documentDigest(utf8('hermetic-rig-source-entry')),
      canonical: true,
      finality: 'finalized',
      chainId: base.id,
      taskId: input.taskId,
      attemptIndex: input.attemptIndex,
      solutionRequestId: input.solutionRequestId,
      operatorAddress: input.solverSafeAddress,
      deliveryCid: 'bafy-hermetic-rig-solution',
      advertisedDeliveryDigest: material.delivery.digest,
      blockHash: settlementReceipt.blockHash,
      blockNumber: settlementReceipt.blockNumber,
      transactionHash: input.solutionSettlementTxHash,
      logIndex: 0,
      canonicalEventIdentity: `${base.id}:${settlementReceipt.blockHash}:0`,
    },
    evaluatorAgent: EVALUATOR_AGENT,
    coordinator: input.routerAddress,
    material,
  });

  // The subject-authority claim a live trust catalog would produce (LEG 9, seeded).
  state.recordAdmissionVerified(admitted.evaluationId, {
    requester: { signerKey: 'did:key:hermetic-rig-requester', sealingTime: '2026-01-01T00:00:00.000Z' },
    admission: { signerKey: 'did:key:hermetic-rig-admission', effectiveTime: '2026-01-01T00:00:00.000Z' },
    executor: {
      signerKey: 'did:key:hermetic-rig-solver',
      agent: 'urn:jinn:solver:hermetic-native-activity-rig',
      declarationKey: 'did:key:hermetic-rig-solver-declaration',
      effectiveTime: '2026-01-01T00:00:00.000Z',
      address: input.solverSafeAddress,
    },
    evaluator: {
      signerKey: roles.get('evaluator-verdict').keyId,
      agent: EVALUATOR_AGENT,
      declarationKey: roles.get('evaluator-settlement').keyId,
      address: evaluator.safeAddress,
    },
    verificationDigest: documentDigest(utf8('hermetic-rig-subject-authority-verification')),
  });

  const evaluationTaskBytes = utf8(JSON.stringify({
    evaluation: 'hermetic-native-activity-rig',
    subjectTask: material.task.digest,
    subjectDelivery: material.delivery.digest,
    evaluationMethodDigest,
  }));
  const evaluationTaskDigest = documentDigest(evaluationTaskBytes);
  const submissionUri = `urn:uuid:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}` as const;
  const submissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: submissionUri,
    task: { digest: { sha256: evaluationTaskDigest.slice('sha256:'.length) } },
    requester: EVALUATOR_AGENT,
    idempotencyKey: admitted.evaluationId,
    nonce: admitted.evaluationId,
    deadline: '2099-01-01T00:00:00.000Z',
  });
  state.recordDerivedEvaluation(admitted.evaluationId, {
    taskBytes: evaluationTaskBytes,
    taskDigest: evaluationTaskDigest,
    submissionBytes,
    submissionDigest: documentDigest(submissionBytes),
    submissionUri,
  });

  // ── The seeded grading backend (LEG 9/10): a deterministic verdict, sealed the real way ──
  const verdictBytes = utf8(JSON.stringify({
    predicate: { verdict: 'pass', evaluator: { id: EVALUATOR_AGENT }, signerHandle: EVALUATOR_SIGNER_HANDLE },
  }));
  const evidenceBytes = utf8('hermetic-rig-evaluation-evidence');
  let deliveryBytes = new Uint8Array();
  const backend = {
    recover: async () => ({ classification: 'absent' as const }),
    submit: async (_task: Uint8Array, _submission: Uint8Array, engagement?: { attemptUri: string }) => {
      deliveryBytes = sealDelivery({
        protocol: TASK_EXECUTION_PROTOCOL_URI,
        attempt: engagement!.attemptUri as `urn:uuid:${string}`,
        task: evaluationTaskDigest,
        outputs: [{ name: 'verdict', digest: { sha256: documentDigest(verdictBytes).slice('sha256:'.length) } }],
        evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(evidenceBytes) }],
        outcome: 'fulfilled',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      return { accepted: true } as never;
    },
    observe: async () => ({ descriptor: { derived: { terminal: true, state: 'delivered' } } }) as never,
    deliveries: async () => [{ digest: documentDigest(deliveryBytes), uri: 'memory:delivery' }] as never,
    fetchDelivery: async () => deliveryBytes,
    fetchArtifact: async () => verdictBytes,
    capabilities: async () => ({}) as never,
  };

  // ── LEG 3: the REAL signed-source publisher, signing with the evaluator-discovery key ────
  const publisher = await openNativeEvaluatorPublisher({
    rootDir: join(rigRoot, 'public', 'evaluator'),
    publicBaseUrl: 'https://evaluator.hermetic.invalid/native',
    source: { agent: EVALUATOR_AGENT, name: 'evaluator-records' },
    signer: roles.get('evaluator-discovery'),
  });

  const coordinator = new NativeEvaluatorCoordinator({
    state,
    backend: backend as never,
    // Persisted above by `recordAdmissionVerified`, so this is never reached on the happy path.
    authority: {
      claim: async () => { throw new Error('subject authority was already persisted by the rig'); },
      dependencies: {} as never,
    },
    deadline: () => new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    evaluatorAddress: evaluator.safeAddress as `0x${string}`,
    verdictPorts,
    // REAL chain reads against the loaded snapshot.
    chain: {
      isFinalized: async (transaction) =>
        (await publicClient.getBlockNumber()) >= transaction.blockNumber + LOCAL_FINALITY_DEPTH,
      transactionStatus: async (txHash) => {
        const receipt = await publicClient
          .getTransactionReceipt({ hash: txHash })
          .catch(() => undefined);
        return receipt === undefined ? { kind: 'pending' as const } : { kind: 'canonical' as const };
      },
    },
    deliverySignature: { get: () => utf8('hermetic-rig-evaluation-delivery-envelope') },
    evidence: {
      awaitIndexed: async () => ({ status: 'indexed' }),
      getRecord: async () => evidenceBytes,
    },
    publisher,
    // LEG 9 (seeded): a live catalog's decision-grade gate. Pass(1) so the settled verdict code is
    // the one a resolved market would produce.
    verification: { verify: async () => ({ ok: true as const, verdictCode: 1 as const }) },
    retry: { delayMs: 10, maxDelayMs: 100 },
  });

  return {
    store,
    state,
    venueState,
    publisher,
    evaluationId: admitted.evaluationId,
    /**
     * The `NativeEvaluatorComposition` surface `EvaluatorLoop` drives. The loop is the real one;
     * the ingestion half of `tick()` (the signed-source read) is LEG 8, seeded — the rig admitted
     * the opportunity directly, so a tick is exactly the recovery/advance pass.
     */
    composition: {
      tick: async () => ({ sourceEvents: 0, coordinator: await coordinator.reconcileStartup() }),
    } as never,
  };
}
