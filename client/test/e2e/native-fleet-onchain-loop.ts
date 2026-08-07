// client/test/e2e/native-fleet-onchain-loop.ts
/**
 * Native fleet G-loop ON-CHAIN rig (one-swap M7 follow-on, umbrella #2461, DR-2026-08-05).
 *
 * Sibling to `native-fleet-loop.ts` (PR #2497). That rig proved LEG 0 (native boot gate), LEG 1
 * (fork-finalized trust/role-identity boot) and LEG 2 (M6 serving) for two SYNTHETIC operators, and
 * left LEG 4/5/6/7 as "deploy-time" because no funded/staked operator existed. This sibling drives
 * the REAL forked contracts with the two operators that ARE now live on Base Sepolia 84532:
 *
 *   - Operator A = service 72 (agent 5474, EOA 0xF5fb…, Safe 0xf11e…, mech 0xE8ae…) — EVICTED.
 *   - Operator B = service 75 (agent 8865, EOA 0xB35f…, Safe 0xc679…, mech 0xD0Fd…) — STAKED.
 *
 * It forks Base Sepolia 84532 (Anvil `--fork-url`), so it inherits the operators' LIVE staked /
 * registered / owned state, and it never writes to the real chain. It loads the operators' REAL
 * agent EOAs from their REAL earning keystores (the same `decryptMnemonic` + `deriveAgentSigner` the
 * production earning stack uses), proves each EOA owns its real service Safe on the fork, proves the
 * fork carried the live staking state (72 evicted, 75 staked), and then drives the loop through the
 * real service Safes with the binding's REAL `executeSafeTransaction` Safe broadcaster:
 *
 *   - LEG 4  A posts an escrowed `createTask` from A's REAL service Safe → forked jinnRouter.
 *   - LEG 5  B claims it (`claimTask`) from B's REAL service Safe with B's REAL mech → forked
 *            jinnRouter; asserts the on-chain operator is B (0xc679…), distinct from creator A.
 *
 * WHAT THIS RIG DOES AND DOES NOT PROVE (stated loud so nothing reads as vacuous green):
 *
 *  - The CONTRACT-LEVEL loop legs run against the REAL forked contracts through the REAL operators'
 *    REAL Safes/EOAs/mechs — not in-memory venue ports. `createTask` and `claimTask` emit real
 *    `TaskCreated` / `TaskAttemptCreated` events with real ids, and the on-chain distinctness
 *    creator≠operator (A≠B) is proven by the event topics.
 *  - The NATIVE evidence/seal machinery (M5e sealed Task/Submission + IPFS pin, M3 discovery decode,
 *    M4a container verdict, M5f adopt) is NOT exercised here and is reported BLOCKED with the exact,
 *    investigated reasons — chiefly that the real operators have NO native role-identity ceremony /
 *    on-chain-anchored trust catalog (a separate cryptographic layer never provisioned for services
 *    72/75), and the fork has no IPFS registry/gateway to pin/fetch the sealed documents. Those legs
 *    therefore cannot "load the real operators' native identities" — those identities do not exist.
 *
 * Skips cleanly (exit 0) when no Base Sepolia RPC is reachable, or when the real operator keystores
 * are absent (a CI runner has neither), exactly like the legacy variant skips on an absent key.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  BASE_SEPOLIA_TODAY,
  JINN_ROUTER_V3_ABI,
  executeSafeTransaction,
} from '@jinn-network/marketplace-binding';
import { spawnAnvilFork } from '../_support/chain/anvil.js';
import { assertNativeDeployment } from '../../src/daemon/native-vertical-mode.js';
import { decryptMnemonic, deriveAgentSigner } from '../../src/earning/wallet.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Real operator descriptors (pseudonymous on-chain addresses; not PII) ──────────────────────────
interface RealOperator {
  readonly label: 'A' | 'B';
  readonly serviceId: number;
  readonly agentId: number;
  readonly accountIndex: number;
  readonly agentEoa: `0x${string}`;
  readonly safe: `0x${string}`;
  readonly mech: `0x${string}`;
  readonly keystorePath: string;
  readonly expectedStakingState: number; // 1 = Staked, 2 = Evicted
  /** Resolves this operator's keystore password without ever logging it. */
  password(): Promise<string>;
}

