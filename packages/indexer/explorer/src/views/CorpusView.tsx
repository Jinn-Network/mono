/**
 * CorpusView — the corpus index (#1406).
 *
 * A browsable, sortable, paginated list of corpus items (published capture
 * envelopes). Matches the SolverNets / Operators roster idiom: page header +
 * DataTable + StatusBar. No gold accent on this surface (the roster surfaces
 * carry none; spec §3.5).
 *
 * Sort, seed-filter, and page all live in URL state (spec §3.3) so a row's
 * list position is shareable. The backend is the source of ordering AND
 * pagination: sort is server-side over the FULL corpus before slicing, so a
 * sort claim holds across pages (not just the fetched page). Changing sort or
 * the seed filter resets the page to avoid stranding the viewer at a stale
 * offset.
 *
 * Empty state: "No contributions yet…" in the explorer's voice.
 */

import { Link } from 'wouter';
import { useCorpus } from '../lib/api';
import type { CorpusItemRow } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { DataTable, cellStyle, cellNumStyle, cellMutedStyle } from '../components/DataTable';
import { CorpusTierChip, CorpusTagChip } from '../components/CorpusChips';
import { SegmentedControl } from '../components/SegmentedControl';
import { useEnumParam, useNumParam, usePatchParams } from '../lib/url-state';
import { int, shortCid, shortAddr, relUnix } from '../lib/format';

const PAGE_SIZE = 25;

// ── Seed filter (spec §2.4) ───────────────────────────────────────────────────

type SeedFilter = 'envelope-only' | 'include-seeded';

// ── Columns ───────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: 'summary', label: 'Contribution', sortable: false },
  { key: 'cluster', label: 'Cluster', sortable: true },
  { key: 'tier', label: 'Tier', sortable: true },
  { key: 'contributor', label: 'Contributor', sortable: false },
  { key: 'stepCount', label: 'Steps', numeric: true, sortable: true },
  { key: 'createdAt', label: 'Age', numeric: true, sortable: true },
];

// ── Row renderer ──────────────────────────────────────────────────────────────

function renderRow(row: CorpusItemRow) {
  return (
    <>
      <td style={cellStyle}>
        <Link
          href={`/corpus/${encodeURIComponent(row.cid)}`}
          style={{
            color: 'var(--accent)',
            textDecoration: 'none',
            display: 'block',
            lineHeight: 1.3,
          }}
        >
          <span style={{ fontSize: 12.5 }}>{row.summary || '(no summary)'}</span>
          <span
            style={{
              display: 'block',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--fg-dim)',
              marginTop: 2,
            }}
          >
            {shortCid(row.cid)}
          </span>
        </Link>
      </td>
      <td style={cellStyle}>
        {row.cluster ? <CorpusTagChip>{row.cluster}</CorpusTagChip> : <span style={{ color: 'var(--fg-dim)' }}>—</span>}
      </td>
      <td style={cellStyle}>
        <CorpusTierChip tier={row.tier} />
      </td>
      <td style={cellMutedStyle}>{shortAddr(row.contributor)}</td>
      <td className="data" style={cellNumStyle}>{int(row.stepCount)}</td>
      <td className="data" style={{ ...cellNumStyle, color: 'var(--fg-muted)' }}>{relUnix(row.createdAt)}</td>
    </>
  );
}

// ── Pager ─────────────────────────────────────────────────────────────────────

function Pager({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const btnStyle = (disabled: boolean) =>
    ({
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      letterSpacing: '0.10em',
      textTransform: 'uppercase' as const,
      padding: '5px 12px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-1)',
      background: 'transparent',
      color: disabled ? 'var(--fg-dim)' : 'var(--fg-muted)',
      opacity: disabled ? 0.4 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }) as const;

  const atStart = page <= 0;
  const atEnd = page >= pageCount - 1;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {total === 0 ? '0 of 0' : `${rangeStart}–${rangeEnd} of ${int(total)}`} · newest first
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={atStart} onClick={atStart ? undefined : onPrev} style={btnStyle(atStart)}>
          Prev
        </button>
        <button disabled={atEnd} onClick={atEnd ? undefined : onNext} style={btnStyle(atEnd)}>
          Next
        </button>
      </div>
    </div>
  );
}

// ── CorpusView ────────────────────────────────────────────────────────────────

