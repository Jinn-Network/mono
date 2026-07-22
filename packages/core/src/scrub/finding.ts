/**
 * Detector finding contract (#1969 / design §6.1).
 *
 * Detectors emit findings; they never edit attributes. Disposition is applied
 * in one pass from the versioned policy table (§6.5).
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

/** DLP-style confidence bands (design §6.1). */
export type Band = 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export interface FindingSpan {
  /** Attribute key the span lives in. */
  key: string;
  /** Inclusive start offset in the string value. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface Finding {
  class: ScrubClass;
  span: FindingSpan;
  confidence: Band;
  /** Explainability: which shape/checksum/context/model fired. */
  evidence: string[];
  detector: { name: string; version: string };
}

/**
 * Detector contract: emit findings over an attribute bag. Must not mutate
 * values — disposition owns edits.
 */
export interface Detector {
  readonly name: string;
  readonly version: string;
  detect(attributes: Record<string, unknown>): Finding[] | Promise<Finding[]>;
}
