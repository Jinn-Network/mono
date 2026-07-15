import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CapturesStore, PendingCaptureRow, SpanRow } from '../store/captures.js';

type OutcomeStatus = 'completed' | 'failed' | 'abandoned';

export interface LocalDistillCapturedTask {
  session: {
    sessionId: string;
    capturedAt: string;
  };
  task: {
    summary: string;
    distributionTags: string[];
  };
  environment: {
    harness: {
      name: string;
      version: string;
    };
    model: string;
    tools: string[];
  };
  steps: Array<{
    spanId: string;
    parentSpanId: string | null;
    name: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: Record<string, unknown>;
    redactedKeys: string[];
  }>;
  outcome: {
    status: OutcomeStatus;
    verifiabilityTier: 'user-accepted';
    summary: string;
  };
  cost: {
    durationMs: number;
    tokens?: {
      input: number;
      output: number;
    };
    usdEstimate?: string;
  };
  provenance: 'contributed' | 'imported';
}

export const DEFAULT_LOCAL_DISTILL_CAPTURES_DIR = join(homedir(), '.jinn-client', 'harness-layer', 'captures');

export function localDistillCapturesDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['JINN_LAYER_CAPTURES_DIR'] || DEFAULT_LOCAL_DISTILL_CAPTURES_DIR;
}

export function capturedTaskFromStoredCapture(
  capture: PendingCaptureRow,
  spans: SpanRow[],
): LocalDistillCapturedTask {
  if (spans.length === 0) {
    throw new Error(`Cannot export capture ${capture.sessionId} for distill without transcript spans`);
  }
  const summary = inferSummary(capture, spans);
  const tools = uniq([
    capture.originatingTool.name,
    ...spans.map((span) => stringAttr(span, 'tool.name')),
  ]);
  const cost = inferCost(capture, spans);
  return {
    session: {
      sessionId: capture.sessionId,
      capturedAt: capture.capturedAt,
    },
    task: {
      summary,
      distributionTags: ['coding'],
    },
    environment: {
      harness: {
        name: capture.originatingTool.name,
        version: capture.originatingTool.version ?? 'unknown',
      },
      model: inferModel(spans),
      tools,
    },
    steps: spans.map((span) => ({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      startTimeUnixNano: span.startTimeUnixNano,
      endTimeUnixNano: span.endTimeUnixNano,
      attributes: span.attributes,
      redactedKeys: span.redactedKeys,
    })),
    outcome: {
      status: inferOutcome(spans),
      verifiabilityTier: 'user-accepted',
      summary,
    },
    cost,
    provenance: capture.capturePath === 'B' ? 'imported' : 'contributed',
  };
}

export function writeCapturedTaskForDistill(task: LocalDistillCapturedTask, capturesDir: string): string {
  mkdirSync(capturesDir, { recursive: true, mode: 0o700 });
  const filePath = join(capturesDir, `${safeFilePart(task.session.sessionId)}.json`);
  const tmpPath = join(dirname(filePath), `.${safeFilePart(task.session.sessionId)}.${process.pid}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
  return filePath;
}

export function exportStoredCaptureForDistill(
  captures: CapturesStore,
  sessionId: string,
  opts: { capturesDir?: string } = {},
): { task: LocalDistillCapturedTask; filePath: string } | null {
  const capture = captures.getBySession(sessionId);
  if (!capture) return null;
  const spans = captures.getSpansBySession(sessionId);
  const task = capturedTaskFromStoredCapture(capture, spans);
  const filePath = writeCapturedTaskForDistill(task, opts.capturesDir ?? localDistillCapturesDirFromEnv());
  return { task, filePath };
}

function inferSummary(capture: PendingCaptureRow, spans: SpanRow[]): string {
  const userMessage = spans.find((span) => stringAttr(span, 'jinn.capture.event.kind') === 'user-message');
  const message = userMessage ? stringAttr(userMessage, 'message.content') : undefined;
  return oneLine(message, 180) ?? `${capture.originatingTool.name} session ${capture.sessionId}`;
}

function inferModel(spans: SpanRow[]): string {
  for (const key of ['gen_ai.request.model', 'gen_ai.response.model', 'llm.model', 'model']) {
    const model = spans.map((span) => stringAttr(span, key)).find((value) => value !== undefined);
    if (model) return model;
  }
  return 'unknown';
}

function inferCost(capture: PendingCaptureRow, spans: SpanRow[]): LocalDistillCapturedTask['cost'] {
  const input = firstNumber(spans, ['gen_ai.usage.input_tokens', 'llm.usage.input_tokens', 'usage.input_tokens']);
  const output = firstNumber(spans, ['gen_ai.usage.output_tokens', 'llm.usage.output_tokens', 'usage.output_tokens']);
  return {
    durationMs: Math.max(0, capture.durationMs),
    ...(input !== undefined || output !== undefined
      ? { tokens: { input: input ?? 0, output: output ?? 0 } }
      : {}),
  };
}

function inferOutcome(spans: SpanRow[]): OutcomeStatus {
  const status = spans
    .map((span) => normalizeOutcome(stringAttr(span, 'jinn.session.outcome') ?? stringAttr(span, 'session.outcome')))
    .find((value): value is OutcomeStatus => value !== undefined);
  return status ?? 'completed';
}

function normalizeOutcome(value: string | undefined): OutcomeStatus | undefined {
  if (value === 'completed' || value === 'failed' || value === 'abandoned') return value;
  if (value === 'cancelled' || value === 'timeout') return 'abandoned';
  return undefined;
}

function firstNumber(spans: SpanRow[], keys: string[]): number | undefined {
  for (const span of spans) {
    for (const key of keys) {
      const value = span.attributes[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
      if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    }
  }
  return undefined;
}

function stringAttr(span: SpanRow, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function oneLine(value: string | undefined, max: number): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function uniq(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => typeof value === 'string' && value.trim() !== ''))];
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return safe || 'capture';
}
