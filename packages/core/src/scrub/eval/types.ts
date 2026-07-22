/**
 * Scrub eval harness types (#1968 / design §7).
 *
 * Synthetic fixtures and operator-local labels never leave the machine as text
 * in published artifacts — only metrics-only JSON (counts) is safe to share.
 */

/** Class taxonomy from design §3.2. */
export type ScrubClass =
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'B1'
  | 'B2'
  | 'B3'
  | 'B4'
  | 'B5'
  | 'B6'
  | 'B7'
  | 'C1'
  | 'C2'
  | 'D1'
  | 'D2'
  | 'D3'
  | 'E1';

export interface LabeledSpan {
  class: ScrubClass;
  /** Inclusive start offset in the fixture text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Optional stable id for distinct-source weighting (dedupe replayed boilerplate). */
  sourceId?: string;
}

export interface EvalFixture {
  id: string;
  /** Attribute key the pipeline sees (default `content`). */
  key?: string;
  text: string;
  labels: LabeledSpan[];
  /**
   * When true, the scrubbed output must be byte-identical to the input
   * (corruption corpus / #1784 clean prose).
   */
  mustSurvive?: boolean;
  /** Profile to run: trace (strict), seed, or layer2. Default seed for CI. */
  profile?: 'trace' | 'seed' | 'layer2';
}

export interface ClassCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface ClassMetrics extends ClassCounts {
  recall: number;
  precision: number;
  /** Fβ with β=2 (recall-weighted). */
  fBeta2: number;
}

export interface BenchReport {
  /** Schema version for metrics-only artifacts. */
  schemaVersion: 1;
  /** Which pipeline builders were measured. */
  profiles: string[];
  /** Per-class counts + rates. No text, no spans. */
  classes: Partial<Record<ScrubClass, ClassMetrics>>;
  /** Corruption corpus: fixtures that must pass through unchanged. */
  corruption: {
    fixtures: number;
    failures: number;
  };
  /** Wall time for the run (ms). */
  elapsedMs: number;
}

export interface ScoredFinding {
  class: ScrubClass;
  start: number;
  end: number;
}
