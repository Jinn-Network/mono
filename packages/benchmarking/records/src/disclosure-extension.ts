/**
 * The `disclosure-specification/v1` Report extension (design §6.3, issue #2839).
 *
 * The disclosure record is **sealed, never separately signed**. Attribution comes from the carrier:
 * the Report is already a DSSE payload signed by the report authority, so naming the record's
 * digest from a Report extension key pulls the record under the author's existing signature at no
 * new key-management cost. A second signature over the same claim by the same key would add no fact
 * and would create a way for the two to disagree.
 *
 * Two shape decisions are load-bearing:
 *
 * - **One descriptor, not a list.** R1 says the cardinality is structural, so this extension names
 *   exactly one record. `MatrixPublicationExtensionSchema`'s single-descriptor shape is the
 *   precedent; the Run extension's `registrationArtifacts` array is the wrong one here.
 * - **The Report record schema does not change.** `ReportRecordSchema` is built on
 *   `topLevelRecordSchema`, a loose object admitting any absolute-URI extension key. Every existing
 *   Report record stays byte-identical and every existing fixture stays green — the whole binding
 *   rests on unknown keys surviving parse → re-seal → byte-compare.
 */

import { z } from "zod";
import { DigestBearingResourceDescriptorSchema } from "./descriptors.js";
import { DISCLOSURE_SPECIFICATION_EXTENSION } from "./identifiers.js";

/** A bare `DigestBearingResourceDescriptor`: the acquisition URI is a hint, the digest is the
 * identity, and no hint can ever substitute for it. */
export const ReportDisclosureExtensionSchema = DigestBearingResourceDescriptorSchema;
export type ReportDisclosureExtension = z.infer<typeof ReportDisclosureExtensionSchema>;

type ExtensibleRecord = Record<string, unknown>;

/** Construct the typed namespaced Report extension. Throws on a descriptor this schema refuses. */
export function reportDisclosureExtension(value: unknown): ReportDisclosureExtension {
  return ReportDisclosureExtensionSchema.parse(value);
}

export function withReportDisclosureExtension<T extends ExtensibleRecord>(
  record: T,
  extension: ReportDisclosureExtension,
): T & { [DISCLOSURE_SPECIFICATION_EXTENSION]: ReportDisclosureExtension } {
  return {
    ...record,
    [DISCLOSURE_SPECIFICATION_EXTENSION]: reportDisclosureExtension(extension),
  } as T & { [DISCLOSURE_SPECIFICATION_EXTENSION]: ReportDisclosureExtension };
}

export function readReportDisclosureExtension(record: ExtensibleRecord): ReportDisclosureExtension | undefined {
  const value = record[DISCLOSURE_SPECIFICATION_EXTENSION];
  return value === undefined ? undefined : reportDisclosureExtension(value);
}