export function CorpusView() {
  const [page] = useNumParam('page', 0);
  const [sort] = useEnumParam('sort', 'createdAt', [
    'createdAt',
    'cluster',
    'tier',
    'stepCount',
  ]);
  const [dir] = useEnumParam('dir', 'desc', ['asc', 'desc']);
  const [seedFilter] = useEnumParam('include', 'envelope-only', [
    'envelope-only',
    'include-seeded',
  ]);
  const includeSeeds = seedFilter === 'include-seeded';
  // Coupled writes (sort/dir/filter all reset the page) go through one atomic
  // patch — the per-key setters clobber each other in a single handler (see
  // usePatchParams).
  const patchParams = usePatchParams();

  const { data, isLoading, isError, refetch } = useCorpus({
    limit: PAGE_SIZE,
    offset: Math.max(page, 0) * PAGE_SIZE,
    // Sort is server-side over the full corpus (not the fetched page) so the
    // ordering holds across pages.
    sort,
    dir: dir as 'asc' | 'desc',
    includeSeeds,
  });

  function handleSort(key: string) {
    const nextDir = key === sort ? (dir === 'desc' ? 'asc' : 'desc') : 'desc';
    // Re-ordering the whole corpus invalidates the current offset — reset the
    // page in the SAME write so the viewer isn't stranded mid-list.
    patchParams({ sort: key, dir: nextDir, page: null });
  }

  function handleSeedFilter(next: SeedFilter) {
    // The filtered set changes size; a stale offset could point past the end,
    // so drop the page in the same atomic write as the filter change.
    patchParams({ include: next === 'envelope-only' ? null : next, page: null });
  }

  function goToPage(next: number | null) {
    patchParams({ page: next === null || next <= 0 ? null : next });
  }

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);
  const isEmpty = Boolean(data) && total === 0;

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      {/* Page header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontStyle: 'italic',
              fontSize: 'var(--text-4xl)',
              lineHeight: 1.05,
              color: 'var(--fg)',
              margin: 0,
              marginBottom: 4,
              fontWeight: 400,
            }}
          >
            Corpus
          </h1>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
            }}
          >
            {data
              ? `${int(total)} ${includeSeeds ? 'task traces (seeded included)' : 'contributed task traces'}`
              : 'loading…'}
            {data && !includeSeeds && data.seedsExcluded > 0 && (
              <>
                <span style={{ margin: '0 8px' }}>·</span>
                {int(data.seedsExcluded)} seeds excluded
              </>
            )}
          </div>
        </div>
        <SegmentedControl<SeedFilter>
          options={[
            { label: 'envelope-only', value: 'envelope-only' },
            { label: 'include seeded', value: 'include-seeded' },
          ]}
          value={seedFilter as SeedFilter}
          onChange={handleSeedFilter}
        />
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-3)',
            overflow: 'hidden',
          }}
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{
                padding: '14px 16px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                display: 'flex',
                gap: 16,
                background: 'var(--bg-elevated)',
              }}
            >
              {Array.from({ length: 6 }).map((__, j) => (
                <div
                  key={j}
                  style={{
                    height: 14,
                    flex: j === 0 ? 3 : 1,
                    background: 'var(--bg-sunken)',
                    borderRadius: 'var(--radius-1)',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            color: 'var(--break-red)',
            border: '1px solid var(--break-red)',
            borderRadius: 'var(--radius-2)',
            padding: '12px 16px',
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

      {/* Empty state — in the explorer's voice */}
      {isEmpty && (
        <div
          style={{
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-3)',
            padding: '48px 24px',
            textAlign: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: 14,
            color: 'var(--fg)',
          }}
        >
          No contributions yet — the corpus grows as operators publish task traces.
        </div>
      )}

      {/* Data table + pager */}
      {data && !isEmpty && (
        <>
          <DataTable
            columns={COLUMNS}
            rows={rows}
            sortKey={sort}
            sortDir={dir as 'asc' | 'desc'}
            onSort={handleSort}
            renderRow={(row) => renderRow(row as CorpusItemRow)}
            emptyState="No contributions on this page."
          />
          <Pager
            page={page}
            pageCount={pageCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={total}
            onPrev={() => goToPage(page - 1)}
            onNext={() => goToPage(page + 1)}
          />
        </>
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        behindHead={data?.behindHead}
        degraded={isError}
      />
    </div>
  );
}
