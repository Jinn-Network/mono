// SPDX-License-Identifier: MIT

// The thin reader profile of design §7 ruling 2: chunked `getLogs` sized to provider caps; a
// hash-verified `(blockNumber, blockHash)` high-water mark; dual marks -- a live cursor tracking
// `latest`, a durable checkpoint advancing only on Base's `finalized` tag; cursor-hash mismatch
// = reorg = roll back to the finalized checkpoint and re-scan. Rollback governs projector STATE
// only: announcements already emitted from pre-finality blocks are corrected append-only through
// signed retractions (binding §8), never rewritten -- which is why orphaned hashes are recorded
// and returned rather than deleted.
import type { MarketplaceChainConfig } from "@jinn-network/marketplace-binding";
import type { MarketplaceRawLog } from "@jinn-network/marketplace-projector";
import type { Address, Hex, PublicClient } from "viem";
import type { VenueStateDatabase } from "../state/database.js";
import { createCursorStore, type CursorStore } from "./cursor-store.js";

/** 1000-block chunks: the legacy oracle's cap (#807/#801/#803) -- fits every vetted provider. */
export const DEFAULT_LOG_CHUNK_BLOCKS = 1000n;
/** Used only when a provider serves a stale `finalized` tag equal to `latest` (OP-stack §7 note). */
export const DEFAULT_FINALITY_DEPTH_FALLBACK = 120n;

export interface ChainLogCursor {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export interface ChainLogBatch {
  readonly logs: readonly MarketplaceRawLog[];
  readonly cursor: ChainLogCursor;
  readonly finalizedCheckpoint: ChainLogCursor;
  readonly reorg?: {
    readonly rolledBackTo: ChainLogCursor;
    readonly orphanedBlockHashes: readonly Hex[];
  };
}

export interface ChainLogSourceOptions {
  readonly chunkBlocks?: bigint;
  readonly startBlock?: bigint;
  readonly stream?: string;
  readonly finalityDepthFallback?: bigint;
}

export interface ChainLogSource {
  poll(): Promise<ChainLogBatch>;
  cursor(): ChainLogCursor | undefined;
  finalizedCheckpoint(): ChainLogCursor | undefined;
  logsInRange(fromBlock: bigint, toBlock: bigint): Promise<readonly MarketplaceRawLog[]>;
  orphanedBlockHashes(): ReadonlySet<string>;
  close(): void;
}

export function createChainLogSource(input: {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly state: VenueStateDatabase;
  readonly addresses: readonly Address[];
  readonly options?: ChainLogSourceOptions;
}): ChainLogSource {
  const options = input.options ?? {};
  const chunkBlocks = options.chunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS;
  const stream = options.stream ?? `venue:${input.chain.chainId}:${input.chain.jinnRouter.toLowerCase()}`;
  const depthFallback = options.finalityDepthFallback ?? DEFAULT_FINALITY_DEPTH_FALLBACK;
  const store: CursorStore = createCursorStore(input.state);
  const addresses = input.addresses.map((address) => address.toLowerCase() as Address);

  async function headAt(blockTag: "latest" | "finalized"): Promise<ChainLogCursor> {
    const block = await input.publicClient.getBlock({ blockTag });
    return { blockNumber: block.number ?? 0n, blockHash: block.hash ?? ("0x" as Hex) };
  }

  async function hashAt(blockNumber: bigint): Promise<Hex | undefined> {
    const block = await input.publicClient.getBlock({ blockNumber });
    return block.hash ?? undefined;
  }

  async function fetchChunked(
    fromBlock: bigint,
    toBlock: bigint,
    finalizedHeight: bigint,
  ): Promise<MarketplaceRawLog[]> {
    const collected: MarketplaceRawLog[] = [];
    for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
      const end = start + chunkBlocks - 1n > toBlock ? toBlock : start + chunkBlocks - 1n;
      // eslint-disable-next-line no-await-in-loop -- chunks are strictly sequential by design.
      const logs = await input.publicClient.getLogs({ address: addresses, fromBlock: start, toBlock: end });
      for (const log of logs) {
        if (log.blockNumber === null || log.blockHash === null
          || log.transactionHash === null || log.logIndex === null) {
          continue;
        }
        collected.push({
          chainId: input.chain.chainId,
          address: log.address,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          finalityTier: log.blockNumber <= finalizedHeight ? "finalized" : "safe",
          topics: log.topics,
          data: log.data,
        });
      }
    }
    return collected;
  }

