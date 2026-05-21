/**
 * NetworkView — protocol-wide stats.
 *
 * Layout follows the May 15 redesign (jinn-mono-ujlu):
 *   1. Hero — gold-bordered card pairing the solve rate (big serif) with the
 *      Posted → Attempted → Evaluated pipeline.
 *   2. Activity — 3-cell strip (operators / SolverNets / last settled).
 *   3. Economy — JINN distributed meter (operator/DAO split) + "how it flows".
 *   4. What's running — HBars by mode / harness / model / plugin.
 *   5. Enrichment coverage line + status bar.
 *
 * The on-chain-vs-envelope comparison previously rendered here moved to the
 * SolverNet detail surface where the daemon's submitVerdictDelivery default is
 * in scope. The "one gold element per surface" rule maps to the hero's solve
 * rate; all other numerics are mono/white.
 */

import type { ReactNode } from 'react';
import { useNetwork } from '../lib/api';
import type { NetworkResponse } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { HBars } from '../components/HBars';
import { pct, int, block, jinn } from '../lib/format';

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonHero() {
  return (
    <div
      style={{
        border: '1px solid var(--border-accent)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--bg-elevated)',
        padding: 28,
        display: 'grid',
        gridTemplateColumns: '1.4fr 1fr',
        gap: 32,
      }}
    >
      <div
        style={{
          height: 140,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--radius-1)',
        }}
      />
      <div
        style={{
          height: 140,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--radius-1)',
        }}
      />
    </div>
  );
}

// ── Hero (Solve rate + pipeline) ─────────────────────────────────────────────

function SolveHero({ data }: { data: NetworkResponse }) {
  const attemptsPerTask =
    data.tasksPosted > 0 ? data.attempts / data.tasksPosted : 0;

  return (
    <section
      aria-label="Solve rate"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
        border: '1px solid var(--border-accent)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--bg-elevated)',
        overflow: 'hidden',
      }}
    >
      {/* Left — solve-rate hero */}
      <div
        style={{
          padding: '32px 36px',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--gold-500)',
              color: 'var(--accent-gold)',
              padding: '3px 10px',
              borderRadius: 'var(--radius-pill)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: 'currentColor',
              }}
            />
            Solve rate
          </span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
            }}
          >
            Cumulative
          </span>
        </div>

        <div
          className="data"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-7xl)',
            lineHeight: 0.9,
            color: 'var(--accent-gold)',
            letterSpacing: '-0.01em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {pct(data.resolvedRate)}
        </div>

        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-base)',
            color: 'var(--fg-muted)',
            maxWidth: 460,
            lineHeight: 1.5,
          }}
        >
          Out of{' '}
          <b style={{ color: 'var(--fg)', fontWeight: 500 }}>
            {int(data.tasksPosted)} tasks posted
          </b>
          ,{' '}
          <b style={{ color: 'var(--fg)', fontWeight: 500 }}>
            {int(data.tasksSettled)} settled
          </b>
          {data.tasksRefunded > 0 && (
            <>; {int(data.tasksRefunded)} refunded with no passing solution</>
          )}
          .
        </div>
      </div>

      {/* Right — task pipeline */}
      <div
        style={{
          padding: '28px 32px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg)',
            paddingBottom: 14,
            borderBottom: '1px solid var(--border)',
            marginBottom: 18,
          }}
        >
          Task pipeline
        </div>

        <PipelineStep n="01" label="Posted" value={int(data.tasksPosted)} />
        <PipelineSep />
        <PipelineStep
          n="02"
          label="Attempted"
          value={int(data.attempts)}
          delta={
            attemptsPerTask > 0
              ? `${attemptsPerTask.toFixed(1)}× per task`
              : undefined
          }
        />
        <PipelineSep />
        <PipelineStep n="03" label="Evaluated" value={int(data.verdicts)} />
      </div>
    </section>
  );
}

function PipelineStep({
  n,
  label,
  value,
  delta,
}: {
  n: string;
  label: string;
  value: ReactNode;
  delta?: string;
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            color: 'var(--fg-dim)',
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          {n}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg)',
          }}
        >
          {label}
        </span>
      </div>
      <div
        className="data"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 28,
          lineHeight: 1,
          color: 'var(--fg)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
        {delta && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--vow-green)',
              marginLeft: 10,
              letterSpacing: '0.08em',
            }}
          >
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}

function PipelineSep() {
  return (
    <div
      aria-hidden
      style={{
        height: 22,
        display: 'flex',
        alignItems: 'center',
        color: 'var(--fg-dim)',
        paddingLeft: 6,
        margin: '8px 0',
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M12 5v14M6 13l6 6 6-6" />
      </svg>
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
          v={int(data.distinctOperators)}
          sub="submitting attempts"
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
          Every settled task pays out from the launcher's bond. Operators earn
          for passing solutions; the DAO collects a protocol cut to fund the
          next epoch.
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
      {/* No page header — the chrome's Network tab is the wayfinder, and the
          gold Solve-rate hero leads. Matches the May 15 redesign reference. */}

      {/* Loading state */}
      {isLoading && <SkeletonHero />}

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
          <SolveHero data={data} />
          <ActivityStrip data={data} />
          <EconomyRow data={data} />

          <Card title="What's running">
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
