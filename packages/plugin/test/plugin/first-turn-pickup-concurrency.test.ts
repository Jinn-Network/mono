// Mono #1795: `firstTurnPickup` awaited each term's `corpus.search` call
// sequentially — at ~1.6s/term against a live indexer, lexical v2's 10-term
// budget (#1791) serialized to ~16s, blowing the Hermes host's 15s subprocess
// deadline. The searches are independent; only the merge has an ordering
// requirement (dedup priority, first-observed degraded reason). These tests
// pin: (1) searches are actually issued concurrently, proven structurally —
// not by wall-clock timing; (2) the merge stays in term order regardless of
// which search resolves first; (3) a rejected port promise (a PortResult
// convention violation, guarded anyway) degrades only its own term.
import { describe, expect, it } from 'vitest';
import { createJinnPlugin } from '../../src/index.js';
import {
  InMemoryContributionPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../../src/testing.js';
import { ok, unavailable, type PortResult } from '../../src/outcome.js';
import type { CorpusPort, CorpusRecord } from '../../src/ports/corpus-port.js';
import type { KnowledgeHit } from '../../src/schemas/knowledge-hit.js';

function buildPlugin(corpus: CorpusPort) {
  return createJinnPlugin({
    corpus,
    evidence: new InMemoryEvidencePort(),
    contribution: new InMemoryContributionPort(),
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
  });
}

const META = {
  sessionId: 's1',
  taskSummary: 'concurrency probe',
  harness: { name: 'hermes', version: '0.1.0' },
  model: 'm',
  tools: ['bash'],
};

/** A deterministic concurrency barrier (a macrotask boundary) — proves
 *  overlap structurally, not by racing wall-clock delays against each other. */
function macrotaskBarrier(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Minimal valid CorpusRecord: a defined `synthesis` with no steps is enough
 *  to clear the empty-packet guard (mono #1782 guard 2), so a hit that wins
 *  the merge actually surfaces as a packet. */
function minimalRecord(ref: string, summary: string): CorpusRecord {
  return {
    ref,
    task: { summary },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis: `${summary} — synthesis text standing in as evidence.`,
    steps: [],
    tags: [],
    provenance: 'imported',
    origin: `seed:${ref}`,
    capturedAt: '2026-07-16T00:00:00.000Z',
    retrievalVisible: true,
  };
}

describe('firstTurnPickup — concurrent per-term corpus search (mono #1795)', () => {
  it('issues per-term searches concurrently: max in-flight exceeds 1 for a multi-term message', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const corpus: CorpusPort = {
      async search(term): Promise<PortResult<KnowledgeHit[]>> {
        calls.push(term);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await macrotaskBarrier();
        inFlight -= 1;
        return ok([]);
      },
      async get(): Promise<PortResult<CorpusRecord | null>> {
        return ok(null);
      },
    };

    const plugin = buildPlugin(corpus);
    const session = plugin.session(META);
    await session.firstTurnPickup('alpha beta gamma delta');

    expect(calls).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    // A sequential `for...await` loop can never have more than one search in
    // flight at a time; only issuing before awaiting reaches maxInFlight > 1.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("merges hits in term order: two terms returning the same ref keep the first term's hit", async () => {
    // 'alpha' (first derived term) carries a hit that matches both derived
    // terms (score 2, clears the relevance floor). 'beta' (second term)
    // carries a same-ref hit that matches neither term (score 0, below the
    // floor). First-term-wins merge keeps the alpha version, so bafyMarker
    // clears the floor and surfaces; a merge that let beta overwrite it
    // would drop bafyMarker below the floor and no packet would appear.
    // Beta is made to resolve BEFORE alpha (the opposite of term order) so
    // this also proves the merge follows original term order, not
    // resolution order.
    const alphaHit: KnowledgeHit = {
      ref: 'bafyMarker',
      kind: 'trace',
      snippet: 'alpha beta content match',
      tags: [],
      tier: 'tests-passed',
      retrievalVisible: true,
    };
    const betaHit: KnowledgeHit = {
      ref: 'bafyMarker',
      kind: 'trace',
      snippet: 'unrelated other stuff nothing',
      tags: [],
      tier: 'tests-passed',
      retrievalVisible: true,
    };
    const corpus: CorpusPort = {
      async search(term): Promise<PortResult<KnowledgeHit[]>> {
        if (term === 'alpha') {
          await macrotaskBarrier(); // settles after beta despite being first in term order
          return ok([alphaHit]);
        }
        if (term === 'beta') return ok([betaHit]);
        return ok([]);
      },
      async get(ref): Promise<PortResult<CorpusRecord | null>> {
        if (ref !== 'bafyMarker') return ok(null);
        return ok(minimalRecord('bafyMarker', 'alpha beta content record'));
      },
    };

    const plugin = buildPlugin(corpus);
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('alpha beta');

    expect(result.packets.map((p) => p.ref)).toEqual(['bafyMarker']);
  });

  it('degradedReason is the first non-ok result in term order, even when a later term resolves first', async () => {
    const corpus: CorpusPort = {
      async search(term): Promise<PortResult<KnowledgeHit[]>> {
        if (term === 'alpha') return ok([]);
        if (term === 'beta') {
          await macrotaskBarrier(); // settles after gamma despite being second in term order
          return unavailable('beta reason');
        }
        if (term === 'gamma') return unavailable('gamma reason');
        return ok([]);
      },
      async get(): Promise<PortResult<CorpusRecord | null>> {
        return ok(null);
      },
    };

    const plugin = buildPlugin(corpus);
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('alpha beta gamma');

    expect(result.degraded).toBe('beta reason');
  });

  it("a rejected search for one term contributes nothing and is captured as degraded; the other terms' results still surface", async () => {
    const corpus: CorpusPort = {
      async search(term): Promise<PortResult<KnowledgeHit[]>> {
        if (term === 'alpha') throw new Error('alpha network exploded');
        if (term === 'beta') {
          return ok([{
            ref: 'bafyBetaHit',
            kind: 'trace',
            snippet: 'alpha beta content',
            tags: [],
            tier: 'tests-passed',
            retrievalVisible: true,
          }]);
        }
        return ok([]);
      },
      async get(ref): Promise<PortResult<CorpusRecord | null>> {
        if (ref !== 'bafyBetaHit') return ok(null);
        return ok(minimalRecord('bafyBetaHit', 'alpha beta content record'));
      },
    };

    const plugin = buildPlugin(corpus);
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('alpha beta');

    expect(result.packets.map((p) => p.ref)).toEqual(['bafyBetaHit']);
    expect(result.degraded).toContain('alpha network exploded');
  });
});
