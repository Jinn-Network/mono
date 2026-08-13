/**
 * Operator entry point for the projector replay described in
 * `client/src/daemon/projector-replay.ts` and `docs/runbooks/projector-replay.md` (defect #47).
 *
 * Dry run by default: it prints the row it would change and exits 0 without writing. Pass `--apply`
 * to commit. Run it with the daemon STOPPED — the daemon holds the same SQLite file and a rewind
 * landing mid-tick would race the poll that is about to overwrite it.
 *
 *   tsx scripts/projector-replay.ts \
 *     --state ~/.jinn-client/venue/venue.db \
 *     --rpc https://base-sepolia.publicnode.com \
 *     --router 0x6f47863ac4120a5a97af224a5e30c3ec2c9ea247 \
 *     --chain-id 84532 \
 *     --to-block 45415190 [--apply]
 */
import { createPublicClient, http, type Hex } from 'viem';
import { openVenueState } from '@jinn-network/marketplace-venue-base';
import {
  ProjectorReplayError,
  readChainLogCursor,
  rewindChainLogCursor,
} from '../src/daemon/projector-replay.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = flag(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const statePath = required('state');
  const rpcUrl = required('rpc');
  const chainId = Number(required('chain-id'));
  const toBlock = BigInt(required('to-block'));
  const stream = flag('stream') ?? `venue:${chainId}:${required('router').toLowerCase()}`;
  const apply = process.argv.includes('--apply');

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const onChainId = await publicClient.getChainId();
  if (onChainId !== chainId) {
    throw new Error(`--rpc serves chain ${onChainId}, but --chain-id says ${chainId}`);
  }

  const state = openVenueState(statePath);
  try {
    const current = readChainLogCursor(state, stream);
    console.log(`[projector-replay] state   ${statePath}`);
    console.log(`[projector-replay] stream  ${stream}`);
    console.log(
      `[projector-replay] cursor  live=${current?.liveBlockNumber ?? '<absent>'} `
      + `finalized=${current?.finalizedBlockNumber ?? '<absent>'}`,
    );
    const result = await rewindChainLogCursor({
      state,
      stream,
      toBlock,
      apply,
      readCanonicalBlockHash: async (blockNumber) =>
        (await publicClient.getBlock({ blockNumber })).hash as Hex | undefined,
    });
    console.log(
      `[projector-replay] rewind  live/finalized -> ${result.after.liveBlockNumber} `
      + `(${result.after.liveBlockHash})`,
    );
    console.log(
      `[projector-replay] replays blocks ${result.replayFromBlock}..${result.replayThroughBlock} `
      + 'and everything mined since',
    );
    console.log(
      result.applied
        ? '[projector-replay] APPLIED — restart the daemon; the next tick re-offers the range.'
        : '[projector-replay] DRY RUN — nothing written. Re-run with --apply to commit.',
    );
  } finally {
    state.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ProjectorReplayError) {
    console.error(`[projector-replay] refused: ${error.message}`);
  } else {
    console.error(`[projector-replay] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
