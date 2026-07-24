import type { Span } from '../schema.js';

/** A canonical typed trajectory span before collector-assigned ids and chaining. */
export type TranscriptSpanInput = Omit<Span, 'traceId' | 'spanId' | 'parentSpanId'> & {
  parentSpanId?: string | null;
};

/**
 * Converts a native harness transcript to canonical typed trajectory spans.
 * File parsing always degrades to an empty list. Parsers that can safely
 * consume in-memory snapshot bytes expose the same implementation via
 * `parseText`.
 */
export interface TranscriptSpanParser {
  readonly sourceFormat: string;
  readonly parserName: string;
  readonly parserVersion: string;
  parse(transcriptPath: string): Promise<TranscriptSpanInput[]>;
  parseText?(rawText: string): TranscriptSpanInput[];
}
