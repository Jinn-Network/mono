import { describe, expect, it } from 'vitest';
import { createJinnPlugin } from '../../src/index.js';
import {
  InMemoryContributionPort,
  InMemoryCorpusPort,
  InMemoryEvidencePort,
  InMemoryLocalLearningPort,
  InMemorySkillsPort,
} from '../../src/testing.js';
import { unavailable, type PortResult } from '../../src/outcome.js';
import type { CorpusPort, CorpusRecord } from '../../src/ports/corpus-port.js';
import type { KnowledgeHit } from '../../src/schemas/knowledge-hit.js';
import type { InMemoryCorpusSeed } from '../../src/testing/in-memory-corpus.js';

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
  taskSummary: 'tdd refactor',
  harness: { name: 'hermes', version: '0.1.0' },
  model: 'm',
  tools: ['bash'],
};

/** The seeded source episode — a dashboard version-status flake fix, mirroring
 *  the rescope §4.2 seed shape (task A). */
function sourceEvidence(overrides: Partial<InMemoryCorpusSeed> = {}): InMemoryCorpusSeed {
  return {
    ref: 'bafySourceEpisode',
    kind: 'trace',
    task: { summary: 'Fix the dashboard version-status flake', repositorySlug: 'Jinn-Network/mono' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis: 'The version-status fetch was unawaited, so the test raced the promise. Awaiting it fixed the flake.',
    steps: [
      {
        name: 'run tests',
        attributes: {
          'tool.args': 'yarn --cwd client test dashboard/version-status',
          'tool.result': 'FAIL: expected "up to date" got "checking..."',
          'tool.exitCode': 1,
        },
      },
      {
        name: 'apply fix',
        attributes: { 'tool.args': 'await fetchVersionStatus()', 'tool.exitCode': 0 },
      },
      {
        name: 'rerun tests',
        attributes: {
          'tool.args': 'yarn --cwd client test dashboard/version-status',
          'tool.result': '3 passed',
          'tool.exitCode': 0,
        },
      },
    ],
    tags: ['mono', 'dashboard', 'vitest', 'version-status', 'async', 'flake'],
    provenance: 'imported',
    origin: 'seed:mono-dashboard-flake',
    capturedAt: '2026-07-04T00:00:00.000Z',
    tier: 'tests-passed',
    ...overrides,
  };
}

/** D1: same-repo, different-module distractor. */
function distractorSameRepo(): InMemoryCorpusSeed {
  return {
    ref: 'bafyDistractorD1',
    kind: 'trace',
    task: { summary: 'Warn when joinedSolverNets entry skips claim registration', repositorySlug: 'Jinn-Network/mono' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    steps: [],
    tags: ['mono', 'operator', 'claim-registration'],
    provenance: 'imported',
    origin: 'seed:mono-operator-warn',
    capturedAt: '2026-07-05T00:00:00.000Z',
    tier: 'tests-passed',
  };
}

/** D2: different-domain distractor. */
function distractorDifferentDomain(): InMemoryCorpusSeed {
  return {
    ref: 'bafyDistractorD2',
    kind: 'trace',
    task: { summary: 'Fix the sympy latex printer regression' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    steps: [],
    tags: ['sympy', 'latex', 'printer'],
    provenance: 'imported',
    origin: 'seed:sympy-latex',
    capturedAt: '2026-07-03T00:00:00.000Z',
    tier: 'tests-passed',
  };
}

/** D3/D4: a duplicated skill seed pair — must never surface from pickup. */
function skillDistractor(ref: string): InMemoryCorpusSeed {
  return {
    ref,
    kind: 'skill',
    title: 'implement',
    task: { summary: 'Seed import: acme/skills/implement' },
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    steps: [],
    tags: ['dashboard', 'vitest', 'implement'],
    provenance: 'imported',
    origin: 'seed:acme-implement',
    capturedAt: '2026-07-02T00:00:00.000Z',
    tier: 'user-accepted',
    payloadKind: 'skill',
  };
}

const TARGET_MESSAGE = 'the dashboard `version-status` test is flaking on vitest, likely an unawaited async fetch';

describe('firstTurnPickup over ports — evidence-first pickup (rescope §3/§4.5)', () => {
  it('scenario 1: provides relevant evidence content (not metadata) for a matching task', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([sourceEvidence()]));
    const session = plugin.session({ ...META, repositorySlug: 'Jinn-Network/mono' });
    const result = await session.firstTurnPickup(TARGET_MESSAGE);

    expect(result.packets).toHaveLength(1);
    expect(result.packets[0]?.ref).toBe('bafySourceEpisode');
    expect(result.contextBlock).toContain('[jinn corpus] Prior evidence relevant to this task:');
    // Content, not just metadata: a distinctive excerpt string that is not itself a search term.
    expect(result.contextBlock).toContain('expected "up to date" got "checking..."');
    expect(result.contextBlock).toContain('await fetchVersionStatus()');
    expect(result.contextBlock).toContain('source: bafySourceEpisode');
    expect(result.contextBlock).toContain('corpus_fetch bafySourceEpisode');
  });

  it('scenario 2: the most relevant record wins; distractors are excluded', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([
      sourceEvidence(),
      distractorSameRepo(),
      distractorDifferentDomain(),
    ]));
    const session = plugin.session({ ...META, repositorySlug: 'Jinn-Network/mono' });
    const result = await session.firstTurnPickup(TARGET_MESSAGE);

    expect(result.packets.map((p) => p.ref)).toEqual(['bafySourceEpisode']);
    expect(result.contextBlock).not.toContain('bafyDistractorD1');
    expect(result.contextBlock).not.toContain('bafyDistractorD2');
  });

  it('scenario 3: honest no-result when nothing clears the relevance floor', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([sourceEvidence(), distractorDifferentDomain()]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('investigate quasar unobtainium levels');

    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
  });

  it('scenario 4: retrieval unavailable proceeds honestly with a degraded reason, no injection', async () => {
    const brokenCorpus: CorpusPort = {
      async search(): Promise<PortResult<KnowledgeHit[]>> {
        return unavailable('corpus offline');
      },
      async get(): Promise<PortResult<CorpusRecord | null>> {
        return unavailable('corpus offline');
      },
    };
    const plugin = buildPlugin(brokenCorpus);
    const session = plugin.session(META);
    const result = await session.firstTurnPickup(TARGET_MESSAGE);

    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
    expect(result.degraded).toBe('corpus offline');
  });

  it('scenario boundary: skill records (including duplicates) never surface from pickup', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([
      sourceEvidence(),
      skillDistractor('bafySkillD3'),
      skillDistractor('bafySkillD4'),
    ]));
    const session = plugin.session({ ...META, repositorySlug: 'Jinn-Network/mono' });
    const result = await session.firstTurnPickup(TARGET_MESSAGE);

    expect(result.packets.map((p) => p.ref)).toEqual(['bafySourceEpisode']);
    expect(result.contextBlock).not.toContain('skills install');
    expect(result.contextBlock).not.toContain('bafySkillD3');
    expect(result.contextBlock).not.toContain('bafySkillD4');
  });

  it('records the searched terms even when nothing is found', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('fix `retryBudget` in the dashboard');
    expect(result.searchedTerms).toContain('retrybudget');
  });

  it('fails open on empty terms (all stopwords / blank)', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([sourceEvidence()]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('how do you help');
    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
    expect(result.searchedTerms).toEqual([]);
  });

  it('is a no-op when config disables pickup', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([sourceEvidence()]));
    const session = plugin.session({
      ...META,
      pickup: { enabled: false, autoAdopt: false, autoAdoptTier: 'evaluator-verified', maxCandidates: 3 },
    });
    const result = await session.firstTurnPickup(TARGET_MESSAGE);
    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
  });
});
