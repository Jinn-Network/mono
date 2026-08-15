import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { guidedOwnWorkCreateAction } from "@/app/actions";

export default async function NewDraftPage({ searchParams }: { readonly searchParams: Promise<{ readonly journey?: string }> }) {
  const guided = (await searchParams).journey === "own-work";
  return <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6 outline-none"><header className="flex min-w-0 flex-col items-start justify-between gap-4 sm:flex-row"><div className="min-w-0"><p className="colophon-eyebrow text-muted-foreground">{guided ? "Use my work · Step 1 of 3" : "Benchmark commission"}</p><h1 className="mt-2 text-5xl">{guided ? "Name the comparison" : "New draft"}</h1><p className="colophon-body mt-2 text-muted-foreground">{guided ? "Next you will choose a task source, then two configurations. Nothing runs and no provider is contacted while you set this up." : "Name the comparison before attaching tasks, configurations, and assurance."}</p></div><nav aria-label="New draft navigation"><Button asChild variant="outline"><Link href={guided ? "/" : "/workspace"}>{guided ? "Local home" : "Workspace"}</Link></Button></nav></header><Card className="border-t-2 border-t-foreground"><CardHeader><CardTitle>{guided ? "Comparison name" : "Draft details"}</CardTitle></CardHeader><CardContent>{guided ? <ActionForm action={guidedOwnWorkCreateAction} submitLabel="Choose tasks"><div><Label htmlFor="name">Name</Label><Input id="name" name="name" placeholder="Claude Code and Codex on my SWE-bench set" required /></div></ActionForm> : <ActionForm action={GUI_SERVER_ACTIONS["draft.create"]} submitLabel="Create draft"><div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div><div><Label htmlFor="draft-id">Draft ID</Label><Input className="font-mono" id="draft-id" name="draftId" /></div><div><Label htmlFor="description">Description</Label><Input id="description" name="description" /></div></ActionForm>}</CardContent></Card></main>;
}
