'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A block of text meant to be lifted whole — a shell command, or a prompt
 * handed to an agent.
 *
 * Copy lifecycle, per WEBSITE-APP-SPEC.md §3.3: `idle → copied → idle`
 * (2s), with `failed` as the terminal alternative when the Clipboard API is
 * unavailable or refuses (insecure origin, denied permission). `failed` is
 * a real state, not a silent no-op: a copy button that does nothing when
 * clicked is worse than one that says it could not.
 */
type CopyState = 'idle' | 'copied' | 'failed';

const RESET_MS = 2000;

export function PromptBlock({
  label,
  children,
  className,
}: {
  label?: string;
  children: string;
  className?: string;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(children);
      setState('copied');
    } catch {
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), RESET_MS);
  }, [children]);

  const Icon = state === 'copied' ? Check : state === 'failed' ? TriangleAlert : Copy;

  return (
    <figure
      className={cn(
        'not-prose bg-sunken border-border my-6 overflow-hidden rounded-lg border',
        className,
      )}
    >
      <div className="border-border flex items-center justify-between gap-4 border-b px-4 py-2">
        <span className="text-muted-foreground text-xs tracking-[0.14em] uppercase">
          {label ?? 'Copy'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copy}
          data-copy-state={state}
          aria-live="polite"
        >
          <Icon aria-hidden="true" />
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-sm leading-relaxed">
        <code>{children}</code>
      </pre>
    </figure>
  );
}
