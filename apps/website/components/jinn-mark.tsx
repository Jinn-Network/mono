import { cn } from '@/lib/utils';

/**
 * The vessel sigil and the wordmark, transcribed from
 * docs/design/jinn-design-system/project/assets/{logo-sigil,logo-wordmark}.svg.
 * Reused, not redrawn. `currentColor` throughout so the mark inherits the
 * surface it sits on.
 */
export function JinnSigil({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      className={cn('size-6', className)}
    >
      <circle cx="60" cy="60" r="44" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M60 22 L97 86 L23 86 Z" stroke="currentColor" strokeWidth="2" fill="none" />
      <line x1="16" y1="60" x2="104" y2="60" stroke="currentColor" strokeWidth="2" />
      <circle cx="60" cy="60" r="3" fill="currentColor" />
    </svg>
  );
}

export function JinnWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <JinnSigil className="size-6" />
      <span className="font-serif text-2xl leading-none italic">jinn</span>
    </span>
  );
}
