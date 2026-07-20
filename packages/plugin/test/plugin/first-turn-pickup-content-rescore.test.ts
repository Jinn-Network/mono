// Mono #1792: metadata search can identify a plausible record (score 1)
// while the vocabulary that proves relevance lives only in the fetched
// synthesis or step titles. These tests pin the bounded, deterministic
// content-rescore escalation without widening the metadata hot path.
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

const META = {
  sessionId: 'content-rescore',
  taskSummary: 'content rescore probe',
  harness: { name: 'hermes', version: '0.1.0' },
  model: 'm',
  tools: ['bash'],
};

function buildPlugin(corpus: CorpusPort) {
  return createJinnPlugin({
    corpus,
    evidence: new InMemoryEvidencePort(),
    contribution: new InMemoryContributionPort(),
    localLearning: new InMemoryLocalLearningPort(),
    skills: new InMemorySkillsPort(),
  });
}

function hit(
  ref: string,
  snippet: string,
  overrides: Partial<KnowledgeHit> = {},
): KnowledgeHit {
  return {
    ref,
    kind: 'trace',
    snippet,
    tags: [],
    tier: 'tests-passed',
    origin: `seed:${ref}`,
    publishedAt: 1,
    retrievalVisible: true,
    ...overrides,
  };
}

function record(
  ref: string,
  overrides: Partial<CorpusRecord> = {},
): CorpusRecord {
  return {
    ref,
    task: { summary: 'alpha metadata candidate' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis: 'beta evidence from the fetched record',
    steps: [],
    tags: [],
    provenance: 'imported',
    origin: `seed:${ref}`,
    capturedAt: '2026-07-20T00:00:00.000Z',
    retrievalVisible: true,
    ...overrides,
  };
}

function fixedCorpus(
  hits: KnowledgeHit[],
  get: (ref: string) => Promise<PortResult<CorpusRecord | null>>,
): CorpusPort {
  return {
    async search(): Promise<PortResult<KnowledgeHit[]>> {
      return ok(hits);
    },
    get,
  };
}

describe('firstTurnPickup — bounded content rescore escalation (#1792)', () => {
  it('promotes a score-1 metadata candidate when synthesis matches another original term, fetching it only once', async () => {
    const getCalls: string[] = [];
    const corpus = fixedCorpus([hit('synthesis-match', 'alpha')], async (ref) => {
      getCalls.push(ref);
      return ok(record(ref, { synthesis: 'the beta regression was fixed by awaiting the request' }));
    });

    const result = await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(result.packets.map((packet) => packet.ref)).toEqual(['synthesis-match']);
    expect(getCalls).toEqual(['synthesis-match']);
  });

  it('promotes a score-1 metadata candidate when a step title matches another original term', async () => {
    const corpus = fixedCorpus([hit('step-match', 'alpha')], async (ref) =>
      ok(record(ref, {
        synthesis: undefined,
        steps: [{
          name: 'seed:step:fix',
          attributes: {
            'seed.step.title': 'diagnose beta race',
            'tool.args': 'yarn test beta-race',
            'tool.result': 'the race reproduced',
            'tool.exitCode': 1,
          },
        }],
      })));

    const result = await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(result.packets.map((packet) => packet.ref)).toEqual(['step-match']);
  });

  it('counts unique original terms across metadata and content, so repeating the same term does not cross the floor', async () => {
    const getCalls: string[] = [];
    const corpus = fixedCorpus([hit('repeat-only', 'alpha')], async (ref) => {
      getCalls.push(ref);
      return ok(record(ref, { synthesis: 'alpha appears again; no other query vocabulary occurs' }));
    });

    const result = await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(getCalls).toEqual(['repeat-only']);
    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
  });

  it('does no content gets when every metadata candidate scores zero, even if fetched content could have matched', async () => {
    const getCalls: string[] = [];
    const corpus = fixedCorpus([hit('score-zero', 'unrelated')], async (ref) => {
      getCalls.push(ref);
      return ok(record(ref, { synthesis: 'alpha beta would match if fetched' }));
    });

    const result = await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(getCalls).toEqual([]);
    expect(result.packets).toEqual([]);
  });

  it('fetches at most the first three deterministically ranked near-misses', async () => {
    const hits = [
      hit('rank-4', 'alpha', { publishedAt: 1 }),
      hit('rank-2', 'alpha', { publishedAt: 3 }),
      hit('rank-1', 'alpha', { publishedAt: 4 }),
      hit('rank-3', 'alpha', { publishedAt: 2 }),
    ];
    const getCalls: string[] = [];
    const corpus = fixedCorpus(hits, async (ref) => {
      getCalls.push(ref);
      return ok(record(ref));
    });

    await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(getCalls).toEqual(['rank-1', 'rank-2', 'rank-3']);
  });

  it('issues the three escalation gets concurrently but keeps packet and failure ordering deterministic', async () => {
    const hits = [
      hit('rank-3', 'alpha', { publishedAt: 1 }),
      hit('rank-1-fails', 'alpha', { publishedAt: 3 }),
      hit('rank-2', 'alpha', { publishedAt: 2 }),
    ];
    const getCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const corpus = fixedCorpus(hits, async (ref) => {
      getCalls.push(ref);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (ref === 'rank-1-fails') return unavailable('rank-1 unavailable');
      return ok(record(ref));
    });

    const result = await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(maxInFlight).toBeGreaterThan(1);
    expect(getCalls).toEqual(['rank-1-fails', 'rank-2', 'rank-3']);
    expect(result.packets.map((packet) => packet.ref)).toEqual(['rank-2', 'rank-3']);
    expect(result.degraded).toBe('rank-1 unavailable');
  });

  it('deduplicates near-misses before escalation and never refetches the promoted record', async () => {
    const duplicateIdentity = { snippet: 'alpha', origin: 'seed:same-content' };
    const hits = [
      hit('first-copy', 'alpha', duplicateIdentity),
      hit('second-copy', 'alpha', duplicateIdentity),
    ];
    const getCalls: string[] = [];
    const corpus = fixedCorpus(hits, async (ref) => {
      getCalls.push(ref);
      return ok(record(ref));
    });

    const result = await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(getCalls).toEqual(['first-copy']);
    expect(result.packets.map((packet) => packet.ref)).toEqual(['first-copy']);
  });

  it('applies post-fetch skill and retrieval-visibility guards before promotion', async () => {
    const hits = [
      hit('skill-payload', 'alpha', { publishedAt: 3 }),
      hit('content-invisible', 'alpha', { publishedAt: 2 }),
      hit('valid', 'alpha', { publishedAt: 1 }),
    ];
    const getCalls: string[] = [];
    const corpus = fixedCorpus(hits, async (ref) => {
      getCalls.push(ref);
      if (ref === 'skill-payload') return ok(record(ref, { isSkillPayload: true }));
      if (ref === 'content-invisible') return ok(record(ref, { retrievalVisible: false }));
      return ok(record(ref));
    });

    const result = await buildPlugin(corpus).session(META).firstTurnPickup('alpha beta');

    expect(getCalls).toEqual(['skill-payload', 'content-invisible', 'valid']);
    expect(result.packets.map((packet) => packet.ref)).toEqual(['valid']);
    expect(result.contextBlock).not.toContain('skill-payload');
    expect(result.contextBlock).not.toContain('content-invisible');
  });
});
