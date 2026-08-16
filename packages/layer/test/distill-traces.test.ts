import { describe, it, expect } from 'vitest';
import type { CapturedTask } from '../src/capture.js';
import {
  clusterTraceCards,
  readTrace,
  searchTraceCards,
  traceCardFromCapture,
} from '../src/distill-traces.js';

function capture(over: {
  sessionId: string;
  summary: string;
  capturedAt?: string;
  command?: string;
  file?: string;
  error?: string;
  redactedKeys?: string[];
}): CapturedTask {
  const capturedAt = over.capturedAt ?? '2026-07-09T00:00:00.000Z';
  return {
    session: { sessionId: over.sessionId, capturedAt },
    task: { summary: over.summary, distributionTags: ['coding'] },
    environment: {
      harness: { name: 'codex', version: '1.0.0' },
      model: 'gpt-5.5',
      tools: ['shell', 'apply_patch'],
    },
    steps: [
      {
        spanId: `${over.sessionId}-user`,
        parentSpanId: null,
        name: 'jinn.transcript.user-message',
        startTimeUnixNano: '1752000000000000000',
        endTimeUnixNano: '1752000001000000000',
        attributes: {
          'jinn.capture.event.kind': 'user-message',
          'message.content': over.summary,
        },
        redactedKeys: [],
      },
      {
        spanId: `${over.sessionId}-tool`,
        parentSpanId: null,
        name: 'jinn.transcript.tool-call',
        startTimeUnixNano: '1752000002000000000',
        endTimeUnixNano: '1752000003000000000',
        attributes: {
          'jinn.capture.event.kind': 'tool-call',
          'tool.name': over.command ? 'shell' : 'apply_patch',
          'tool.args': JSON.stringify(over.command ? { command: over.command } : { path: over.file }),
          ...(over.file ? { 'file.path': over.file } : {}),
        },
        redactedKeys: over.redactedKeys ?? [],
      },
      ...(over.error
        ? [{
            spanId: `${over.sessionId}-error`,
            parentSpanId: null,
            name: 'jinn.transcript.tool-result',
            startTimeUnixNano: '1752000004000000000',
            endTimeUnixNano: '1752000005000000000',
            attributes: {
              'jinn.capture.event.kind': 'tool-result',
              'tool.name': 'shell',
              'tool.result': over.error,
              'tool.is_error': true,
            },
            redactedKeys: [],
          }]
        : []),
    ],
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted', summary: over.summary },
    cost: { durationMs: 1000 },
    provenance: 'contributed',
  };
}

describe('local distill trace primitives', () => {
  it('normalizes a CapturedTask into a compact trace card', () => {
    const card = traceCardFromCapture(capture({
      sessionId: 's1',
      summary: 'Fix pytest image setup',
      command: 'pytest -q',
      file: 'operator/test/foo.test.ts',
      error: 'pytest: command not found',
      redactedKeys: ['tool.args.token'],
    }));

    expect(card).toMatchObject({
      traceId: 'local-capture:s1',
      sessionId: 's1',
      sourceTool: 'codex',
      summary: 'Fix pytest image setup',
      commands: ['pytest -q'],
      filesTouched: ['operator/test/foo.test.ts'],
      errorSnippets: ['pytest: command not found'],
      outcome: 'completed',
      redactionFlags: ['redacted'],
    });
  });

  it('supports scoped read modes and gates full transcript reads', () => {
    const task = capture({ sessionId: 's1', summary: 'Debug setup', command: 'pytest -q' });

    expect(readTrace(task, { mode: 'summary' })).toMatchObject({ mode: 'summary', traceId: 'local-capture:s1' });
    expect(readTrace(task, { mode: 'tool_calls' }).toolCalls[0]).toMatchObject({ toolName: 'shell' });
    expect(() => readTrace(task, { mode: 'full_transcript' })).toThrow(/full transcript/i);
    expect(readTrace(task, { mode: 'full_transcript', allowFullTranscript: true }).events).toHaveLength(2);
  });

  it('searches cards by text, command, file, error, tool, and outcome', () => {
    const cards = [
      traceCardFromCapture(capture({ sessionId: 's1', summary: 'Fix setup', command: 'pytest -q', error: 'pytest missing' })),
      traceCardFromCapture(capture({ sessionId: 's2', summary: 'Edit UI', file: 'operator/src/App.tsx' })),
    ];

    expect(searchTraceCards(cards, { query: 'setup' }).map((c) => c.sessionId)).toEqual(['s1']);
    expect(searchTraceCards(cards, { command: 'pytest' }).map((c) => c.sessionId)).toEqual(['s1']);
    expect(searchTraceCards(cards, { file: 'App.tsx' }).map((c) => c.sessionId)).toEqual(['s2']);
    expect(searchTraceCards(cards, { error: 'missing' }).map((c) => c.sessionId)).toEqual(['s1']);
    expect(searchTraceCards(cards, { tool: 'apply_patch' }).map((c) => c.sessionId)).toEqual(['s1', 's2']);
    expect(searchTraceCards(cards, { outcome: 'completed' })).toHaveLength(2);
  });

  it('clusters repeated trace-card signals into candidate cards', () => {
    const cards = [
      traceCardFromCapture(capture({ sessionId: 's1', summary: 'Setup fails', command: 'pytest -q', error: 'pytest missing' })),
      traceCardFromCapture(capture({ sessionId: 's2', summary: 'Setup still fails', command: 'pytest -q', error: 'pytest missing' })),
    ];

    const candidates = clusterTraceCards(cards);

    expect(candidates[0]).toMatchObject({
      candidateId: 'local-candidate-001',
      title: 'Repeated error: pytest missing',
      traceIds: ['local-capture:s1', 'local-capture:s2'],
      evidenceTierEstimate: 'recurring-pattern',
      estimatedDistillCost: 'low',
    });
  });
});
