import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wordmark } from "@/components/wordmark";
import {
  guidedSampleRunAction,
  guidedVerifyBundleAction,
} from "@/app/actions";

export const dynamic = "force-dynamic";

export default function Page() {
  return <main id="main-content" tabIndex={-1} className="page-frame flex min-h-screen flex-col py-10 outline-none sm:py-16">
    <header className="border-b-2 border-foreground pb-10">
      <Wordmark />
      <p className="colophon-eyebrow mt-12 text-[var(--vermilion)]">Local workspace</p>
      <h1 className="colophon-display mt-3 max-w-[14ch] text-[clamp(3.5rem,8vw,6.5rem)] leading-[.92]">What do you want to check?</h1>
      <p className="colophon-body mt-7 max-w-[62ch] text-muted-foreground">Everything here stays on this machine. Colophon has no account, uploads no benchmark bundle, and sends no telemetry.</p>
    </header>

    <section aria-label="Start choices" className="grid border-b md:grid-cols-3">
      <Card className="rounded-none border-0 border-b bg-transparent py-8 shadow-none md:border-b-0 md:border-r">
        <CardHeader><p className="colophon-eyebrow text-[var(--vermilion)]">01 · Zero credentials</p><CardTitle className="mt-5 text-3xl">Run the sample</CardTitle></CardHeader>
        <CardContent className="grid gap-5"><p>Run the bundled three-task, two-configuration comparison through a verified local report. It needs no account, no API key, no funds, no Docker, and no agent login.</p><ActionForm action={guidedSampleRunAction} submitLabel="Run to verified report" /></CardContent>
      </Card>

      <Card className="rounded-none border-0 border-b bg-transparent py-8 shadow-none md:border-b-0 md:border-r">
        <CardHeader><p className="colophon-eyebrow text-[var(--vermilion)]">02 · Reader only</p><CardTitle className="mt-5 text-3xl">Verify a bundle</CardTitle></CardHeader>
        <CardContent><ActionForm action={guidedVerifyBundleAction} submitLabel="Run all six checks"><div><Label htmlFor="bundle">Bundle directory on this machine</Label><Input id="bundle" name="bundle" placeholder="/absolute/path/to/bundle" required /></div><p className="text-sm text-muted-foreground">The reader opens this directory read-only. It needs no runner, account, key, funds, or Docker.</p></ActionForm></CardContent>
      </Card>

      <Card className="rounded-none border-0 bg-transparent py-8 shadow-none">
        <CardHeader><p className="colophon-eyebrow text-[var(--vermilion)]">03 · Your tasks</p><CardTitle className="mt-5 text-3xl">Use my work</CardTitle></CardHeader>
        <CardContent className="grid gap-5"><p>Choose a task source, add two supported agent profiles, review what uses the network and may cost money, then lock the method before launch.</p><Button asChild><Link href="/workspace/new?journey=own-work">Start my comparison</Link></Button></CardContent>
      </Card>
    </section>

    <section className="grid gap-8 py-10 sm:grid-cols-[1fr_auto] sm:items-start">
      <div><h2 className="text-2xl">Already started?</h2><p className="mt-2 text-muted-foreground">Open an existing draft or continue a retained run. Nothing executes just by opening it.</p></div>
      <Button asChild variant="outline"><Link href="/workspace">Open existing work</Link></Button>
    </section>

    <details className="border-t py-8"><summary className="cursor-pointer font-semibold">Advanced product surfaces</summary><p className="mt-4 max-w-[65ch] text-sm text-muted-foreground">Authority records, raw arm pinning, Inspect configuration, publication accounting, and explicit lifecycle operations remain available for expert use.</p><Button asChild className="mt-4" variant="outline"><Link href="/workspace">Open the commissioning desk</Link></Button></details>
  </main>;
}
