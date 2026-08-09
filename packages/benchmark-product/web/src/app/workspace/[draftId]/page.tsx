import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { loadDraftView } from "@/lib/server/view-models";

function HiddenDraft({ draftId }: { draftId: string }) { return <input type="hidden" name="draftId" value={draftId} />; }

export default async function DraftPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const view = loadDraftView(draftId);
  const draftState = view.ok && view.draft.ok ? view.draft.result.draft.state : undefined;
  const editable = draftState === "draft" || draftState === "quoted";
  return <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 outline-none"><header className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-3xl font-semibold">Draft</h1><nav aria-label="Draft navigation" className="flex flex-wrap gap-2"><Button asChild><Link href={`/workspace/${draftId}/run`}>Run monitor</Link></Button><Button asChild variant="outline"><Link href={`/workspace/${draftId}/results`}>Results</Link></Button><Button asChild variant="outline"><Link href="/workspace">Workspace</Link></Button></nav></header>{!view.ok ? <p role="alert">{view.detail}</p> : <><Card><CardHeader><CardTitle>State</CardTitle></CardHeader><CardContent><pre tabIndex={0} aria-label="Draft state and records" className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify({ draft: view.draft, inspection: view.inspection, arms: view.arms }, null, 2)}</pre></CardContent></Card><div className="grid gap-6 lg:grid-cols-2">
    <Card><CardHeader><CardTitle>Edit</CardTitle></CardHeader><CardContent><ActionForm action={GUI_SERVER_ACTIONS["draft.update"]} submitLabel="Apply patch" disabled={!editable}><HiddenDraft draftId={draftId} /><Label htmlFor="patch">Draft spec patch</Label><Textarea id="patch" name="patch" defaultValue={'{"assurance":{"preset":"direct-check"}}'} disabled={!editable} /></ActionForm></CardContent></Card>
    <Card><CardHeader><CardTitle>Task intake</CardTitle></CardHeader><CardContent className="grid gap-6"><ActionForm action={GUI_SERVER_ACTIONS["intake.sample"]} submitLabel="Attach sample" disabled={!editable}><HiddenDraft draftId={draftId} /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["intake.swebench"]} submitLabel="Import rows" disabled={!editable}><HiddenDraft draftId={draftId} /><Label htmlFor="rows">SWE-bench rows JSON</Label><Textarea id="rows" name="rows" defaultValue="[]" disabled={!editable} /></ActionForm></CardContent></Card>
    <Card><CardHeader><CardTitle>Arms</CardTitle></CardHeader><CardContent className="grid gap-6"><ActionForm action={GUI_SERVER_ACTIONS["arm.add"]} submitLabel="Add arm" disabled={!editable}><HiddenDraft draftId={draftId} /><Label htmlFor="arm-id">Arm ID</Label><Input id="arm-id" name="armId" required disabled={!editable} /><Label htmlFor="pinning">Pinning JSON</Label><Textarea id="pinning" name="pinning" defaultValue="{}" disabled={!editable} /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["arm.update"]} submitLabel="Update arm" disabled={!editable}><HiddenDraft draftId={draftId} /><Label htmlFor="update-arm-id">Arm ID</Label><Input id="update-arm-id" name="armId" required disabled={!editable} /><Label htmlFor="update-pinning">Pinning JSON</Label><Textarea id="update-pinning" name="pinning" disabled={!editable} /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["arm.remove"]} submitLabel="Remove arm" disabled={!editable}><HiddenDraft draftId={draftId} /><Label htmlFor="remove-arm-id">Arm ID</Label><Input id="remove-arm-id" name="armId" required disabled={!editable} /></ActionForm></CardContent></Card>
    <Card><CardHeader><CardTitle>Rehearse and commit</CardTitle></CardHeader><CardContent className="grid gap-6"><ActionForm action={GUI_SERVER_ACTIONS["run.preview"]} submitLabel="Run preview" disabled={!editable}><HiddenDraft draftId={draftId} /><Label htmlFor="items">Item limit</Label><Input id="items" name="items" type="number" min="1" disabled={!editable} /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["run.quote"]} submitLabel="Quote" disabled={draftState !== "draft"}><HiddenDraft draftId={draftId} /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["run.lock"]} submitLabel="Lock run" gated disabled={draftState !== "quoted"}><HiddenDraft draftId={draftId} /></ActionForm></CardContent></Card>
  </div></>}</main>;
}
