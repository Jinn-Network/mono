/**
 * Transcript-to-spans parser contract (DR-2026-07-14, issue #1473).
 *
 * A TranscriptSpanParser reads a harness's raw solve transcript off disk and
 * converts it into SpanInput[] ready for TrajectoryCollector.addSpan — the
 * spans that make jinn.trajectory.v1's `trajectory` slot truthful. Parsing
 * degrades to [] on any failure (missing file, unparseable content); it never
 * throws past the caller (see getTranscriptSpanParser callers in engine.ts).
 */

import type { TranscriptSpanParser } from '@jinn-network/core/trajectory';

export type {
  TranscriptSpanInput,
  TranscriptSpanParser,
} from '@jinn-network/core/trajectory';

/** Result of resolving a harness impl name to its transcript parser + expected file path. */
export interface TranscriptSpanParserResolution {
  parser: TranscriptSpanParser;
  transcriptPath: string;
}
