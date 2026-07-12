/**
 * CorpusView — the corpus index (#1406).
 *
 * A browsable, sortable, paginated list of attempts (published, scrubbed,
 * consented task traces). Matches the SolverNets / Operators roster idiom: page
 * header + DataTable + StatusBar. No gold accent on this surface (the roster
 * surfaces carry none; spec §3.5).
 *
 * Columns are the shared corpus row (Attempt · Cluster · Contributor · Age);
 * tier, step count, and the content-hash subline were dropped from the roster
 * (tier is monotone on a pre-evaluator testnet; the rest live on the detail
 * view). Sort and page live in URL state (spec §3.3) so a row's list position
 * is shareable; sort is server-side over the FULL corpus before slicing, so a
 * sort claim holds across pages. Changing sort resets the page to avoid
 * stranding the viewer at a stale offset.
 *
 * Empty state: "No attempts yet…" in the explorer's voice.
 */

import { useCorpus } from '../lib/api';
import type { CorpusItemRow } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { DataTable } from '../components/DataTable';
import { corpusColumns, renderCorpusRow } from '../components/CorpusTable';
import { CorpusTagChip } from '../components/CorpusChips';
import { useEnumParam, useNumParam, useQueryParam, usePatchParams } from '../lib/url-state';
import { int } from '../lib/format';

const PAGE_SIZE = 25;

// Shared ghost-button token block (mono uppercase, hairline border, transparent
// fill) used by the Pager's Prev/Next and the active-filter Clear control.
// `padding` is the only per-use knob.
const ghostButtonStyle = (padding: string) =>
  ({
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.10em',
    textTransform: 'uppercase' as const,
    padding,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-1)',
    background: 'transparent',
    color: 'var(--fg-muted)',
    cursor: 'pointer',
  }) as const;

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
      ...ghostButtonStyle('5px 12px'),
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
  const [sort] = useEnumParam('sort', 'createdAt', ['createdAt', 'cluster']);
  const [dir] = useEnumParam('dir', 'desc', ['asc', 'desc']);
  const [cluster] = useQueryParam('cluster', '');
  // Coupled writes (sort/dir both reset the page) go through one atomic patch —
  // the per-key setters clobber each other in a single handler (usePatchParams).
  const patchParams = usePatchParams();

  const { data, isLoading, isError, refetch } = useCorpus({
    limit: PAGE_SIZE,
    offset: Math.max(page, 0) * PAGE_SIZE,
    // Filter to a single cluster (#1414); omit when unset.
    cluster: cluster || undefined,
    // Sort is server-side over the full corpus (not the fetched page) so the
    // ordering holds across pages.
    sort,
    dir: dir as 'asc' | 'desc',
  });

  function handleSort(key: string) {
    const nextDir = key === sort ? (dir === 'desc' ? 'asc' : 'desc') : 'desc';
    // Re-ordering the whole corpus invalidates the current offset — reset the
    // page in the SAME write so the viewer isn't stranded mid-list.
    patchParams({ sort: key, dir: nextDir, page: null });
  }

  function goToPage(next: number | null) {
    patchParams({ page: next === null || next <= 0 ? null : next });
  }

  // Clearing the cluster filter re-orders the full corpus — reset the page in
  // the SAME write so the viewer isn't stranded at a stale offset (#1414).
  function clearCluster() {
    patchParams({ cluster: null, page: null });
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
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-dim)',
          }}
        >
          <span>{data ? `${int(total)} attempts` : 'loading…'}</span>
          {cluster && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CorpusTagChip>{cluster}</CorpusTagChip>
              <button
                aria-label="Clear cluster filter"
                onClick={clearCluster}
                style={ghostButtonStyle('3px 8px')}
              >
                Clear ×
              </button>
            </span>
          )}
        </div>
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
              {Array.from({ length: 4 }).map((__, j) => (
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
          No attempts yet — the corpus grows as operators publish them.
        </div>
      )}

      {/* Data table + pager */}
      {data && !isEmpty && (
        <>
          <DataTable
            columns={corpusColumns(true)}
            rows={rows}
            sortKey={sort}
            sortDir={dir as 'asc' | 'desc'}
            onSort={handleSort}
            renderRow={(row) => renderCorpusRow(row as CorpusItemRow)}
            emptyState="No attempts on this page."
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
