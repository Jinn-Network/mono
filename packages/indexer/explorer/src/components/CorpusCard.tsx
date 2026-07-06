/**
 * CorpusCard — the corpus summary on the Network view (#1407, spec §2.4).
 *
 * Rename + restructure of the shipped "Distribution signal" card (#1314): it
 * now reads as a plain-language summary of the corpus (the network's
 * accumulating body of contributed task-trace envelopes), not a jargon
 * "signal" panel. It is the Network-view entry point into the Corpus tab
 * (#1406) — the cluster names and the footer both link into /corpus.
 *
 * The underlying data is unchanged (the /distribution-signal endpoint and its
 * clusters/contributors/tags), re-presented per the 1407 design
 * (docs/design/artifacts/2026-07-06-corpus-onboarding/1407-corpus-card.html):
 *   - a one-sentence summary — "N task traces contributed by M operators, in
 *     K clusters" — with the corpus total in gold (the Network surface's one
 *     gold hero, spec §3.5);
 *   - "Where contributions concentrate" HBars (top 5);
 *   - the cluster/contributor/tag breakdown table (cluster names link into
 *     the tab);
 *   - a "Browse the corpus →" footer into /corpus.
 *
 * The seed-exclusion toggle is intentionally retired on this surface per the
 * design: the card counts contributed (envelope-only) traces, full stop. Seed
 * provenance is a fact about one envelope, so it surfaces per-item on the
 * corpus detail (#1406), not as a filter the Network summary carries. The
 * endpoint keeps its envelope-only default; this card simply reports it.
 */

import { Link } from 'wouter';
import { useDistributionSignal } from '../lib/api';
import type { DistributionSignalRow } from '../lib/api';
import { Card } from './Card';
import { HBars } from './HBars';
import { DataTable, cellStyle, cellNumStyle } from './DataTable';
import { CorpusTagChip } from './CorpusChips';
import { int } from '../lib/format';

const EMPTY_COPY =
  'No contributions yet — the corpus grows as operators publish task traces.';

const COLUMNS = [
  { key: 'cluster', label: 'Cluster', sortable: false },
  { key: 'envelopeCount', label: 'Envelopes', numeric: true, sortable: false },
  {
    key: 'contributorCount',
    label: 'Contributors',
    numeric: true,
    sortable: false,
  },
  { key: 'topTags', label: 'Top tags', sortable: false },
];

const LOW_VOLUME_THRESHOLD = 2;

function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0)
    return <span style={{ color: 'var(--fg-dim)' }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {tags.map((tag) => (
        <CorpusTagChip key={tag}>{tag}</CorpusTagChip>
      ))}
    </span>
  );
}

function ClusterRowCells({ row }: { row: DistributionSignalRow }) {
  return (
    <>
      <td style={cellStyle}>
        <Link
          href={`/corpus?cluster=${encodeURIComponent(row.cluster)}`}
          style={{ color: 'var(--accent)', textDecoration: 'none' }}
        >
          {row.cluster}
        </Link>
      </td>
      <td className="data" style={cellNumStyle}>
        {int(row.envelopeCount)}
      </td>
      <td className="data" style={{ ...cellNumStyle, color: 'var(--fg-muted)' }}>
        {int(row.contributorCount)}
      </td>
      <td style={cellStyle}>
        <TagChips tags={row.topTags} />
      </td>
    </>
  );
}

export function CorpusCard() {
  // Envelope-only is the sole reading on this surface — no seed toggle (design
  // §1407). Seeds are excluded from every count by the endpoint's default.
  const { data: raw, isLoading, isError, refetch } = useDistributionSignal(false);
  // Defensive: tolerate a malformed/partial response (e.g. a stubbed backend)
  // by treating it as an empty corpus rather than crashing the Network view.
  const data = raw && Array.isArray(raw.rows) ? raw : undefined;

  const mainRows = data
    ? data.rows.filter((r) => r.envelopeCount > LOW_VOLUME_THRESHOLD)
    : [];
  const lowVolumeRows = data
    ? data.rows.filter((r) => r.envelopeCount <= LOW_VOLUME_THRESHOLD)
    : [];

  return (
    <Card title="Corpus">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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
            <span>Failed to load the corpus.</span>
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
            {/* Plain-language summary — the card's one job. The corpus total
                takes gold: the Network view's single gold hero (spec §3.5). */}
            <div style={{ maxWidth: '62ch' }}>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: 'var(--fg)',
                  letterSpacing: '-0.01em',
                }}
              >
                <span
                  className="data"
                  style={{
                    color: 'var(--gold)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {int(data.envelopeTotal)}
                </span>{' '}
                task traces contributed by{' '}
                <span className="data">{int(data.contributorTotal)}</span>{' '}
                operators, in <span className="data">{int(data.rows.length)}</span>{' '}
                clusters.
              </div>
            </div>

            <HBars
              title="Where contributions concentrate"
              data={data.rows.slice(0, 5).map((row) => ({
                label: row.cluster,
                value: row.envelopeCount,
                share:
                  data.envelopeTotal > 0
                    ? row.envelopeCount / data.envelopeTotal
                    : 0,
              }))}
            />

            <DataTable<DistributionSignalRow>
              columns={COLUMNS}
              rows={mainRows}
              lowVolumeRows={lowVolumeRows}
              lowVolumeLabel="Low-volume"
              sortKey="envelopeCount"
              sortDir="desc"
              onSort={() => {}}
              renderRow={(row) => <ClusterRowCells row={row} />}
              emptyState={EMPTY_COPY}
            />

            {/* Entry point into the Corpus tab (#1406). */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
              }}
            >
              <Link
                href="/corpus"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  color: 'var(--accent)',
                  textDecoration: 'none',
                }}
              >
                Browse the corpus →
              </Link>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: '0.02em',
                  color: 'var(--fg-dim)',
                }}
              >
                every trace: summary · tool steps · IPFS ref · on-chain anchor
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
