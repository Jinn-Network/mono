/**
 * NetworkView — protocol-wide stats.
 *
 * Gold element: the resolved-rate KPI (one per surface rule).
 * Page headline: Instrument Serif "The ether" — not gold.
 * All numerics: tabular-nums via the data className.
 */

import { useNetwork } from '../lib/api';
import { StatusBar } from '../components/StatusBar';
import { Card } from '../components/Card';
import { Kpi, KpiRow } from '../components/Kpi';
import { HBars } from '../components/HBars';
import { pct, int, block, jinn } from '../lib/format';

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonTile() {
  return (
    <div
      style={{
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          height: 10,
          width: 64,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--radius-1)',
        }}
      />
      <div
        style={{
          height: 24,
          width: 96,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--radius-1)',
        }}
      />
    </div>
  );
}

function SkeletonKpiRow() {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        background: 'var(--bg-elevated)',
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          style={{
            flex: '1 1 140px',
            borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
          }}
        >
          <SkeletonTile />
        </div>
      ))}
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
          The ether
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
          Network
        </div>
      </div>

      {/* Loading state */}
      {isLoading && <SkeletonKpiRow />}

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
          {/* KPI row — resolved-rate is the ONE gold element */}
          <KpiRow>
            <Kpi label="Tasks posted" value={int(data.tasksPosted)} />
            <Kpi label="Settled" value={int(data.tasksSettled)} />
            <Kpi label="Refunded" value={int(data.tasksRefunded)} />
            <Kpi label="Attempts" value={int(data.attempts)} />
            <Kpi
              label="Active operators"
              value={int(data.distinctOperators)}
            />
            <Kpi
              label="SolverNets running"
              value={int(data.solverNetsRunning)}
            />
            <Kpi label="Verdicts" value={int(data.verdicts)} />
            {/* GOLD: the single accent-gold element on this surface */}
            <Kpi
              label="Resolved rate"
              value={pct(data.resolvedRate)}
              accent
            />
            <Kpi
              label="JINN distributed"
              value={jinn(data.jinnDistributedOperator)}
              sub={`DAO: ${jinn(data.jinnDistributedDao)}`}
            />
            <Kpi
              label="Last settlement"
              value={block(data.mostRecentSettlementBlock)}
            />
          </KpiRow>

          {/* Composition cards */}
          <Card title="What's running">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
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
              <HBars
                title="By model"
                data={data.composition.byModel.map((e) => ({
                  label: e.value,
                  value: e.count,
                  share: e.share,
                }))}
              />
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

          {/* Verdict consistency — on-chain code vs off-chain evaluation envelope (ebu7.13).
              Surfaces the daemon-side verdictCode = 1 (Pass) default that makes failed
              evaluations appear as passes on-chain; envelope truth is the headline. */}
          {data.verdictConsistency.total > 0 && (
            <Card title="On-chain vs envelope">
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 32,
                  alignItems: 'baseline',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <div>
                  <div className="label" style={{ color: 'var(--fg-muted)' }}>
                    Envelope-truth resolved
                  </div>
                  <div className="data" style={{ fontSize: 22 }}>{pct(data.resolvedRate)}</div>
                </div>
                <div>
                  <div className="label" style={{ color: 'var(--fg-muted)' }}>
                    On-chain code resolved
                  </div>
                  <div className="data" style={{ fontSize: 22, color: 'var(--fg-muted)' }}>
                    {pct(data.onChainResolvedRate)}
                  </div>
                </div>
                <div>
                  <div className="label" style={{ color: 'var(--fg-muted)' }}>Agreement</div>
                  <div className="data" style={{ fontSize: 22 }}>{pct(data.verdictConsistency.agreementShare)}</div>
                </div>
                <div>
                  <div className="label" style={{ color: 'var(--fg-muted)' }}>Disagreed</div>
                  <div
                    className="data"
                    style={{
                      fontSize: 22,
                      color:
                        data.verdictConsistency.disagreed > 0
                          ? 'var(--break-red)'
                          : 'var(--vow-green)',
                    }}
                  >
                    {int(data.verdictConsistency.disagreed)}
                    {' / '}
                    {int(data.verdictConsistency.total)}
                  </div>
                </div>
              </div>
              <div
                style={{
                  marginTop: 12,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--fg-dim)',
                  maxWidth: 720,
                }}
              >
                The daemon's <span className="data">submitVerdictDelivery</span> default sends
                <span className="data"> verdictCode = 1 (Pass) </span>
                even for failed evaluations, so on-chain pass-rate is artificially high. The
                evaluator's real outcome lives in the off-chain evaluation envelope on IPFS; the
                explorer now indexes it and prefers it where enriched. The headline
                <span className="data"> resolved rate </span>uses envelope truth.
              </div>
            </Card>
          )}

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
