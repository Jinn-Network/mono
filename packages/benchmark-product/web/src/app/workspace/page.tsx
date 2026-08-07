import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { loadWorkspaceView } from "@/lib/server/view-models";

export const dynamic = "force-dynamic";

export default function WorkspacePage() {
  const view = loadWorkspaceView();
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">Workspace</h1>
        <Button asChild><Link href="/workspace/new">New draft</Link></Button>
      </header>
      {!view.ok ? (
        <Card><CardHeader><CardTitle>Configuration required</CardTitle></CardHeader><CardContent><p role="alert">{view.detail}</p></CardContent></Card>
      ) : (
        <>
          <Card><CardHeader><CardTitle>Configured actor</CardTitle></CardHeader><CardContent><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">Workspace</dt><dd className="break-all font-mono text-sm">{view.configuration.workspaceDir}</dd></div><div><dt className="text-sm text-muted-foreground">Principal</dt><dd>{view.configuration.principal}</dd></div></dl></CardContent></Card>
          {!view.drafts.ok ? (
            <Card><CardHeader><CardTitle>Initialize</CardTitle></CardHeader><CardContent><ActionForm action={GUI_SERVER_ACTIONS["workspace.init"]} submitLabel="Initialize workspace" /></CardContent></Card>
          ) : (
            <Card><CardHeader><CardTitle>Drafts</CardTitle></CardHeader><CardContent>{view.drafts.result.drafts.length === 0 ? <p>No drafts yet.</p> : <ul className="divide-y">{view.drafts.result.drafts.map((draft) => <li className="flex items-center justify-between gap-4 py-3" key={draft.draftId}><div><p className="font-medium">{draft.name}</p><p className="text-sm text-muted-foreground">{draft.state}</p></div><Button asChild variant="outline"><Link href={`/workspace/${draft.draftId}`}>Open</Link></Button></li>)}</ul>}</CardContent></Card>
          )}
          <Card><CardHeader><CardTitle>Authority</CardTitle></CardHeader><CardContent className="grid gap-6 lg:grid-cols-2">
            <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(view.authority, null, 2)}</pre>
            <div className="grid gap-6">
              <ActionForm action={GUI_SERVER_ACTIONS["authority.grant"]} submitLabel="Grant" notice="Sponsor only"><div><Label htmlFor="grant-principal">Principal</Label><Input id="grant-principal" name="principalId" required /></div><div><Label htmlFor="grant-role">Role</Label><Input id="grant-role" name="role" placeholder="delegated-agent" /></div><div><Label htmlFor="grant-ops">Operations</Label><Input id="grant-ops" name="operations" placeholder="lock, launch" /></div></ActionForm>
              <ActionForm action={GUI_SERVER_ACTIONS["authority.revoke"]} submitLabel="Revoke" notice="Sponsor only"><div><Label htmlFor="revoke-principal">Principal</Label><Input id="revoke-principal" name="principalId" required /></div><div><Label htmlFor="revoke-ops">Operations</Label><Input id="revoke-ops" name="operations" placeholder="lock" /></div></ActionForm>
            </div>
          </CardContent></Card>
        </>
      )}
    </main>
  );
}
