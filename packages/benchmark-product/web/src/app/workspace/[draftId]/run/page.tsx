import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { RunMonitorRefresh } from "@/components/run-monitor-refresh";
import { LifecycleRail } from "@/components/lifecycle-rail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const publication = view.ok && view.publication?.ok ? view.publication.result : undefined;
  const publicationConfiguration = view.ok ? view.publicationConfiguration : undefined;
  const beaconSources = view.ok ? view.beaconSources : [];
  const postHoc = state === "closed" || state === "reported" || state === "published-bundle";
  const reportStage = publication?.stages.find((stage) => stage.name === "report");
  const accountingStage = publication?.stages.find((stage) => stage.name === "accounting");
  const matrixStage = publication?.stages.find((stage) => stage.name === "matrix");
  const accountingReady = accountingStage?.state === "complete" && accountingStage.receipt !== undefined
    && matrixStage?.state === "complete" && matrixStage.receipt !== undefined;
  const reportPublished = reportStage?.state === "complete"
    && reportStage.receipt !== undefined
    && reportStage.digests.payload !== undefined
    && reportStage.digests.record !== undefined;
  const reportNeedsRecovery = reportStage?.state === "in-progress"
    || (reportStage?.state === "complete" && !reportPublished);
  const cancellationPending = status?.cancelRequested === true && state === "running";
  const poll = status?.driver?.status === "active" || cancellationPending;
  // A summary tile stating how many delivered cells still have an evaluation leg, alongside the
  // other count tiles. It carries no action cue: `driver.status` is folded from the journal, so a
  // killed driver stays `active` forever (`core/src/operations/run-status.ts:99-100`) and no
  // journal-derived signal separates that crash from a healthy driver mid-judgment. Gating on one
  // would hide the count in exactly the stranded case it exists to surface. The driver-generation
  // card below names Resume for the interrupted generation; the Resume control states its own
  // preconditions.
  const awaitingEvaluationCount = status?.counts.awaitingEvaluation ?? 0;

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
        {awaitingEvaluationCount > 0 ? <Card><CardHeader><CardTitle>Awaiting evaluation</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{awaitingEvaluationCount}</CardContent></Card> : null}
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
      <Card><CardHeader><CardTitle>Post-seal randomness</CardTitle></CardHeader><CardContent className="grid min-w-0 gap-5 [&>*]:min-w-0">
        {status?.binding
          ? <p className="text-sm">{status.binding.statement}</p>
          : <ActionForm action={GUI_SERVER_ACTIONS["run.bind"]} submitLabel="Bind to this beacon value" disabled={state !== "locked"}>
              <HiddenDraft draftId={draftId} />
              <p className="text-sm text-muted-foreground">Read a round from a public beacon that has already been published, and bind this sealed run to it. A round published before the seal is refused. A run binds once.</p>
              <Label htmlFor="beacon-source">Beacon</Label>
              <select id="beacon-source" name="beaconSource" required disabled={state !== "locked"} className="h-10 rounded-md border border-input bg-background px-3 text-sm">{beaconSources.map((id) => <option key={id} value={id}>{id}</option>)}</select>
              <Label htmlFor="beacon-round">Round or block height</Label>
              <Input className="font-mono" id="beacon-round" name="beaconRound" required disabled={state !== "locked"} />
              <Label htmlFor="beacon-value">Published value</Label>
              <Input className="font-mono" id="beacon-value" name="beaconValue" required disabled={state !== "locked"} />
            </ActionForm>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Third-party time</CardTitle></CardHeader><CardContent className="grid min-w-0 gap-5 [&>*]:min-w-0">
        <p className="text-sm text-muted-foreground">A configured lock anchors on its own. Anchor the sealed Run record here when a lock-time attempt did not succeed, or the terminal Matrix once the run is closed. Provider and endpoint come from this workspace&rsquo;s configuration; this form never accepts one.</p>
        <p className="text-sm text-muted-foreground">A lock anchor must be obtained before dispatch begins; an anchor never proves a result is correct, only that these bytes existed by a time a third party attests.</p>
        <div className="grid min-w-0 gap-5 md:grid-cols-2 [&>*]:min-w-0">
          <ActionForm action={GUI_SERVER_ACTIONS["run.anchor"]} submitLabel="Anchor the sealed Run record" disabled={state !== "locked"}><HiddenDraft draftId={draftId} /><input type="hidden" name="subject" value="lock" /></ActionForm>
          <ActionForm action={GUI_SERVER_ACTIONS["run.anchor"]} submitLabel="Anchor the terminal Matrix" disabled={state !== "closed"}><HiddenDraft draftId={draftId} /><input type="hidden" name="subject" value="matrix" /></ActionForm>
        </div>
      </CardContent></Card>
      <section aria-labelledby="publication-heading" className="grid gap-5 lg:grid-cols-2">
        <Card><CardHeader><CardTitle id="publication-heading">Publication status</CardTitle></CardHeader><CardContent className="space-y-4">
          {!publication ? <p role="status">Publication status becomes available after the Run is locked.</p> : <>
            <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="font-medium">Mode</dt><dd>{publication.mode === "prospective" ? "Prospective public publication" : "Local-first (not public by default)"}</dd></div><div><dt className="font-medium">Analysis preregistration</dt><dd>{publication.analysisPreregistration === "fixed-in-run" ? "Fixed in sealed Run" : "Not locked"}</dd></div><div><dt className="font-medium">Public-registration timing</dt><dd>{publication.registrationTiming}</dd></div><div><dt className="font-medium">Public URL</dt><dd className="break-all">{publication.publicBaseUrl ?? "Not configured"}</dd></div></dl>
            <div><h3 className="font-semibold">Stages</h3><ul aria-label="Publication stages" className="mt-2 space-y-1">{publication.stages.map((stage) => <li key={stage.name}><span className="font-medium">{stage.name}</span>: {stage.state}{stage.receipt ? ` · receipt ${stage.receipt.sourceSequence}` : ""}</li>)}</ul></div>
            <p role="status">{publication.recovery.guidance}</p>
            {publication.compatibility.status === "refused" ? <p role="alert">Accounting compatibility needs attention before public accounting can close.</p> : null}
          </>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Public publication controls</CardTitle></CardHeader><CardContent className="grid gap-5">
          <p className="text-sm text-muted-foreground">Local-first is the default. Configure before dispatch only when you intend prospective public registration. The server never accepts a workspace path from this form.</p>
          <p className="break-all text-sm" role="status">Server-configured archive mount: {publicationConfiguration?.publicBaseUrl ?? "Unavailable — set the publication public base URL on the server."}</p>
          <ActionForm action={GUI_SERVER_ACTIONS["publication.configure"]} submitLabel={postHoc ? "Configure post-hoc public source (does not rerun)" : "Configure prospective public source"} gated disabled={!publicationConfiguration?.available || (state !== "locked" && !postHoc)}><HiddenDraft draftId={draftId} /></ActionForm>
          <ActionForm action={GUI_SERVER_ACTIONS["publication.register"]} submitLabel={postHoc ? "Register post-hoc (does not rerun)" : "Register before dispatch"} gated disabled={!publicationConfiguration?.available || (state !== "locked" && !postHoc)}><HiddenDraft draftId={draftId} /></ActionForm>
          <ActionForm action={GUI_SERVER_ACTIONS["publication.accounting"]} submitLabel="Publish accounting and Matrix (does not rerun)" gated disabled={!postHoc || publication?.postHocPublicationAvailable === false}><HiddenDraft draftId={draftId} /></ActionForm>
          <ActionForm action={GUI_SERVER_ACTIONS["publication.report"]} submitLabel={reportPublished ? "Signed Report v2 published" : reportNeedsRecovery ? "Retry / resume signed Report v2" : "Publish signed Report v2 (does not rerun)"} gated disabled={!postHoc || !publicationConfiguration?.available || !accountingReady || reportPublished} notice="Requires authority and explicit consent"><HiddenDraft draftId={draftId} /><input type="hidden" name="consent" value="publish-signed-report-v2" /></ActionForm>
          <p className="text-sm text-muted-foreground">Accounting can close a partial or cancelled managed run. It does not require a Report; signed Report v2 publication is optional, separately consented, and uses retained records without rerunning work.</p>
        </CardContent></Card>
      </section>
      <Card><CardHeader><CardTitle>Cells</CardTitle></CardHeader><CardContent><div tabIndex={0} role="region" aria-label="Run cells table" className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th scope="col">Arm</th><th scope="col">Replicate</th><th scope="col">Status</th><th scope="col">Dispatches</th><th scope="col">Failure / blame</th></tr></thead><tbody>{status?.cells.map((cell) => <tr key={cell.cellKey} className="border-t"><td className="py-2">{cell.armId}</td><td>{cell.replicate}</td><td>{cell.status}{cell.evaluationGap === undefined ? "" : cell.evaluationGap.deliveryJournaled ? " · awaiting evaluation" : " · awaiting evaluation (delivery not journaled)"}</td><td>{cell.dispatches}</td><td>{cell.detail ?? "—"}{cell.blame ? ` (${cell.blame})` : ""}</td></tr>)}</tbody></table></div></CardContent></Card>
    </>}
  </main>;
}
