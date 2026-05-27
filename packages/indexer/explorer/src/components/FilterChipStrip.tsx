/**
 * FilterChipStrip — chip strip above the chart showing active value filters.
 *
 * Hidden entirely when filters are empty (returns null). When ≥1 filter is
 * active, renders horizontal hairline-bordered strip with one chip per
 * (dim, value) pair plus a "+ filter" add chip at the end.
 *
 * Filter chip: dim:value × in accent-sky.
 * Add chip:    dashed border in fg-dim.
 */
import { FILTER_DIMS, type FilterDim, type FilterMap } from '../lib/url-state';

interface Props {
  filters: FilterMap;
  onRemove: (dim: FilterDim, value: string) => void;
  onAddFilter: () => void;
}

export function FilterChipStrip({ filters, onRemove, onAddFilter }: Props) {
  const flat: { dim: FilterDim; value: string }[] = [];
  for (const dim of FILTER_DIMS) {
    const values = filters[dim];
    if (values) {
      for (const v of values) flat.push({ dim, value: v });
    }
  }
  if (flat.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Active filters"
      style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      {flat.map(({ dim, value }) => (
        <FilterChip
          key={`${dim}:${value}`}
          dim={dim}
          value={value}
          onRemove={() => onRemove(dim, value)}
        />
      ))}
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
    </div>
  );
}

function FilterChip({
  dim,
  value,
  onRemove,
}: {
  dim: FilterDim;
  value: string;
  onRemove: () => void;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: '1px solid var(--accent-sky)',
        borderRadius: 'var(--radius-pill)',
        padding: '3px 9px',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        color: 'var(--accent-sky)',
        background: 'transparent',
      }}
    >
      {dim}:{value}
      <button
        type="button"
        aria-label={`Remove ${dim}=${value}`}
        onClick={onRemove}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-dim)',
          cursor: 'pointer',
          padding: 0,
          marginLeft: 2,
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </span>
  );
}
