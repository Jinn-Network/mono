/**
 * CorpusCard — the corpus summary on the Dashboard (spec §2.4).
 *
 * Two big stats (attempts · clusters), a "Browse the corpus" button pinned to
 * the card header, and the latest 5 attempts rendered with the SAME shared
 * table the Corpus index uses (CorpusTable) — so the preview and the full
 * roster read identically. The attempt total takes the Dashboard's one gold
 * hero (spec §3.5).
 *
 * The stats come from the distribution-signal aggregate (attempt total +
 * distinct clusters); the latest-5 rows come from the corpus list endpoint,
 * newest first. No cluster HBars, no breakdown table, no footer legend — the
 * card's job is a glance + a way in, not an analytics panel.
 */

import { Link } from 'wouter';
import { useDistributionSignal, useCorpus } from '../lib/api';
import type { CorpusItemRow } from '../lib/api';
import { Card } from './Card';
import { DataTable } from './DataTable';
import { corpusColumns, renderCorpusRow } from './CorpusTable';
import { int } from '../lib/format';

const EMPTY_COPY = 'No attempts yet — the corpus grows as operators publish them.';

function BrowseButton() {
  return (
    <Link
      href="/corpus"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        color: 'var(--fg-muted)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-1)',
        padding: '5px 12px',
        textDecoration: 'none',
      }}
    >
      Browse the corpus →
    </Link>
  );
}

function Stat({ value, label, gold }: { value: string; label: string; gold?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        className="data"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--text-4xl)',
          lineHeight: 1,
          color: gold ? 'var(--accent-gold)' : 'var(--fg)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function CorpusCard() {
  const {
    data: rawSignal,
    isLoading: signalLoading,
    isError: signalError,
    refetch: refetchSignal,
  } = useDistributionSignal(false);
  const {
    data: list,
    isLoading: listLoading,
    isError: listError,
    refetch: refetchList,
  } = useCorpus({ limit: 5, sort: 'createdAt', dir: 'desc' });

  // Defensive: tolerate a malformed/partial signal response by treating it as
  // an empty corpus rather than crashing the Dashboard.
  const signal = rawSignal && Array.isArray(rawSignal.rows) ? rawSignal : undefined;
  const isLoading = signalLoading || listLoading;
  // Either fetch failing surfaces the one error+retry (the retry re-fires both).
  const isError = signalError || listError;
  const attempts = signal?.envelopeTotal ?? 0;
  const clusters = signal?.rows.length ?? 0;
  const latest = list?.items ?? [];

  return (
    <Card title="Corpus" action={<BrowseButton />}>
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

        {isError && !isLoading && (
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
              onClick={() => {
                void refetchSignal();
                void refetchList();
              }}
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

        {signal && !isLoading && !isError && attempts === 0 && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', padding: '18px 0' }}>
            {EMPTY_COPY}
          </div>
        )}

        {signal && !isLoading && !isError && attempts > 0 && (
          <>
            <div style={{ display: 'flex', gap: 48 }}>
              <Stat value={int(attempts)} label="attempts" gold />
              <Stat value={int(clusters)} label={clusters === 1 ? 'cluster' : 'clusters'} />
            </div>

            {latest.length > 0 && (
              <DataTable
                columns={corpusColumns(false)}
                rows={latest}
                sortKey="createdAt"
                sortDir="desc"
                onSort={() => {}}
                renderRow={(row) => renderCorpusRow(row as CorpusItemRow)}
                emptyState={EMPTY_COPY}
              />
            )}
          </>
        )}
      </div>
    </Card>
  );
}