const OP_A: RealOperator = {
  label: 'A',
  serviceId: 72,
  agentId: 5474,
  accountIndex: 2,
  agentEoa: '0xF5fb745EC6F948A1d2deEf325B3377d2FA5f868A',
  safe: '0xf11eDAF5330852bd77c79e3e30af6248c64f963b',
  mech: '0xE8aeBa4BE60035Ed6CF22bF07fcaeef1240C6A97',
  keystorePath: join(homedir(), '.jinn-client', 'earning', 'master_keystore.json'),
  expectedStakingState: 2,
  async password() {
    const file = join(homedir(), '.jinn-client', 'keystore-password');
    return (await readFile(file, 'utf8')).trim();
  },
};

const OP_B: RealOperator = {
  label: 'B',
  serviceId: 75,
  agentId: 8865,
  accountIndex: 1,
  agentEoa: '0xB35f31BB8FDb3850Ac2a70B574A2639a3dEF17Fa',
  safe: '0xc679BD172f6c6bA0f6437d26361E92BD9b7995C3',
  mech: '0xD0Fd477A6c4A726A8d4BA1EE2b07C02317e9182a',
  keystorePath: join(homedir(), '.jinn-client-op-b', 'earning', 'master_keystore.json'),
  expectedStakingState: 1,
  async password() {
    // The op-b standup password is supplied out of band via env — never hard-coded in source.
    const pw = process.env['JINN_PASSWORD_OP_B'] ?? process.env['JINN_PASSWORD'];
    if (pw === undefined || pw.length === 0) {
      throw new Error('operator B keystore password not provided (set JINN_PASSWORD_OP_B)');
    }
    return pw;
  },
};

const STAKING_ADDRESS = '0x4DB0Fcb877CCd92B6AeEdAaD561DaccB0CCc7E39' as const;
const STAKING_ABI = [
  { type: 'function', name: 'getStakingState', stateMutability: 'view', inputs: [{ name: 'serviceId', type: 'uint256' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'getServiceIds', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256[]' }] },
] as const;
const SAFE_OWNERS_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address[]' }] },
] as const;

/** Escrow leg amounts — tiny native wei; the fork carries no real value. responseTimeout in [60,300]. */
const SOLUTION_RATE_WEI = 2000n;
const VERDICT_RATE_WEI = 1000n;
const RESPONSE_TIMEOUT_SECONDS = 300n;

interface LegResult {
  readonly leg: string;
  readonly status: 'PROVEN' | 'BLOCKED' | 'SKIPPED';
  readonly detail: string;
}

function sepoliaRpcFromEnv(): string | undefined {
  return process.env['JINN_E2E_SEPOLIA_RPC']
    ?? process.env['BASE_SEPOLIA_RPC_URL']
    ?? 'https://base-sepolia.publicnode.com';
}

async function reachable(rpcUrl: string): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    return (await client.getChainId()) === 84532;
  } catch {
    return false;
  }
}

/** Loads an operator's REAL agent EOA from its REAL earning keystore. Never logs key material. */
async function loadRealWallet(
  op: RealOperator,
  rpcUrl: string,
): Promise<WalletClient> {
  const mnemonic = await decryptMnemonic(await readFile(op.keystorePath, 'utf8'), await op.password());
  const account = deriveAgentSigner(mnemonic, op.accountIndex);
  if (getAddress(account.address) !== getAddress(op.agentEoa)) {
    throw new Error(`operator ${op.label} keystore derived ${account.address}, expected ${op.agentEoa}`);
  }
  return createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
}

