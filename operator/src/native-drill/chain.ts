// operator/src/native-drill/chain.ts
/**
 * The restart drill's chain port, backed by a real Anvil node (#2434).
 *
 * This is the delta over the in-process recovery matrix
 * (`operator/test/daemon/native-recovery-matrix.test.ts`), which injects chain facts as constants.
 * Here a broadcast is a real transaction and a recovery reads the real receipt and the node's real
 * `finalized` tag back. Anvil implements genuine finality semantics -- `finalized` trails `latest`
 * by 64 blocks -- so "execution starts only after canonical finality" is exercised, not asserted.
 *
 * The drill issues no call to the pinned BASE_SEPOLIA_TODAY contracts. It carries each operation's
 * digest as transaction calldata, because what a restart must reconcile is transaction identity,
 * receipt, replacement, and finality -- none of which needs a contract to be real.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

/** Anvil's first default development account. Public, funded, and never a real key. */
const DRILL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
/** Anvil's second default development account: an inert destination for drill calldata. */
const DRILL_SINK = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

/** Anvil's `finalized` tag trails `latest` by this many blocks. */
export const ANVIL_FINALITY_DEPTH = 64;

export interface DrillTransaction {
  readonly hash: `0x${string}`;
  readonly blockHash: `0x${string}`;
  readonly blockNumber: bigint;
}

export type DrillCanonicalRead =
  | { readonly kind: 'absent'; readonly checkedAtBlock: bigint }
  | ({ readonly kind: 'mined'; readonly finalized: boolean } & DrillTransaction);

export interface DrillChain {
  /** Broadcast a real transaction carrying `digest` as calldata and return its hash. */
  broadcast(digest: string): Promise<`0x${string}`>;
  /** Read a transaction back from the node, including whether its block is finalized. */
  read(hash: `0x${string}`): Promise<DrillCanonicalRead>;
  /**
   * Reconcile canonical history for one operation: every transaction the drill sender broadcast
   * carrying `digest` as calldata, oldest first. A restarted process finds its lost broadcast this
   * way rather than being handed the hash, and a second entry is a real on-chain duplicate.
   */
  findByDigest(digest: string): Promise<readonly DrillTransaction[]>;
  /** Mine until `hash`'s block is finalized; the node's own tag decides, not a counter here. */
  awaitFinalized(hash: `0x${string}`): Promise<DrillTransaction>;
  /** Confirmed transaction count for the drill sender — the nonce history a posting recovery reads. */
  senderNonce(): Promise<number>;
  readonly senderAddress: `0x${string}`;
}

function digestToCalldata(digest: string): Hex {
  return `0x${Buffer.from(digest, 'utf8').toString('hex')}`;
}

/**
 * Wire a `DrillChain` to a running Anvil at `rpcUrl`. The node must report chain id 84532: the
 * native vertical refuses any other chain, and a drill on the wrong chain would prove nothing.
 */
export async function createAnvilDrillChain(rpcUrl: string): Promise<DrillChain> {
  const publicClient: PublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== baseSepolia.id) {
    throw new Error(`restart drill requires an Anvil reporting chain id ${baseSepolia.id}, got ${chainId}`);
  }
  const account = privateKeyToAccount(DRILL_PRIVATE_KEY);
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const mine = async (blocks: number): Promise<void> => {
    await publicClient.request({
      method: 'anvil_mine' as never,
      params: [`0x${blocks.toString(16)}`] as never,
    });
  };

  const readHash = async (hash: `0x${string}`): Promise<DrillCanonicalRead> => {
    const latest = await publicClient.getBlockNumber();
    let receipt;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash });
    } catch {
      return { kind: 'absent', checkedAtBlock: latest };
    }
    if (receipt.status !== 'success') return { kind: 'absent', checkedAtBlock: latest };
    const finalizedBlock = await publicClient.getBlock({ blockTag: 'finalized' });
    return {
      kind: 'mined',
      hash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      finalized: receipt.blockNumber <= finalizedBlock.number,
    };
  };

  return {
    senderAddress: account.address,
    async broadcast(digest) {
      return walletClient.sendTransaction({
        account,
        chain: baseSepolia,
        to: DRILL_SINK,
        value: 0n,
        data: digestToCalldata(digest),
      });
    },
    read: readHash,
    async findByDigest(digest) {
      const calldata = digestToCalldata(digest).toLowerCase();
      const latest = await publicClient.getBlockNumber();
      const found: DrillTransaction[] = [];
      // Anvil mines one transaction per block here, and the drill's chains are tens of blocks
      // long, so an exhaustive scan is both cheap and exact — no log filter to get wrong.
      for (let height = 0n; height <= latest; height += 1n) {
        const block = await publicClient.getBlock({ blockNumber: height, includeTransactions: true });
        for (const transaction of block.transactions) {
          if (typeof transaction === 'string') continue;
          if (transaction.from.toLowerCase() !== account.address.toLowerCase()) continue;
          if ((transaction.input ?? '0x').toLowerCase() !== calldata) continue;
          found.push({
            hash: transaction.hash,
            blockHash: block.hash as `0x${string}`,
            blockNumber: block.number as bigint,
          });
        }
      }
      return found;
    },
    async awaitFinalized(hash) {
      // Advance past Anvil's finality depth, then let the node's own `finalized` tag decide.
      await mine(ANVIL_FINALITY_DEPTH + 1);
      const read = await readHash(hash);
      if (read.kind !== 'mined') {
        throw new Error(`restart drill transaction ${hash} is not mined and cannot finalize`);
      }
      if (!read.finalized) {
        throw new Error(`restart drill transaction ${hash} did not reach the node's finalized tag`);
      }
      return { hash, blockHash: read.blockHash, blockNumber: read.blockNumber };
    },
    async senderNonce() {
      return publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
    },
  };
}
