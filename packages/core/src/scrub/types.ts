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
  /** Findings from the detection pass (#1969). Optional for legacy stage wrappers. */
  findings?: import('./finding.js').Finding[];
  /** True when reject-publish fired or check-mode saw a non-pass finding. */
  rejected?: boolean;
  /** Unresolved flag findings held for review (#1973). */
  unresolvedFlags?: import('./finding.js').Finding[];
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
