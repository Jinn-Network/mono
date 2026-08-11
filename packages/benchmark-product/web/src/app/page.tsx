import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { Wordmark } from "@/components/wordmark";
import { PRODUCT_BRANDING } from "@/lib/branding";

const principles = [
  ["01", "Fix the method first", "The task set, configurations, assurance policy, and budget are locked before the official run. The report carries the exact digest."],
  ["02", "Choose the assurance", "State what counts as success and how each delivery becomes a verdict. The published report records the choice in the same words."],
  ["03", "Account for every execution", "Returned, failed, conflicted, and missing work stays in the denominator. Cancellation never erases expected cells."],
  ["04", "Publish what can be checked", "Every report includes its method, exact accounting, disagreements, limitations, evidence references, and portable verification command."],
] as const;

const reportPreviews = [
  ["Two agent configurations on six sample tasks", "Complete comparison", "6 / 6 cells judged"],
  ["A cancelled run with the denominator intact", "Cancelled comparison", "6 / 6 cells terminal"],
  ["Split evaluator verdicts retained", "Conflicted comparison", "Disagreement published"],
] as const;

export default function Page() {
  return <>
    <SiteHeader />
    <main id="main-content" tabIndex={-1}>
      <section className="page-frame flex min-h-[800px] flex-col justify-center border-b py-32 sm:min-h-[1060px] sm:py-40">
        <p className="colophon-eyebrow mb-8 text-muted-foreground">{PRODUCT_BRANDING.categoryDescriptor}</p>
        <h1 className="colophon-display max-w-[13ch] text-[clamp(4.25rem,10vw,8.75rem)] leading-[0.88]">{PRODUCT_BRANDING.tagline}</h1>
        <p className="colophon-body mt-10 max-w-[64ch] text-muted-foreground">It compares agent configurations on the same tasks. Run two or more configurations against one task set, choose how the results are judged, and {PRODUCT_BRANDING.promise.toLowerCase().replace(/\.$/u, "")}.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg"><Link href="/workspace">Start a benchmark</Link></Button>
          <Button asChild size="lg" variant="outline"><Link href="/preview/reports">Read a report preview</Link></Button>
        </div>
        <div className="mt-10">
          <p className="mb-3 font-mono text-xs text-muted-foreground">Every claim travels with its accounting and report identity.</p>
          <div className="inline-flex max-w-full flex-wrap border font-mono text-xs">
            <span className="bg-foreground px-3 py-2 text-background">Colophon</span>
            <span className="border-l px-3 py-2">6 / 6 cells</span>
            <span className="border-l bg-[var(--moss-soft)] px-3 py-2 text-[var(--moss)]">Observed</span>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="page-frame grid gap-x-12 gap-y-16 border-b py-24 md:grid-cols-2">
        {principles.map(([number, title, detail]) => <article className="border-t-2 border-foreground pt-5" key={number}>
          <p className="font-mono text-sm text-muted-foreground">{number}</p>
          <h2 className="mt-8 text-3xl">{title}</h2>
          <p className="colophon-body mt-5 max-w-[36ch] text-muted-foreground">{detail}</p>
        </article>)}
      </section>

      <section id="assurance" className="bg-[#14120e] text-[#f7f4ed]">
        <div className="page-frame grid gap-14 py-24 lg:grid-cols-[0.8fr_1.2fr]">
          <div><p className="colophon-eyebrow text-[#a39b90]">Agent-native operation</p><h2 className="mt-6 max-w-[12ch] text-5xl">Stable verbs. Durable states. Inspectable work.</h2></div>
          <div className="border-y border-[#403a33] font-mono text-sm">
            {[['run.lock', 'Method digest fixed before execution'], ['run.launch', 'Driver generation recorded durably'], ['run.cancel', 'Requested and terminal cancellation stay distinct'], ['run.publish', 'Immutable local bundle emitted and checked']].map(([operation, detail]) => <div className="grid gap-2 border-b border-[#403a33] py-5 last:border-0 sm:grid-cols-[9rem_1fr]" key={operation}><span className="text-[#e2755d]">{operation}</span><span className="text-[#bdb5a8]">{detail}</span></div>)}
          </div>
        </div>
      </section>

      <section className="page-frame py-24">
        <div className="flex flex-wrap items-end justify-between gap-6 border-b-2 border-foreground pb-5"><div><p className="colophon-eyebrow text-muted-foreground">Report previews</p><h2 className="mt-3 text-5xl">The artifact a skeptic reads.</h2><p className="mt-3 max-w-[62ch] text-muted-foreground">Each report keeps quality, cost, runtime, failures, evaluator disagreement, and machine-readable evidence in view.</p></div><Link href="/preview/reports">Browse future report library</Link></div>
        <div className="grid gap-0 md:grid-cols-3">
          {reportPreviews.map(([title, status, count], index) => <article className="border-b p-6 md:border-r md:last:border-r-0" key={title}><p className="colophon-eyebrow text-[var(--vermilion)]">Preview data · 0{index + 1}</p><h3 className="mt-8 text-2xl">{title}</h3><p className="mt-12 font-mono text-xs">{status}<br />{count}</p></article>)}
        </div>
      </section>
    </main>
    <footer className="border-t bg-card"><div className="page-frame flex flex-wrap items-end justify-between gap-8 py-12"><div><Wordmark compact /><p className="mt-4 max-w-[50ch] text-sm text-muted-foreground">{PRODUCT_BRANDING.promise} Available today as a local, standalone workspace and portable report.</p></div><p className="font-mono text-xs text-muted-foreground">{PRODUCT_BRANDING.attribution}</p></div></footer>
  </>;
}
