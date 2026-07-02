/**
 * Capture-path tests — the privacy surface (plan Task 3, issue #1310).
 *
 * The seeded-secrets fixture (test/fixtures/seeded-secrets-task.json) is the
 * regression net: every secret in it is SYNTHETIC (canonical documentation
 * examples and invented values — no real PII), and every one of them must
 * show as redacted in the ScrubReport. A seeded secret surviving into the
 * preview envelope is a scrub gap, and these tests are what catch it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ScrubPipeline } from '../../../src/trajectory/scrub/pipeline.js';
import {
  capture,
  CaptureScrubError,
  parseCapturedTask,
  type CapturedTask,
} from '../src/capture.js';
import { preview } from '../src/preview.js';
import { MAX_STEPS, MAX_STEP_ATTRIBUTES_BYTES } from '../src/envelope.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/seeded-secrets-task.json', import.meta.url),
);

function loadFixture(): CapturedTask {
  return parseCapturedTask(JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')));
}

/**
 * Every secret seeded into the fixture. All synthetic. If any of these
 * strings appears in the preview envelope, the scrub has a gap.
 */
const SEEDED_SECRETS = [
  'AKIAIOSFODNN7EXAMPLE', // AWS access key shape
  'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', // GitHub token shape
  'sk-proj-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0De9Cb8Aa7', // generic API key shape
  'sk-synthetic-not-a-real-key-000000000000', // env.* dump (dropped key)
  'synthetic-bearer-token-for-fixture', // authorization header (dropped key)
  'jane.doe@example-corp.com', // email
  'janedoe', // username in a file path
];

