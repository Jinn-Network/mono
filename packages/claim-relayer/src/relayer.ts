import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  JINN_DISTRIBUTOR_ABI,
  MOCK_MESSENGER_ABI,
  TASK_CLAIM_EMITTER_ABI,
} from './abis.js';
import type { ClaimRelayerConfig } from './config.js';
import { ClaimRelayerStore } from './db.js';
import type { ClaimSnapshot, MessengerFixture, RelayerStats } from './types.js';

type PublicClientLike = {
  getBlockNumber?: () => Promise<bigint>;
  getLogs?: (args: any) => Promise<Array<Record<string, unknown>>>;
  readContract: (args: any) => Promise<unknown>;
  simulateContract?: (args: any) => Promise<{ request: any }>;
  waitForTransactionReceipt?: (args: { hash: Hex }) => Promise<{ status?: string }>;
};

type WalletClientLike = {
  account?: { address: Address };
  writeContract: (request: any) => Promise<Hex>;
};

export interface ClaimRelayerClients {
  l1Public: PublicClientLike;
  l2Public: PublicClientLike;
  l1Wallet: WalletClientLike;
}

export interface RunOnceResult {
  fromBlock: bigint;
  toBlock: bigint;
  scanned: number;
  claimed: number;
  skipped: number;
  failed: number;
}

export class ClaimRelayer {
  private timer: NodeJS.Timeout | null = null;
  private startupChecked = false;
  private readonly stats: RelayerStats;

  constructor(
    private readonly config: ClaimRelayerConfig,
    private readonly store: ClaimRelayerStore,
    private readonly clients: ClaimRelayerClients,
  ) {
    this.stats = {
      scannedTickets: 0,
      claimedTickets: 0,
      skippedTickets: 0,
      failedTickets: 0,
      lastError: null,
      startedAt: new Date().toISOString(),
      ready: false,
    };
  }

  async startupCheck(): Promise<void> {
    const walletAddress = this.clients.l1Wallet.account?.address;
    if (!walletAddress || !isAddressEqual(walletAddress, this.config.signerAddress)) {
      throw new Error('L1 wallet account does not match configured signer');
    }

    const [owner, distributorMessenger] = await Promise.all([
      this.clients.l1Public.readContract({
        address: this.config.artifacts.messenger,
        abi: MOCK_MESSENGER_ABI,
        functionName: 'owner',
      }) as Promise<Address>,
      this.clients.l1Public.readContract({
        address: this.config.artifacts.distributor,
        abi: JINN_DISTRIBUTOR_ABI,
        functionName: 'messenger',
      }) as Promise<Address>,
    ]);

    if (!isAddressEqual(getAddress(owner), this.config.signerAddress)) {
      throw new Error(
        `MockMessenger.owner() ${owner} does not match signer ${this.config.signerAddress}`,
      );
    }
    if (!isAddressEqual(getAddress(distributorMessenger), this.config.artifacts.messenger)) {
      throw new Error(
        `JinnDistributor.messenger() ${distributorMessenger} does not match configured MockMessenger ${this.config.artifacts.messenger}`,
      );
    }

    this.startupChecked = true;
    this.stats.ready = true;
  }

