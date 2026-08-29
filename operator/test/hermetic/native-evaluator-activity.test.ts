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
 *  - The REAL native evaluator composition (`buildNativeEvaluatorComposition`) driven by the REAL
 *    `EvaluatorLoop`, over:
 *      * REAL native identity stores (`openRoleIdentitySet`, the `evaluator-*` role family) backed
 *        by a real encrypted keystore on disk;
 *      * the REAL committed prediction-evaluator deployment registration — the composition loads
 *        `deployments/evaluator/prediction-market-deployment.mjs`, re-hashes its bytes, and refuses
 *        any disagreement between the configured agent / signer handle / evaluation-method digest
 *        and what the registration declares;
 *      * the REAL local task-execution backend, which spawns the real evaluation-harness child to
 *        grade the subject material and seals its Delivery with the evaluator-verdict role key;
 *      * the REAL signed-source publisher, signing the six announced records with the
 *        evaluator-discovery role key;
 *      * REAL production `VerdictPorts` (`createVerdictPorts` over a real `createSafeBroadcaster`)
 *        bound to the evaluator's Safe, its own mech, and the locally-deployed router — so
 *        `claimEvaluation` / `deliverToMarketplace` / `claimVerdictDelivery` are real Safe-executed
 *        transactions, not fakes;
 *      * REAL chain reads for finality/transaction reconciliation against the loaded snapshot.
 *
 *    The market is unresolved by construction (`native-evaluation-context.ts` stamps every native
 *    prediction context `unresolved`), so the honest verdict is `inconclusive`. That is the full
 *    proof of the reward path regardless: `claimVerdictDelivery` credits activity on attempt
 *    finalization for ANY verdict code — the loop-completion gate, not a verdict-quality gate.
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
 * this rig admits the evaluation directly from the REAL on-chain `SolutionDeliveryClaimed` facts
 * over a rig-sealed subject document graph, and stands in for the subject-authority claim and the
 * decision-grade NAMED verdict gate. `verifyExactGraph` — the exact delivery/verdict/evidence join
 * around that gate — is not stood in and runs on every phase. Everything downstream — derivation,
 * claim, grading, publication, marketplace delivery, settlement, activity credit — is the real
 * code on a real chain. Restoring the ingestion half hermetically is the native G-loop's own
 * program, not this gate's.
 *
 * SKIP-CLEAN when the committed fixture is absent (the gate asserts its presence separately).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  sealTask,
} from '@jinn-network/task-execution-protocol';
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  buildEvaluationTaskProfile,
  sealEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  PREDICTION_PARSER,
  predictionEvaluationSpecMeasurements,
  predictionEvaluationSpecVerdictRule,
} from '@jinn-network/task-execution-evaluator-adapters';
import { ADMISSION_RECEIPT_ANNOTATION_URI } from '@jinn-network/marketplace-binding';
import {
  createBroadcastLock,
  createSafeBroadcaster,
  createSubmissionLedger,
  createVerdictPorts,
  openVenueState,
} from '@jinn-network/marketplace-venue-base';
import { Store } from '../../src/store/store.js';
import { EvaluatorLoop } from '../../src/daemon/evaluator-loop.js';
import { buildNativeEvaluatorComposition } from '../../src/daemon/native-evaluator-composition.js';
import { NativeEvaluatorStateRepository } from '../../src/daemon/native-evaluator-state.js';
import {
  buildNativeWorkspaceRuntime,
  buildPinnedNodeLauncherDeployment,
} from '../../src/daemon/native-solver-backend.js';
import { openOperatorEvidence } from '../../src/daemon/evidence-join.js';
import { openRoleIdentitySet } from '../../src/daemon/role-identities.js';
import {
  PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH,
  PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH,
  predictionEvaluatorMethodDigest,
  predictionEvaluatorModuleDigest,
  writePredictionEvaluatorSidecar,
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

/** The launcher's Node pin. The fleet path computes it the same way (`native-fleet-evaluator.ts`). */
function runningNodeDigest(): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(readFileSync(process.execPath)).digest('hex')}`;
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
    ['LEG 4  committed prediction-evaluator deployment registration, loaded + digest-pinned', 'PROVEN-hermetic'],
    ['LEG 5  real local backend: spawned evaluation-harness child produces the verdict', 'PROVEN-hermetic'],
    ['LEG 5b signed-source publisher announces the six evaluation records', 'PROVEN-hermetic'],
    ['LEG 5c NativeEvaluatorCoordinator + EvaluatorLoop settlement state machine', 'PROVEN-hermetic'],
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
      let closeRig: (() => Promise<void>) | undefined;

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
          coordinatorAddress: v3Env.coordinatorAddress,
          mechAddress: evaluatorV3.mockMechAddress,
          solutionSettlementTxHash: settlement.txHash,
          solverSafeAddress: solver.safeAddress,
          solutionRequestId: claim.requestId,
          taskId: settlement.taskId,
          attemptIndex: settlement.attemptIndex,
        });
        closeRig = () => rig.close();

        // The REAL loop drives the REAL composition. Each pass advances one phase and needs the
        // preceding transaction buried past the rig's finality depth, so the rig mines between
        // ticks exactly as wall-clock block production would.
        const loop = new EvaluatorLoop({
          composition: rig.composition,
          store: rig.store,
          pollIntervalMs: 50,
          // The coordinator's only durable diagnostic is the reason it records; surface it so a
          // stalled phase names itself instead of needing DB spelunking.
          // eslint-disable-next-line no-console
          logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
        });
        const deadline = Date.now() + 300_000;
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
        if (closeRig) { try { await closeRig(); } catch { /* best-effort */ } }
        try { await mockIpfs.close(); } catch { /* best-effort */ }
        try { await fixture.teardown(); } catch { /* best-effort */ }
        try { await rm(rigRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
    // The solution leg plus the evaluator's four finality-gated phases (claim, grade, marketplace
    // delivery, settlement) each need blocks mined past the rig's finality depth; the spawned
    // evaluation-harness child adds a real process launch on top.
    480_000,
  );
});
interface NativeEvaluatorRigInput {
  readonly fixture: DaemonHarnessFixture;
  readonly evaluator: BootstrappedOperator;
  readonly rigRoot: string;
  readonly routerAddress: Address;
  readonly coordinatorAddress: Address;
  readonly mechAddress: Address;
  readonly solutionSettlementTxHash: Hex;
  readonly solverSafeAddress: Address;
  readonly solutionRequestId: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
}

/**
 * The exact EvaluationSpec shape the committed prediction registration grades against — the same
 * sealed-spec fixture `test/native-evaluator/prediction-deployment.test.ts` drives its spawn proof
 * with, so the deployment module under test here is exercised on its real input shape.
 */
function predictionSpec(): EvaluationSpec {
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: 'deterministic-process',
    grader: {
      name: PREDICTION_PARSER.id,
      digest: { sha256: PREDICTION_PARSER.digest.slice('sha256:'.length) },
      accessClass: 'public',
    },
    familyBlock: {
      image: { name: 'hermetic-native-activity-rig', digest: { sha256: 'b'.repeat(64) } },
      platform: 'linux/amd64',
      workspace: {},
      testMaterial: [],
      parser: PREDICTION_PARSER,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: predictionEvaluationSpecMeasurements(),
    verdictRule: predictionEvaluationSpecVerdictRule(),
    unscorable: [],
    evidenceConventions: { requiredRefs: [] },
  } as EvaluationSpec;
}

/**
 * The subject document graph the evaluator grades. Sealed with the real protocol sealers so
 * `deriveNativeEvaluation`'s graph verification, `deriveEvaluationTask`, and the deployment
 * module's own provisioner all run on records they would accept from a live solver.
 *
 * The forecast window brackets the result's `submittedAt`, and the market is deliberately
 * unresolved: `native-evaluation-context.ts` stamps every native prediction context `unresolved`
 * by construction, so an honest native verdict here is `inconclusive`. That is not a weaker proof
 * of the reward path — `JinnRouterV3.claimVerdictDelivery` credits activity on attempt
 * finalization for ANY verdict code, which is exactly the loop-completion gate under test.
 */
function predictionSubjectGraph() {
  const sealedSpecification = sealEvaluationSpec(predictionSpec());
  const subjectTask = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
      digest: { sha256: '4'.repeat(64) },
    },
    payload: {
      forecast: {
        marketId: 'hermetic-native-activity-rig',
        question: 'Will the hermetic native-evaluator activity rig settle a verdict?',
        consensusProbabilityYes: '0.500000',
        observedAt: '2026-01-01T12:00:00Z',
        resolvesAt: '2026-01-01T12:01:00Z',
      },
    },
    instructions: 'Submit a prediction.',
    outputs: [{ name: 'result.json', mediaType: 'application/json', required: true }],
    evaluation: {
      name: 'evaluation-spec.json',
      digest: { sha256: sealedSpecification.digest.slice('sha256:'.length) },
    },
  });
  const subjectResult = utf8(JSON.stringify({
    probabilityYes: '0.750000',
    submittedAt: '2026-01-01T12:00:30.000Z',
  }));
  // The admission receipt the requester's Submission must annotate (§7.39). `deriveNativeEvaluation`
  // reads it off the Submission, so the receipt artifact and the annotation descriptor have to name
  // the same exact bytes.
  const admissionReceipt = utf8('hermetic-rig-admission-receipt');
  const subjectSubmission = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    task: { digest: { sha256: documentDigest(subjectTask).slice('sha256:'.length) } },
    requester: 'urn:jinn:requester:hermetic-native-activity-rig',
    idempotencyKey: 'hermetic-native-activity-rig',
    nonce: 'hermetic-native-activity-rig',
    deadline: '2099-01-01T00:00:00.000Z',
    annotations: {
      [ADMISSION_RECEIPT_ANNOTATION_URI]: {
        name: 'admission-receipt',
        mediaType: 'application/vnd.in-toto+json',
        digest: { sha256: documentDigest(admissionReceipt).slice('sha256:'.length) },
      },
    },
  });
  // `verifyExactGraph` requires the Delivery's evidence set to equal the material's exactly.
  const solutionEvidence = utf8('hermetic-rig-solution-evidence');
  const subjectDelivery = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: 'urn:uuid:11111111-1111-4111-8111-111111111112',
    task: documentDigest(subjectTask),
    outputs: [{
      name: 'result.json',
      mediaType: 'application/json',
      digest: { sha256: documentDigest(subjectResult).slice('sha256:'.length) },
    }],
    evidenceRecords: [{ family: 'execution-evidence', digest: documentDigest(solutionEvidence) }],
    outcome: 'fulfilled',
    createdAt: '2026-01-01T12:00:00.000Z',
  });
  return {
    task: artifactOf('subject-task.json', subjectTask),
    submission: artifactOf('submission', subjectSubmission),
    requesterEnvelope: artifactOf('requester-envelope', utf8('hermetic-rig-requester-envelope')),
    admissionReceipt: artifactOf('admission-receipt', admissionReceipt),
    delivery: artifactOf('subject-delivery.json', subjectDelivery),
    deliveryEnvelope: artifactOf('delivery-envelope', utf8('hermetic-rig-delivery-envelope')),
    evidenceRecords: [artifactOf('solution-evidence', solutionEvidence)],
    results: [artifactOf('result.json', subjectResult)],
    evaluationSpec: artifactOf('evaluation-spec.json', sealedSpecification.bytes),
  };
}

/**
 * Assembles the REAL native evaluator composition over the locally-deployed V3 stack.
 *
 * Real: the identity store, the committed deployment module + its registration (loaded and
 * digest-checked by `buildNativeEvaluatorComposition` itself), the local task-execution backend
 * and its spawned evaluation-harness child, the signed-source publisher, filesystem evidence, the
 * venue Safe broadcaster + `VerdictPorts`, the chain reads, and the coordinator.
 *
 * Seeded: the opportunity (admitted directly from the REAL on-chain settlement facts rather than
 * read from a signed source), the subject-authority claim, and the decision-grade verdict gate —
 * see the file header.
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

  // ── LEG 4: the committed prediction-evaluator deployment registration ───────────────────
  // `buildNativeEvaluatorComposition` re-reads the module bytes, refuses a digest mismatch, and
  // refuses a registration whose declared agent / signer handle / method digest disagree with
  // what is configured here — so this is the real registration, not a name.
  const deploymentModuleDigest = await predictionEvaluatorModuleDigest();
  const evaluationMethodDigest = await predictionEvaluatorMethodDigest();
  // The module reads its per-operator identity from an on-disk sidecar at import time.
  await writePredictionEvaluatorSidecar({
    agent: EVALUATOR_AGENT,
    claimEvidenceDir: join(rigRoot, 'claim-evidence'),
  });

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
  const material = predictionSubjectGraph();

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
    coordinator: input.coordinatorAddress,
    material,
  });

  // The subject-authority claim a live trust catalog would produce (LEG 9, seeded). Recording it
  // here is what makes `prepareClaim` skip `authority.claim`; everything it guards downstream —
  // including the REAL `deriveNativeEvaluation` of the evaluation Task — still runs.
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

  // ── The real local backend's dependencies ───────────────────────────────────────────────
  const evidence = await openOperatorEvidence({ rootDir: join(rigRoot, 'evidence') });
  const launcherDeployment = await buildPinnedNodeLauncherDeployment(runningNodeDigest());
  const evaluationProfile = buildEvaluationTaskProfile();
  const evaluationProfileDigest = sealTaskProfile(evaluationProfile).digest;
  const subjectBytesByDigest = new Map<string, Uint8Array>(
    [material.task, material.submission, material.requesterEnvelope, material.admissionReceipt,
      material.delivery, material.deliveryEnvelope, material.evaluationSpec,
      ...material.evidenceRecords, ...material.results]
      .map((entry) => [entry.digest, entry.bytes]),
  );

  const composition = await buildNativeEvaluatorComposition({
    roles,
    state,
    coordinatorAddress: input.coordinatorAddress,
    evaluatorAddress: evaluator.safeAddress as `0x${string}`,
    operatorIdentity: {
      safeAddress: evaluator.safeAddress,
      agentEoa: evaluator.agentAddress,
      agentIri: EVALUATOR_AGENT,
    },
    deployment: {
      module: PREDICTION_EVALUATOR_DEPLOYMENT_MODULE_PATH,
      moduleDigest: deploymentModuleDigest,
      signerHandle: EVALUATOR_SIGNER_HANDLE,
      evaluationMethodDigest,
    },
    backend: {
      stateRoot: join(rigRoot, 'evaluator-backend'),
      source: EVALUATOR_AGENT,
      executor: 'urn:jinn:operator-runtime:hermetic-native-activity-rig',
      profileStore: {
        get: (digest) => digest === evaluationProfileDigest ? evaluationProfile : undefined,
      },
      launcherDeployment,
      workspaceRuntime: buildNativeWorkspaceRuntime(),
      evidence: evidence.ports,
      maxConcurrentAttempts: 1,
    },
    publisher: {
      rootDir: join(rigRoot, 'public', 'evaluator'),
      publicBaseUrl: 'https://evaluator.hermetic.invalid/native',
    },
    // LEG 8 (seeded): the signed-source read. The opportunity is already admitted, so every tick
    // is exactly the recovery/advance pass the live loop runs alongside its source read.
    opportunities: {
      sourceId: 'urn:jinn:solver:hermetic-native-activity-rig/solver-records',
      read: async () => [],
    },
    subject: {
      fetcher: {
        byCid: async () => undefined,
        byDigest: async (digest: string) => subjectBytesByDigest.get(digest),
      },
    },
    // Persisted above, so this is never reached on the happy path.
    authority: {
      claim: async () => { throw new Error('subject authority was already persisted by the rig'); },
      dependencies: {} as never,
    },
    deadline: () => new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    verdictPorts,
    // REAL chain reads against the loaded snapshot. An Anvil state fixture leaves the `finalized`
    // tag pinned at the loaded tip, so a depth rule over `latest` is the only honest local reading.
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
    // LEG 9 (seeded): a live catalog's decision-grade named gate. `verifyExactGraph` — the exact
    // delivery/verdict/evidence join `buildNativeEvaluatorVerdictVerification` runs around this
    // port — is NOT stood in, and still runs on every phase.
    verification: {
      gate: { gate: async () => ({ decisionGrade: true, failures: [] }) as never },
      solutionDeliveryAuthority: { verify: async () => ({ ok: true }) } as never,
      evaluationDeliveryAuthority: { verify: async () => ({ ok: true }) } as never,
      preSettlementClaimTime: async () => new Date().toISOString(),
      blockTime: async (blockNumber: bigint) => {
        const block = await publicClient.getBlock({ blockNumber });
        return new Date(Number(block.timestamp) * 1000).toISOString();
      },
    },
  });

  return {
    store,
    state,
    venueState,
    evidence,
    composition,
    evaluationId: admitted.evaluationId,
    async close() {
      try { await composition.close(); } catch { /* best-effort */ }
      try { await evidence.close(); } catch { /* best-effort */ }
      try { store.close(); } catch { /* best-effort */ }
      try { venueState.close(); } catch { /* best-effort */ }
      try { await rm(PREDICTION_EVALUATOR_DEPLOYMENT_SIDECAR_PATH, { force: true }); } catch { /* best-effort */ }
    },
  };
}
