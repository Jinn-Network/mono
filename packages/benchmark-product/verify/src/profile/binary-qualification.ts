import { validateBinaryInstrumentParameters } from "@jinn-network/benchmarking-aggregate";
import {
  PROMPTED_SCREENING_LIMITATIONS,
  PROMPTED_SCREENING_PROFILE,
} from "../admission/contracts.js";

export const BINARY_INSTRUMENT_REPORT_LIMITATIONS = {
  mutableModelAlias:
    "The gpt-5.6-luna identifier is a mutable provider alias; this evidence does not prove invariant model weights across calls.",
  reviewerKeyPerson:
    "Distinct reviewer signing keys prove key control, not that the controllers are distinct people.",
  cognitiveBlinding:
    "Signed visibility and reveal receipts attest the review protocol; they do not technically prove cognitive blinding.",
  operatorOnly:
    "Truth uses operator-only admission and is not publication-grade two-human unanimous truth.",
  // Prose, not the spec's bare kebab identifier `screened-not-independently-labeled` (spec §6.8,
  // ruling C-1): that identifier is the limitation's NAME, and every other entry in this map is a
  // full sentence, rendered on the public page (`assets.ts`) and byte-compared at cold
  // verification (`claim-consistency.ts`). Passes §6.1's overclaim test: no "unanimous", no
  // "independent" as an affirmative claim -- "human reviewers" appears only as the disclosed
  // absence, which is the point of a limitation string.
  screenedNotIndependentlyLabeled:
    "Truth uses screened-operator-sampled admission: a pinned model screens every item and the "
    + "operator hand-checks the flagged set plus a random sample; this proves screen-hand "
    + "agreement on that sample, not independent two-human truth.",
} as const;

/** Portable disclosure projection from the registered binary-instrument method parameters. */
export function binaryInstrumentReportLimitations(
  parameters: Readonly<Record<string, unknown>>,
): readonly string[] {
  const validation = validateBinaryInstrumentParameters(parameters);
  if (!validation.ok) {
    throw new TypeError(`invalid sealed binary-instrument parameters: ${validation.issues.join("; ")}`);
  }
  return [
    // Absent, or any profile other than dated-snapshot-sampling, means "emit the alias
    // limitation" — today's behavior byte for byte (spec §1.4 clause 2). This is not a default of
    // convenience: the two frozen 144-cell golden fixtures seal parameters with no
    // judgeModelProfile, so they must keep emitting this string in this position to stay green
    // unmodified. Flipping the absent case to "emit nothing" would move those fixtures' bytes and
    // destroy the compatibility proof this program depends on.
    ...(parameters["judgeModelProfile"] === "dated-snapshot-sampling"
      ? []
      : [BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias]),
    // reviewerKeyPerson and cognitiveBlinding are claims about a two-reviewer protocol; an
    // operator-only run has no reviewers and no visibility receipts at all, so emitting them there
    // is a false limitation (spec §1.4 clause 4). truthAdmission is already a sealed parameter, so
    // this needs no new key.
    ...(parameters["truthAdmission"] === "two-human-unanimous"
      ? [
        BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
        BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
      ]
      : []),
    ...(parameters["truthAdmission"] === "operator-only"
      ? [BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly]
      : []),
    // Appended AFTER the operator-only arm (ruling C-3): the return is a positional array and the
    // two frozen 144-cell goldens depend on the existing entries keeping their indices.
    ...(parameters["truthAdmission"] === "screened-operator-sampled"
      ? [BINARY_INSTRUMENT_REPORT_LIMITATIONS.screenedNotIndependentlyLabeled]
      : []),
    // Appended only for an authenticated screening-table/v2 closure. Legacy parameter sets omit
    // the profile and therefore retain their exact limitation arrays and sealed Report bytes.
    ...(parameters["promptedScreeningProfile"] === PROMPTED_SCREENING_PROFILE
      ? PROMPTED_SCREENING_LIMITATIONS
      : []),
  ];
}
