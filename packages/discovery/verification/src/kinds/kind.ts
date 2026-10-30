// SPDX-License-Identifier: Apache-2.0

import type { Finding } from "../results.js";
import type { RecordView } from "../record-view.js";

/** A digest a record cites. */
export interface RecordReference {
  readonly digest: string;
  /** The field's name, as the spec's facts profile for this kind names it where it does. */
  readonly field: string;
  /** JSON pointer into the document. */
  readonly path: string;
  /**
   * The family lets a reader lack these bytes: a private input, a withheld trace, a grader nobody
   * outside may see. An absent target is then reported as unavailable, not as dangling.
   */
  readonly mayBeUnavailable?: boolean;
}

/** Who a record says it speaks for, for trust-core's §7.5 procedure. */
export interface RecordAttribution {
  /** The Agent IRI claimed. */
  readonly agent: string;
  /** The record family the signing key's binding must cover. */
  readonly scope: string;
  /** The record's own effective time, when it states one. A caller's `atTime` overrides it. */
  readonly atTime?: string;
  /** §7.5b: a `signs-for` relationship stands in for `scope: authorizations`. */
  readonly allowSignsForAuthorization?: boolean;
}

/**
 * How one record type is checked. The two optional reasons are where a family's normative text
 * departs from the general rules in "Verifying a record by hand": each states why, so a report can
 * say why a check did not run.
 */
export interface RecordKind {
  readonly family: string;
  /** Whether these bytes name this kind. Must be exact: two kinds claiming a record is a finding. */
  identify(view: RecordView): boolean;
  /** Findings against the type's schema and the family's structural rules. Empty means conforming. */
  validate(view: RecordView): readonly Finding[];
  /** Why RFC 8785 is not this kind's rule. Omit when a sealed record's encoding applies. */
  readonly encodingExemption?: string;
  /** Exempt from RFC 8785 and still I-JSON, so `encoding` checks that much. */
  readonly requiresIJson?: boolean;
  /** The envelope's `payloadType` when this kind is signed (TEP §21.2). Trust validators check their own. */
  readonly mediaType?: string;
  /** Why a bare document is acceptable. Omit when the kind must be a signed envelope. */
  readonly unsignedBecause?: string;
  /** The family accepts any JSON spelling of the DSSE envelope. Defaults to the exact sealed bytes. */
  readonly anyEnvelopeSpelling?: boolean;
  /** Keys that must be among the verified signers. */
  requiredSigners?(view: RecordView): readonly string[];
  /** Every digest the record cites. Runs only on a record that passed `validate`. */
  references?(view: RecordView): readonly RecordReference[];
  /** Omit when the record names no agent a binding could be resolved for. */
  attribution?(view: RecordView): RecordAttribution | undefined;
}

export type RecordKinds = Readonly<Record<string, RecordKind>>;
