"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { IDLE_ACTION_STATE, type GuiActionState } from "@/lib/action-state";

interface VerificationFormProps {
  readonly action: (state: GuiActionState, formData: FormData) => Promise<GuiActionState>;
  readonly draftId: string;
}

interface VerificationResult {
  readonly checks: readonly string[];
  readonly matrixSha256: string;
  readonly reportEnvelopeSha256?: string;
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
  return <form action={formAction} className="flex min-w-0 flex-col gap-3">
    <input type="hidden" name="draftId" value={draftId} />
    <Button type="submit" disabled={pending} className="self-start">{pending ? "Verifying" : "Verify records"}</Button>
    <div aria-live="polite" className="min-w-0">
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
      </div> : null}
    </div>
  </form>;
}
