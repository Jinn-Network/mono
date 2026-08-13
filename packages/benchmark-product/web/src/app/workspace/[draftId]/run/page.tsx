import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { RunMonitorRefresh } from "@/components/run-monitor-refresh";
import { LifecycleRail } from "@/components/lifecycle-rail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { loadRunView } from "@/lib/server/view-models";

function HiddenDraft({ draftId }: { readonly draftId: string }) {
  return <input type="hidden" name="draftId" value={draftId} />;
}

export default async function RunMonitorPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const view = loadRunView(draftId);
  const status = view.ok && view.status.ok ? view.status.result : undefined;
  const state = status?.state;
  const cancellationPending = status?.cancelRequested === true && state === "running";
  const poll = status?.driver?.status === "active" || cancellationPending;

  return <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 outline-none">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><p className="colophon-eyebrow text-muted-foreground">Draft <span className="font-mono normal-case tracking-normal">{draftId}</span></p><h1 className="mt-2 text-5xl">Durable run monitor</h1><p className="colophon-body mt-2 text-muted-foreground">Expected work stays visible through delivery, judgment, failure, and cancellation.</p></div>
      <nav aria-label="Run navigation" className="flex flex-wrap gap-2"><RunMonitorRefresh poll={poll} /><Button asChild variant="outline"><Link href={`/workspace/${draftId}/results`}>Results</Link></Button><Button asChild variant="outline"><Link href={`/workspace/${draftId}`}>Draft</Link></Button></nav>
    </header>
    <LifecycleRail state={state} />
    {!view.ok ? <p role="alert">{view.detail}</p> : !view.status.ok ? (
      <Card><CardHeader><CardTitle>Run unavailable</CardTitle></CardHeader><CardContent role="alert"><p className="font-semibold">{view.status.error.code}</p><p>{view.status.error.detail}</p></CardContent></Card>
    ) : <>
      <section aria-live="polite" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardHeader><CardTitle>Lifecycle</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold">{status?.state}</p>{cancellationPending ? <p className="text-destructive">Cancellation requested; driver is draining.</p> : status?.cancelRequested === true && state === "closed" ? <p>Cancellation finalized; run is cancelled.</p> : null}</CardContent></Card>
        <Card><CardHeader><CardTitle>Expected</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{status?.counts.expected}</CardContent></Card>
        <Card><CardHeader><CardTitle>Delivered</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{status?.counts.delivered}</CardContent></Card>
        <Card><CardHeader><CardTitle>Judged / failed</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{status?.counts.judged} / {status?.counts.failed}</CardContent></Card>
      </section>
      {status?.driver ? <Card><CardHeader><CardTitle>Driver generation</CardTitle></CardHeader><CardContent>
        <dl className="grid gap-2 sm:grid-cols-2"><div><dt className="font-medium">Operation</dt><dd>{status.driver.operation}</dd></div><div><dt className="font-medium">Durable outcome</dt><dd>{status.driver.status}</dd></div></dl>
        {status.driver.status === "active" ? <p>A server restart may have interrupted this generation. Resume safely from the durable journal if progress stops.</p> : null}
        {status.driver.error ? <div role="alert" className="mt-3 rounded-md border border-destructive p-3"><p className="font-semibold">{status.driver.error.code}</p><p>{status.driver.error.detail}</p><p>Correct the condition, then retry with Resume.</p></div> : null}
      </CardContent></Card> : null}
      <Card><CardHeader><CardTitle>Run controls</CardTitle></CardHeader><CardContent className="grid min-w-0 gap-5 [&>*]:min-w-0"><p role="note" className="rounded-md border border-amber-600/40 bg-amber-50 p-3 text-sm text-foreground dark:bg-amber-950/20"><strong>Provider network and possible charges.</strong> Launching a provider-backed Arm contacts its provider using your local Colophon credential and may create provider charges. The bundled sample needs no account, API key, funds, or provider connection.</p><div className="grid min-w-0 gap-5 md:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
        <ActionForm action={GUI_SERVER_ACTIONS["run.launch"]} submitLabel="Launch" gated disabled={state !== "locked"}><HiddenDraft draftId={draftId} /></ActionForm>
        <ActionForm action={GUI_SERVER_ACTIONS["run.resume"]} submitLabel="Resume" disabled={state !== "running" || status?.cancelRequested === true}><HiddenDraft draftId={draftId} /></ActionForm>
        <ActionForm action={GUI_SERVER_ACTIONS["run.cancel"]} submitLabel="Request / finalize cancel" gated disabled={state !== "running" && !(state === "closed" && status?.cancelRequested === true)}><HiddenDraft draftId={draftId} /></ActionForm>
        <ActionForm action={GUI_SERVER_ACTIONS["run.collect"]} submitLabel="Collect" disabled={state !== "running" || status?.cancelRequested === true}><HiddenDraft draftId={draftId} /></ActionForm>
      </div></CardContent></Card>
      <Card><CardHeader><CardTitle>Cells</CardTitle></CardHeader><CardContent><div tabIndex={0} role="region" aria-label="Run cells table" className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th scope="col">Arm</th><th scope="col">Replicate</th><th scope="col">Status</th><th scope="col">Dispatches</th><th scope="col">Failure / blame</th></tr></thead><tbody>{status?.cells.map((cell) => <tr key={cell.cellKey} className="border-t"><td className="py-2">{cell.armId}</td><td>{cell.replicate}</td><td>{cell.status}</td><td>{cell.dispatches}</td><td>{cell.detail ?? "—"}{cell.blame ? ` (${cell.blame})` : ""}</td></tr>)}</tbody></table></div></CardContent></Card>
    </>}
  </main>;
}
