import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";

export default function NewDraftPage() {
  return <main id="main-content" tabIndex={-1} className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-10 sm:px-6 outline-none"><header className="flex items-center justify-between gap-4"><h1 className="text-3xl font-semibold">New draft</h1><nav aria-label="Workspace navigation"><Button asChild variant="outline"><Link href="/workspace">Workspace</Link></Button></nav></header><Card><CardHeader><CardTitle>Draft details</CardTitle></CardHeader><CardContent><ActionForm action={GUI_SERVER_ACTIONS["draft.create"]} submitLabel="Create draft"><div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div><div><Label htmlFor="draft-id">Draft ID</Label><Input id="draft-id" name="draftId" /></div><div><Label htmlFor="description">Description</Label><Input id="description" name="description" /></div></ActionForm></CardContent></Card></main>;
}