  async start(): Promise<void> {
    await this.startupCheck();
    await this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.stats.lastError = error instanceof Error ? error.message : String(error);
      });
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stats.ready = false;
  }

  getStatus(): RelayerStats {
    return { ...this.stats, ready: this.stats.ready && this.startupChecked };
  }

  async runOnce(): Promise<RunOnceResult> {
    if (!this.startupChecked) {
      await this.startupCheck();
    }

    if (!this.clients.l2Public.getBlockNumber || !this.clients.l2Public.getLogs) {
      throw new Error('L2 public client is missing scan methods');
    }

    const latest = await this.clients.l2Public.getBlockNumber();
    const previous = this.store.getCheckpoint(this.config.startBlock);
    const fromBlock = previous + 1n;
    const toBlock = latest < fromBlock
      ? previous
      : minBigInt(latest, fromBlock + this.config.batchBlocks - 1n);

    if (toBlock < fromBlock) {
      return { fromBlock, toBlock, scanned: 0, claimed: 0, skipped: 0, failed: 0 };
    }

    const logs = await this.clients.l2Public.getLogs({
      address: this.config.artifacts.claimEmitter,
      event: TASK_CLAIM_EMITTER_ABI[0],
      fromBlock,
      toBlock,
    });

    logs.sort(compareLogs);

    let claimed = 0;
    let skipped = 0;
    let failed = 0;

    for (const log of logs) {
      const snapshot = decodeClaimTicket(log);
      this.stats.scannedTickets++;
      const previousStatus = this.store.upsertObserved(snapshot);
      if (previousStatus === 'claimed') {
        skipped++;
        this.stats.skippedTickets++;
        continue;
      }

      try {
        const didClaim = await this.processSnapshot(snapshot);
        if (didClaim) {
          claimed++;
          this.stats.claimedTickets++;
        } else {
          skipped++;
          this.stats.skippedTickets++;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.markFailed(snapshot.claimId, message);
        this.stats.failedTickets++;
        this.stats.lastError = message;
        failed++;
      }
    }

    this.store.setCheckpoint(toBlock);
    return { fromBlock, toBlock, scanned: logs.length, claimed, skipped, failed };
  }

  async processSnapshot(snapshot: ClaimSnapshot): Promise<boolean> {
    await this.assertSnapshotHash(snapshot);

    const owed = await this.computeOwed(snapshot);
    if (owed.operator === 0n && owed.dao === 0n) {
      this.store.markSkipped(snapshot.claimId, 'no distributor delta owed');
      return false;
    }

    const fixture = await this.readFixture(snapshot.claimId);

    if (isEmptyFixture(fixture)) {
      const txHash = await this.setFixture(snapshot);
      this.store.markFixtureSet(snapshot.claimId, txHash);
    } else {
      assertFixtureMatchesSnapshot(fixture, snapshot);
      this.store.markFixtureSet(snapshot.claimId, null);
    }

    const claimTxHash = await this.submitClaim(snapshot.claimId);
    this.store.markClaimed(snapshot.claimId, claimTxHash);
    return true;
  }

  private async computeOwed(snapshot: ClaimSnapshot): Promise<{ operator: bigint; dao: bigint }> {
    const [
      operatorRatio,
      daoRatio,
      wTaskCreation,
      wSolutionDelivery,
      wVerdictDelivery,
      totalClaimedOperator,
      totalClaimedDao,
    ] = await Promise.all([
      this.readDistributorUint('operatorRatio'),
      this.readDistributorUint('daoRatio'),
      this.readDistributorUint('wTaskCreation'),
      this.readDistributorUint('wSolutionDelivery'),
      this.readDistributorUint('wVerdictDelivery'),
      this.readDistributorUint('totalClaimedOperator', [snapshot.serviceId]),
      this.readDistributorUint('totalClaimedDao', [snapshot.serviceId]),
    ]);

    const weighted =
      wTaskCreation * snapshot.taskCreationWeight +
      wSolutionDelivery * snapshot.solutionDeliveryWeight +
      wVerdictDelivery * snapshot.verdictDeliveryWeight;
    const entitledOperator = (weighted * operatorRatio) / 1_000_000_000_000_000_000n;
    const entitledDao = (weighted * daoRatio) / 1_000_000_000_000_000_000n;

    return {
      operator: entitledOperator > totalClaimedOperator ? entitledOperator - totalClaimedOperator : 0n,
      dao: entitledDao > totalClaimedDao ? entitledDao - totalClaimedDao : 0n,
    };
  }

  private async readDistributorUint(functionName: string, args: unknown[] = []): Promise<bigint> {
    return this.clients.l1Public.readContract({
      address: this.config.artifacts.distributor,
      abi: JINN_DISTRIBUTOR_ABI,
      functionName,
      args,
    }) as Promise<bigint>;
  }

  private async assertSnapshotHash(snapshot: ClaimSnapshot): Promise<void> {
    const expected = snapshotHash(snapshot);
    const actual = await this.clients.l2Public.readContract({
      address: this.config.artifacts.claimEmitter,
      abi: TASK_CLAIM_EMITTER_ABI,
      functionName: 'claimSnapshotHashes',
      args: [snapshot.claimId],
    }) as Hex;

    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `snapshot hash mismatch for claim ${snapshot.claimId}: event=${expected} onchain=${actual}`,
      );
    }
  }

  private async readFixture(claimId: bigint): Promise<MessengerFixture> {
    const result = await this.clients.l1Public.readContract({
      address: this.config.artifacts.messenger,
      abi: MOCK_MESSENGER_ABI,
      functionName: 'fixtures',
      args: [claimId],
    }) as readonly [bigint, bigint, bigint, bigint, Address];
    return {
      serviceId: result[0],
      taskCreationWeight: result[1],
      solutionDeliveryWeight: result[2],
      verdictDeliveryWeight: result[3],
      multisig: getAddress(result[4]),
    };
  }

  private async setFixture(snapshot: ClaimSnapshot): Promise<Hex> {
    const request = await this.simulateL1({
      address: this.config.artifacts.messenger,
      abi: MOCK_MESSENGER_ABI,
      functionName: 'setFixture',
      args: [
        snapshot.claimId,
        {
          serviceId: snapshot.serviceId,
          taskCreationWeight: snapshot.taskCreationWeight,
          solutionDeliveryWeight: snapshot.solutionDeliveryWeight,
          verdictDeliveryWeight: snapshot.verdictDeliveryWeight,
          multisig: snapshot.multisig,
        },
      ],
      account: this.clients.l1Wallet.account,
    });
    return this.writeAndWait(request);
  }

  private async submitClaim(claimId: bigint): Promise<Hex> {
    const request = await this.simulateL1({
      address: this.config.artifacts.distributor,
      abi: JINN_DISTRIBUTOR_ABI,
      functionName: 'claim',
      args: [encodeAbiParameters([{ type: 'uint256' }], [claimId])],
      account: this.clients.l1Wallet.account,
    });
    return this.writeAndWait(request);
  }

  private async simulateL1(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.clients.l1Public.simulateContract) {
      return args;
    }
    const { request } = await this.clients.l1Public.simulateContract(args);
    return request;
  }

  private async writeAndWait(request: Record<string, unknown>): Promise<Hex> {
    const hash = await this.clients.l1Wallet.writeContract(request);
    if (this.clients.l1Public.waitForTransactionReceipt) {
      const receipt = await this.clients.l1Public.waitForTransactionReceipt({ hash });
      if (receipt.status && receipt.status !== 'success') {
        throw new Error(`transaction ${hash} failed with status ${receipt.status}`);
      }
    }
    return hash;
  }
}

