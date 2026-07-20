import { describe, expect, it } from 'vitest';

import {
  analyzeAttributionInstrument,
  renderAttributionReadoutMarkdown,
  type AttributionFacts,
  type AttributionPreregistration,
  type MarketplaceArm,
} from '../../src/eval/attribution-instrument.js';

const MARKETPLACE_ARMS: MarketplaceArm[] = ['seedsOnly', 'rawEvidence', 'distilled'];

function prereg(overrides: Partial<AttributionPreregistration> = {}): AttributionPreregistration {
  return {
    schema: 'jinn.attribution-preregistration.v1',
    instrumentId: 'stage2-c12-first-readout',
    registeredAt: '2026-07-20T08:00:00.000Z',
    design: 'matched-crossed-3x2',
    window: {
      startsAt: '2026-07-21T08:00:00.000Z',
      endsAt: '2026-07-22T08:00:00.000Z',
    },
    primaryOutcome: 'completed-with-accepted-diff',
    primaryMarketplaceArm: 'rawEvidence',
    alpha: 0.05,
    minimumMatchedPairs: 6,
    minimumDiscordantPairs: 6,
    executionOrderSeed: 'sha256:fixed-before-run',
    runtime: {
      modelRef: 'provider/model@version',
      harnessRef: 'swe-rebench-v2.v1',
      graderRef: 'eval-semantics:v1',
      taskSourceRef: 'held-out-slate:v3',
      sourceRevision: '33abcbd1ed7ebe98c6c774ff2857afb023deaf7d',
    },
    population: {
      instanceIds: Array.from({ length: 12 }, (_, index) => `task-${index}`),
    },
    cells: MARKETPLACE_ARMS.flatMap((marketplaceArm) =>
      (['off', 'on'] as const).map((autoload) => ({
        marketplaceArm,
        autoload,
        corpusSnapshotRef: `bafy-${marketplaceArm}`,
      }))),
    ...overrides,
  };
}

function facts(
  passCounts: Partial<Record<`${MarketplaceArm}:off` | `${MarketplaceArm}:on`, number>> = {},
): AttributionFacts {
  const registration = prereg();
  return {
    schema: 'jinn.attribution-facts.v1',
    instrumentId: registration.instrumentId,
    completedAt: '2026-07-22T09:00:00.000Z',
    runtime: registration.runtime,
    cells: registration.cells.map((cell) => {
      const count = passCounts[`${cell.marketplaceArm}:${cell.autoload}`] ?? 6;
      return {
        ...cell,
        results: registration.population.instanceIds.map((instanceId, index) => ({
          instanceId,
          passed: index < count,
          unscorable: false,
          sessionKind: 'user' as const,
          origin: 'marketplace',
          verdictRef: `verdict:${instanceId}:${cell.marketplaceArm}:${cell.autoload}`,
          deliveredRefs: cell.autoload === 'on'
            ? [`sha256:${cell.marketplaceArm}:${instanceId}`]
            : [],
        })),
      };
    }),
  };
}

const AFTER_WINDOW = new Date('2026-07-22T10:00:00.000Z');