  return {
    cursor: () => store.read(stream)?.live,
    finalizedCheckpoint: () => store.read(stream)?.finalized,
    orphanedBlockHashes: () => store.orphanedHashes(input.chain.chainId),
    close: () => undefined,

    async logsInRange(fromBlock, toBlock) {
      const finalized = await headAt("finalized");
      return fetchChunked(fromBlock, toBlock, finalized.blockNumber);
    },

    async poll(): Promise<ChainLogBatch> {
      const latest = await headAt("latest");
      const rawFinalized = await headAt("finalized");
      // Two stale-tag shapes need the depth fallback, never the primary signal:
      //   1. finalized == latest (OP-stack §7 note / lying providers) — decision-grade compute
      //      must not run on unfinalized facts.
      //   2. finalized lagging MORE than depthFallback behind latest — Anvil forks (and any
      //      provider whose `finalized` tag does not advance with locally-mined blocks) leave
      //      finalized stuck at the fork point forever; without the depth floor, every claim
      //      mined after the fork is permanently unfinalizable and the work loop hangs in
      //      `awaitFinalized` until its 900s timeout (E39 cycle 3 / anvil-fork gate).
      const depthFloor = latest.blockNumber > depthFallback
        ? latest.blockNumber - depthFallback
        : 0n;
      const useDepthFallback =
        (rawFinalized.blockNumber >= latest.blockNumber && latest.blockNumber > depthFallback)
        || (latest.blockNumber > rawFinalized.blockNumber + depthFallback);
      const finalized = useDepthFallback
        ? {
            blockNumber: depthFloor,
            blockHash: (await hashAt(depthFloor)) ?? rawFinalized.blockHash,
          }
        : rawFinalized;

      const persisted = store.read(stream);
      if (persisted === undefined) {
        const start = options.startBlock ?? finalized.blockNumber;
        const logs = await fetchChunked(start, latest.blockNumber, finalized.blockNumber);
        store.write(stream, input.chain.chainId, latest, finalized);
        return { logs, cursor: latest, finalizedCheckpoint: finalized };
      }

      const canonicalAtCursor = await hashAt(persisted.live.blockNumber);
      if (canonicalAtCursor !== undefined
        && canonicalAtCursor.toLowerCase() !== persisted.live.blockHash.toLowerCase()) {
        const rolledBackTo = persisted.finalized.blockNumber > finalized.blockNumber
          ? persisted.finalized
          : finalized;
        const orphaned: ChainLogCursor[] = [{ ...persisted.live }];
        store.recordOrphaned(input.chain.chainId, orphaned);
        const logs = await fetchChunked(rolledBackTo.blockNumber + 1n, latest.blockNumber, finalized.blockNumber);
        store.write(stream, input.chain.chainId, latest, rolledBackTo);
        return {
          logs,
          cursor: latest,
          finalizedCheckpoint: rolledBackTo,
          reorg: { rolledBackTo, orphanedBlockHashes: orphaned.map((block) => block.blockHash) },
        };
      }

      if (latest.blockNumber <= persisted.live.blockNumber) {
        return { logs: [], cursor: persisted.live, finalizedCheckpoint: persisted.finalized };
      }
      const logs = await fetchChunked(
        persisted.live.blockNumber + 1n,
        latest.blockNumber,
        finalized.blockNumber,
      );
      // The checkpoint is monotone: a provider that regresses its `finalized` tag never moves it back.
      const checkpoint = finalized.blockNumber > persisted.finalized.blockNumber ? finalized : persisted.finalized;
      store.write(stream, input.chain.chainId, latest, checkpoint);
      return { logs, cursor: latest, finalizedCheckpoint: checkpoint };
    },
  };
}
