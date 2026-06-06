import { z } from 'zod/v3';

export const TranscriptEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user-message'),
    timestamp: z.string().datetime(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal('assistant-message'),
    timestamp: z.string().datetime(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal('tool-call'),
    timestamp: z.string().datetime(),
    name: z.string(),
    args: z.record(z.unknown()),
  }),
  z.object({
    kind: z.literal('tool-result'),
    timestamp: z.string().datetime(),
    name: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('edit'),
    timestamp: z.string().datetime(),
    path: z.string(),
    diff: z.string(),
  }),
]);

export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

/**
 * Per-tool transcript parser. Each implementation reads the native disk format
 * for one tool (Claude Code JSONL, Cursor SQLite, Aider history, etc.) and
 * normalises into the canonical TranscriptEvent shape so the synthetic-span
 * builder (Task 3.2) can produce uniform OTel spans regardless of source.
 */
export interface TranscriptParser {
  /** Tool identity. Used by the synthetic-span builder to brand `service.name`. */
  readonly tool:
    | 'claude-code'
    | 'codex'
    | 'gemini-cli'
    | 'cursor'
    | 'aider'
    | 'continue';

  /**
   * Incremental parser. Called when the watcher observes new bytes appended
   * to the transcript file. Returns events drained since the last call.
   */
  parseChunk(input: { sessionId: string; chunk: Buffer | string }): TranscriptEvent[];

  /**
   * One-shot parser for a complete transcript file. Used by the
   * `jinn capture import` CLI and as the path-D safety-net ingest at session end.
   */
  parseFull(input: { sessionId: string; path: string }): Promise<TranscriptEvent[]>;
}
