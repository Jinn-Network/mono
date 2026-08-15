import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { CapturesStore } from '../store/captures.js';
import type { Receiver } from '../trajectory/receiver.js';
import { startSyntheticSpanProvider, emitSyntheticSpan } from '../trajectory/synthetic-span-builder.js';
import { ClaudeCodeJsonlParser } from '../trajectory/transcript-parsers/claude-code-jsonl.js';
import { CodexSessionParser } from '../trajectory/transcript-parsers/codex-session.js';
import { GeminiSessionParser } from '../trajectory/transcript-parsers/gemini-session.js';
import { CursorSqliteParser } from '../trajectory/transcript-parsers/cursor-sqlite.js';
import type { TranscriptParser } from '../trajectory/transcript-parsers/types.js';
import type { StopHookPayload, StopHookTool } from '../api/stop-hook.js';

export class EnsurePendingCaptureProcessor implements SpanProcessor {
  constructor(private readonly captures: CapturesStore) {}

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const sessionId = stringAttribute(span.attributes['jinn.session.id']);
    if (!sessionId) return;
    ensurePendingCapture(this.captures, {
      sessionId,
      capturedAt: hrTimeToIso(span.startTime),
      tool: inferCaptureTool(span),
      capturePath: inferCapturePath(span),
      ...repoMetadataFromSpan(span),
    });
  }
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function hrTimeToIso(time: ReadableSpan['startTime']): string {
  const millis = (time[0] * 1000) + Math.floor(time[1] / 1_000_000);
  return new Date(millis).toISOString();
}

function inferCaptureTool(span: ReadableSpan): string {
  return stringAttribute(span.attributes['transcript.tool'])
    ?? stringAttribute(span.resource.attributes['service.name'])
    ?? 'otel';
}

function inferCapturePath(span: ReadableSpan): 'A' | 'B' | 'C' | 'D' {
  if (stringAttribute(span.attributes['transcript.tool'])) return 'B';
  return 'A';
}

function repoMetadataFromSpan(span: ReadableSpan): { repoRemoteUrl?: string; repoCommitHash?: string } {
  const attrs = span.attributes;
  const repoRemoteUrl = stringAttribute(attrs['repo.remote_url'])
    ?? stringAttribute(attrs['vcs.repository.url'])
    ?? stringAttribute(attrs['git.remote_url']);
  const repoCommitHash = stringAttribute(attrs['repo.commit_hash'])
    ?? stringAttribute(attrs['vcs.ref.head.revision'])
    ?? stringAttribute(attrs['git.commit']);
  return {
    ...(repoRemoteUrl ? { repoRemoteUrl } : {}),
    ...(repoCommitHash ? { repoCommitHash } : {}),
  };
}

function parserForStopHookTool(tool: StopHookTool): TranscriptParser {
  switch (tool) {
    case 'claude-code':
      return new ClaudeCodeJsonlParser();
    case 'codex':
      return new CodexSessionParser();
    case 'gemini-cli':
      return new GeminiSessionParser();
    case 'cursor':
      return new CursorSqliteParser();
    default: {
      const exhaustive: never = tool;
      throw new Error(`No transcript parser for stop-hook tool: ${String(exhaustive)}`);
    }
  }
}

export function ensurePendingCapture(
  captures: CapturesStore,
  params: {
    sessionId: string;
    capturedAt: string;
    tool: string;
    capturePath: 'A' | 'B' | 'C' | 'D';
    repoRemoteUrl?: string;
    repoCommitHash?: string;
  },
): void {
  if (captures.getBySession(params.sessionId)) return;
  try {
    captures.savePending({
      sessionId: params.sessionId,
      capturedAt: params.capturedAt,
      originatingTool: { name: params.tool },
      capturePath: params.capturePath,
      status: 'pending',
      spanCount: 0,
      durationMs: 0,
      redactedSpanCount: 0,
      ...(params.repoRemoteUrl ? { repoRemoteUrl: params.repoRemoteUrl } : {}),
      ...(params.repoCommitHash ? { repoCommitHash: params.repoCommitHash } : {}),
    });
  } catch (err) {
    if (!captures.getBySession(params.sessionId)) throw err;
  }
}

export async function ingestStopHookCapture(
  captures: CapturesStore,
  receiver: Receiver | undefined,
  payload: StopHookPayload,
): Promise<void> {
  ensurePendingCapture(captures, {
    sessionId: payload.sessionId,
    capturedAt: payload.stoppedAt,
    tool: payload.tool,
    capturePath: 'D',
  });
  if (!payload.transcriptPath) return;
  if (!receiver) {
    console.warn('[main] stop-hook capture received but OTLP receiver is unavailable; pending capture has no transcript spans.');
    return;
  }

  const parser = parserForStopHookTool(payload.tool);
  let events;
  try {
    events = await parser.parseFull({ sessionId: payload.sessionId, path: payload.transcriptPath });
  } catch (err) {
    console.warn(
      `[main] stop-hook transcript import failed for ${payload.transcriptPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (events.length === 0) return;

  const provider = startSyntheticSpanProvider({
    otlpHttpEndpoint: `http://127.0.0.1:${receiver.httpPort}/v1/traces`,
  });
  try {
    for (const event of events) {
      emitSyntheticSpan(provider, { tool: parser.tool, sessionId: payload.sessionId, event });
    }
    await provider.flush();
  } finally {
    await provider.shutdown();
  }
}
