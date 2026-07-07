/**
 * Milestone2GateCard — a discrete PASS / NOT-YET readout of the #647 gate.
 *
 * Complements the chart's milestone chrome (SliceChrome.ChartWithMilestoneMark):
 * the chart draws the trailing curve + the lifetime-rate reference line, while
 * this card states the literal #647 condition — trailing-30 now vs the
 * trailing-30 rate at t-99, against the +10pp gate and the 130-verdict floor.
 *
 * Pure presentation: the caller fetches the M2-pinned slice (harness=codex,
 * model=gpt-5.4-mini, window=30) and passes the computed gate in. No emoji,
 * no gradients; status colour lives on the StatusChip + the signed delta only,
 * so the one-gold-per-surface headline stays unique.
 */

import { Card } from './Card';
import { StatusChip } from './StatusChip';
import { Kpi, KpiRow } from './Kpi';
import { pct, int } from '../lib/format';
import type { Milestone2Gate } from '../lib/milestone2';

const CARD_TITLE = 'Milestone 2 — solvers improving';

function signedPp(deltaPp: number): string {
  return `${deltaPp >= 0 ? '+' : '−'}${Math.abs(deltaPp).toFixed(1)}pp`;
}

function SkeletonBlock() {
  return (
    <div
      data-testid="m2-skeleton"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3)',
        height: 120,
        padding: 24,
      }}
    />
  );
}

export interface Milestone2GateCardProps {
  gate: Milestone2Gate | null;
  loading?: boolean;
}

export function Milestone2GateCard({ gate, loading }: Milestone2GateCardProps) {
  if (loading) return <SkeletonBlock />;
  if (!gate) return null;

  // Ineligible — below the 130-verdict floor: no delta to show yet.
  if (gate.status === 'ineligible') {
    return (
      <Card title={CARD_TITLE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <StatusChip kind="unknown" label="Awaiting verdicts" />
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-muted)',
              lineHeight: 1.5,
            }}
          >
            Needs {int(gate.floor)} envelope-enriched verdicts at codex +
            gpt-5.4-mini to evaluate the gate · have {int(gate.verdicts)}.
          </div>
        </div>
      </Card>
    );
  }

  const pass = gate.status === 'pass';
  const deltaColor = pass ? 'var(--vow-green)' : 'var(--wane)';

  return (
    <Card title={CARD_TITLE}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <StatusChip
            kind={pass ? 'ok' : 'pending'}
            label={pass ? 'PASS' : 'NOT YET'}
          />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              color: 'var(--fg-muted)',
              lineHeight: 1.5,
            }}
          >
            Trailing-30 verdict-success is{' '}
            <span style={{ color: deltaColor }}>{signedPp(gate.deltaPp!)}</span>{' '}
            vs its value 99 verdicts ago (gate: +{gate.gatePp.toFixed(1)}pp).
          </span>
        </div>

        <KpiRow>
          <Kpi label="Trailing-30 now" value={pct(gate.current)} />
          <Kpi label="At t − 99" value={pct(gate.baseline)} />
          <Kpi
            label="Delta"
            value={<span style={{ color: deltaColor }}>{signedPp(gate.deltaPp!)}</span>}
            sub={`gate +${gate.gatePp.toFixed(1)}pp`}
          />
          <Kpi label="Verdicts" value={`${int(gate.verdicts)} / ${int(gate.floor)}`} />
        </KpiRow>
      </div>
    </Card>
  );
}
