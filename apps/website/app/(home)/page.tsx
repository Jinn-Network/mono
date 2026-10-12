import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JinnSigil } from '@/components/jinn-mark';
import { links, repoFile } from '@/lib/shared';

/**
 * The landing page.
 *
 * Copy provenance: every claim on this page traces to a canonical document.
 *   - What Jinn is, what exists today and what is direction: THESIS.md §3 and
 *     §4, and the root README.md.
 *   - Record, holder, offer and price: GLOSSARY.md "Records and offers", which
 *     points at Jinn-Network/spec as the authority.
 *   - Colophon: the root README.md "What you can do here".
 *   - The caveats: the specification's own list of what is still open,
 *     THESIS.md §4, and the limits Colophon's checker prints.
 *   - The verb rules are CLAUDE.md "External Communication"; the protocol
 *     takes no part in payment, so it is never the subject of a payment verb.
 *     `test/content.test.mjs` asserts them over this file.
 *
 * Selling records is the direction, not a working market. Nothing here says
 * or implies otherwise: the hero says a holder can offer a record, and the
 * one step that involves payment is marked as direction.
 *
 * Call to action: GROWTH.md §3 names "Bring a claim" as the single call to
 * action on every outward surface. The doors below are navigation, not a
 * second ask. There is exactly one button on this page.
 */

const doors = [
  {
    title: 'Check a claim',
    href: '/docs/check-a-claim',
    body: 'Run the published checker over a sealed benchmark claim, on your own machine.',
    detail: 'Free, with no account. Needs Node 22 or newer.',
    label: 'Read the docs',
  },
  {
    title: 'Find a claim',
    href: links.colophonFind,
    body: 'Every public claim listed on Colophon, newest first.',
    detail: 'One claim is listed as of 12 October 2026.',
    label: 'Open Colophon',
  },
  {
    title: 'Build on the protocol',
    href: '/docs/protocol',
    body: 'The normative text, the schemas and the conformance vectors, in one public repository.',
    detail: 'Release v0.1.0. One implementation exists so far.',
    label: 'Read the docs',
  },
];

const steps = [
  {
    step: '01',
    name: 'Record',
    body: 'Work produces a record: a sealed document with a published schema, a stable identifier and a digest.',
  },
  {
    step: '02',
    name: 'Check',
    body: 'Anyone can check it from its own bytes, with their own tools. No Jinn code is needed.',
  },
  { step: '03', name: 'Offer', body: 'Its holder publishes an offer for it, free or priced.' },
  { step: '04', name: 'Find', body: 'Others find the record and its offer.' },
  {
    step: '05',
    name: 'Buy',
    body: 'A buyer asks the holder for the record. Payment goes straight to the holder, outside the protocol.',
    direction: true,
  },
];