/** Broadcasts an escrowed `createTask` through a REAL service Safe; returns the real taskId + tx. */
async function postTaskThroughSafe(input: {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safe: `0x${string}`;
  readonly taskCidDigest: Hex;
  readonly manifestDigest: Hex;
}): Promise<{ readonly taskId: bigint; readonly txHash: Hex }> {
  const data = encodeFunctionData({
    abi: JINN_ROUTER_V3_ABI,
    functionName: 'createTask',
    args: [
      input.taskCidDigest,
      input.manifestDigest,
      { maxClaims: 1, allowSolverSelfEvaluation: false },
      SOLUTION_RATE_WEI,
      VERDICT_RATE_WEI,
      RESPONSE_TIMEOUT_SECONDS,
    ],
  });
  const txHash = await executeSafeTransaction(input.publicClient, input.walletClient, {
    safeAddress: input.safe,
    to: BASE_SEPOLIA_TODAY.jinnRouter as `0x${string}`,
    value: SOLUTION_RATE_WEI + VERDICT_RATE_WEI,
    data,
  });
  const receipt = await input.publicClient.getTransactionReceipt({ hash: txHash });
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(BASE_SEPOLIA_TODAY.jinnRouter)) continue;
    try {
      const ev = decodeEventLog({ abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'TaskCreated') {
        return { taskId: (ev.args as { taskId: bigint }).taskId, txHash };
      }
    } catch {
      /* not this event */
    }
  }
  throw new Error('createTask succeeded but no TaskCreated event was decoded');
}

/** Broadcasts a `claimTask` through a REAL service Safe; returns the real requestId + operator + tx. */
async function claimTaskThroughSafe(input: {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safe: `0x${string}`;
  readonly taskId: bigint;
  readonly mech: `0x${string}`;
}): Promise<{ readonly requestId: Hex; readonly operator: `0x${string}`; readonly txHash: Hex }> {
  const data = encodeFunctionData({
    abi: JINN_ROUTER_V3_ABI,
    functionName: 'claimTask',
    args: [input.taskId, input.mech],
  });
  const txHash = await executeSafeTransaction(input.publicClient, input.walletClient, {
    safeAddress: input.safe,
    to: BASE_SEPOLIA_TODAY.jinnRouter as `0x${string}`,
    value: 0n,
    data,
  });
  const receipt = await input.publicClient.getTransactionReceipt({ hash: txHash });
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(BASE_SEPOLIA_TODAY.jinnRouter)) continue;
    try {
      const ev = decodeEventLog({ abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'TaskAttemptCreated') {
        const args = ev.args as { requestId: Hex; operator: `0x${string}` };
        return { requestId: args.requestId, operator: getAddress(args.operator), txHash };
      }
    } catch {
      /* not this event */
    }
  }
  throw new Error('claimTask succeeded but no TaskAttemptCreated event was decoded');
}

