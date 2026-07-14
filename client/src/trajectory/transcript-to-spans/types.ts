/**
 * Transcript-to-spans parser contract (DR-2026-07-14, issue #1473).
 *
 * A TranscriptSpanParser reads a harness's raw solve transcript off disk and
 * converts it into SpanInput[] ready for TrajectoryCollector.addSpan — the
 * spans that make jinn.trajectory.v1's `trajectory` slot truthful. Parsing
 * degrades to [] on any failure (missing file, unparseable content); it never
 * throws past the caller (see getTranscriptSpanParser callers in engine.ts).
 */

import type { SpanInput } from '../collector.js';

export interface TranscriptSpanParser {
  /** Provenance tag recorded on every span's jinn.transcript.sourceFormat attribute. */
  readonly sourceFormat: string;
  /** Parser identity recorded on jinn.transcript.parser. */
  readonly parserName: string;
  /** Parser version recorded on jinn.transcript.parserVersion. */
  readonly parserVersion: string;
  /** Parse a complete transcript file into spans. Never throws — returns [] on failure. */
  parse(transcriptPath: string): Promise<SpanInput[]>;
}

/** Result of resolving a harness impl name to its transcript parser + expected file path. */
export interface TranscriptSpanParserResolution {
  parser: TranscriptSpanParser;
  transcriptPath: string;
}
