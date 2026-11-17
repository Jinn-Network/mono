"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { IDLE_ACTION_STATE, type GuiActionState } from "@/lib/action-state";
import { presentProtocolText } from "@/lib/present-protocol-profile";

interface VerificationFormProps {
  readonly action: (state: GuiActionState, formData: FormData) => Promise<GuiActionState>;
  readonly draftId: string;
}

interface VerificationAnchor {
  readonly recordSha256: string;
  readonly status: string;
  readonly subject?: string;
}

type TimestampCoverageOutcome = "anchored" | "absent" | "declared-but-absent";

interface VerificationSubject {
  readonly subject: string;
  readonly outcome: TimestampCoverageOutcome;
  readonly declaredProfiles?: readonly string[];
}

/**
 * The reader tool's names for the timestamp-proof block (reader-facing vocabulary spec section 4.2,
 * v1.14; issue #5241): the claimant who reads this card next runs the reader on the same records.
 * This package cannot import the reader, so these copy it, and `verification-form.test.tsx` fails
 * when the reader's source stops printing them. The raw outcome values stay in the result, and so
 * does the raw subject `matrix`, which the reader names *the runs* (v1.15; issue #5278).
 */
export const TIMESTAMP_PROOF_LABELS = {
  heading: "Timestamps",
  coverageHeading: "Timestamp coverage",
  proof: "timestamp proof",
  noneCarried: "no timestamp proofs carried",
  outcomes: {
    anchored: "timestamped",
    absent: "none",
    "declared-but-absent": "promised but missing",
  } satisfies Record<TimestampCoverageOutcome, string>,
  subjects: { lock: "lock", matrix: "the runs" },
} as const;

/** The reader's name for the record a proof covers; a subject the reader does not name prints as written. */
function timestampSubjectName(subject: string): string {
  return Object.hasOwn(TIMESTAMP_PROOF_LABELS.subjects, subject)
    ? TIMESTAMP_PROOF_LABELS.subjects[subject as keyof typeof TIMESTAMP_PROOF_LABELS.subjects]
    : subject;
}

function isTimestampCoverageOutcome(value: unknown): value is TimestampCoverageOutcome {
  return typeof value === "string" && Object.hasOwn(TIMESTAMP_PROOF_LABELS.outcomes, value);
}

interface VerificationResult {
  readonly checks: readonly string[];
  readonly matrixSha256: string;
  readonly reportEnvelopeSha256?: string;
  readonly anchors?: {
    readonly anchors: readonly VerificationAnchor[];
    readonly subjects: readonly VerificationSubject[];
  };
  readonly anchoringWindow?: { readonly closingOperation: "report" };
  readonly readerChecksNotRun?: readonly string[];
}

function isVerificationResult(value: unknown): value is VerificationResult {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<VerificationResult>;
  return Array.isArray(candidate.checks) && candidate.checks.every((check) => typeof check === "string")
    && typeof candidate.matrixSha256 === "string"
    && (candidate.reportEnvelopeSha256 === undefined || typeof candidate.reportEnvelopeSha256 === "string")
    && (candidate.readerChecksNotRun === undefined
      || (Array.isArray(candidate.readerChecksNotRun) && candidate.readerChecksNotRun.every((check) => typeof check === "string")))
    // An outcome the card has no name for is an unreadable result, so no raw value is printed.
    && (candidate.anchors === undefined
      || (Array.isArray(candidate.anchors.anchors) && Array.isArray(candidate.anchors.subjects)
        && candidate.anchors.subjects.every((subject) => isTimestampCoverageOutcome(subject?.outcome))));
}

export function VerificationForm({ action, draftId }: VerificationFormProps) {
  const [state, formAction, pending] = useActionState(action, IDLE_ACTION_STATE);
  const result = state.status === "success" && isVerificationResult(state.result) ? state.result : undefined;
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status !== "idle") resultRef.current?.focus();
  }, [state]);
  return <form action={formAction} className="flex min-w-0 flex-col gap-3">
    <input type="hidden" name="draftId" value={draftId} />
    <Button type="submit" disabled={pending} className="self-start">{pending ? "Verifying" : "Verify records"}</Button>
    <div ref={resultRef} tabIndex={-1} aria-live="polite" aria-atomic="true" className="min-w-0 rounded-md focus-visible:ring-[3px] focus-visible:ring-foreground focus-visible:ring-offset-2">
      {state.status === "error" ? <div role="alert" className="rounded-md border border-destructive p-3 [overflow-wrap:anywhere]">
        <p className="font-semibold">Verification failed: {state.error.code}</p>
        <p>{state.error.detail}</p>
        <p>No passing verification claim is shown. Inspect the named integrity or recomputation failure before retrying.</p>
      </div> : null}
      {state.status === "success" && result === undefined ? <p role="alert">Verification returned an unreadable result.</p> : null}
      {result !== undefined ? <div className="rounded-md border p-3">
        <p className="font-semibold">Verification passed</p>
        <dl className="mt-2 grid min-w-0 gap-2">
          <div><dt className="font-medium">Matrix digest</dt><dd className="break-all font-mono text-xs">{result.matrixSha256}</dd></div>
          {result.reportEnvelopeSha256 !== undefined ? <div><dt className="font-medium">Report envelope digest</dt><dd className="break-all font-mono text-xs">{result.reportEnvelopeSha256}</dd></div> : null}
        </dl>
        <p className="mt-3 font-medium">Named checks</p>
        <ul className="list-disc pl-5">{result.checks.map((check) => <li key={check}>{check}</li>)}</ul>
        {result.readerChecksNotRun !== undefined && result.readerChecksNotRun.length > 0 ? <>
          <p className="mt-3 font-medium">Not run here (publish runs them on the bundle)</p>
          <ul className="list-disc pl-5">{result.readerChecksNotRun.map((check) => <li key={check}>{check}</li>)}</ul>
        </> : null}
        {result.anchors !== undefined ? <>
          <p className="mt-3 font-medium">{TIMESTAMP_PROOF_LABELS.heading}</p>
          {result.anchors.anchors.length === 0
            ? <p>{TIMESTAMP_PROOF_LABELS.noneCarried}</p>
            : <ul className="list-disc pl-5">{result.anchors.anchors.map((anchor) => (
              <li key={anchor.recordSha256}>{anchor.subject === undefined ? "unresolved" : timestampSubjectName(anchor.subject)} {TIMESTAMP_PROOF_LABELS.proof} · {anchor.status} · {anchor.recordSha256}</li>
            ))}</ul>}
          <p className="mt-3 font-medium">{TIMESTAMP_PROOF_LABELS.coverageHeading}</p>
          <ul className="list-disc pl-5">{result.anchors.subjects.map((subject) => (
            <li key={subject.subject}>{timestampSubjectName(subject.subject)}: {TIMESTAMP_PROOF_LABELS.outcomes[subject.outcome]}{subject.declaredProfiles !== undefined ? ` (${subject.declaredProfiles.map(presentProtocolText).join(", ")})` : ""}</li>
          ))}</ul>
        </> : null}
        {result.anchoringWindow !== undefined
          ? <p className="mt-3">a timestamp proof is still pending, and `report` closes the anchoring window.</p>
          : null}
      </div> : null}
    </div>
  </form>;
}
