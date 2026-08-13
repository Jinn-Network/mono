import {
  BenchmarkAccountingRecordSchema,
  ObservationArchiveSchema,
  type BenchmarkAccountingRecord,
  type ObservationArchive,
} from "./schema.js";

export type PublicationCheckResult =
  | { readonly status: "pass" }
  | { readonly status: "fail"; readonly detail: string }
  | { readonly status: "indeterminate"; readonly detail: string };

/**
 * Checks only the ordering evidence carried by `publicRegistration`.
 * Signature/trust, stream enumeration, and substrate-profile ordering deliberately remain
 * separate verification layers.
 */
export function checkPublicRegistrationOrder(accounting: BenchmarkAccountingRecord): PublicationCheckResult {
  const registration = accounting.publicRegistration;
  if (registration.status === "post-hoc") return { status: "pass" };
  if (registration.status === "unverifiable") {
    return { status: "indeterminate", detail: "publisher declared public registration ordering unverifiable" };
  }
  const { runBoundary, firstDispatchBoundary } = registration;
  if (runBoundary.kind !== firstDispatchBoundary.kind) {
    return { status: "indeterminate", detail: "registration and first-dispatch boundaries use incomparable authorities" };
  }
  if (runBoundary.kind === "substrate" || firstDispatchBoundary.kind === "substrate") {
    return { status: "indeterminate", detail: "substrate anchor ordering requires its profile-specific verifier" };
  }
  if (
    runBoundary.source.agent !== firstDispatchBoundary.source.agent
    || runBoundary.source.name !== firstDispatchBoundary.source.name
  ) {
    return { status: "indeterminate", detail: "record-discovery boundaries belong to different source chains" };
  }
  return runBoundary.position.sequence < firstDispatchBoundary.position.sequence
    ? { status: "pass" }
    : { status: "fail", detail: "Run source position must precede the first dispatch source position" };
}

/** Structural conformance result for a prevalidated archive, including retained conflicts. */
export function checkObservationArchive(archive: ObservationArchive): PublicationCheckResult {
  const parsed = ObservationArchiveSchema.safeParse(archive);
  if (!parsed.success) return { status: "fail", detail: "archive does not satisfy the observation archive schema" };
  const conflict = archive.streams.find((stream) => stream.conflicts.length > 0);
  if (conflict !== undefined) {
    return { status: "fail", detail: `stream ${conflict.source} / ${conflict.subject} retains conflicting observations` };
  }
  return { status: "pass" };
}

/** Local record-shape check; scope completeness is intentionally a Discovery-layer operation. */
export function checkBenchmarkAccounting(accounting: BenchmarkAccountingRecord): PublicationCheckResult {
  const parsed = BenchmarkAccountingRecordSchema.safeParse(accounting);
  if (!parsed.success) return { status: "fail", detail: "accounting record does not satisfy the BenchmarkAccounting v1 schema" };
  return checkPublicRegistrationOrder(accounting);
}
