export type Attributes = Record<string, unknown>;

export interface RedactionRecord {
  /** attribute key affected */
  key: string;
  /** stage that made the redaction (matches ScrubStage.name) */
  stage: string;
  /** category, e.g. 'dropped-key' | 'secret' | 'pii' */
  kind: string;
  /** optional detail, e.g. a rule id or entity type */
  detail?: string;
}

export interface ScrubResult {
  attributes: Attributes;
  redactions: RedactionRecord[];
}

/**
 * A single stage in the seller-side scrub pipeline. `name` + `version` are
 * recorded in the signed provenance manifest so a buyer/auditor can see exactly
 * which components (and versions) produced a published trajectory.
 */
export interface ScrubStage {
  readonly name: string;
  readonly version: string;
  scrub(attributes: Attributes): ScrubResult | Promise<ScrubResult>;
}
