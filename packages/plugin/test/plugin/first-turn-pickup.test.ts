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

/**
 * Mono #1782 — the live R6 escalation: a legacy pre-#1394 seed-imported skill
 * record. The seed-import lane (`seed-import/execute.ts` `toCapturedTask`)
 * publishes the SKILL.md as a single synthetic step named `seed:skill-md`
 * carrying a string `skill.md` attribute — no first-class `jinn.skill.v1`
 * artifact — so the real indexer classifies it `kind: 'trace'` on the wire
 * (`consume.ts` `toSearchHit`: kind is derived from artifact presence only).
 * The structural shape (step name + attribute key) mirrors the real
 * RunComfy record verbatim; only the tags/summary vocabulary is invented so
 * this fixture can be scored deterministically without a live indexer.
 */
function runComfySkillLeak(): InMemoryCorpusSeed {
  return {
    ref: 'bafyRunComfySkillLeak',
    kind: 'trace', // wire kind lies for a legacy skill-shaped seed — this is the bug.
    task: { summary: 'Seed import: agentspace-so/runcomfy-agent-skills/video-edit' },
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    steps: [
      {
        name: 'seed:skill-md',
        attributes: {
          'skill.md': '# Video Edit\n\nEdit video clips with RunComfy workflows.',
          'seed.attribution': {
            skill: 'agentspace-so/runcomfy-agent-skills/video-edit',
            source: 'https://github.com/agentspace-so/runcomfy-agent-skills',
            licence: 'MIT',
          },
        },
      },
    ],
    tags: ['seed-import', 'runcomfy-agent-skills', 'video-edit'],
    provenance: 'imported',
    origin: 'seed:runcomfy-video-edit',
    capturedAt: '2026-07-02T00:00:00.000Z',
    tier: 'user-accepted',
    // Content-level fact the corpus adapter derives from the skill.md step
    // attribute (client/packages/harness-layer/src/adapters/corpus-adapter.ts)
    // — hand-set here because the plugin package never decodes trace
    // envelopes itself; that derivation is covered by
    // client/packages/harness-layer/test/adapters/corpus-adapter.test.ts.
    isSkillPayload: true,
  };
}

/** Real evidence paired with the leak above — the record the live
 *  escalation's "two packets" bug still ought to deliver once the leak is
 *  excluded. */
