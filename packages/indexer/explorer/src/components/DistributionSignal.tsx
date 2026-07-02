/**
 * DistributionSignal — where is real usage concentrating (#1314, spec §7).
 *
 * Read-only section on the Network view: concentration bars + clusters table
 * over enriched capture envelopes, sorted by volume. Seeds (provenance:
 * imported) are excluded from every number by default; the segmented control
 * (`envelope-only` / `include seeded`) folds them back in live and states the
 * excluded total plainly — the demonstrate-it-live behaviour, expressed in
 * the explorer's own vocabulary (design: docs/design/artifacts/
 * 2026-07-02-1314-distribution-signal/).
 *
 * v0 clustering is the indexer's tag rollup (crude counts are enough,
 * spec §8); this section renders whatever the endpoint returns.
 */

import { useState } from 'react';
import { useDistributionSignal } from '../lib/api';
import type { DistributionSignalRow } from '../lib/api';
import { Card } from './Card';
import { HBars } from './HBars';
import { DataTable } from './DataTable';
import { SegmentedControl } from './SegmentedControl';
import { int } from '../lib/format';

const EMPTY_COPY = 'No contributions yet — signal appears as the corpus grows.';

type SeedFilter = 'envelope-only' | 'include-seeded';

const COLUMNS = [
  { key: 'cluster', label: 'Cluster' },
  { key: 'envelopeCount', label: 'Envelopes', numeric: true },
  { key: 'contributorCount', label: 'Contributors', numeric: true },
  { key: 'topTags', label: 'Top tags' },
];

const LOW_VOLUME_THRESHOLD = 2;

function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span style={{ color: 'var(--fg-dim)' }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {tags.map((tag) => (
        <span
          key={tag}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-1)',
            padding: '1px 6px',
          }}
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

function SignalRowCells({ row }: { row: DistributionSignalRow }) {
  return (
    <>
      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>
        {row.cluster}
      </td>
      <td className="data" style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {int(row.envelopeCount)}
      </td>
      <td className="data" style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {int(row.contributorCount)}
      </td>
      <td style={{ padding: '10px 12px' }}>
        <TagChips tags={row.topTags} />
      </td>
    </>
  );
}

export function DistributionSignal() {
  const [filter, setFilter] = useState<SeedFilter>('envelope-only');
  const { data: raw, isLoading, isError, refetch } = useDistributionSignal(filter === 'include-seeded');
  // Defensive: tolerate a malformed/partial response (e.g. a stubbed backend)
  // by treating it as an empty signal rather than crashing the Network view.
  const data = raw && Array.isArray(raw.rows) ? raw : undefined;

  return (
    <Card title="Distribution signal">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-dim)',
            }}
          >
            Where real usage concentrates — seeds excluded from every count
            {data && data.seedsExcluded > 0 && (
              <> ({int(data.seedsExcluded)} seeded excluded)</>
            )}
            {data && data.includeSeeds && <> (seeded entries included)</>}
          </div>
          <SegmentedControl<SeedFilter>
            options={[
              { label: 'envelope-only', value: 'envelope-only' },
              { label: 'include seeded', value: 'include-seeded' },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </div>

        {isLoading && (
          <div
            style={{
              height: 90,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2)',
            }}
          />
        )}

        {isError && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--break-red)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <span>Failed to load the distribution signal.</span>
            <button
              onClick={() => void refetch()}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--break-red)',
                border: '1px solid currentColor',
                borderRadius: 'var(--radius-1)',
                padding: '4px 10px',
                cursor: 'pointer',
                background: 'transparent',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {data && data.rows.length === 0 && !isLoading && !isError && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-dim)',
              padding: '18px 0',
            }}
          >
            {EMPTY_COPY}
          </div>
        )}

        {data && data.rows.length > 0 && (
          <>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-sm)',
                color: 'var(--fg-dim)',
              }}
            >
              <span className="data" style={{ color: 'var(--fg-muted)' }}>{int(data.envelopeTotal)}</span>
              {' envelopes · '}
              <span className="data" style={{ color: 'var(--fg-muted)' }}>{int(data.rows.length)}</span>
              {' clusters · '}
              <span className="data" style={{ color: 'var(--fg-muted)' }}>{int(data.contributorTotal)}</span>
              {' distinct contributors'}
            </div>

            <HBars
              title="Where usage concentrates"
              data={data.rows.slice(0, 8).map((row) => ({
                label: row.cluster,
                value: row.envelopeCount,
                share: data.envelopeTotal > 0 ? row.envelopeCount / data.envelopeTotal : 0,
              }))}
            />

            <DataTable<DistributionSignalRow>
              columns={COLUMNS}
              rows={data.rows.filter((r) => r.envelopeCount > LOW_VOLUME_THRESHOLD)}
              lowVolumeRows={data.rows.filter((r) => r.envelopeCount <= LOW_VOLUME_THRESHOLD)}
              lowVolumeLabel="Low-volume"
              sortKey="envelopeCount"
              sortDir="desc"
              onSort={() => {}}
              renderRow={(row) => <SignalRowCells row={row} />}
              emptyState={EMPTY_COPY}
            />
          </>
        )}
      </div>
    </Card>
  );
}
