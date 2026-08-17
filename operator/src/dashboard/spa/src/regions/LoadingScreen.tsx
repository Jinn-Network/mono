import { useState, type JSX } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEventStream } from '../api/events.js';
import type { OperatorLifecycleCloudEvent } from '../../../../api/contract/index.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { ScrollArea } from '../components/ui/scroll-area.js';
import { cn } from '../lib/utils.js';

const eyebrow =
  'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--accent-gold)]';
const display = 'font-serif font-normal leading-[1.05] text-foreground text-[64px]';

export function LoadingScreen({ headline }: { headline: string }): JSX.Element {
  const [showDetails, setShowDetails] = useState(false);
  const { events } = useEventStream();
  const latest = events.length > 0 ? events[events.length - 1] : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-10 py-16 text-foreground">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <span className={eyebrow}>Jinn · starting up</span>
        <h1 className={display}>{headline}.</h1>
        <p className="min-h-[1.5em] font-mono text-sm text-[var(--fg-muted)]">
          {latest
            ? statusLineFor(latest)
            : 'The daemon is booting. This usually takes a second.'}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-[var(--fg-dim)] hover:text-foreground"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
        >
          {showDetails ? <ChevronUp /> : <ChevronDown />}
          {showDetails ? 'Hide details' : 'Show details'}
        </Button>
        {showDetails && (
          <Card className="bg-[var(--bg-elevated)]">
            <CardContent className="p-0">
              <ScrollArea className="h-64">
                <div className="px-3 py-2 font-mono text-xs">
                  {events.length === 0 && (
                    <div className="text-[var(--fg-dim)]">no events yet</div>
                  )}
                  {events
                    .slice()
                    .reverse()
                    .map((e) => (
                      <div
                        key={e.id}
                        className="grid grid-cols-[68px_84px_1fr] gap-3 py-0.5"
                      >
                        <span className="text-[var(--fg-dim)]">{e.time.slice(11, 19)}</span>
                        <span
                          className={cn(
                            e.data.severity === 'error'
                              ? 'text-[var(--break-red)]'
                              : e.data.kind === 'startup'
                                ? 'text-[var(--accent-sky)]'
                                : 'text-[var(--fg-dim)]',
                          )}
                        >
                          {e.data.kind}
                        </span>
                        <span className="text-foreground">{e.data.message}</span>
                      </div>
                    ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function statusLineFor(e: OperatorLifecycleCloudEvent): string {
  if (e.data.severity === 'error') return `Error: ${e.data.message}`;
  return e.data.message;
}
