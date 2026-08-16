import { Card, CardContent, CardHeader } from '../../components/ui/card.js';
import { Separator } from '../../components/ui/separator.js';
import { renderMarkdownSubset } from './markdown.js';
// Vite resolves `?raw` imports at build time. The path is relative to this
// file: src/dashboard/spa/src/pages/build/ → ../../../../../../docs/build/.
// In tests Vitest also honours `?raw` via its Vite integration.
import quickstartMd from '../../../../../../docs/build/quickstart.md?raw';

import type { JSX } from 'react';

const QUICKSTART_URL =
  'https://github.com/Jinn-Network/mono/blob/next/client/docs/build/quickstart.md';

const eyebrow = 'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-dim)]';

/**
 * IntroCard — the /build page quickstart card. Renders the canonical
 * `operator/docs/build/quickstart.md` content inline (via `renderMarkdownSubset`)
 * with an eyebrow header and a footer link out to the GitHub source.
 *
 * The page-level H1 ("Build a plug-in") lives inside the rendered markdown
 * so there's exactly one H1 on the /build page.
 */
export function IntroCard(): JSX.Element {
  return (
    <Card className="p-6">
      <CardHeader className="mb-2 p-0">
        <span className={eyebrow}>Quickstart · 60 seconds</span>
      </CardHeader>
      <CardContent className="p-0">
        <div className="hfmf-intro-markdown">{renderMarkdownSubset(quickstartMd)}</div>
        <Separator className="my-5" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={eyebrow}>Next</span>
          <a
            href={QUICKSTART_URL}
            target="_blank"
            rel="noreferrer"
            className="border-b border-border pb-px font-mono text-[12px] text-primary no-underline hover:text-[var(--accent-sky-hover)]"
          >
            Read the full quickstart on GitHub →
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
