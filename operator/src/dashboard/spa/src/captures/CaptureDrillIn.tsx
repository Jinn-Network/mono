import type { CaptureDetailResponse } from '../../../../api/contract/index.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Separator } from '../components/ui/separator.js';
import { HarnessIdCard } from './HarnessIdCard.js';
import { RedactionDiff } from './RedactionDiff.js';

import type { JSX } from 'react';

export interface CaptureDrillInProps {
  detail: CaptureDetailResponse;
  approving?: boolean;
  skipping?: boolean;
  onApprove: () => void;
  onSkip: () => void;
  onTrustRepo: (trusted: boolean) => void;
}

/**
 * CaptureDrillIn — the detail surface for a single capture.
 *
 * Rendered inside the CapturesTab `<Sheet>`. Composed top-to-bottom:
 *   - Header (session id, when + span count, action `<Button>`s)
 *   - Executor facts (HarnessIdCard)
 *   - Redactions list (RedactionDiff)
 *   - Trajectory: one `<Card>` containing the span rows, divided by
 *     `<Separator>` instead of per-row borders.
 */
export function CaptureDrillIn({
  detail,
  approving = false,
  skipping = false,
  onApprove,
  onSkip,
  onTrustRepo,
}: CaptureDrillInProps): JSX.Element {
  const { capture, spans } = detail;
  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="m-0 break-all font-serif text-[22px] font-normal leading-tight text-foreground">
            {capture.sessionId}
          </h1>
          <div className="mt-1.5 font-mono text-[12px] text-muted-foreground">
            {new Date(capture.capturedAt).toLocaleString()} · {spans.length} spans
          </div>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          {capture.repoRemoteUrl ? (
            <Button variant="secondary" size="sm" onClick={() => onTrustRepo(true)}>
              Trust repo
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" disabled={skipping} onClick={onSkip}>
            {skipping ? 'Skipping' : 'Skip'}
          </Button>
          <Button variant="default" size="sm" disabled={approving} onClick={onApprove}>
            {approving ? 'Approving' : 'Approve'}
          </Button>
        </div>
      </header>

      <HarnessIdCard capture={capture} />
      <RedactionDiff spans={spans} />

      <section className="flex flex-col gap-2">
        <h2 className="m-0 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Trajectory
        </h2>
        {spans.length === 0 ? (
          <div className="font-mono text-[12px] text-muted-foreground">No spans recorded.</div>
        ) : (
          <Card>
            <CardContent className="flex flex-col p-0">
              {spans.map((span, idx) => (
                <div key={span.spanId}>
                  {idx > 0 && <Separator />}
                  <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <strong className="min-w-0 truncate font-mono text-[12px] font-medium text-foreground">
                      {span.name}
                    </strong>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {span.spanId}
                    </span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
