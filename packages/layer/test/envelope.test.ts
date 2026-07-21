import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TraceEnvelopeV0Schema,
  parseTraceEnvelopeV0,
  MAX_STEPS,
  MAX_STEP_ATTRIBUTES_BYTES,
  MAX_DISTRIBUTION_TAGS,
  VERIFIABILITY_TIERS,
  type TraceEnvelopeV0,
} from '../src/envelope.js';

function validStep(overrides: Record<string, unknown> = {}) {
  return {
    spanId: 's-001',
    parentSpanId: null,
    name: 'tool:run_command',
    startTimeUnixNano: '1751452890000000000',
    endTimeUnixNano: '1751452905000000000',
    attributes: { command: 'yarn test', exitCode: 0 },
    redactedKeys: [],
    ...overrides,
  };
}

function validEnvelope(): TraceEnvelopeV0 {
  return {
    schemaVersion: 'jinn.trace-envelope.v0',
    session: {
      sessionId: '9f2c1e4a-7b3d-4e8f-a1c2-d5e6f7a8b9c0',
      capturedAt: '2026-07-02T10:41:22.000Z',
    },
    task: {
      summary: 'Fix failing vitest suite after zod v4 upgrade',
      distributionTags: ['typescript', 'testing'],
    },
    environment: {
      harness: { name: 'jinn-hermes', version: '0.3.1' },
      model: 'claude-sonnet-4-6',
      tools: ['read_file', 'edit_file', 'run_command'],
    },
    steps: [validStep()],
    outcome: {
      status: 'completed',
      verifiabilityTier: 'tests-passed',
      summary: 'All tests pass',
    },
    cost: {
      durationMs: 48000,
      tokens: { input: 18432, output: 2210 },
      usdEstimate: '0.09',
    },
    consent: {
      contributionConsent: true,
      scrubCompleted: true,
    },
    provenance: 'contributed',
  };
}

