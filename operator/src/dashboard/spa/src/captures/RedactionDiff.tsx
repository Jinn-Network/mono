import type { CaptureSpan } from '../../../../api/contract/index.js';

import type { JSX } from 'react';

/**
 * RedactionDiff — flat list of `{ spanName, redactedAttributeKey }` pairs.
 *
 * Each row is a two-column monospace grid: span name on the left, the
 * redacted attribute key on the right. No bespoke primitive needed —
 * this is just a styled definition-list shape, expressed with tailwind
 * utilities against shadcn tokens.
 */
export function RedactionDiff({ spans }: { spans: CaptureSpan[] }): JSX.Element {
  const redacted = spans.flatMap((span) =>
    span.redactedKeys.map((key) => ({ span: span.name, key })),
  );

  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Redactions
      </h2>
      {redacted.length === 0 ? (
        <div className="font-mono text-[12px] text-muted-foreground">No redacted attributes.</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {redacted.map((entry, idx) => (
            <div
              key={`${entry.span}-${entry.key}-${idx}`}
              className="grid gap-3 font-mono text-[12px] text-foreground [grid-template-columns:minmax(120px,180px)_minmax(0,1fr)]"
            >
              <span className="text-muted-foreground">{entry.span}</span>
              <span className="break-words">{entry.key}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
