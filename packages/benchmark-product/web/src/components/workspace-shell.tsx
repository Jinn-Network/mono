import { Archive, Bot, CircleDollarSign, FileCheck2, FlaskConical, Gauge, Layers3, Library, ScrollText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";

const available = [
  ["Benchmarks", "/workspace", Layers3],
  ["New benchmark", "/workspace/new", FlaskConical],
] as const;
const future = [
  ["Task sets", "/preview/task-sets", Library],
  ["Entrants", "/preview/entrants", Archive],
  ["Evaluators", "/preview/evaluators", ShieldCheck],
  ["Runs", "/preview/runs", Gauge],
  ["Reports", "/preview/reports", FileCheck2],
  ["Agents", "/preview/agents", Bot],
  ["Docs", "/preview/docs", ScrollText],
  ["Billing", "/preview/billing", CircleDollarSign],
] as const;

function Navigation() {
  return <nav aria-label="Workspace navigation" className="space-y-7">
    <div><p className="colophon-eyebrow mb-2 px-3 text-muted-foreground">Available locally</p><ul>{available.map(([label, href, Icon]) => <li key={href}><Link className="flex items-center gap-3 rounded-sm px-3 py-2 text-sm hover:bg-card" href={href}><Icon aria-hidden className="size-4" />{label}</Link></li>)}</ul></div>
    <div><p className="colophon-eyebrow mb-2 px-3 text-muted-foreground">Future hosted previews</p><ul>{future.map(([label, href, Icon]) => <li key={href}><Link className="flex items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm hover:bg-card" href={href}><span className="flex items-center gap-3"><Icon aria-hidden className="size-4" />{label}</span><span className="font-mono text-[10px] text-muted-foreground">Preview</span></Link></li>)}</ul></div>
  </nav>;
}

export function WorkspaceShell({ children }: { readonly children: React.ReactNode }) {
  return <div className="min-h-screen lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
    <aside className="hidden border-r bg-background lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
      <div className="border-b p-5"><Wordmark compact /></div>
      <div className="flex-1 overflow-y-auto p-3 pt-6"><Navigation /></div>
      <div className="border-t p-5"><p className="colophon-eyebrow">Local workspace</p><p className="mt-2 text-xs text-muted-foreground">Server-configured authority. No hosted account.</p></div>
    </aside>
    <div className="min-w-0">
      <header className="border-b bg-background p-4 lg:hidden"><div className="flex items-center justify-between gap-4"><Wordmark compact /><details className="relative"><summary className="cursor-pointer rounded-sm border px-3 py-2 text-sm font-semibold">Menu</summary><div className="absolute right-0 z-40 mt-2 w-72 border bg-background p-4"><Navigation /></div></details></div></header>
      {children}
    </div>
  </div>;
}
