/**
 * StatusChip — a small pill indicating status.
 *
 * Design:
 *   - Pill radius (var(--radius-pill)), color on border + text only — never filled bg
 *   - Caps-mono, ~10px, letter-spacing 0.14em
 *   - A small 5px dot before the label, color matches the chip
 *   - No emoji, no gradients
 */

export type StatusKind =
  | 'launched'
  | 'paused'
  | 'retired'
  | 'ok'
  | 'pending'
  | 'train'
  | 'frozen'
  | 'unknown'
  | 'violation';

const KIND_COLOR: Record<StatusKind, string> = {
  launched:  'var(--vow-green)',
  ok:        'var(--vow-green)',
  paused:    'var(--wane)',
  pending:   'var(--wane)',
  retired:   'var(--fg-dim)',
  unknown:   'var(--fg-dim)',
  train:     'var(--accent)',
  // "frozen" uses muted lamplight gold (--gold-600) rather than --accent-gold so it
  // doesn't compete with the one-gold-per-surface focal headline on Operator surfaces.
  frozen:    'var(--gold-600)',
  violation: 'var(--break-red)',
};

const KIND_DASHED: Partial<Record<StatusKind, boolean>> = {
  paused:  true,
  retired: true,
  unknown: true,
};

export interface StatusChipProps {
  kind: StatusKind | string;
  label?: string;
}

export function StatusChip({ kind, label }: StatusChipProps) {
  const color = KIND_COLOR[kind as StatusKind] ?? 'var(--fg-dim)';
  const dashed = KIND_DASHED[kind as StatusKind] ?? false;
  const displayLabel = label ?? kind;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color,
        border: `1px ${dashed ? 'dashed' : 'solid'} currentColor`,
        borderRadius: 'var(--radius-pill)',
        padding: '2px 9px',
        fontSize: 'var(--text-xs)',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          background: 'currentColor',
          flexShrink: 0,
        }}
      />
      {displayLabel}
    </span>
  );
}
