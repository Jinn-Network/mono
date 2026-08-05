import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JinnSigil } from '@/components/jinn-mark';
import { links, repoFile } from '@/lib/shared';

/**
 * The landing page.
 *
 * Copy provenance — every claim on this page traces to a ratified document,
 * per the DevX surface design §11 success criterion 3:
 *   - the identity paragraph and the "does not yet prove" caveats are
 *     DR-2026-07-30 §11 (docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md);
 *   - the loop, the boundary, and the open-by-design wager are the platform
 *     one-pager (docs/positioning/2026-07-29-jinn-platform-one-pager.md);
 *   - the verb discipline and the absolutist-claim ban come from the
 *     positioning spine's messaging guardrails, and `test/content.test.mjs`
 *     asserts them over this file.
 *
 * Call to action — GROWTH.md §3 binds every outward surface to a single CTA
 * (the Telegram group) until the v0 gate produces a result. The two doors
 * below are navigation into /docs, not a second ask. There is exactly one
 * button on this page.
 */

const doors = [
  {
    title: 'Build on Jinn',
    href: '/docs/build',
    body: 'Your application or agent becomes the requester. Post a task, receive the outcome, and retrieve the evidence behind it.',
    detail: 'Works end to end on testnet today.',
  },
  {
    title: 'Run an operator',
    href: '/docs/operate',
    body: 'Your machine performs and evaluates work others have funded, and records what happened.',
    detail: 'Operators earn OLAS on the canonical network; that network runs on Base Sepolia today.',
  },
];

const loop = [
  { step: '01', name: 'Request', body: 'An entity describes work and escrows the fee.' },
  { step: '02', name: 'Execute', body: 'An operator claims it and does the work.' },
  { step: '03', name: 'Evaluate', body: 'A second party checks the result and records a verdict.' },
  { step: '04', name: 'Deliver', body: 'The outcome goes to whoever asked for it.' },
  { step: '05', name: 'Publish', body: 'The evidence of how it was done stays open to everyone.' },
];

const built = [
  'Benchmarks',
  'Reputation systems',
  'Skill factories',
  'Dataset builders',
  'Harness optimizers',
  'Audit and provenance tools',
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20 sm:py-28">
        <h1 className="font-serif max-w-[20ch] text-4xl leading-[1.05] text-balance sm:text-6xl">
          An open platform for work and the evidence work creates.
        </h1>
        <p className="text-muted-foreground mt-10 max-w-[62ch] text-[15px] leading-relaxed text-pretty">
          Jinn defines sealed records for requesting work, delivering it, and publishing
          what happened — designed so third parties can produce and verify them without
          running Jinn&rsquo;s code — and reusable capabilities for executing work and
          retrieving evidence.
        </p>
        <p className="text-muted-foreground mt-5 max-w-[62ch] text-[15px] leading-relaxed text-pretty">
          Jinn contributors operate a canonical network on Base where work is escrowed,
          delivered, and evaluated, and operators earn OLAS. Everything above that —
          operators, benchmarks, skill factories, agents — is a product anyone can build,
          swap, or compete with.
        </p>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-16">
        <div className="grid gap-5 sm:grid-cols-2">
          {doors.map((door) => (
            <Link
              key={door.href}
              href={door.href}
              className="border-border hover:border-accent-sky group flex flex-col rounded-lg border p-8 no-underline transition-colors"
            >
              <h2 className="font-serif text-3xl leading-tight">{door.title}</h2>
              <p className="text-foreground mt-4 text-sm leading-relaxed">{door.body}</p>
              <p className="text-dim mt-3 text-xs leading-relaxed">{door.detail}</p>
              <span className="text-accent-sky mt-8 inline-flex items-center gap-2 text-xs tracking-[0.14em] uppercase">
                Read the docs
                <ArrowRight aria-hidden="true" className="size-3" />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20">
        <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          How it works
        </p>
        <h2 className="font-serif mt-5 max-w-[22ch] text-4xl leading-tight sm:text-5xl">
          Every execution produces two outputs.
        </h2>
        <ol className="mt-14 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {loop.map((item) => (
            <li key={item.step} className="border-border rounded-lg border p-6">
              <p className="text-dim text-xs tracking-[0.14em] uppercase">
                {item.step} — {item.name}
              </p>
              <p className="mt-3 text-sm leading-relaxed">{item.body}</p>
            </li>
          ))}
        </ol>
        <p className="text-muted-foreground mt-10 max-w-[64ch] text-sm leading-relaxed text-pretty">
          A conventional work marketplace ends at result and settlement. Jinn keeps the
          evidence and leaves it open, so the supply of work is also the supply of
          evidence.
        </p>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20">
        <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          The boundary
        </p>
        <h2 className="font-serif mt-5 max-w-[24ch] text-4xl leading-tight sm:text-5xl">
          Jinn coordinates the work and preserves the evidence. The rest is products.
        </h2>
        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          <div className="border-border rounded-lg border p-8">
            <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
              The platform
            </p>
            <ul className="mt-6 space-y-3 text-sm leading-relaxed">
              <li>Describe and publish work</li>
              <li>Coordinate execution and evaluation</li>
              <li>Deliver results and artifacts</li>
              <li>Escrow and settle the fee</li>
              <li>Record tasks, attempts, outputs, and evaluations</li>
              <li>Store, index, discover, and retrieve evidence</li>
            </ul>
          </div>
          <div className="border-border rounded-lg border p-8">
            <p className="text-gold text-xs tracking-[0.14em] uppercase">Built on it</p>
            <ul className="mt-6 space-y-3 text-sm leading-relaxed">
              {built.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-muted-foreground mt-10 max-w-[64ch] text-sm leading-relaxed text-pretty">
          Jinn does not decide what a piece of evidence means. Applications remain
          responsible for what they trust and how they use it. Work whose evidence has to
          stay private is a poor fit, and that is deliberate.
        </p>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20">
        <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          What this does not yet prove
        </p>
        <ul className="mt-8 max-w-[68ch] space-y-4 text-sm leading-relaxed">
          <li>
            The schemas and kits are not yet published, so third-party verification is a
            designed property no third party has yet exercised.
          </li>
          <li>
            The network runs on Base Sepolia today. Mainnet operation is the Phase-2
            target.
          </li>
          <li>
            Per-task settlement economics and evaluator economics are still open design
            work.
          </li>
        </ul>
        <p className="text-dim mt-8 max-w-[68ch] text-xs leading-relaxed">
          Source:{' '}
          <a href={repoFile('docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md')}>
            the ratified platform architecture
          </a>
          . Watch the network at <a href={links.explorer}>explorer.jinn.network</a>.
        </p>
      </section>

      <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-10 px-6 py-24 text-center">
        <h2 className="font-serif max-w-[20ch] text-4xl leading-tight text-balance sm:text-5xl">
          The network is small and early. That is when it is easiest to shape.
        </h2>
        <Button asChild size="lg">
          <a href={links.telegram}>Join the Telegram</a>
        </Button>
      </section>

      <footer className="border-border border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-8">
          <JinnSigil className="text-dim size-6" />
          <div className="flex flex-wrap items-center gap-6 text-xs">
            <Link href="/docs">Docs</Link>
            <a href={links.explorer}>Explorer</a>
            <a href={links.github}>GitHub</a>
            <Link href="/llms.txt">llms.txt</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