function validTask(overrides: Partial<CapturedTask> = {}): CapturedTask {
  return {
    session: {
      sessionId: '9f2c1e4a-7b3d-4e8f-a1c2-d5e6f7a8b9c0',
      capturedAt: '2026-07-02T10:41:22.000Z',
    },
    task: {
      summary: 'Fix failing vitest suite after zod v4 upgrade',
      distributionTags: ['typescript', 'testing'],
    },
    environment: {
      harness: { name: 'jinn-test-harness', version: '0.0.1' },
      model: 'claude-haiku-4-5',
      tools: ['run_command'],
    },
    steps: [
      {
        spanId: 's-001',
        parentSpanId: null,
        name: 'tool:run_command',
        startTimeUnixNano: '1751452890000000000',
        endTimeUnixNano: '1751452905000000000',
        attributes: { command: 'yarn test', exitCode: 0 },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    cost: { durationMs: 48000 },
    provenance: 'contributed',
    ...overrides,
  };
}

describe('capture() on the seeded-secrets fixture', () => {
  it('redacts every seeded secret out of the preview envelope', async () => {
    const pending = await capture(loadFixture());
    const report = preview(pending);
    const published = JSON.stringify(report.envelope);
    for (const secret of SEEDED_SECRETS) {
      expect(published, `seeded secret survived the scrub: ${secret}`).not.toContain(secret);
    }
  });

  it('reports a redaction entry for every seeded secret', async () => {
    const pending = await capture(loadFixture());
    const report = preview(pending);
    // Each seeded secret must be visible in the diff: either its original
    // value appears in a `before` (value redaction) or the attribute key it
    // lived under is reported as a dropped field.
    const befores = report.redactions
      .map((r) => (typeof r.before === 'string' ? r.before : ''))
      .join('\n');
    const fields = report.redactions.map((r) => r.field).join('\n');
    expect(befores).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(befores).toContain('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(befores).toContain('sk-proj-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0De9Cb8Aa7');
    expect(befores).toContain('jane.doe@example-corp.com');
    expect(befores).toContain('/Users/janedoe');
    expect(fields).toContain('env.OPENAI_API_KEY');
    expect(fields).toContain('http.request.header.authorization');
  });

  it('records the union of redacted keys on each step (the visible receipt)', async () => {
    const pending = await capture(loadFixture());
    const report = preview(pending);
    const step2 = report.envelope.steps.find((s) => s.spanId === 's-002');
    expect(step2).toBeDefined();
    expect(step2!.redactedKeys).toContain('env.OPENAI_API_KEY');
    expect(step2!.redactedKeys).toContain('http.request.header.authorization');
    // Dropped keys are gone from the published attributes entirely.
    expect(step2!.attributes).not.toHaveProperty('env.OPENAI_API_KEY');
    expect(step2!.attributes).not.toHaveProperty('http.request.header.authorization');
  });

  it('produces a schema-valid envelope with consent flags asserted only in the preview', async () => {
    const pending = await capture(loadFixture());
    // The pending (pre-consent) state is not a TraceEnvelopeV0: no consent block.
    expect(pending.draft).not.toHaveProperty('consent');
    const report = preview(pending);
    expect(report.envelope.consent).toEqual({ contributionConsent: true, scrubCompleted: true });
    expect(report.envelope.schemaVersion).toBe('jinn.trace-envelope.v0');
  });
});

describe('capture() fail-closed behaviour', () => {
  it('throws when a scrub stage fails — never a silent pass', async () => {
    const exploding = new ScrubPipeline([
      {
        name: 'boom',
        version: '0.0.0',
        scrub() {
          throw new Error('stage exploded');
        },
      },
    ]);
    await expect(capture(validTask(), { pipeline: exploding })).rejects.toThrow(CaptureScrubError);
    await expect(capture(validTask(), { pipeline: exploding })).rejects.toThrow(/stage exploded/);
  });

  it('rejects a malformed task file instead of guessing', () => {
    expect(() => parseCapturedTask({ not: 'a task' })).toThrow();
  });
});

describe('capture() fitting rule (envelope-v0.md)', () => {
  it('truncates an oversized attribute with a truncatedKeys receipt — never silently', async () => {
    // A 20 KiB single-character run: zero Shannon entropy, so no scrub stage
    // touches it — it exercises the fitting path in isolation.
    const oversized = 'a'.repeat(20 * 1024);
    const task = validTask();
    task.steps[0]!.attributes = { ...task.steps[0]!.attributes, 'command.output': oversized };
    const pending = await capture(task);
    const report = preview(pending);

    const step = report.envelope.steps[0]!;
    const serialised = Buffer.byteLength(JSON.stringify(step.attributes), 'utf8');
    expect(serialised).toBeLessThanOrEqual(MAX_STEP_ATTRIBUTES_BYTES);
    expect(step.truncatedKeys).toContain('command.output');
    // The truncation is visible in the report, not silent.
    const fitEntry = report.redactions.find(
      (r) => r.stage === 'fit' && r.field.includes('command.output'),
    );
    expect(fitEntry).toBeDefined();
    expect(String(fitEntry!.after)).toContain('[truncated]');
  });

  it('head/tail-samples an over-long session down to MAX_STEPS — never dropping it', async () => {
    const steps = Array.from({ length: MAX_STEPS + 88 }, (_, i) => ({
      spanId: `s-${String(i).padStart(4, '0')}`,
      parentSpanId: null,
      name: 'tool:run_command',
      startTimeUnixNano: '1751452890000000000',
      endTimeUnixNano: '1751452905000000000',
      attributes: { index: i },
      redactedKeys: [],
    }));
    const pending = await capture(validTask({ steps }));
    const report = preview(pending);
    expect(report.envelope.steps).toHaveLength(MAX_STEPS);
    // Head and tail survive; the middle is what gets sampled out.
    expect(report.envelope.steps[0]!.spanId).toBe('s-0000');
    expect(report.envelope.steps.at(-1)!.spanId).toBe(`s-${String(MAX_STEPS + 88 - 1).padStart(4, '0')}`);
    const sampleEntry = report.redactions.find((r) => r.stage === 'fit' && r.field === 'steps');
    expect(sampleEntry).toBeDefined();
  });
});