describe('TraceEnvelopeV0Schema', () => {
  it('parses a valid envelope and round-trips it unchanged', () => {
    const input = validEnvelope();
    const parsed = parseTraceEnvelopeV0(input);
    expect(parsed).toEqual(input);
  });

  it('accepts a failed task with a verifiability tier', () => {
    const env = validEnvelope();
    env.outcome = { status: 'failed', verifiabilityTier: 'user-accepted' };
    expect(() => parseTraceEnvelopeV0(env)).not.toThrow();
  });

  it('accepts an envelope without optional cost fields', () => {
    const env = validEnvelope();
    env.cost = { durationMs: 1000 };
    expect(() => parseTraceEnvelopeV0(env)).not.toThrow();
  });

  it('accepts a step with a truncatedKeys receipt', () => {
    const env = validEnvelope();
    env.steps = [
      validStep({ truncatedKeys: ['stdout.tail'] }),
    ] as TraceEnvelopeV0['steps'];
    expect(() => parseTraceEnvelopeV0(env)).not.toThrow();
  });

  it('accepts a step without truncatedKeys — the receipt is optional', () => {
    const env = validEnvelope();
    expect('truncatedKeys' in env.steps[0]).toBe(false);
    expect(() => parseTraceEnvelopeV0(env)).not.toThrow();
  });

  describe('consent flags (fail-closed, spec §5)', () => {
    it('rejects when the consent object is missing entirely', () => {
      const env: Record<string, unknown> = { ...validEnvelope() };
      delete env.consent;
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects when contributionConsent is missing', () => {
      const env = validEnvelope() as unknown as { consent: Record<string, unknown> };
      env.consent = { scrubCompleted: true };
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects when scrubCompleted is missing', () => {
      const env = validEnvelope() as unknown as { consent: Record<string, unknown> };
      env.consent = { contributionConsent: true };
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects consent flags set to false — an unconsented envelope is not constructible', () => {
      const withVeto = { ...validEnvelope(), consent: { contributionConsent: false, scrubCompleted: true } };
      expect(TraceEnvelopeV0Schema.safeParse(withVeto).success).toBe(false);
      const unscrubbed = { ...validEnvelope(), consent: { contributionConsent: true, scrubCompleted: false } };
      expect(TraceEnvelopeV0Schema.safeParse(unscrubbed).success).toBe(false);
    });
  });

  describe('size limits', () => {
    it('rejects more than MAX_STEPS steps', () => {
      const env = validEnvelope();
      env.steps = Array.from({ length: MAX_STEPS + 1 }, (_, i) =>
        validStep({ spanId: `s-${i}` }),
      ) as TraceEnvelopeV0['steps'];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('accepts exactly MAX_STEPS steps', () => {
      const env = validEnvelope();
      env.steps = Array.from({ length: MAX_STEPS }, (_, i) =>
        validStep({ spanId: `s-${i}` }),
      ) as TraceEnvelopeV0['steps'];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(true);
    });

    it('rejects an empty steps array', () => {
      const env = validEnvelope();
      env.steps = [] as unknown as TraceEnvelopeV0['steps'];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects a step whose serialised attributes exceed MAX_STEP_ATTRIBUTES_BYTES', () => {
      const env = validEnvelope();
      env.steps = [
        validStep({ attributes: { blob: 'x'.repeat(MAX_STEP_ATTRIBUTES_BYTES + 1) } }),
      ] as TraceEnvelopeV0['steps'];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects more than MAX_DISTRIBUTION_TAGS tags', () => {
      const env = validEnvelope();
      env.task.distributionTags = Array.from(
        { length: MAX_DISTRIBUTION_TAGS + 1 },
        (_, i) => `tag-${i}`,
      );
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects an empty distributionTags array — untagged envelopes are invisible to the signal', () => {
      const env = validEnvelope();
      env.task.distributionTags = [];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });
  });

  describe('closed schema (frozen at v0 sign-off)', () => {
    it('rejects unknown top-level fields', () => {
      const env = { ...validEnvelope(), sneaky: 'field' };
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects unknown fields nested in task', () => {
      const env = validEnvelope();
      (env.task as Record<string, unknown>).priority = 'high';
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects unknown fields nested in a step', () => {
      const env = validEnvelope();
      env.steps = [validStep({ rawPrompt: 'should not exist' })] as TraceEnvelopeV0['steps'];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects unknown fields nested in outcome and consent', () => {
      const badOutcome = validEnvelope();
      (badOutcome.outcome as Record<string, unknown>).score = 0.9;
      expect(TraceEnvelopeV0Schema.safeParse(badOutcome).success).toBe(false);

      const badConsent = validEnvelope();
      (badConsent.consent as Record<string, unknown>).marketing = true;
      expect(TraceEnvelopeV0Schema.safeParse(badConsent).success).toBe(false);
    });
  });

  describe('field constraints', () => {
    it('rejects a wrong schemaVersion', () => {
      const env = { ...validEnvelope(), schemaVersion: 'jinn.trace-envelope.v1' };
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects an unknown verifiabilityTier', () => {
      const env = validEnvelope();
      (env.outcome as Record<string, unknown>).verifiabilityTier = 'notarised';
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects an unknown provenance', () => {
      const env = { ...validEnvelope(), provenance: 'synthetic' };
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects a non-ISO capturedAt', () => {
      const env = validEnvelope();
      env.session.capturedAt = 'yesterday';
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects non-digit step timestamps', () => {
      const env = validEnvelope();
      env.steps = [validStep({ startTimeUnixNano: '2026-07-02' })] as TraceEnvelopeV0['steps'];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects a distribution tag with surrounding whitespace', () => {
      const env = validEnvelope();
      env.task.distributionTags = [' typescript '];
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });

    it('rejects a non-decimal usdEstimate', () => {
      const env = validEnvelope();
      env.cost = { durationMs: 1000, usdEstimate: '$0.09' };
      expect(TraceEnvelopeV0Schema.safeParse(env).success).toBe(false);
    });
  });

  it('exports the verifiability tier ladder weakest → strongest', () => {
    expect(VERIFIABILITY_TIERS).toEqual([
      'user-accepted',
      'tests-passed',
      'evaluator-verified',
    ]);
  });
});

describe('envelope-v0.md examples', () => {
  const docPath = fileURLToPath(new URL('../docs/envelope-v0.md', import.meta.url));
  const doc = readFileSync(docPath, 'utf8');
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

  it('contains exactly three example envelopes', () => {
    expect(blocks).toHaveLength(3);
  });

  it('every documented example parses against the frozen schema', () => {
    for (const block of blocks) {
      const parsed = TraceEnvelopeV0Schema.safeParse(JSON.parse(block));
      expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    }
  });

  it('the examples cover a coding task, a research task, and a failed task', () => {
    const envelopes = blocks.map((b) => parseTraceEnvelopeV0(JSON.parse(b)));
    const statuses = envelopes.map((e) => e.outcome.status);
    expect(statuses.filter((s) => s === 'completed')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'failed')).toHaveLength(1);
  });
});
