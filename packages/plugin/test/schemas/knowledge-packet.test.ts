import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACKET_CHAR_BUDGET,
  KnowledgePacketSchema,
  projectKnowledgePacket,
  truncateLineBoundary,
} from '../../src/schemas/knowledge-packet.js';
import type { CorpusRecord, CorpusRecordStep } from '../../src/ports/corpus-port.js';

function step(overrides: Partial<CorpusRecordStep> = {}): CorpusRecordStep {
  return { name: 'step', attributes: {}, ...overrides };
}

function record(overrides: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    ref: 'bafySeedEpisode1',
    task: { summary: 'Fix the dashboard version-status flake', repositorySlug: 'Jinn-Network/mono' },
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis: 'The version-status fetch was unawaited; the test raced the promise. Awaiting it fixed the flake.',
    steps: [],
    tags: ['mono', 'dashboard', 'vitest'],
    provenance: 'imported',
    origin: 'seed:acme',
    capturedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function packetContentChars(packet: ReturnType<typeof projectKnowledgePacket>): number {
  return (packet.synthesis?.length ?? 0)
    + packet.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
}

describe('KnowledgePacketSchema', () => {
  it('parses a minimal valid packet', () => {
    const parsed = KnowledgePacketSchema.parse({
      schemaVersion: 'jinn.knowledge-packet.v1',
      ref: 'bafyRef1',
      task: { summary: 'Fix a flake' },
      outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
      excerpts: [{ label: 'command', text: 'yarn test' }],
      attribution: { provenance: 'imported', capturedAt: '2026-07-15T00:00:00.000Z', origin: 'seed:acme' },
    });
    expect(parsed.ref).toBe('bafyRef1');
  });

  it('rejects an unknown excerpt label', () => {
    expect(() =>
      KnowledgePacketSchema.parse({
        schemaVersion: 'jinn.knowledge-packet.v1',
        ref: 'bafyRef1',
        task: { summary: 'x' },
        outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
        excerpts: [{ label: 'bogus', text: 'x' }],
        attribution: { provenance: 'imported', capturedAt: '2026-07-15T00:00:00.000Z', origin: 'x' },
      }),
    ).toThrow();
  });

  it('rejects an unknown top-level field (strict)', () => {
    expect(() =>
      KnowledgePacketSchema.parse({
        schemaVersion: 'jinn.knowledge-packet.v1',
        ref: 'bafyRef1',
        task: { summary: 'x' },
        outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
        excerpts: [],
        attribution: { provenance: 'imported', capturedAt: '2026-07-15T00:00:00.000Z', origin: 'x' },
        extra: true,
      }),
    ).toThrow();
  });
});

describe('truncateLineBoundary', () => {
  it('returns the text unchanged when under budget', () => {
    expect(truncateLineBoundary('short', 100, 'ref-1')).toBe('short');
  });

  it('truncates at a line boundary and appends the corpus_fetch pointer', () => {
    const text = [
      'first line of real output stays intact',
      'second line also fits comfortably inside the budget',
      'third line pushes the text well past the truncation budget on its own',
    ].join('\n');
    const truncated = truncateLineBoundary(text, 100, 'ref-1');
    expect(truncated.startsWith('first line of real output stays intact')).toBe(true);
    expect(truncated).not.toContain('third line');
    expect(truncated).toContain('[truncated — full episode: corpus_fetch ref-1]');
    expect(truncated.length).toBeLessThanOrEqual(100);
  });
});

describe('projectKnowledgePacket (rescope §3.2)', () => {
  it('is a pure projection: summary, outcome+tier, and the record\'s own synthesis', () => {
    const packet = projectKnowledgePacket(record());
    expect(packet.task.summary).toBe('Fix the dashboard version-status flake');
    expect(packet.task.repositorySlug).toBe('Jinn-Network/mono');
    expect(packet.outcome).toEqual({ status: 'completed', verifiabilityTier: 'tests-passed' });
    expect(packet.synthesis).toContain('unawaited');
    expect(packet.attribution).toEqual({
      provenance: 'imported',
      capturedAt: '2026-07-15T00:00:00.000Z',
      origin: 'seed:acme',
    });
  });

  it('selects the failing command, the fix that followed, and the final passing command', () => {
    const steps: CorpusRecordStep[] = [
      step({
        name: 'run tests',
        attributes: { 'tool.args': 'yarn --cwd client test', 'tool.result': 'FAIL version-status.test.ts', 'tool.exitCode': 1 },
      }),
      step({
        name: 'apply fix',
        attributes: { 'tool.args': 'await fetchVersionStatus()', 'tool.exitCode': 0 },
      }),
      step({
        name: 'rerun tests',
        attributes: { 'tool.args': 'yarn --cwd client test', 'tool.result': '5 passed', 'tool.exitCode': 0 },
      }),
    ];
    const packet = projectKnowledgePacket(record({ steps }));

    const failure = packet.excerpts.find((e) => e.label === 'failure');
    const fix = packet.excerpts.find((e) => e.label === 'fix');
    const command = packet.excerpts.find((e) => e.label === 'command');

    expect(failure?.text).toContain('yarn --cwd client test');
    expect(failure?.text).toContain('FAIL version-status.test.ts');
    expect(fix?.text).toBe('await fetchVersionStatus()');
    expect(command?.text).toBe('yarn --cwd client test');
  });

  it('includes a diff excerpt when a step carries one', () => {
    const steps: CorpusRecordStep[] = [
      step({ attributes: { diff: '--- a/x.ts\n+++ b/x.ts\n+await x();' } }),
    ];
    const packet = projectKnowledgePacket(record({ steps }));
    expect(packet.excerpts.find((e) => e.label === 'diff')?.text).toContain('await x();');
  });

  it('falls back to a note excerpt when nothing command-shaped is present', () => {
    const steps: CorpusRecordStep[] = [step({ attributes: { note: 'Just a remark, no commands here.' } })];
    const packet = projectKnowledgePacket(record({ steps }));
    expect(packet.excerpts).toEqual([{ label: 'note', text: 'Just a remark, no commands here.' }]);
  });

  it('produces no excerpts (but a valid packet) when the record has no steps and no notes', () => {
    const packet = projectKnowledgePacket(record({ steps: [] }));
    expect(packet.excerpts).toEqual([]);
  });

  describe('seed-authored steps (rescope R4 — seed.step.label/text convention)', () => {
    it('trusts a seed-authored excerpt verbatim, in step order, instead of the tool.* heuristic', () => {
      const steps: CorpusRecordStep[] = [
        step({ attributes: { 'seed.step.label': 'failure', 'seed.step.text': 'FAIL: expected true' } }),
        step({ attributes: { 'seed.step.label': 'note', 'seed.step.text': 'diagnosis prose' } }),
        step({ attributes: { 'seed.step.label': 'fix', 'seed.step.text': 'the correction, in prose' } }),
        step({ attributes: { 'seed.step.label': 'diff', 'seed.step.text': '--- a/x\n+++ b/x' } }),
        step({ attributes: { 'seed.step.label': 'command', 'seed.step.text': 'yarn test — passing' } }),
      ];
      const packet = projectKnowledgePacket(record({ steps }));
      expect(packet.excerpts).toEqual([
        { label: 'failure', text: 'FAIL: expected true' },
        { label: 'note', text: 'diagnosis prose' },
        { label: 'fix', text: 'the correction, in prose' },
        { label: 'diff', text: '--- a/x\n+++ b/x' },
        { label: 'command', text: 'yarn test — passing' },
      ]);
    });

    it('ignores a seed step with an invalid label rather than crashing', () => {
      const steps: CorpusRecordStep[] = [
        step({ attributes: { 'seed.step.label': 'bogus', 'seed.step.text': 'x' } }),
        step({ attributes: { 'tool.args': 'pytest', 'tool.exitCode': 1, 'tool.result': 'FAIL' } }),
      ];
      const packet = projectKnowledgePacket(record({ steps }));
      // No valid seed-shaped step exists, so selection falls through to the
      // tool.* heuristic rather than emitting an excerpt for the bogus label.
      expect(packet.excerpts).toEqual([{ label: 'failure', text: 'pytest\nFAIL' }]);
    });

    it('never mixes seed-authored steps with the tool.* heuristic on the same record', () => {
      const steps: CorpusRecordStep[] = [
        step({ attributes: { 'seed.step.label': 'command', 'seed.step.text': 'the seed-authored command' } }),
        step({ attributes: { 'tool.args': 'a real tool call', 'tool.exitCode': 0 } }),
      ];
      const packet = projectKnowledgePacket(record({ steps }));
      expect(packet.excerpts).toEqual([{ label: 'command', text: 'the seed-authored command' }]);
    });
  });

  it('never paraphrases: excerpt text is a verbatim slice of the source attributes', () => {
    const verbatim = 'AssertionError: expected true to be false at line 42';
    const steps: CorpusRecordStep[] = [
      step({ attributes: { 'tool.args': 'pytest', 'tool.result': verbatim, 'tool.exitCode': 1 } }),
    ];
    const packet = projectKnowledgePacket(record({ steps }));
    expect(packet.excerpts.find((e) => e.label === 'failure')?.text).toContain(verbatim);
  });

  it('omits synthesis when the record does not carry one', () => {
    const packet = projectKnowledgePacket(record({ synthesis: undefined }));
    expect(packet.synthesis).toBeUndefined();
  });

  it('enforces the default 3,500-char combined budget, truncating with the corpus_fetch tail', () => {
    const longOutput = 'x'.repeat(10_000);
    const steps: CorpusRecordStep[] = [
      step({ attributes: { 'tool.args': 'run-long-command', 'tool.result': longOutput, 'tool.exitCode': 1 } }),
    ];
    const packet = projectKnowledgePacket(record({ steps, synthesis: undefined }));
    const totalChars = (packet.synthesis?.length ?? 0)
      + packet.excerpts.reduce((sum, e) => sum + e.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(DEFAULT_PACKET_CHAR_BUDGET);
    expect(packet.excerpts[0]?.text).toContain('[truncated — full episode: corpus_fetch bafySeedEpisode1]');
  });

  it('respects a caller-supplied budget smaller than the default', () => {
    const steps: CorpusRecordStep[] = [
      step({ attributes: { 'tool.args': 'a', 'tool.result': 'b'.repeat(500), 'tool.exitCode': 1 } }),
    ];
    const packet = projectKnowledgePacket(record({ steps, synthesis: undefined }), { maxChars: 200 });
    const totalChars = packet.excerpts.reduce((sum, e) => sum + e.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(200);
    expect(totalChars).toBeLessThan(502); // proves truncation actually happened
  });

  it.each([
    { remaining: 80, expectedExcerpts: 1 },
    { remaining: 20, expectedExcerpts: 0 },
    { remaining: 5, expectedExcerpts: 0 },
  ])(
    'never exceeds 3,500 chars with $remaining chars remaining for a truncated excerpt',
    ({ remaining, expectedExcerpts }) => {
      const steps: CorpusRecordStep[] = [
        step({
          attributes: {
            'tool.args': 'run-long-command',
            'tool.result': 'x'.repeat(500),
            'tool.exitCode': 1,
          },
        }),
      ];
      const packet = projectKnowledgePacket(record({
        synthesis: 's'.repeat(DEFAULT_PACKET_CHAR_BUDGET - remaining),
        steps,
      }));

      expect(packet.excerpts).toHaveLength(expectedExcerpts);
      expect(packetContentChars(packet)).toBeLessThanOrEqual(DEFAULT_PACKET_CHAR_BUDGET);
    },
  );
});
