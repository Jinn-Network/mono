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
 * A single stage in the seller-side scrub pipeline. `name` + `version` expose
 * the active components to local inspection and tests. The current published
 * trace-envelope schema does not carry this component list.
 */
export interface ScrubStage {
  readonly name: string;
  readonly version: string;
  scrub(attributes: Attributes): ScrubResult | Promise<ScrubResult>;
}
