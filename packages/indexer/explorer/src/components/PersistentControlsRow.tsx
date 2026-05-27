/**
 * PersistentControlsRow — right-aligned row with + filter chip and
 * Group by dropdown. Used at default landing when no filter chips render.
 *
 * When filters are active, the parent renders FilterChipStrip + GroupByDropdown
 * inline instead — this row is only for the empty-strip case.
 */
import { GroupByDropdown } from './GroupByDropdown';
import type { GroupValue } from '../lib/url-state';

interface Props {
  group: GroupValue;
  onGroupChange: (v: GroupValue) => void;
  onAddFilter: () => void;
}

export function PersistentControlsRow({ group, onGroupChange, onAddFilter }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'flex-end',
      }}
    >
      <button
        type="button"
        aria-label="Add filter"
        onClick={onAddFilter}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-pill)',
          padding: '3px 9px',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        + filter
      </button>
      <GroupByDropdown value={group} onChange={onGroupChange} />
    </div>
  );
}
