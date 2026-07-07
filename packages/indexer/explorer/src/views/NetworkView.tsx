/**
 * NetworkView — protocol-wide stats.
 *
 * Layout:
 *   1. Activity strip — distinct operators / SolverNets running / last settlement block.
 *   2. Economy row — JINN distributed (operator/DAO split) + "how it flows" copy.
 *   3. Network composition — HBars by mode / harness / model / plugin under an
 *      ALL-CAPS-MONO `NETWORK COMPOSITION` eyebrow.
 *   4. Enrichment coverage line + status bar.
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
import { InfoTooltip } from '../components/InfoTooltip';
import { ActiveOperatorTooltipBody } from '../components/ActiveOperatorTooltip';
import { pct, int, block, jinn } from '../lib/format';

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
          v={int(data.activeOperators)}
          first
          info={<ActiveOperatorTooltipBody window={data.activeWindow} />}
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
  info,
}: {
  k: string;
  v: ReactNode;
  sub?: string;
  first?: boolean;
  smaller?: boolean;
  info?: ReactNode;
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
        {info && <InfoTooltip label={`${k} definition`}>{info}</InfoTooltip>}
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

// ── Economy row ───────────────────────────────────────────────────────────────

function EconomyRow({ data }: { data: NetworkResponse }) {
  let opWei = 0n;
  let daoWei = 0n;
  try {
    opWei = BigInt(data.jinnDistributedOperator || '0');
  } catch {
    /* leave at 0 */
  }
  try {
    daoWei = BigInt(data.jinnDistributedDao || '0');
  } catch {
    /* leave at 0 */
  }
  const total = opWei + daoWei;
  const opPctNum =
    total === 0n ? 0 : Number((opWei * 10000n) / total) / 100;
  const daoPctNum =
    total === 0n ? 0 : Number((daoWei * 10000n) / total) / 100;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 20,
      }}
    >
      <Card title="Economy">
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            marginBottom: 10,
          }}
        >
          JINN distributed
        </div>
        <div
          className="data"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-4xl)',
            lineHeight: 1,
            color: 'var(--accent-gold)',
            letterSpacing: '-0.01em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {jinn(total.toString())}
        </div>

        <div style={{ marginTop: 20 }}>
          <div
            style={{
              height: 6,
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-pill)',
              overflow: 'hidden',
              display: 'flex',
            }}
          >
            <div
              aria-label="Operators share"
              style={{
                background: 'var(--accent-gold)',
                width: `${opPctNum}%`,
                height: '100%',
              }}
            />
            <div
              aria-label="DAO share"
              style={{
                background: 'var(--seer-violet)',
                width: `${daoPctNum}%`,
                height: '100%',
                opacity: 0.75,
              }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 10,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--fg-muted)',
            }}
          >
            <span>
              <LegendSwatch color="var(--accent-gold)" />
              {jinn(opWei.toString())} to operators
            </span>
            <span>
              <LegendSwatch color="var(--seer-violet)" opacity={0.75} />
              {jinn(daoWei.toString())} to DAO
            </span>
          </div>
        </div>
      </Card>

      <Card>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg)',
            marginBottom: 12,
          }}
        >
          How JINN flows
        </div>
        <p
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--fg-muted)',
            lineHeight: 1.6,
          }}
        >
          Every settled task distributes from the launcher's bond. Operators
          earn for passing solutions; the DAO collects a protocol cut to fund
          the next epoch.
        </p>
      </Card>
    </div>
  );
}

function LegendSwatch({
  color,
  opacity = 1,
}: {
  color: string;
  opacity?: number;
}) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        marginRight: 8,
        verticalAlign: 'middle',
        borderRadius: 2,
        background: color,
        opacity,
      }}
    />
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
          <EconomyRow data={data} />

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
