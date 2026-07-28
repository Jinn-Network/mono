import { z } from "zod";
import { RECORD_DISCOVERY_VERSION } from "./identifiers.js";
import { assertRecordKindUri } from "./grammar.js";

// Facts-profile contract (design §12, program §7.13): owned by the protocol
// package; the per-kind *documents* live in `discovery/facts/*` leaves. A
// profile is purely declarative field labeling -- record vs substrate class
// (§5.4), reference-bearing status (§8 `referrers` inversion), and, for
// fields liftable into CloudEvents extension attributes (§9.1), the
// attribute name and permitted scalar type.

export type FactClass = "record" | "substrate";
export type FactScalarType = "string" | "number" | "boolean";

export interface FactsProfileField {
  name: string;
  class: FactClass;
  referenceBearing?: boolean;
  cloudEvents?: { attribute: string; scalar: FactScalarType };
}

export interface FactsProfileDocument {
  protocol: string;
  kind: string;
  profile: string;
  fields: FactsProfileField[];
}

// CloudEvents 1.0 §2.1 attribute-naming convention: lowercase letters and
// digits only, no more than 20 characters.
const CLOUDEVENTS_ATTRIBUTE_NAME = /^[a-z0-9]{1,20}$/;

const FactsProfileFieldSchema = z.looseObject({
  name: z.string().min(1),
  class: z.enum(["record", "substrate"]),
  referenceBearing: z.boolean().optional(),
  cloudEvents: z
    .looseObject({
      attribute: z.string().regex(CLOUDEVENTS_ATTRIBUTE_NAME),
      scalar: z.enum(["string", "number", "boolean"]),
    })
    .optional(),
});

const FactsProfileDocumentSchema = z.looseObject({
  protocol: z.literal(RECORD_DISCOVERY_VERSION),
  kind: z.string().min(1),
  profile: z.string().min(1),
  fields: z.array(FactsProfileFieldSchema),
});

/**
 * Parses and validates a facts-profile document (§12): `kind` must be a
 * conforming record-kind URI, and every field's `cloudEvents.attribute` (if
 * present) must conform to the CloudEvents 1.0 attribute-naming rule.
 */
export function parseFactsProfile(json: unknown): FactsProfileDocument {
  const parsed = FactsProfileDocumentSchema.parse(json);
  assertRecordKindUri(parsed.kind);
  return parsed as FactsProfileDocument;
}

/** The names of a profile's reference-bearing fields (§8 `referrers` inversion). */
export function referenceBearingFields(profile: FactsProfileDocument): string[] {
  return profile.fields.filter((field) => field.referenceBearing === true).map((field) => field.name);
}

/** The fields a profile declares liftable into CloudEvents extension attributes (§9.1). */
export function cloudEventsFields(profile: FactsProfileDocument): FactsProfileField[] {
  return profile.fields.filter((field) => field.cloudEvents !== undefined);
}
