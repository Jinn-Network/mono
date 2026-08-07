"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { IDLE_ACTION_STATE, type GuiActionState } from "@/lib/action-state";

interface ActionFormProps {
  readonly action: (state: GuiActionState, formData: FormData) => Promise<GuiActionState>;
  readonly submitLabel: string;
  readonly gated?: boolean;
  readonly notice?: string;
  readonly children?: React.ReactNode;
}

export function ActionForm({ action, submitLabel, gated = false, notice, children }: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, IDLE_ACTION_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {children}
      <Button type="submit" variant={gated ? "destructive" : "default"} disabled={pending} className="self-start">
        {pending ? "Working" : submitLabel}
      </Button>
      {gated || notice !== undefined ? <p className="text-xs font-medium text-destructive">{notice ?? "Requires authority"}</p> : null}
      <div aria-live="polite">
        {state.status === "error" ? (
          <div role="alert" className="rounded-md border border-destructive p-3 text-sm">
            <p className="font-semibold">{state.error.code}</p>
            <p>{state.error.detail}</p>
            {state.error.issues?.map((issue) => <p key={`${issue.path}:${issue.message}`}>{issue.path}: {issue.message}</p>)}
            <p>Correct the named input or retry when the stated condition changes.</p>
          </div>
        ) : null}
        {state.status === "success" ? (
          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(state.result, null, 2)}</pre>
        ) : null}
      </div>
    </form>
  );
}
