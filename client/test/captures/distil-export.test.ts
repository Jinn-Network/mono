import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCapturedTask } from '../../packages/harness-layer/src/capture.js';
import type { PendingCaptureRow, SpanRow } from '../../src/store/captures.js';
import {
  capturedTaskFromStoredCapture,
  localDistilCapturesDirFromEnv,
  writeCapturedTaskForDistil,
} from '../../src/captures/distil-export.js';

function pending(over: Partial<PendingCaptureRow> = {}): PendingCaptureRow {
  return {
    sessionId: 'sess/local:1',
    capturedAt: '2026-07-09T00:00:00.000Z',
    originatingTool: { name: 'codex', version: '1.2.3' },
    capturePath: 'D',
    status: 'pending',
    spanCount: 2,
    durationMs: 1234,
    redactedSpanCount: 1,
    ...over,
  };
}

function span(over: Partial<SpanRow> = {}): SpanRow {
  return {
    sessionId: 'sess/local:1',
    spanId: 'span-1',
    traceId: 'trace-1',
    parentSpanId: null,
    name: 'jinn.transcript.user-message',
    startTimeUnixNano: '1752000000000000000',
    endTimeUnixNano: '1752000001000000000',
    attributes: {
      'jinn.capture.event.kind': 'user-message',
      'message.content': 'Fix the failing pytest setup\nand rerun the focused tests.',
      'gen_ai.request.model': 'gpt-5.1',
    },
    redactedKeys: [],
    ...over,
  };
}

describe('local distil capture export', () => {
  it('normalizes stored capture rows into harness-layer CapturedTask JSON', () => {
    const task = capturedTaskFromStoredCapture(pending(), [
      span(),
      span({
        spanId: 'span-2',
        name: 'jinn.transcript.tool-call',
        attributes: {
          'jinn.capture.event.kind': 'tool-call',
          'tool.name': 'shell',
          'tool.args': JSON.stringify({ command: 'pytest -q' }),
        },
        redactedKeys: ['tool.args.token'],
      }),
    ]);

    expect(task).toMatchObject({
      session: { sessionId: 'sess/local:1' },
      task: { summary: 'Fix the failing pytest setup and rerun the focused tests.', distributionTags: ['coding'] },
      environment: {
        harness: { name: 'codex', version: '1.2.3' },
        model: 'gpt-5.1',
        tools: ['codex', 'shell'],
      },
      outcome: {
        status: 'completed',
        verifiabilityTier: 'user-accepted',
      },
      cost: { durationMs: 1234 },
      provenance: 'contributed',
    });
    expect(task.steps[1]?.redactedKeys).toEqual(['tool.args.token']);
  });

  it('writes schema-parseable JSON under a sanitized session filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-local-distil-captures-'));
    const task = capturedTaskFromStoredCapture(pending(), [span()]);

    const filePath = writeCapturedTaskForDistil(task, dir);
    const parsed = parseCapturedTask(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);

    expect(filePath).toBe(join(dir, 'sess_local_1.json'));
    expect(parsed.session.sessionId).toBe('sess/local:1');
    expect(parsed.outcome.verifiabilityTier).toBe('user-accepted');
  });

  it('uses JINN_LAYER_CAPTURES_DIR for the shared distil dropbox', () => {
    expect(localDistilCapturesDirFromEnv({ JINN_LAYER_CAPTURES_DIR: '/tmp/local-captures' })).toBe('/tmp/local-captures');
  });
});
