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
  return <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6"><header className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-3xl font-semibold">Draft</h1><div className="flex flex-wrap gap-2"><Button asChild><Link href={`/workspace/${draftId}/run`}>Run monitor</Link></Button><Button asChild variant="outline"><Link href={`/workspace/${draftId}/results`}>Results</Link></Button><Button asChild variant="outline"><Link href="/workspace">Workspace</Link></Button></div></header>{!view.ok ? <p role="alert">{view.detail}</p> : <><Card><CardHeader><CardTitle>State</CardTitle></CardHeader><CardContent><pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify({ draft: view.draft, inspection: view.inspection, arms: view.arms }, null, 2)}</pre></CardContent></Card><div className="grid gap-6 lg:grid-cols-2">
    <Card><CardHeader><CardTitle>Edit</CardTitle></CardHeader><CardContent><ActionForm action={GUI_SERVER_ACTIONS["draft.update"]} submitLabel="Apply patch"><HiddenDraft draftId={draftId} /><Label htmlFor="patch">Draft spec patch</Label><Textarea id="patch" name="patch" defaultValue={'{"assurance":{"preset":"direct-check"}}'} /></ActionForm></CardContent></Card>
    <Card><CardHeader><CardTitle>Task intake</CardTitle></CardHeader><CardContent className="grid gap-6"><ActionForm action={GUI_SERVER_ACTIONS["intake.sample"]} submitLabel="Attach sample"><HiddenDraft draftId={draftId} /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["intake.swebench"]} submitLabel="Import rows"><HiddenDraft draftId={draftId} /><Label htmlFor="rows">SWE-bench rows JSON</Label><Textarea id="rows" name="rows" defaultValue="[]" /></ActionForm></CardContent></Card>
    <Card><CardHeader><CardTitle>Arms</CardTitle></CardHeader><CardContent className="grid gap-6"><ActionForm action={GUI_SERVER_ACTIONS["arm.add"]} submitLabel="Add arm"><HiddenDraft draftId={draftId} /><Label htmlFor="arm-id">Arm ID</Label><Input id="arm-id" name="armId" required /><Label htmlFor="pinning">Pinning JSON</Label><Textarea id="pinning" name="pinning" defaultValue="{}" /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["arm.update"]} submitLabel="Update arm"><HiddenDraft draftId={draftId} /><Label htmlFor="update-arm-id">Arm ID</Label><Input id="update-arm-id" name="armId" required /><Label htmlFor="update-pinning">Pinning JSON</Label><Textarea id="update-pinning" name="pinning" /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["arm.remove"]} submitLabel="Remove arm"><HiddenDraft draftId={draftId} /><Label htmlFor="remove-arm-id">Arm ID</Label><Input id="remove-arm-id" name="armId" required /></ActionForm></CardContent></Card>
    <Card><CardHeader><CardTitle>Rehearse and commit</CardTitle></CardHeader><CardContent className="grid gap-6"><ActionForm action={GUI_SERVER_ACTIONS["run.preview"]} submitLabel="Run preview"><HiddenDraft draftId={draftId} /><Label htmlFor="items">Item limit</Label><Input id="items" name="items" type="number" min="1" /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["run.quote"]} submitLabel="Quote"><HiddenDraft draftId={draftId} /></ActionForm><ActionForm action={GUI_SERVER_ACTIONS["run.lock"]} submitLabel="Lock run" gated><HiddenDraft draftId={draftId} /></ActionForm></CardContent></Card>
  </div></>}</main>;
}
