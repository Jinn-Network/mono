"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { IDLE_ACTION_STATE, type GuiActionState } from "@/lib/action-state";

interface ActionFormProps {
  readonly action: (state: GuiActionState, formData: FormData) => Promise<GuiActionState>;
  readonly submitLabel: string;
  readonly gated?: boolean;
  readonly disabled?: boolean;
  readonly notice?: string;
  readonly successMessage?: string;
  readonly children?: React.ReactNode;
}

export function ActionForm({ action, submitLabel, gated = false, disabled = false, notice, successMessage, children }: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, IDLE_ACTION_STATE);
  const router = useRouter();
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status !== "idle") resultRef.current?.focus();
  }, [state]);
  useEffect(() => {
    if (state.status !== "scheduled") return undefined;
    // A scheduled launch intentionally returns before its driver advances durable state. Refresh
    // this server-rendered route until RunMonitorRefresh can observe `running` and take over.
    router.refresh();
    const timers = [500, 1_500, 3_000].map((delay) => window.setTimeout(() => router.refresh(), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [router, state]);
  return (
    <form action={formAction} className="flex min-w-0 flex-col gap-3">
      {children}
      <Button type="submit" variant={gated ? "destructive" : "default"} disabled={pending || disabled} className="self-start">
        {pending ? "Working" : submitLabel}
      </Button>
      {gated || notice !== undefined ? <p className="text-xs font-medium text-destructive">{notice ?? "Requires authority"}</p> : null}
      <div ref={resultRef} tabIndex={-1} aria-live="polite" aria-atomic="true" className="min-w-0 rounded-md focus-visible:ring-[3px] focus-visible:ring-foreground focus-visible:ring-offset-2">
        {state.status === "error" ? (
          <div role="alert" className="min-w-0 rounded-md border border-destructive p-3 text-sm [overflow-wrap:anywhere]">
            <p className="font-semibold">{state.error.code}</p>
            <p>{state.error.detail}</p>
            {state.error.issues?.map((issue) => <p key={`${issue.path}:${issue.message}`}>{issue.path}: {issue.message}</p>)}
            <p>Correct the named input or retry when the stated condition changes.</p>
          </div>
        ) : null}
        {state.status === "success" ? (
          successMessage !== undefined
            ? <p className="rounded-md border p-3 text-sm">{successMessage}</p>
            : <pre tabIndex={0} role="region" aria-label={`${submitLabel} result`} className="max-h-72 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify(state.result, null, 2)}</pre>
        ) : null}
        {state.status === "scheduled" ? (
          <p className="rounded-md border p-3 text-sm">{state.result.operation} scheduled. Open or refresh the run monitor for durable progress.</p>
        ) : null}
      </div>
    </form>
  );
}
