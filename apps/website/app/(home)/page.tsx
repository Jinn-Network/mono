import Link from 'next/link';
import { ArrowLeftRight, ArrowRight, FileText, Search, ShieldCheck, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
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
 *   - The checker run: the output of `npx @jinn-network/verify`, abridged, for
 *     the public claim /docs/check-a-claim checks, with the claim's published
 *     digest as the root.
 *   - The caveats: the specification's own list of what is still open,
 *     THESIS.md §4, and the limits Colophon's checker prints.
 *   - The verb rules are CLAUDE.md "External Communication"; the protocol
 *     takes no part in payment, so it is never the subject of a payment verb.
 *     `test/content.test.mjs` asserts them over this file.
 *
 * Selling records is the direction, not a working market. Nothing here says
 * or implies otherwise: the one step that involves payment is marked as
 * direction and says so in its own words.
 *
 * Progressive disclosure: the page shows one line per idea and leaves the
 * detail to the docs. Each caveat is a visible one-line trigger whose
 * explanation and source open beneath it.
 *
 * Call to action: GROWTH.md §3 names "Bring a claim" as the single call to
 * action on every outward surface. The doors below are navigation, not a
 * second ask. There is exactly one button on this page.
 */

const checkRun = [
  { name: 'Root', result: 'matched the digest you gave', passed: true },
  { name: 'Digest', result: '46,010 passed, compared with the list', passed: true },
  { name: 'Schema', result: '26,402 passed, 19,608 skipped (kind unknown)', passed: false },
  {
    name: 'Signatures',
    result: '4,323 verified against keys you supplied, none unverified',
    passed: true,
  },
  {
    name: 'Trust binding',
    result:
      'skipped: no key was tied to an identity, and a root pins what was published, not who published it',
    passed: false,
  },
  { name: 'Anchors', result: '1 pending', passed: false },
  {
    name: 'Completeness',
    result: 'passed: 46,016 listed files present and unchanged, no others',
    passed: true,
  },
];

const steps = [
  { name: 'Record', icon: FileText, body: 'Work leaves a sealed record.' },
  { name: 'Check', icon: ShieldCheck, body: 'Anyone checks it from its own bytes.' },
  { name: 'Offer', icon: Tag, body: 'Its holder offers it, free or priced.' },
  { name: 'Find', icon: Search, body: 'Others find the record and its offer.' },
  {
    name: 'Buy',
    icon: ArrowLeftRight,
    body: 'Buying records is the direction, not a working market.',
    direction: true,
  },
];

const doors = [
  {
    title: 'Check a claim',
    href: '/docs/check-a-claim',
    body: 'Run the Colophon checker on a sealed claim, on your own machine.',
    status: 'Free, no account',
  },
  {
    title: 'Find a claim',
    href: links.colophonFind,
    body: 'Browse the public claims listed on Colophon.',
    status: 'Newest first',
  },
  {
    title: 'Build on the protocol',
    href: '/docs/protocol',
    body: 'The spec, its schemas and its conformance vectors.',
    status: 'Release v0.1.0',
  },
];

const eyebrow = 'text-muted-foreground text-xs tracking-[0.14em] uppercase';
// An eyebrow that heads its section is an <h2> in the outline; this resets the
// design system's display style for h2.
const eyebrowHeading = `${eyebrow} font-sans font-normal leading-normal`;
const sectionClassName = 'mx-auto w-full max-w-6xl px-6';

const doorClassName =
  'border-border hover:border-accent-sky bg-background group flex flex-col rounded-lg border p-7 no-underline transition-colors';

function CheckRun() {
  return (
    <figure className="border-border bg-sunken overflow-hidden rounded-lg border font-mono text-[12px] leading-6">
      <div className="border-border text-dim flex items-center justify-between gap-4 border-b px-5 py-3">
        <span className="truncate">Judging the LoCoMo judges</span>
        <span className="shrink-0">Colophon claim, abridged</span>
      </div>
      <div className="px-5 py-5">
        <p className="text-foreground break-all">
          <span className="text-dim select-none">$ </span>npx @jinn-network/verify ./bundle \
        </p>
        <p className="text-foreground pl-4 break-all">
          --root sha256:de169c04a24bbb4d9d5b52e398b8bfe92e939ba4d8a8c9e6e3e551cf10aa3774 \
        </p>
        <p className="text-foreground pl-4 break-all">--keys ./bundle/trust/public-keys.json</p>
        <dl className="mt-4">
          {checkRun.map((row) => (
            <div key={row.name} className="grid grid-cols-[7rem_1fr] gap-x-3">
              <dt className="text-dim">{row.name}</dt>
              <dd className={row.passed ? 'text-vow' : 'text-muted-foreground'}>{row.result}</dd>
            </div>
          ))}
        </dl>
        <p className="text-foreground mt-4">Nothing failed. Skipped and unknown are not passes.</p>
      </div>
    </figure>
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section
        className={`${sectionClassName} grid items-center gap-14 pt-20 pb-24 sm:pt-28 lg:grid-cols-[1.25fr_1fr] lg:gap-16`}
      >
        <div>
          <h1 className="font-serif text-5xl leading-[1.02] text-balance sm:text-6xl">
            Keep the work, not just the answer.
          </h1>
          <p className="text-muted-foreground mt-8 max-w-[46ch] text-[15px] leading-relaxed text-pretty">
            Jinn is an open protocol and network for work and the data it produces. Anyone can
            check a record from its own bytes, with their own tools. The protocol takes no fee,
            and there is no Jinn token.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
            <Button asChild size="lg">
              <a href={links.bringAClaim}>Bring a claim</a>
            </Button>
            <Link
              href="/docs/check-a-claim"
              className="text-accent-sky group inline-flex items-center gap-2 text-sm no-underline"
            >
              Check a claim
              <ArrowRight
                aria-hidden="true"
                className="size-4 transition-transform group-hover:translate-x-1"
              />
            </Link>
          </div>
        </div>
        <CheckRun />
      </section>

      <section className="border-border border-t">
        <div className={`${sectionClassName} py-24`}>
          <h2 className="font-serif text-4xl leading-tight sm:text-5xl">How a record moves</h2>
          <div className="relative mt-14">
            <div
              aria-hidden="true"
              className="bg-border absolute top-6 right-[10%] left-[10%] hidden h-px lg:block"
            />
            <ol className="grid gap-7 sm:grid-cols-2 lg:grid-cols-5 lg:gap-6">
              {steps.map(({ name, icon: Icon, body, direction }) => (
                <li
                  key={name}
                  className="relative flex items-start gap-5 lg:flex-col lg:items-center lg:gap-0 lg:text-center"
                >
                  <span
                    className={
                      direction
                        ? 'border-gold/50 text-gold bg-background flex size-12 shrink-0 items-center justify-center rounded-md border border-dashed'
                        : 'border-border text-accent-sky bg-background flex size-12 shrink-0 items-center justify-center rounded-md border'
                    }
                  >
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  <div className="lg:mt-5">
                    <p className="flex items-center gap-2 text-sm lg:justify-center">
                      {name}
                      {direction ? (
                        <span className="border-gold/40 text-gold rounded-full border px-2 py-0.5 text-[10px] tracking-[0.14em] uppercase">
                          Direction
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground mt-1 max-w-[24ch] text-sm leading-relaxed lg:mx-auto lg:mt-2">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="border-border bg-sunken border-y">
        <div className={`${sectionClassName} py-24`}>
          <h2 className={eyebrowHeading}>Start here</h2>
          <div className="mt-8 grid gap-5 lg:grid-cols-3">
            {doors.map((door) => {
              const content = (
                <>
                  <h3 className="font-serif text-3xl leading-tight">{door.title}</h3>
                  <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{door.body}</p>
                  <span className="mt-10 flex items-center justify-between text-xs">
                    <span className="text-dim">{door.status}</span>
                    <ArrowRight
                      aria-hidden="true"
                      className="text-accent-sky size-4 transition-transform group-hover:translate-x-1"
                    />
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
        </div>
      </section>

      <section className={`${sectionClassName} grid gap-10 py-24 lg:grid-cols-2 lg:gap-20`}>
        <div>
          <p className={eyebrow}>The first application</p>
          <h2 className="font-serif mt-5 text-4xl leading-tight sm:text-5xl">Colophon</h2>
        </div>
        <div className="lg:pt-10">
          <p className="text-[15px] leading-relaxed text-pretty">
            Colophon turns a comparison of AI agent setups, planned in advance, into a sealed claim
            anyone can check. Its claims are Jinn records.
          </p>
          <p className="text-muted-foreground mt-4 text-sm leading-relaxed text-pretty">
            Checking is free. Sealing runs on your own machine, with no hosted service, account or
            billing.
          </p>
          <a
            href={links.colophon}
            className="text-accent-sky group mt-8 inline-flex items-center gap-2 text-sm no-underline"
          >
            Open Colophon
            <ArrowRight
              aria-hidden="true"
              className="size-4 transition-transform group-hover:translate-x-1"
            />
          </a>
        </div>
      </section>

      <section className="border-border border-t">
        <div className={`${sectionClassName} py-24`}>
          <h2 className="font-serif text-4xl leading-tight sm:text-5xl">Where things stand</h2>
          <div className="mt-12 grid gap-10 sm:grid-cols-3">
            <div>
              <p className="text-vow text-xs tracking-[0.14em] uppercase">Exists today</p>
              <ul className="mt-5 space-y-3 text-sm leading-relaxed">
                <li>
                  <a href={links.spec}>The protocol</a>, release v0.1.0
                </li>
                <li>
                  <a href={links.verifier}>The checker</a>, on npm
                </li>
                <li>
                  <a href={links.colophon}>Colophon</a>&rsquo;s sealed claims
                </li>
              </ul>
            </div>
            <div>
              <p className="text-gold text-xs tracking-[0.14em] uppercase">Direction</p>
              <ul className="mt-5 space-y-3 text-sm leading-relaxed">
                <li>A market in records</li>
                <li>Records from the daemon that turns issues into pull requests</li>
              </ul>
            </div>
            <div>
              <p className="text-dim text-xs tracking-[0.14em] uppercase">Parked</p>
              <ul className="mt-5 space-y-3 text-sm leading-relaxed">
                <li>
                  The <Link href="/docs/task-marketplace">task marketplace</Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-20 max-w-3xl">
            <h2 className={eyebrowHeading}>What this does not yet prove</h2>
            <Accordion type="multiple" className="border-border mt-4 border-t">
              <AccordionItem value="implementations" className="border-border">
                <AccordionTrigger>One implementation of the protocol exists.</AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  Until a second one passes the conformance vectors, &ldquo;written from the spec
                  alone&rdquo; is a claim, not a result. Source:{' '}
                  <a href={links.specOpenQuestions}>the specification</a>.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="market" className="border-border">
                <AccordionTrigger>There is no working market in records.</AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  A holder can offer a record today. Buying and selling records is the direction,
                  not a working market. Source: <a href={repoFile('THESIS.md')}>the thesis</a>.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="check" className="border-border">
                <AccordionTrigger>A check covers the bundle, not the machine.</AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  A passing Colophon check covers a bundle&rsquo;s integrity, evidence, calculations and
                  report. It does not show that the machine that produced the bundle was honest,
                  or that distinct signing keys belong to distinct parties. Source:{' '}
                  <a href={links.colophonLimits}>the limits of a Colophon report</a>.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="parked" className="border-border">
                <AccordionTrigger>The task marketplace is parked.</AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  It stays parked until demand for it exists. Its network on Base Sepolia has
                  recorded no attempt or verdict since 13 August 2026. Source:{' '}
                  <a href={links.explorer}>the record of what ran on the parked network</a>.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            <p className="text-dim mt-6 text-xs leading-relaxed">
              Sources: <a href={links.specOpenQuestions}>the specification</a>,{' '}
              <a href={repoFile('THESIS.md')}>the thesis</a>,{' '}
              <a href={links.colophonLimits}>the limits of a Colophon report</a> and{' '}
              <a href={links.explorer}>the record of what ran on the parked network</a>.
            </p>
          </div>
        </div>
      </section>

      <footer className="border-border border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8">
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
