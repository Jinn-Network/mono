/**
 * NetworkView — protocol-wide stats.
 *
 * Layout:
 *   1. Activity strip — distinct operators / SolverNets running / last settlement block.
 *   2. Network composition — HBars by mode / harness / model / plugin under an
 *      ALL-CAPS-MONO `NETWORK COMPOSITION` eyebrow.
 *   3. Enrichment coverage line + status bar.
 *
 * Per spec §5.1 and #610, the cross-SolverNet "solve rate" hero (added in PR
 * #251) was removed: a single aggregate rate across SolverNets mixes regimes
 * (train vs frozen, different harnesses, different task pools) and is not a
 * coherent score. The strict envelope-only filter (default; `?include=raw`
 * to opt out) lives in the backend; this view simply doesn't surface a
 * cross-net pass-rate KPI anymore.
 *
 * The on-chain-vs-envelope comparison previously rendered here moved to the
 * SolverNet detail surface where the daemon's submitVerdictDelivery default is
 * in scope.
 */

import type { ReactNode } from 'react';
import { useNetwork } from '../lib/api';
import type { NetworkResponse } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { HBars } from '../components/HBars';
import { pct, int, block } from '../lib/format';

// ── Skeleton ──────────────────────────────────────────────────────────────────

function NetworkSkeleton() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div
        style={{
          height: 100,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3)',
        }}
      />
      <div
        style={{
          height: 120,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3)',
        }}
      />
    </div>
  );
}

// ── Activity strip ────────────────────────────────────────────────────────────

function ActivityStrip({ data }: { data: NetworkResponse }) {
  return (
    <Card title="Activity">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
        }}
      >
        <ActivityCell
          k="Active operators"
          v={int(data.everAttemptedOperators)}
          first
        />
        <ActivityCell
          k="SolverNets running"
          v={int(data.solverNetsRunning)}
          sub="launched · accepting tasks"
        />
        <ActivityCell
          k="Last settlement"
          v={block(data.mostRecentSettlementBlock)}
          sub={data.mostRecentSettlementBlock ? 'block' : 'no settled tasks yet'}
          smaller
        />
      </div>
    </Card>
  );
}

function ActivityCell({
  k,
  v,
  sub,
  first,
  smaller,
}: {
  k: string;
  v: ReactNode;
  sub?: string;
  first?: boolean;
  smaller?: boolean;
}) {
  return (
    <div
      style={{
        padding: first ? '0 24px 0 0' : '0 24px',
        borderLeft: first ? 'none' : '1px dashed var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        {k}
      </div>
      <div
        className="data"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: smaller ? 32 : 'var(--text-4xl)',
          lineHeight: 1,
          color: 'var(--fg)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {v}
      </div>
      {sub && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--fg-dim)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ── NetworkView ───────────────────────────────────────────────────────────────

export function NetworkView() {
  const { data, isLoading, isError, refetch } = useNetwork();

  return (
    <div
      style={{
        padding: '40px 28px 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      {/* No page header — the chrome's Network tab is the wayfinder. The
          per-SolverNet detail view is where coherent per-regime rates live. */}

      {/* Loading state */}
      {isLoading && <NetworkSkeleton />}

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
          <span>Failed to load network stats.</span>
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

      {/* Data */}
      {data && (
        <>
          <ActivityStrip data={data} />

          <Card title="Network composition">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 28,
              }}
            >
              <HBars
                title="By mode"
                data={data.composition.byMode.map((e) => ({
                  label: e.value,
                  value: e.count,
                  share: e.share,
                }))}
              />
              <HBars
                title="By harness"
                data={data.composition.byHarness.map((e) => ({
                  label: e.value,
                  value: e.count,
                  share: e.share,
                }))}
              />
              {/* By Model: hide until the daemon stamps executor.model into the
                  envelope (jinn-mono-gbut / gh#191). Auto-shows once at least
                  one real model name lands. */}
              {data.composition.byModel.some(
                (e) => e.value && e.value !== '(unknown)',
              ) && (
                <HBars
                  title="By model"
                  data={data.composition.byModel.map((e) => ({
                    label: e.value,
                    value: e.count,
                    share: e.share,
                  }))}
                />
              )}
              <HBars
                title="By plugin"
                data={data.composition.byPlugin.map((e) => ({
                  label: e.value,
                  value: e.count,
                  share: e.share,
                }))}
              />
            </div>
          </Card>

          {/* Enrichment coverage line */}
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-dim)',
            }}
          >
            <span className="data" style={{ color: 'var(--fg-muted)' }}>
              {int(data.enrichmentCoverage.enrichedAttempts)}
            </span>
            {' / '}
            <span className="data" style={{ color: 'var(--fg-muted)' }}>
              {int(data.enrichmentCoverage.totalAttempts)}
            </span>
            {' attempts enriched ('}
            <span className="data" style={{ color: 'var(--fg-muted)' }}>
              {pct(data.enrichmentCoverage.share)}
            </span>
            {')'}
          </div>
        </>
      )}

      <StatusBar
        lastIndexedBlock={data?.lastIndexedBlock}
        lastIndexedAt={data?.lastIndexedAt}
        degraded={isError}
        enrichmentSharePct={
          data?.enrichmentCoverage
            ? data.enrichmentCoverage.share * 100
            : undefined
        }
      />
    </div>
  );
}
