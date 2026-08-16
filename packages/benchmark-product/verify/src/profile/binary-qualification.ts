import { validateBinaryInstrumentParameters } from "@jinn-network/benchmarking-aggregate";

export const BINARY_INSTRUMENT_REPORT_LIMITATIONS = {
  mutableModelAlias:
    "The gpt-5.6-luna identifier is a mutable provider alias; this evidence does not prove invariant model weights across calls.",
  reviewerKeyPerson:
    "Distinct reviewer signing keys prove key control, not that the controllers are distinct people.",
  cognitiveBlinding:
    "Signed visibility and reveal receipts attest the review protocol; they do not technically prove cognitive blinding.",
  operatorOnly:
    "Truth uses operator-only admission and is not publication-grade two-human unanimous truth.",
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
    BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
    BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
    BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
    ...(parameters["truthAdmission"] === "operator-only"
      ? [BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly]
      : []),
  ];
}