describe('Stage 2 attribution instrument', () => {
  it('produces a reproducible primary helped signal with design, N, paired facts, and Wilson context', () => {
    const registration = prereg();
    const recorded = facts({
      'rawEvidence:off': 0,
      'rawEvidence:on': 10,
    });

    const readout = analyzeAttributionInstrument(registration, recorded, { now: AFTER_WINDOW });

    expect(readout.schema).toBe('jinn.attribution-readout.v1');
    expect(readout.design).toBe('matched-crossed-3x2');
    expect(readout.primaryOutcome).toBe('completed-with-accepted-diff');
    expect(readout.runtime).toEqual(registration.runtime);
    expect(readout.preregistrationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readout.factsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readout.cells).toEqual(registration.cells);
    expect(readout.plannedN).toBe(12);
    expect(readout.primary.marketplaceArm).toBe('rawEvidence');
    expect(readout.primary.primary).toBe(true);
    expect(readout.primary.signal).toBe('helped');
    expect(readout.primary.matchedN).toBe(12);
    expect(readout.primary.improved).toBe(10);
    expect(readout.primary.regressed).toBe(0);
    expect(readout.primary.pValue).toBeLessThan(0.05);
    expect(readout.primary.offRate).toMatchObject({ passed: 0, scorable: 12 });
    expect(readout.primary.onRate).toMatchObject({ passed: 10, scorable: 12 });
    expect(readout.primary.onDeliveredRefsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readout.primary.offDeliveredRefsDigest).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(readout.exploratory.map((item) => item.marketplaceArm).sort()).toEqual(['distilled', 'seedsOnly']);
  });

  it('classifies a powered negative direction as harmed and a powered balanced result as no difference detected', () => {
    const harmed = analyzeAttributionInstrument(
      prereg(),
      facts({ 'rawEvidence:off': 10, 'rawEvidence:on': 0 }),
      { now: AFTER_WINDOW },
    );
    expect(harmed.primary.signal).toBe('harmed');

    const noDifferenceFacts = facts();
    const rawOff = noDifferenceFacts.cells.find(
      (cell) => cell.marketplaceArm === 'rawEvidence' && cell.autoload === 'off',
    )!;
    const rawOn = noDifferenceFacts.cells.find(
      (cell) => cell.marketplaceArm === 'rawEvidence' && cell.autoload === 'on',
    )!;
    rawOff.results.forEach((result, index) => { result.passed = index < 3 || (index >= 6 && index < 9); });
    rawOn.results.forEach((result, index) => { result.passed = index >= 3 && index < 9; });

    const noDifference = analyzeAttributionInstrument(prereg(), noDifferenceFacts, { now: AFTER_WINDOW });
    expect(noDifference.primary).toMatchObject({
      signal: 'no-difference-detected',
      improved: 3,
      regressed: 3,
      discordant: 6,
      barMet: true,
    });
  });

  it('keeps an underpowered result inconclusive instead of converting a null into no difference', () => {
    const readout = analyzeAttributionInstrument(prereg(), facts(), { now: AFTER_WINDOW });
    expect(readout.primary).toMatchObject({
      signal: 'inconclusive',
      discordant: 0,
      barMet: false,
    });
  });

  it('rejects a preregistered discordant bar that cannot reach the selected alpha', () => {
    expect(() => analyzeAttributionInstrument(
      prereg({ minimumDiscordantPairs: 5 }),
      facts(),
      { now: AFTER_WINDOW },
    )).toThrow(/cannot reach significance/i);
  });

  it('renders the mechanical readout without claiming the human interpretation happened', () => {
    const readout = analyzeAttributionInstrument(
      prereg(),
      facts({ 'rawEvidence:off': 0, 'rawEvidence:on': 10 }),
      { now: AFTER_WINDOW },
    );
    const markdown = renderAttributionReadoutMarkdown(readout);

    expect(markdown).toContain('# Stage 2 attribution readout');
    expect(markdown).toContain('Design: matched-crossed-3x2');
    expect(markdown).toContain('Primary outcome: completed-with-accepted-diff');
    expect(markdown).toContain('Primary marketplace arm: rawEvidence');
    expect(markdown).toContain('Matched N: 12');
    expect(markdown).toContain('Mechanical signal: helped');
    expect(markdown).toContain('Interpretation and downstream posture decisions remain human');
  });

  it.each([
    {
      name: 'readout before the frozen window closes',
      mutate: (_registration: AttributionPreregistration, _recorded: AttributionFacts) => {},
      now: new Date('2026-07-22T07:59:59.000Z'),
      error: /fixed evaluation window has not closed/i,
    },
    {
      name: 'facts marked complete before the frozen window ends',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.completedAt = '2026-07-22T07:00:00.000Z';
      },
      now: AFTER_WINDOW,
      error: /before the fixed evaluation window ended/i,
    },
    {
      name: 'missing one of the six cells',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells.pop();
      },
      now: AFTER_WINDOW,
      error: /exactly six cells/i,
    },
    {
      name: 'snapshot drift between preregistration and facts',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells[0]!.corpusSnapshotRef = 'bafy-drifted';
      },
      now: AFTER_WINDOW,
      error: /snapshot/i,
    },
    {
      name: 'execution order drift',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells.reverse();
      },
      now: AFTER_WINDOW,
      error: /execution order/i,
    },
    {
      name: 'runtime provenance drift',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.runtime.modelRef = 'different/model';
      },
      now: AFTER_WINDOW,
      error: /runtime provenance/i,
    },
    {
      name: 'task population drift',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells[0]!.results[0]!.instanceId = 'not-preregistered';
      },
      now: AFTER_WINDOW,
      error: /population/i,
    },
    {
      name: 'host-internal observation',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells[0]!.results[0]!.sessionKind = 'host-internal';
      },
      now: AFTER_WINDOW,
      error: /sessionKind=user/i,
    },
    {
      name: 'synthetic-origin observation',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells[0]!.results[0]!.origin = 'synthetic';
      },
      now: AFTER_WINDOW,
      error: /synthetic/i,
    },
    {
      name: 'missing verdict grounding',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells[0]!.results[0]!.verdictRef = '';
      },
      now: AFTER_WINDOW,
      error: /verdict/i,
    },
    {
      name: 'autoload-off delivery',
      mutate: (_registration: AttributionPreregistration, recorded: AttributionFacts) => {
        recorded.cells[0]!.results[0]!.deliveredRefs = ['sha256:should-not-be-here'];
      },
      now: AFTER_WINDOW,
      error: /autoload-off/i,
    },
  ])('fails closed on $name', ({ mutate, now, error }) => {
    const registration = prereg();
    const recorded = facts({ 'rawEvidence:off': 0, 'rawEvidence:on': 10 });
    mutate(registration, recorded);

    expect(() => analyzeAttributionInstrument(registration, recorded, { now })).toThrow(error);
  });
});
