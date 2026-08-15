import type { CaptureSummary } from '../../../../api/contract/index.js';

import type { JSX } from 'react';

/**
 * HarnessIdCard — the "Executor" panel shown inside the capture drill-in.
 *
 * Renders four labelled facts (tool / version / repo / commit) as a
 * definition list. The eyebrow heading matches the shared
 * section-heading type used across the operator dashboard.
 */
export function HarnessIdCard({ capture }: { capture: CaptureSummary }): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Executor
      </h2>
      <dl className="m-0 grid gap-x-3 gap-y-1.5 [grid-template-columns:120px_minmax(0,1fr)]">
        <dt className="font-mono text-[12px] text-muted-foreground">Tool</dt>
        <dd className="m-0 font-mono text-[12px] text-foreground">{capture.originatingTool.name}</dd>
        <dt className="font-mono text-[12px] text-muted-foreground">Version</dt>
        <dd className="m-0 font-mono text-[12px] text-foreground">
          {capture.originatingTool.version ?? 'unknown'}
        </dd>
        <dt className="font-mono text-[12px] text-muted-foreground">Repo</dt>
        <dd className="m-0 break-words font-mono text-[12px] text-foreground">
          {capture.repoRemoteUrl ?? 'none'}
        </dd>
        <dt className="font-mono text-[12px] text-muted-foreground">Commit</dt>
        <dd className="m-0 font-mono text-[12px] text-foreground">
          {capture.repoCommitHash?.slice(0, 12) ?? 'none'}
        </dd>
      </dl>
    </section>
  );
}