function checkoutEvidence(): InMemoryCorpusSeed {
  return {
    ref: 'bafyCheckoutEvidence',
    kind: 'trace',
    task: { summary: 'Fix the checkout button double-submit bug' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis:
      'The submit handler was not debounced, so a fast double click double-submitted '
      + 'the checkout order. Adding a debounce guard fixed it.',
    steps: [
      {
        name: 'run tests',
        attributes: {
          'tool.args': 'yarn test checkout',
          'tool.result': 'FAIL: expected 1 submit got 2',
          'tool.exitCode': 1,
        },
      },
      { name: 'apply fix', attributes: { 'tool.args': 'add debounce guard', 'tool.exitCode': 0 } },
    ],
    tags: ['checkout', 'double-submit', 'debounce'],
    provenance: 'imported',
    origin: 'seed:checkout-double-submit',
    capturedAt: '2026-07-10T00:00:00.000Z',
    tier: 'tests-passed',
  };
}

/** Defensive scenario (mono #1782 guard 1, second case): a first-class
 *  `jinn.skill.v1`-backed record whose wire `kind` is (still, somehow)
 *  `'trace'` — content-level classification must exclude it independent of
 *  *why* the wire kind under-reported. */
function distilledSkillLeak(): InMemoryCorpusSeed {
  return {
    ref: 'bafyDistilledSkillLeak',
    kind: 'trace',
    task: { summary: 'Distilled skill: retry-budget-tuning' },
    outcome: { status: 'completed', verifiabilityTier: 'evaluator-verified' },
    steps: [{ name: 'distill', attributes: { 'tool.args': 'distill retry-budget-tuning', 'tool.exitCode': 0 } }],
    tags: ['retry-budget-tuning', 'distilled'],
    provenance: 'contributed',
    origin: 'agent-distill-1',
    capturedAt: '2026-07-12T00:00:00.000Z',
    tier: 'evaluator-verified',
    isSkillPayload: true, // adapter found a jinn.skill.v1 artifact on the record
  };
}

/** Mono #1782 guard 2: a record whose steps carry nothing excerpt-shaped and
 *  no synthesis — `projectKnowledgePacket` yields zero excerpts. Not
 *  evidence; must not consume a packet slot. */
function emptyPacketDecoy(): InMemoryCorpusSeed {
  return {
    ref: 'bafyEmptyPacketDecoy',
    kind: 'trace',
    task: { summary: 'Investigate the payment retry queue backlog' },
    outcome: { status: 'completed', verifiabilityTier: 'evaluator-verified' },
    steps: [],
    tags: ['payment', 'retry-queue', 'backlog'],
    provenance: 'imported',
    origin: 'seed:payment-retry-queue',
    capturedAt: '2026-07-11T00:00:00.000Z',
    tier: 'evaluator-verified',
  };
}

/** The next-ranked, genuinely evidential record the empty decoy above must
 *  promote to once dropped. */
function paymentRetryFix(): InMemoryCorpusSeed {
  return {
    ref: 'bafyPaymentRetryFix',
    kind: 'trace',
    task: { summary: 'Fix the payment retry queue backlog by capping retry count' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis:
      'The retry queue had no max-attempts cap, so poison messages recirculated forever. '
      + 'Capping retries at 5 cleared the backlog.',
    steps: [
      {
        name: 'run tests',
        attributes: {
          'tool.args': 'yarn test retry-queue',
          'tool.result': 'FAIL: queue depth 500 after 1h',
          'tool.exitCode': 1,
        },
      },
      { name: 'apply fix', attributes: { 'tool.args': 'cap retries at 5', 'tool.exitCode': 0 } },
    ],
    tags: ['payment', 'retry-queue', 'backlog'],
    provenance: 'imported',
    origin: 'seed:payment-retry-queue-fix',
    capturedAt: '2026-07-13T00:00:00.000Z',
    tier: 'tests-passed',
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

  // Mono #1782 — the live R6 escalation (next @ 1ae580dd3): a natural,
  // on-topic message returned two packets — the seeded evidence record, and
  // the legacy RunComfy skill seed (kind:'trace' on the wire, slipping the
  // rescope's kind:'skill' selection filter, then projecting empty). This
  // test PINS that regression: pre-fix it returns both refs (mirroring the
  // live "two packets" symptom); post-fix only the real evidence surfaces.
  it('mono #1782 pin: a legacy skill-shaped seed (skill.md step attribute, wire kind trace) is excluded by content even though it clears the relevance floor, and the co-ranked real evidence still surfaces', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([
      checkoutEvidence(),
      runComfySkillLeak(),
    ]));
    const session = plugin.session(META);
    const message =
      'the checkout double-submit bug needs a fix, and please check the runcomfy video-edit skill workflow too';
    const result = await session.firstTurnPickup(message);

    expect(result.packets.map((p) => p.ref)).toEqual(['bafyCheckoutEvidence']);
    expect(result.contextBlock).not.toContain('bafyRunComfySkillLeak');
    expect(result.contextBlock).not.toContain('runcomfy');
  });

  it('mono #1782 guard 1: a legacy skill-shaped seed alone yields an honest nothing-found, not an empty injected packet', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([runComfySkillLeak()]));
    const session = plugin.session(META);
    const message = 'please help me use the `runcomfy-agent-skills` video-edit skill';
    const result = await session.firstTurnPickup(message);

    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
  });

  it('mono #1782 guard 1: a first-class jinn.skill.v1-backed record is excluded by content even when the wire kind says trace', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([distilledSkillLeak()]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('please apply the retry-budget-tuning distilled skill');

    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
  });

  it('mono #1782 guard 2: a zero-excerpt, no-synthesis packet is dropped and the next above-floor candidate is promoted into its slot', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([
      emptyPacketDecoy(),
      paymentRetryFix(),
    ]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('the payment retry queue backlog needs a fix');

    expect(result.packets.map((p) => p.ref)).toEqual(['bafyPaymentRetryFix']);
    expect(result.contextBlock).not.toContain('bafyEmptyPacketDecoy');
  });

  it('mono #1782 guard 2: a zero-excerpt, no-synthesis packet with nothing to promote yields an honest nothing-found', async () => {
    const plugin = buildPlugin(new InMemoryCorpusPort([emptyPacketDecoy()]));
    const session = plugin.session(META);
    const result = await session.firstTurnPickup('the payment retry queue backlog needs a fix');

    expect(result.packets).toEqual([]);
    expect(result.contextBlock).toBeNull();
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