const doorClassName =
  'border-border hover:border-accent-sky group flex flex-col rounded-lg border p-8 no-underline transition-colors';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20 sm:py-28">
        <h1 className="font-serif max-w-[20ch] text-4xl leading-[1.05] text-balance sm:text-6xl">
          An open protocol and network for work and the data it produces.
        </h1>
        <p className="text-muted-foreground mt-10 max-w-[62ch] text-[15px] leading-relaxed text-pretty">
          Most work leaves an answer behind and discards the record of how it was reached.
          The Jinn protocol says how work is described, done, evidenced, judged, trusted and
          found.
        </p>
        <p className="text-muted-foreground mt-5 max-w-[62ch] text-[15px] leading-relaxed text-pretty">
          A record can be kept in Jinn&rsquo;s standard formats or its producer&rsquo;s own.
          Either way anyone can check it from its own bytes, with their own tools, and find
          it. Whoever holds a record can offer it, free or priced. The protocol takes no fee
          and no part in payment, and there is no Jinn token.
        </p>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-16">
        <div className="grid gap-5 lg:grid-cols-3">
          {doors.map((door) => {
            const content = (
              <>
                <h2 className="font-serif text-3xl leading-tight">{door.title}</h2>
                <p className="text-foreground mt-4 text-sm leading-relaxed">{door.body}</p>
                <p className="text-dim mt-3 text-xs leading-relaxed">{door.detail}</p>
                <span className="text-accent-sky mt-8 inline-flex items-center gap-2 text-xs tracking-[0.14em] uppercase">
                  {door.label}
                  <ArrowRight aria-hidden="true" className="size-3" />
                </span>
              </>
            );
            return door.href.startsWith('/') ? (
              <Link key={door.href} href={door.href} className={doorClassName}>
                {content}
              </Link>
            ) : (
              <a key={door.href} href={door.href} className={doorClassName}>
                {content}
              </a>
            );
          })}
        </div>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20">
        <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          Where things stand
        </p>
        <h2 className="font-serif mt-5 max-w-[24ch] text-4xl leading-tight sm:text-5xl">
          The protocol and the checker exist today. The market is the direction.
        </h2>
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          <div className="border-border rounded-lg border p-8">
            <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
              Exists today
            </p>
            <ul className="mt-6 space-y-3 text-sm leading-relaxed">
              <li>
                The protocol, written only in <a href={links.spec}>Jinn-Network/spec</a> and
                first released as <a href={links.specRelease}>v0.1.0</a> on 24 September 2026.
              </li>
              <li>
                The checker, published on npm as{' '}
                <a href={links.verifier}>@colophon-claims/verify</a>.
              </li>
              <li>
                <a href={links.colophon}>Colophon</a>&rsquo;s sealed benchmark claims, which
                are Jinn records.
              </li>
            </ul>
          </div>
          <div className="border-border rounded-lg border p-8">
            <p className="text-gold text-xs tracking-[0.14em] uppercase">Direction</p>
            <ul className="mt-6 space-y-3 text-sm leading-relaxed">
              <li>
                A market in records. Buying and selling records is the direction, not a
                working market.
              </li>
              <li>
                Work records from the daemon that turns issues into pull requests, to be
                published once they can be anonymized.
              </li>
            </ul>
          </div>
          <div className="border-border rounded-lg border p-8">
            <p className="text-dim text-xs tracking-[0.14em] uppercase">Parked</p>
            <ul className="mt-6 space-y-3 text-sm leading-relaxed">
              <li>
                The <Link href="/docs/task-marketplace">task marketplace</Link>, in which a
                Curator funds tasks and an operator network solves and evaluates them for
                OLAS.
              </li>
              <li>
                Its network on Base Sepolia has recorded no attempt or verdict since 13
                August 2026. A node started today finds no work and earns nothing.
              </li>
              <li>
                <a href={links.explorer}>The record of what ran</a>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20">
        <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          How a record moves
        </p>
        <h2 className="font-serif mt-5 max-w-[22ch] text-4xl leading-tight sm:text-5xl">
          Work leaves a record, and anyone can check it.
        </h2>
        <ol className="mt-14 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {steps.map((item) => (
            <li key={item.step} className="border-border rounded-lg border p-6">
              <p className="text-dim text-xs tracking-[0.14em] uppercase">
                {item.step} {item.name}
              </p>
              {item.direction ? (
                <p className="text-gold mt-2 text-xs tracking-[0.14em] uppercase">Direction</p>
              ) : null}
              <p className="mt-3 text-sm leading-relaxed">{item.body}</p>
            </li>
          ))}
        </ol>
        <p className="text-muted-foreground mt-10 max-w-[64ch] text-sm leading-relaxed text-pretty">
          The first four steps are in the protocol today. Buying and selling records is the
          direction, not a working market.
        </p>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20">
        <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          The first application
        </p>
        <h2 className="font-serif mt-5 max-w-[24ch] text-4xl leading-tight sm:text-5xl">
          Colophon is the first application built on Jinn.
        </h2>
        <p className="text-muted-foreground mt-10 max-w-[64ch] text-sm leading-relaxed text-pretty">
          <a href={links.colophon}>Colophon</a> turns a preregistered comparison of agent
          configurations into a portable bundle anyone can check from its own bytes. Its
          sealed benchmark claims are Jinn records.
        </p>
        <p className="text-muted-foreground mt-5 max-w-[64ch] text-sm leading-relaxed text-pretty">
          Checking a published claim is free. The sealing tool is not published yet, so
          sealing a claim is still local, and there is no hosted service, account or billing.
        </p>
      </section>

      <section className="border-border mx-auto w-full max-w-5xl border-b px-6 py-20">
        <p className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          What this does not yet prove
        </p>
        <ul className="mt-8 max-w-[68ch] space-y-4 text-sm leading-relaxed">
          <li>
            One implementation of the protocol exists. Until a second one passes the
            conformance vectors, &ldquo;written from the specification alone&rdquo; is a
            claim, not a result.
          </li>
          <li>Buying and selling records is the direction, not a working market.</li>
          <li>
            A passing check covers a bundle&rsquo;s integrity, evidence, calculations and
            report. It does not show that the machine that produced the bundle was honest,
            or that distinct signing keys belong to distinct parties.
          </li>
          <li>The task marketplace is parked until demand for it exists.</li>
        </ul>
        <p className="text-dim mt-8 max-w-[68ch] text-xs leading-relaxed">
          Sources: <a href={links.specOpenQuestions}>the specification</a>,{' '}
          <a href={repoFile('THESIS.md')}>the thesis</a>, and{' '}
          <a href={links.colophonLimits}>the limits of a Colophon report</a>.
        </p>
      </section>

      <section className="mx-auto flex w-full max-w-5xl flex-col items-center gap-10 px-6 py-24 text-center">
        <h2 className="font-serif max-w-[24ch] text-4xl leading-tight text-balance sm:text-5xl">
          What AI performance claim or decision do you need other people to trust next?
        </h2>
        <Button asChild size="lg">
          <a href={links.bringAClaim}>Bring a claim</a>
        </Button>
      </section>

      <footer className="border-border border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-8">
          <JinnSigil className="text-dim size-6" />
          <div className="flex flex-wrap items-center gap-6 text-xs">
            <Link href="/docs">Docs</Link>
            <a href={links.spec}>Protocol</a>
            <a href={links.colophon}>Colophon</a>
            <a href={links.github}>GitHub</a>
            <Link href="/llms.txt">llms.txt</Link>
            <a href={links.explorer}>Record of the parked network</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
