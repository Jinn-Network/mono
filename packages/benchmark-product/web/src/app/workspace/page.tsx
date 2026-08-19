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
    <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6 outline-none">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="colophon-eyebrow text-muted-foreground">Commissioning desk</p><h1 className="mt-2 text-5xl">Benchmarks</h1><p className="colophon-body mt-2 max-w-[52ch] text-muted-foreground">Define the comparison, fix the method, run every expected cell, and publish the resulting evidence.</p></div>
        <Button asChild><Link href="/workspace/new">New draft</Link></Button>
      </header>
      {!view.ok ? (
        <Card><CardHeader><CardTitle>Configuration required</CardTitle></CardHeader><CardContent><p role="alert">{view.detail}</p></CardContent></Card>
      ) : (
        <>
          <Card><CardHeader><CardTitle>Configured actor</CardTitle></CardHeader><CardContent><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="colophon-eyebrow text-muted-foreground">Workspace</dt><dd>Configured on this server</dd></div><div><dt className="colophon-eyebrow text-muted-foreground">Principal</dt><dd className="font-mono text-sm">{view.configuration.principal}</dd></div></dl></CardContent></Card>
          {!view.drafts.ok ? (
            <Card><CardHeader><CardTitle>Initialize</CardTitle></CardHeader><CardContent><ActionForm action={GUI_SERVER_ACTIONS["workspace.init"]} submitLabel="Initialize workspace" /></CardContent></Card>
          ) : (
            <Card><CardHeader><CardTitle>Drafts</CardTitle></CardHeader><CardContent>{view.drafts.result.drafts.length === 0 ? <p>No drafts yet.</p> : <ul className="divide-y">{view.drafts.result.drafts.map((draft) => <li className="flex items-center justify-between gap-4 py-3" key={draft.draftId}><div><p className="font-medium">{draft.name}</p><p className="text-sm text-muted-foreground">{draft.state}</p></div><Button asChild variant="outline"><Link href={`/workspace/${draft.draftId}`}>Open</Link></Button></li>)}</ul>}</CardContent></Card>
          )}
          <Card><CardHeader><CardTitle>Third-party time</CardTitle></CardHeader><CardContent className="grid gap-5">
            <p className="text-sm text-muted-foreground">Anchoring is off until configured. Once a provider is configured, every later lock obtains an anchor on its own and a failure never blocks the lock. The server owns the endpoint; this form never accepts one.</p>
            <p className="text-sm" role="status">Server-configured anchor providers: {view.anchoringConfiguration.available ? view.anchoringConfiguration.providerProfiles.join(", ") : "Unavailable — set the anchor providers on the server."}</p>
            <div className="grid gap-5 md:grid-cols-2">
              <ActionForm action={GUI_SERVER_ACTIONS["anchoring.configure"]} submitLabel="Apply the configured anchor providers" gated disabled={!view.anchoringConfiguration.available} />
              <ActionForm action={GUI_SERVER_ACTIONS["anchoring.configure"]} submitLabel="Turn anchoring off" gated><input type="hidden" name="clear" value="clear-anchoring" /></ActionForm>
            </div>
          </CardContent></Card>
          <Card><CardHeader><CardTitle>Agent authority</CardTitle></CardHeader><CardContent className="grid gap-6 lg:grid-cols-2">
            <details><summary className="cursor-pointer font-semibold">Exact authority record</summary><pre tabIndex={0} role="region" aria-label="Authority record" className="mt-3 overflow-auto rounded-sm bg-muted p-3 text-xs">{JSON.stringify(view.authority, null, 2)}</pre></details>
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