export function snapshotHash(snapshot: Pick<ClaimSnapshot, 'claimId' | 'serviceId' | 'taskCreationWeight' | 'solutionDeliveryWeight' | 'verdictDeliveryWeight' | 'multisig'>): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'address' },
    ],
    [
      snapshot.claimId,
      snapshot.serviceId,
      snapshot.taskCreationWeight,
      snapshot.solutionDeliveryWeight,
      snapshot.verdictDeliveryWeight,
      snapshot.multisig,
    ],
  ));
}

export function assertFixtureMatchesSnapshot(fixture: MessengerFixture, snapshot: ClaimSnapshot): void {
  const same =
    fixture.serviceId === snapshot.serviceId &&
    fixture.taskCreationWeight === snapshot.taskCreationWeight &&
    fixture.solutionDeliveryWeight === snapshot.solutionDeliveryWeight &&
    fixture.verdictDeliveryWeight === snapshot.verdictDeliveryWeight &&
    isAddressEqual(fixture.multisig, snapshot.multisig);

  if (!same) {
    throw new Error(`fixture mismatch for claim ${snapshot.claimId}`);
  }
}

function decodeClaimTicket(log: Record<string, unknown>): ClaimSnapshot {
  const decoded = decodeEventLog({
    abi: TASK_CLAIM_EMITTER_ABI,
    data: log.data as Hex,
    topics: log.topics as [Hex, ...Hex[]],
    eventName: 'ClaimTicket',
  });
  const args = decoded.args as unknown as {
    claimId: bigint;
    serviceId: bigint;
    taskCreationWeight: bigint;
    solutionDeliveryWeight: bigint;
    verdictDeliveryWeight: bigint;
    multisig: Address;
    claimer: Address;
  };

  return {
    claimId: args.claimId,
    serviceId: args.serviceId,
    taskCreationWeight: args.taskCreationWeight,
    solutionDeliveryWeight: args.solutionDeliveryWeight,
    verdictDeliveryWeight: args.verdictDeliveryWeight,
    multisig: getAddress(args.multisig),
    claimer: getAddress(args.claimer),
    l2BlockNumber: BigInt(String(log.blockNumber ?? 0n)),
    l2LogIndex: Number(log.logIndex ?? 0),
    l2TxHash: (log.transactionHash ?? '0x') as Hex,
  };
}

function isEmptyFixture(fixture: MessengerFixture): boolean {
  return fixture.multisig.toLowerCase() === zeroAddress;
}

function compareLogs(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aBlock = BigInt(String(a.blockNumber ?? 0n));
  const bBlock = BigInt(String(b.blockNumber ?? 0n));
  if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
  return Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
