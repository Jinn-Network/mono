import { describe, expect, it } from 'vitest';
import type { DrillChain, DrillTransaction } from '../../src/native-drill/chain.js';
import { DRILL_SPECS } from '../../src/native-drill/checkpoints.js';
import {
  broadcastOnce,
  countBroadcast,
  type ScenarioContext,
} from '../../src/native-drill/scenarios/support.js';

function hash(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function memoryChain(): DrillChain & { readonly broadcasts: string[] } {
  const history = new Map<string, DrillTransaction[]>();
  const broadcasts: string[] = [];
  let next = 1;
  return {
    broadcasts,
    async broadcast(digest) {
      broadcasts.push(digest);
      const tx: DrillTransaction = {
        hash: hash(next),
        blockHash: hash(next),
        blockNumber: BigInt(next),
      };
      next += 1;
      history.set(digest, [...(history.get(digest) ?? []), tx]);
      return tx.hash;
    },
    async findByDigest(digest) {
      return history.get(digest) ?? [];
    },
    async awaitFinalized() {
      throw new Error('unused');
    },
    async senderNonce() {
      return broadcasts.length;
    },
    async latestBlock() {
      return BigInt(next);
    },
  };
}

function context(chain: DrillChain): ScenarioContext {
  return {
    checkpoint: 'posting',
    seed: 'B810',
    runId: 'B810-posting',
    stateDir: '/tmp/unused',
    mode: 'resume',
    chain,
    boundary: async () => {},
  };
}

describe('broadcastOnce fence', () => {
  it('returns broadcast=false on a second call under the same key without sending again', async () => {
    const chain = memoryChain();
    const ctx = context(chain);
    const first = await broadcastOnce(ctx, 'posting-key');
    const second = await broadcastOnce(ctx, 'posting-key');
    expect(first.broadcast).toBe(true);
    expect(second.broadcast).toBe(false);
    expect(second.txHash).toBe(first.txHash);
    expect(chain.broadcasts).toEqual(['posting-key']);
  });

  it('counts the port call even when the fence absorbed the send', () => {
    const counters = { attempts: 0, sent: 0 };
    countBroadcast({ broadcast: true }, counters);
    countBroadcast({ broadcast: false }, counters);
    expect(counters).toEqual({ attempts: 2, sent: 1 });
  });
});

describe('chain-backed drill proofs', () => {
  it('name the broadcastOnce fence so the artifact claims the harness, not operator reconcile', () => {
    const chainBacked = DRILL_SPECS.filter(({ checkpoint }) => (
      checkpoint === 'posting'
      || checkpoint === 'claim'
      || checkpoint === 'solution-settlement'
      || checkpoint === 'verdict-settlement'
    ));
    expect(chainBacked).toHaveLength(4);
    for (const spec of chainBacked) {
      expect(spec.proof, spec.checkpoint).toMatch(/broadcastOnce/u);
    }
  });
});
