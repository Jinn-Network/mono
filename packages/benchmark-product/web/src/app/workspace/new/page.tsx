import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";

export default function NewDraftPage() {
  return <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6 outline-none"><header className="flex min-w-0 flex-col items-start justify-between gap-4 sm:flex-row"><div className="min-w-0"><p className="colophon-eyebrow text-muted-foreground">Benchmark commission</p><h1 className="mt-2 text-5xl">New draft</h1><p className="colophon-body mt-2 text-muted-foreground">Name the comparison before attaching tasks, configurations, and assurance.</p></div><nav aria-label="New draft navigation"><Button asChild variant="outline"><Link href="/workspace">Workspace</Link></Button></nav></header><Card className="border-t-2 border-t-foreground"><CardHeader><CardTitle>Draft details</CardTitle></CardHeader><CardContent><ActionForm action={GUI_SERVER_ACTIONS["draft.create"]} submitLabel="Create draft"><div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div><div><Label htmlFor="draft-id">Draft ID</Label><Input className="font-mono" id="draft-id" name="draftId" /></div><div><Label htmlFor="description">Description</Label><Input id="description" name="description" /></div></ActionForm></CardContent></Card></main>;
}