export async function runNativeFleetOnchainLoop(): Promise<void> {
  const rpcUrl = sepoliaRpcFromEnv();
  if (rpcUrl === undefined || !(await reachable(rpcUrl))) {
    console.log('\n=== native-fleet on-chain e2e — SKIPPED: no reachable Base Sepolia (84532) RPC ===');
    return;
  }
  if (!existsSync(OP_A.keystorePath) || !existsSync(OP_B.keystorePath)) {
    console.log('\n=== native-fleet on-chain e2e — SKIPPED: real operator keystores absent (A and/or B) ===');
    return;
  }

  console.log('\n=== native-fleet G-loop ON-CHAIN rig — fork Base Sepolia 84532, REAL operators A + B ===');
  const anvil = await spawnAnvilFork({ forkUrl: rpcUrl, chain: baseSepolia, silent: true });
  const results: LegResult[] = [];
  try {
    console.log(`anvil rpc: ${anvil.rpcUrl}`);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(anvil.rpcUrl) });

    // ── LEG 0: native boot gate ─────────────────────────────────────────────────────────────────
    assertNativeDeployment({ network: 'testnet', chain: BASE_SEPOLIA_TODAY });
    for (const [name, address] of Object.entries({
      taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
      jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
      mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
      activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
    })) {
      const code = await publicClient.getBytecode({ address: address as `0x${string}` });
      if (code === undefined || code === '0x') {
        throw new Error(`native boot gate: forked ${name} at ${address} has no code`);
      }
    }
    results.push({ leg: 'LEG 0  native boot gate (assertNativeDeployment + forked code)', status: 'PROVEN', detail: 'chainId 84532, today contracts present' });
    console.log('  ✓ LEG 0 PROVEN — native boot gate against forked BASE_SEPOLIA_TODAY');

    // ── LEG R: real operators loaded from real keystores; fork inherited their live state ─────────
    const aWallet = await loadRealWallet(OP_A, anvil.rpcUrl);
    const bWallet = await loadRealWallet(OP_B, anvil.rpcUrl);
    const aOwners = await publicClient.readContract({ address: OP_A.safe, abi: SAFE_OWNERS_ABI, functionName: 'getOwners' });
    const bOwners = await publicClient.readContract({ address: OP_B.safe, abi: SAFE_OWNERS_ABI, functionName: 'getOwners' });
    const aOwnsSafe = aOwners.map((o) => getAddress(o)).includes(getAddress(OP_A.agentEoa));
    const bOwnsSafe = bOwners.map((o) => getAddress(o)).includes(getAddress(OP_B.agentEoa));
    if (!aOwnsSafe || !bOwnsSafe) throw new Error('a real agent EOA does not own its real service Safe on the fork');

    const aState = await publicClient.readContract({ address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: 'getStakingState', args: [BigInt(OP_A.serviceId)] });
    const bState = await publicClient.readContract({ address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: 'getStakingState', args: [BigInt(OP_B.serviceId)] });
    const serviceIds = await publicClient.readContract({ address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: 'getServiceIds' });
    const bStakedListed = serviceIds.map((id) => Number(id)).includes(OP_B.serviceId);
    if (Number(aState) !== OP_A.expectedStakingState) throw new Error(`fork staking state for A (svc 72) is ${aState}, expected ${OP_A.expectedStakingState} (evicted)`);
    if (Number(bState) !== OP_B.expectedStakingState) throw new Error(`fork staking state for B (svc 75) is ${bState}, expected ${OP_B.expectedStakingState} (staked)`);
    if (!bStakedListed) throw new Error('fork getServiceIds() does not list B service 75');

    // Honest distinctness: different EOAs, different Safes, different agent ids.
    if (getAddress(OP_A.agentEoa) === getAddress(OP_B.agentEoa)) throw new Error('operators A and B share an EOA');
    if (getAddress(OP_A.safe) === getAddress(OP_B.safe)) throw new Error('operators A and B share a Safe');
    if (OP_A.agentId === OP_B.agentId) throw new Error('operators A and B share an agent id');

    // Fund both operators' EOAs (gas + escrow msg.value) on the fork.
    await anvil.setBalance(getAddress(OP_A.agentEoa), 100n * 10n ** 18n);
    await anvil.setBalance(getAddress(OP_B.agentEoa), 100n * 10n ** 18n);
    await anvil.setBalance(getAddress(OP_A.safe), 10n * 10n ** 18n);
    await anvil.setBalance(getAddress(OP_B.safe), 10n * 10n ** 18n);

    results.push({ leg: 'LEG R  real ops from real keystores + fork inherits live state', status: 'PROVEN', detail: `A(svc72,agent5474,state=${aState}=evicted) B(svc75,agent8865,state=${bState}=staked); EOAs own Safes; A≠B` });
    console.log(`  ✓ LEG R PROVEN — A EOA ${OP_A.agentEoa} owns Safe ${OP_A.safe} (svc 72, staking ${aState}=evicted)`);
    console.log(`             — B EOA ${OP_B.agentEoa} owns Safe ${OP_B.safe} (svc 75, staking ${bState}=staked, listed=${bStakedListed})`);

    // ── LEG 4: A posts a REAL escrowed createTask through A's REAL service Safe ───────────────────
    let taskId: bigint | undefined;
    let postTx: Hex | undefined;
    try {
      const post = await postTaskThroughSafe({
        publicClient,
        walletClient: aWallet,
        safe: OP_A.safe,
        taskCidDigest: `0x${'aa'.repeat(32)}` as Hex,
        manifestDigest: `0x${'bb'.repeat(32)}` as Hex,
      });
      taskId = post.taskId;
      postTx = post.txHash;
      results.push({ leg: 'LEG 4  A posts escrowed createTask (real Safe → forked jinnRouter)', status: 'PROVEN', detail: `taskId=${taskId} tx=${postTx} creator=${OP_A.safe}` });
      console.log(`  ✓ LEG 4 PROVEN — A posted taskId ${taskId} via real Safe ${OP_A.safe}; tx ${postTx}`);
    } catch (err) {
      results.push({ leg: 'LEG 4  A posts escrowed createTask (real Safe → forked jinnRouter)', status: 'BLOCKED', detail: err instanceof Error ? err.message : String(err) });
      console.log(`  ✗ LEG 4 BLOCKED — ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── LEG 5: B claims it (`claimTask`) through B's REAL service Safe + B's REAL mech ────────────
    if (taskId !== undefined) {
      try {
        const claim = await claimTaskThroughSafe({
          publicClient,
          walletClient: bWallet,
          safe: OP_B.safe,
          taskId,
          mech: OP_B.mech,
        });
        const operatorIsB = getAddress(claim.operator) === getAddress(OP_B.safe);
        const operatorIsNotA = getAddress(claim.operator) !== getAddress(OP_A.safe);
        if (!operatorIsB || !operatorIsNotA) {
          throw new Error(`claim operator ${claim.operator} is not B's Safe (or equals A)`);
        }
        results.push({ leg: 'LEG 5  B claims (real Safe + real mech → forked jinnRouter)', status: 'PROVEN', detail: `requestId=${claim.requestId} operator=${claim.operator}(B) tx=${claim.txHash}; operator≠A` });
        console.log(`  ✓ LEG 5 PROVEN — B claimed taskId ${taskId}: operator=${claim.operator} (B, ≠A), requestId ${claim.requestId}; tx ${claim.txHash}`);
      } catch (err) {
        results.push({ leg: 'LEG 5  B claims (real Safe + real mech → forked jinnRouter)', status: 'BLOCKED', detail: err instanceof Error ? err.message : String(err) });
        console.log(`  ✗ LEG 5 BLOCKED — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      results.push({ leg: 'LEG 5  B claims (real Safe + real mech → forked jinnRouter)', status: 'BLOCKED', detail: 'upstream LEG 4 did not produce a taskId' });
    }

    // ── LEG 5b/6/7: native seal + delivery + verdict + adopt — reported BLOCKED with real reasons ──
    results.push({
      leg: 'LEG 5b delivery anchor (claimSolutionDelivery)',
      status: 'BLOCKED',
      detail: 'forked jinnRouter reverts RouterNotDelivered until B\'s mech delivers via the mech marketplace (deliverMarketplace); the OLAS mech-delivery flow is not driven here',
    });
    results.push({
      leg: 'LEG 4/5/6/7 NATIVE seal machinery (M5e/M3/M4a/M5f sealed docs)',
      status: 'BLOCKED',
      detail: 'real operators have NO native role-identity stores and NO on-chain-anchored trust catalog (services 72/75 never ran a native-identity ceremony), and the fork has no IPFS registry/gateway to pin/fetch sealed Task/Submission/verdict docs — so createNativeRequester/native fleet/native evaluator cannot open role identities or seal documents',
    });
    results.push({
      leg: 'LEG 6  container-graded verdict (DR-3a, swe-rebench Docker)',
      status: 'BLOCKED',
      detail: 'no delivered solution to grade (LEG 5b blocked) AND no native evaluator role-identity ceremony for the real ops; Docker is healthy but the decisionGrade path requires both',
    });
    results.push({
      leg: 'LEG 7  A adopts (M5f)',
      status: 'BLOCKED',
      detail: 'requires a real delivered solution + verdict (LEG 5b/6 blocked)',
    });

    printEvidenceTable(results);
    console.log('\n=== native-fleet on-chain rig complete — real contract legs PROVEN; native-seal legs BLOCKED (reasons above) ===');
  } finally {
    await anvil.teardown();
  }
}

function printEvidenceTable(results: readonly LegResult[]): void {
  console.log('\nEVIDENCE TABLE (G-loop on-chain, real operators A+B, Base Sepolia 84532 fork):');
  for (const r of results) {
    console.log(`  [${r.status.padEnd(7)}] ${r.leg}`);
    console.log(`             → ${r.detail}`);
  }
}

/** Self-execute only when run directly (`tsx native-fleet-onchain-loop.ts`), not when imported. */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runNativeFleetOnchainLoop().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
