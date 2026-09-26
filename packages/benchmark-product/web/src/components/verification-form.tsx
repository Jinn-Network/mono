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

interface VerificationSubject {
  readonly subject: string;
  readonly outcome: string;
  readonly declaredProfiles?: readonly string[];
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
}

function isVerificationResult(value: unknown): value is VerificationResult {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<VerificationResult>;
  return Array.isArray(candidate.checks) && candidate.checks.every((check) => typeof check === "string")
    && typeof candidate.matrixSha256 === "string"
    && (candidate.reportEnvelopeSha256 === undefined || typeof candidate.reportEnvelopeSha256 === "string");
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
        {result.anchors !== undefined ? <>
          <p className="mt-3 font-medium">Anchors</p>
          {result.anchors.anchors.length === 0
            ? <p>no anchor records carried</p>
            : <ul className="list-disc pl-5">{result.anchors.anchors.map((anchor) => (
              <li key={anchor.recordSha256}>{anchor.subject ?? "unresolved"} · {anchor.status} · {anchor.recordSha256}</li>
            ))}</ul>}
          <p className="mt-3 font-medium">Anchor subjects</p>
          <ul className="list-disc pl-5">{result.anchors.subjects.map((subject) => (
            <li key={subject.subject}>{subject.subject}: {subject.outcome}{subject.declaredProfiles !== undefined ? ` (${subject.declaredProfiles.map(presentProtocolText).join(", ")})` : ""}</li>
          ))}</ul>
        </> : null}
        {result.anchoringWindow !== undefined
          ? <p className="mt-3">unresolved pending anchor evidence exists and `report` closes the anchoring window.</p>
          : null}
      </div> : null}
    </div>
  </form>;
}
