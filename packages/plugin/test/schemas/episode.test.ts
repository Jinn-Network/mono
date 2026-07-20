import { describe, expect, it } from 'vitest';
import {
  EpisodeV1Schema,
  EpisodeV1WriteSchema,
  SessionActivityFactsWriteSchema,
} from '../../src/schemas/episode.js';
import { makeSampleEpisode } from '../_fixtures/episode.js';

const valid = makeSampleEpisode({ episodeId: 'ep-1' });

describe('EpisodeV1Schema', () => {
  it('parses a valid episode', () => {
    const parsed = EpisodeV1Schema.parse(valid);
    expect(parsed.episodeId).toBe('ep-1');
    expect(parsed.trajectory).toHaveLength(3);
    expect(parsed.trajectory.filter((s) => s.kind === 'jinn.agent_turn')).toHaveLength(2);
    expect(parsed.trajectory.filter((s) => s.kind === 'jinn.tool_call')).toHaveLength(1);
  });

  it('rejects an episode with an unknown top-level field (strict)', () => {
    expect(() => EpisodeV1WriteSchema.parse({
      ...valid,
      session: { ...valid.session, kind: 'user' },
      origin: { writer: 'test-writer', build: 'test-build' },
      extra: true,
    })).toThrow();
  });

  it('normalizes legacy optional nulls and delivery aliases on tolerant reads', () => {
    const parsed = EpisodeV1Schema.parse({
      ...valid,
      origin: undefined,
      session: { ...valid.session, parentSessionId: null },
      task: {
        ...valid.task,
        repositorySlug: null,
        baseCommit: null,
        createdAt: null,
        instanceId: null,
      },
      trajectory: valid.trajectory.map((step, index) => (
        index === 0 ? { ...step, truncatedKeys: null } : step
      )),
      environment: {
        ...valid.environment,
        generatorModel: {
          id: 'model',
          provider: null,
          openWeights: null,
          source: 'config',
        },
        distributionClass: null,
        verifier: {
          type: 'none',
          failToPass: [],
          passToPass: [],
          evalSemanticsVersion: null,
        },
      },
      outcome: {
        ...valid.outcome,
        summary: null,
        acceptedDiff: null,
        testRuns: null,
      },
      cost: { ...valid.cost, tokens: null, usdEstimate: null },
      activity: {
        searchedTerms: ['dashboard'],
        providedRefs: ['bafy-delivered'],
        deliveredContentHash: null,
      },
      attemptGroup: {
        groupId: 'group',
        attemptId: 'attempt',
        relatedAttemptRefs: [],
        groupSize: null,
        nPass: null,
        nFail: null,
      },
      eligibility: null,
      lineage: { episodeId: 'ep-0', mintRef: null },
      futureAdditiveField: { preserved: true },
    });

    expect(parsed.session.kind).toBe('user');
    expect(parsed.session).not.toHaveProperty('parentSessionId');
    expect(parsed.origin).toBe('legacy-unstamped');
    expect(parsed.task).not.toHaveProperty('repositorySlug');
    expect(parsed.task).not.toHaveProperty('baseCommit');
    expect(parsed.task).not.toHaveProperty('createdAt');
    expect(parsed.task).not.toHaveProperty('instanceId');
    expect(parsed.trajectory[0]).not.toHaveProperty('truncatedKeys');
    expect(parsed.environment.generatorModel).not.toHaveProperty('provider');
    expect(parsed.environment.generatorModel).not.toHaveProperty('openWeights');
    expect(parsed.environment).not.toHaveProperty('distributionClass');
    expect(parsed.environment.verifier).not.toHaveProperty('evalSemanticsVersion');
    expect(parsed.outcome).not.toHaveProperty('summary');
    expect(parsed.outcome).not.toHaveProperty('acceptedDiff');
    expect(parsed.outcome).not.toHaveProperty('testRuns');
    expect(parsed.cost).not.toHaveProperty('tokens');
    expect(parsed.cost).not.toHaveProperty('usdEstimate');
    expect(parsed.activity).toMatchObject({
      retrievalFired: true,
      eligibleRefs: ['bafy-delivered'],
      deliveredRefs: ['bafy-delivered'],
      deliveryMode: 'delivered',
      providedRefs: ['bafy-delivered'],
    });
    expect(parsed.activity).not.toHaveProperty('deliveredContentHash');
    expect(parsed.attemptGroup).not.toHaveProperty('groupSize');
    expect(parsed.attemptGroup).not.toHaveProperty('nPass');
    expect(parsed.attemptGroup).not.toHaveProperty('nFail');
    expect(parsed).not.toHaveProperty('eligibility');
    expect(parsed.lineage).not.toHaveProperty('mintRef');
    expect(parsed.futureAdditiveField).toEqual({ preserved: true });
  });

  it.each([
    ['environment.generatorModel', {
      ...valid,
      environment: { ...valid.environment, generatorModel: null },
    }],
    ['environment.verifier', {
      ...valid,
      environment: { ...valid.environment, verifier: null },
    }],
    ['attemptGroup', { ...valid, attemptGroup: null }],
    ['lineage', { ...valid, lineage: null }],
  ])('normalizes a read-only null at %s to absence', (_path, input) => {
    const parsed = EpisodeV1Schema.parse(input);
    if (_path === 'environment.generatorModel') {
      expect(parsed.environment).not.toHaveProperty('generatorModel');
    } else if (_path === 'environment.verifier') {
      expect(parsed.environment).not.toHaveProperty('verifier');
    } else {
      expect(parsed).not.toHaveProperty(_path);
    }
  });

  it('preserves future fields in every nested additive read block', () => {
    const parsed = EpisodeV1Schema.parse({
      ...valid,
      environment: {
        ...valid.environment,
        generatorModel: {
          id: 'future-model',
          source: 'config',
          futureGeneratorFact: { family: 'future' },
        },
        verifier: {
          type: 'none',
          futureVerifierFact: ['future'],
        },
      },
      attemptGroup: {
        groupId: 'future-group',
        attemptId: 'future-attempt',
        futureGroupFact: true,
      },
    });

    expect(parsed).toMatchObject({
      environment: {
        generatorModel: {
          futureGeneratorFact: { family: 'future' },
        },
        verifier: {
          failToPass: [],
          passToPass: [],
          futureVerifierFact: ['future'],
        },
      },
      attemptGroup: {
        relatedAttemptRefs: [],
        futureGroupFact: true,
      },
    });
  });

  it('retains the attempt-group count invariant on tolerant reads', () => {
    expect(() => EpisodeV1Schema.parse({
      ...valid,
      attemptGroup: {
        groupId: 'group',
        attemptId: 'attempt',
        relatedAttemptRefs: [],
        groupSize: 3,
        nPass: 1,
        nFail: 1,
      },
    })).toThrow(/groupSize must equal nPass \+ nFail/);
  });

  it('rejects a present activity field with the wrong container instead of defaulting it', () => {
    expect(() => EpisodeV1Schema.parse({
      ...valid,
      activity: {
        searchedTerms: 'dashboard',
      },
    })).toThrow();
  });

  it('rejects wrong-typed activity array members instead of filtering them out', () => {
    expect(() => EpisodeV1Schema.parse({
      ...valid,
      activity: {
        providedRefs: ['bafy-valid', 42],
      },
    })).toThrow();
  });

  it('rejects null for required legacy facts while retaining documented optional nulls', () => {
    expect(() => EpisodeV1Schema.parse({
      ...valid,
      origin: null,
    })).toThrow();
    expect(() => EpisodeV1Schema.parse({
      ...valid,
      activity: {
        providedRefs: null,
      },
    })).toThrow();
  });

  it('requires explicit writer and v1.1 session/delivery facts on strict writes', () => {
    const next = {
      ...valid,
      session: {
        ...valid.session,
        kind: 'host-internal' as const,
        parentSessionId: 'parent-session',
      },
      origin: { writer: 'jinn-agent', build: '0.18.0' },
      task: { ...valid.task, repositorySlug: 'Jinn-Network/mono' },
      outcome: {
        ...valid.outcome,
        acceptedDiff: true,
        testRuns: { passed: 2, failed: 1 },
      },
      activity: {
        retrievalFired: true,
        eligibleRefs: ['bafy-eligible'],
        deliveredRefs: ['bafy-delivered'],
        deliveryMode: 'delivered' as const,
        deliveredContentHash: `sha256:${'a'.repeat(64)}`,
        searchedTerms: ['dashboard'],
        providedRefs: ['bafy-delivered'],
        surfacedRefs: [],
        fetchedRefs: ['bafy-delivered'],
        installedSkillRefs: [],
      },
    };

    expect(EpisodeV1WriteSchema.parse(next)).toEqual({
      ...next,
      retrievalVisible: false,
      outcome: {
        status: next.outcome.status,
        verificationStrength: next.outcome.verificationStrength,
        acceptedDiff: next.outcome.acceptedDiff,
        testRuns: next.outcome.testRuns,
      },
    });
    expect(() => EpisodeV1WriteSchema.parse({
      ...next,
      task: { ...next.task, repositorySlug: null },
    })).toThrow();
  });

  it.each([
    ['session.parentSessionId', {
      ...valid,
      session: { ...valid.session, parentSessionId: null },
    }],
    ['task.baseCommit', {
      ...valid,
      task: { ...valid.task, baseCommit: null },
    }],
    ['trajectory.truncatedKeys', {
      ...valid,
      trajectory: [{ ...valid.trajectory[0], truncatedKeys: null }, ...valid.trajectory.slice(1)],
    }],
    ['environment.generatorModel', {
      ...valid,
      environment: { ...valid.environment, generatorModel: null },
    }],
    ['environment.generatorModel.provider', {
      ...valid,
      environment: {
        ...valid.environment,
        generatorModel: { id: 'model', provider: null, source: 'config' },
      },
    }],
    ['environment.verifier.evalSemanticsVersion', {
      ...valid,
      environment: {
        ...valid.environment,
        verifier: {
          type: 'none',
          failToPass: [],
          passToPass: [],
          evalSemanticsVersion: null,
        },
      },
    }],
    ['attemptGroup.nPass', {
      ...valid,
      attemptGroup: {
        groupId: 'group',
        attemptId: 'attempt',
        relatedAttemptRefs: [],
        nPass: null,
      },
    }],
    ['lineage.mintRef', {
      ...valid,
      lineage: { episodeId: 'ep-0', mintRef: null },
    }],
  ])('strict writers reject null at %s', (_path, input) => {
    expect(() => EpisodeV1WriteSchema.parse(input)).toThrow();
  });

  it.each([
    ['environment.generatorModel', {
      ...valid,
      environment: {
        ...valid.environment,
        generatorModel: {
          id: 'future-model',
          source: 'config',
          futureGeneratorFact: true,
        },
      },
    }],
    ['environment.verifier', {
      ...valid,
      environment: {
        ...valid.environment,
        verifier: {
          type: 'none',
          failToPass: [],
          passToPass: [],
          futureVerifierFact: true,
        },
      },
    }],
    ['attemptGroup', {
      ...valid,
      attemptGroup: {
        groupId: 'future-group',
        attemptId: 'future-attempt',
        relatedAttemptRefs: [],
        futureGroupFact: true,
      },
    }],
  ])('strict writers reject unknown fields at %s', (_path, input) => {
    expect(() => EpisodeV1WriteSchema.parse(input)).toThrow();
  });

  it('writes one canonical verification-strength axis and normalizes the legacy tier name', () => {
    const canonical = {
      ...valid,
      session: { ...valid.session, kind: 'user' as const },
      origin: { writer: 'jinn-agent', build: '0.18.0' },
      outcome: {
        status: valid.outcome.status,
        verificationStrength: 'tests-passed' as const,
      },
    };
    const legacy = {
      ...canonical,
      outcome: {
        status: valid.outcome.status,
        verifiabilityTier: 'tests-passed' as const,
      },
    };

    expect(EpisodeV1WriteSchema.parse(canonical).outcome).toEqual({
      status: 'completed',
      verificationStrength: 'tests-passed',
    });
    expect(EpisodeV1WriteSchema.parse(legacy).outcome).toEqual({
      status: 'completed',
      verificationStrength: 'tests-passed',
    });
    expect(EpisodeV1Schema.parse(legacy).outcome).not.toHaveProperty('verifiabilityTier');
  });

  it('rejects conflicting legacy and canonical verification strengths', () => {
    expect(() => EpisodeV1WriteSchema.parse({
      ...valid,
      session: { ...valid.session, kind: 'user' },
      origin: { writer: 'jinn-agent', build: '0.18.0' },
      outcome: {
        status: 'completed',
        verificationStrength: 'evaluator-verified',
        verifiabilityTier: 'user-accepted',
      },
    })).toThrow();
  });

  it('carries every post-training-readiness delta on the shared episode contract', () => {
    const ready = {
      ...valid,
      session: { ...valid.session, kind: 'user' as const },
      origin: { writer: 'jinn-execution-ledger-bridge', build: '0.1.0' },
      task: {
        ...valid.task,
        repositorySlug: 'django/django',
        baseCommit: 'a'.repeat(40),
        createdAt: 1_752_000_000,
        instanceId: 'django__django-12345',
      },
      environment: {
        ...valid.environment,
        generatorModel: {
          id: 'claude-sonnet-4-6',
          provider: 'anthropic',
          openWeights: false,
          source: 'stream' as const,
        },
        distributionClass: 'restricted-tos' as const,
        verifier: {
          type: 'f2p-p2p' as const,
          failToPass: ['tests/test_fix.py::test_regression'],
          passToPass: ['tests/test_existing.py::test_stable'],
          evalSemanticsVersion: 'swe-rebench-v2.1',
        },
      },
      attemptGroup: {
        groupId: 'django__django-12345',
        attemptId: '0xattempt',
        relatedAttemptRefs: ['bafy-pass', 'bafy-fail'],
        groupSize: 2,
        nPass: 1,
        nFail: 1,
      },
      outcome: {
        status: 'completed' as const,
        verificationStrength: 'evaluator-verified' as const,
      },
      retrievalVisible: true,
    };

    expect(EpisodeV1WriteSchema.parse(ready)).toMatchObject({
      task: {
        baseCommit: 'a'.repeat(40),
        createdAt: 1_752_000_000,
        instanceId: 'django__django-12345',
      },
      environment: {
        generatorModel: { id: 'claude-sonnet-4-6', source: 'stream' },
        distributionClass: 'restricted-tos',
        verifier: {
          type: 'f2p-p2p',
          failToPass: ['tests/test_fix.py::test_regression'],
          passToPass: ['tests/test_existing.py::test_stable'],
        },
      },
      attemptGroup: {
        groupId: 'django__django-12345',
        attemptId: '0xattempt',
        groupSize: 2,
        nPass: 1,
        nFail: 1,
      },
      outcome: { verificationStrength: 'evaluator-verified' },
      retrievalVisible: true,
    });
  });

  it.each([
    {
      name: 'deliveryMode=delivered with no refs',
      activity: {
        retrievalFired: true,
        eligibleRefs: [],
        deliveredRefs: [],
        deliveryMode: 'delivered' as const,
      },
    },
    {
      name: 'nonempty deliveredRefs in a degraded delivery',
      activity: {
        retrievalFired: true,
        eligibleRefs: ['bafy-delivered'],
        deliveredRefs: ['bafy-delivered'],
        deliveryMode: 'degraded' as const,
      },
    },
  ])('requires deliveredContentHash for a strict write with $name', ({ activity }) => {
    expect(() => SessionActivityFactsWriteSchema.parse({
      ...activity,
      searchedTerms: [],
      providedRefs: activity.deliveredRefs,
      surfacedRefs: [],
      fetchedRefs: [],
      installedSkillRefs: [],
    })).toThrow();
  });

  it.each(['disabled', 'withheld', 'degraded'] as const)(
    'allows a genuine %s no-delivery write to omit deliveredContentHash',
    (deliveryMode) => {
      expect(() => SessionActivityFactsWriteSchema.parse({
        retrievalFired: deliveryMode !== 'disabled',
        eligibleRefs: [],
        deliveredRefs: [],
        deliveryMode,
        searchedTerms: [],
        providedRefs: [],
        surfacedRefs: [],
        fetchedRefs: [],
        installedSkillRefs: [],
      })).not.toThrow();
    },
  );

  it('rejects an empty trajectory', () => {
    expect(() => EpisodeV1Schema.parse({ ...valid, trajectory: [] })).toThrow();
  });

  it('allows a trajectory of only agent-turn steps (zero tool calls)', () => {
    const turnsOnly = valid.trajectory.filter((s) => s.kind === 'jinn.agent_turn');
    expect(() => EpisodeV1Schema.parse({ ...valid, trajectory: turnsOnly })).not.toThrow();
  });

  it('accepts an optional cost.usdEstimate string', () => {
    expect(() =>
      EpisodeV1Schema.parse({ ...valid, cost: { ...valid.cost, usdEstimate: '0.42' } }),
    ).not.toThrow();
  });

  it('rejects a non-numeric cost.usdEstimate', () => {
    expect(() =>
      EpisodeV1Schema.parse({ ...valid, cost: { ...valid.cost, usdEstimate: 'abc' } }),
    ).toThrow();
  });

  it('accepts an optional lineage block', () => {
    const withLineage = { ...valid, lineage: { episodeId: 'ep-0', mintRef: 'mint-1' } };
    expect(EpisodeV1Schema.parse(withLineage).lineage?.mintRef).toBe('mint-1');
  });

  it('persists strict evidence-first session activity facts and an authoritative eligibility verdict', () => {
    const enriched = {
      ...valid,
      activity: {
        searchedTerms: ['dashboard', 'vitest'],
        providedRefs: ['knowledge/provided-1'],
        surfacedRefs: [],
        fetchedRefs: ['knowledge/provided-1'],
        installedSkillRefs: [],
      },
      eligibility: {
        eligible: true,
        reason: 'accepted diff on a public repository',
        checkedAt: '2026-07-15T12:00:00.000Z',
      },
    };

    const parsed = EpisodeV1Schema.parse(enriched);

    expect(parsed.activity).toEqual({
      ...enriched.activity,
      retrievalFired: true,
      eligibleRefs: ['knowledge/provided-1'],
      deliveredRefs: ['knowledge/provided-1'],
      deliveryMode: 'delivered',
    });
    expect(parsed.eligibility).toEqual(enriched.eligibility);
  });

  it('accepts a pre-rescope (legacy) activity shape lacking searchedTerms/providedRefs, defaulting them to []', () => {
    const legacy = {
      ...valid,
      activity: {
        surfacedRefs: ['knowledge/surfaced-1'],
        fetchedRefs: ['knowledge/fetched-1'],
        installedSkillRefs: ['skills/testing@1'],
      },
    };

    const parsed = EpisodeV1Schema.parse(legacy);

    expect(parsed.activity).toEqual({
      searchedTerms: [],
      providedRefs: [],
      surfacedRefs: ['knowledge/surfaced-1'],
      fetchedRefs: ['knowledge/fetched-1'],
      installedSkillRefs: ['skills/testing@1'],
      retrievalFired: false,
      eligibleRefs: [],
      deliveredRefs: [],
      deliveryMode: 'disabled',
    });
  });

  it('rejects unknown persisted activity facts on strict writes', () => {
    expect(() => EpisodeV1WriteSchema.parse({
      ...valid,
      session: { ...valid.session, kind: 'user' },
      origin: { writer: 'test-writer', build: 'test-build' },
      activity: {
        retrievalFired: false,
        eligibleRefs: [],
        deliveredRefs: [],
        deliveryMode: 'disabled',
        searchedTerms: [],
        providedRefs: [],
        surfacedRefs: [],
        fetchedRefs: [],
        installedSkillRefs: [],
        privatePrompt: 'must never be persisted here',
      },
    })).toThrow();
  });

  // Cross-runtime contract guard (mono #1662): the Python plugin's
  // capture_buffer.assemble_episode() is the sole producer of this record; if its
  // emitted shape drifts from EpisodeV1Schema, the network drops real traces. The
  // two fixtures below are verbatim assemble_episode() output (a full user→tool→
  // assistant episode and a turn-only, no-tokens episode) — parsing them through
  // the strict schema pins the producer↔schema contract.
  it('parses a real assemble_episode full-trajectory output', () => {
    const fromPython = {
      schemaVersion: 'jinn.episode.v1',
      episodeId: 's-1784073615851964000',
      session: { sessionId: 's', capturedAt: '2026-07-15T00:00:15.851854Z' },
      task: { summary: 'fix the retry bug', distributionTags: [] },
      trajectory: [
        {
          spanId: 'turn-1',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:user',
          startTimeUnixNano: '1784073615851967000',
          endTimeUnixNano: '1784073615851967000',
          attributes: { 'turn.text': 'fix the retry bug', role: 'user' },
          redactedKeys: [],
        },
        {
          spanId: 'c1',
          parentSpanId: null,
          kind: 'jinn.tool_call',
          name: 'tool:edit',
          startTimeUnixNano: '1784073615846972000',
          endTimeUnixNano: '1784073615851972000',
          attributes: { 'tool.args': { path: 'x' }, 'tool.result': 'ok' },
          redactedKeys: [],
        },
        {
          spanId: 'turn-2',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:assistant',
          startTimeUnixNano: '1784073615851975000',
          endTimeUnixNano: '1784073615851975000',
          attributes: { 'turn.text': 'fixed it', role: 'assistant' },
          redactedKeys: [],
        },
      ],
      environment: {
        harness: { name: 'hermes-agent', version: '0.1.0' },
        model: 'gpt-4o-mini',
        tools: ['edit'],
        skillsLoadout: ['tdd', 'debugging'],
      },
      outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
      cost: { durationMs: 0, tokens: { input: 100, output: 50 } },
      retention: { policy: 'local-private' },
      provenance: 'contributed',
    };
    expect(() => EpisodeV1Schema.parse(fromPython)).not.toThrow();
  });

  it('parses a real assemble_episode turn-only output (no tool calls, cost.tokens omitted)', () => {
    const fromPython = {
      schemaVersion: 'jinn.episode.v1',
      episodeId: 't-1784073615852046000',
      session: { sessionId: 't', capturedAt: '2026-07-15T00:00:15.852044Z' },
      task: { summary: 'just a question', distributionTags: [] },
      trajectory: [
        {
          spanId: 'turn-1',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:user',
          startTimeUnixNano: '1784073615852047000',
          endTimeUnixNano: '1784073615852047000',
          attributes: { 'turn.text': 'just a question', role: 'user' },
          redactedKeys: [],
        },
        {
          spanId: 'turn-2',
          parentSpanId: null,
          kind: 'jinn.agent_turn',
          name: 'turn:assistant',
          startTimeUnixNano: '1784073615852049000',
          endTimeUnixNano: '1784073615852049000',
          attributes: { 'turn.text': 'here is the answer', role: 'assistant' },
          redactedKeys: [],
        },
      ],
      environment: {
        harness: { name: 'hermes-agent', version: '0.1.0' },
        model: 'gpt-4o-mini',
        tools: [],
        skillsLoadout: [],
      },
      outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
      cost: { durationMs: 0 },
      retention: { policy: 'contribution-eligible' },
      provenance: 'contributed',
    };
    expect(() => EpisodeV1Schema.parse(fromPython)).not.toThrow();
  });
});
