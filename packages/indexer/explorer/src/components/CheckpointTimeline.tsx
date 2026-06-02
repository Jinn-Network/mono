/**
 * CheckpointTimeline — horizontal timeline of model checkpoints.
 *
 * Design:
 *   - Horizontal hairline with ticks positioned linearly across block range
 *   - Each tick shows enriched manifest fields + frozen-eval score on hover tooltip
 *   - verifiedFrozen checkpoints show a "verified-frozen" StatusChip in the tooltip
 *   - enrichmentStatus !== 'ok': show CID + "enrichment pending/failed" caption
 *   - Below: note caption in var(--fg-dim) when non-empty
 *   - 0-1 checkpoints: centered or single placement
 *   - No emoji, no gradients, linear motion
 */

import { useState } from 'react';
import type { CheckpointTimelineEntry } from '../lib/api';
import { StatusChip } from './StatusChip';
import { shortCid, shortAddr, block as blockFmt, pct } from '../lib/format';

export interface CheckpointTimelineData {
  checkpoints: CheckpointTimelineEntry[];
  note: string;
}

export interface CheckpointTimelineProps {
  data: CheckpointTimelineData;
}

interface TooltipState {
  x: number;
  y: number;
  entry: CheckpointTimelineEntry;
}

/** Signed percentage for a held-out delta, e.g. +12.0% / -20.0% / 0.0%. */
function signedPct(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${pct(delta)}`;
}

/** Improvement → success, regression → danger, no change → muted. */
function deltaColor(delta: number): string {
  if (delta > 0) return 'var(--success)';
  if (delta < 0) return 'var(--danger)';
  return 'var(--fg-dim)';
}

export function CheckpointTimeline({ data }: CheckpointTimelineProps) {
  const { checkpoints, note } = data;
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  if (checkpoints.length === 0) {
    return (
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-dim)',
        }}
      >
        No published checkpoints yet.
        {note && (
          <div style={{ marginTop: 8, color: 'var(--fg-dim)' }}>{note}</div>
        )}
      </div>
    );
  }

  // Compute block range for linear positioning
  const blocks = checkpoints.map((cp) => Number(cp.publishedAtBlock));
  const minBlock = Math.min(...blocks);
  const maxBlock = Math.max(...blocks);
  const range = maxBlock - minBlock || 1;

  function xPct(cp: CheckpointTimelineEntry): number {
    if (checkpoints.length === 1) return 50;
    return ((Number(cp.publishedAtBlock) - minBlock) / range) * 100;
  }

  // Tick accent: 'ok' = accent, 'failed' = wane, 'pending' = fg-dim
  function tickColor(status: string): string {
    if (status === 'ok') return 'var(--accent)';
    if (status === 'failed') return 'var(--wane)';
    return 'var(--fg-dim)';
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Timeline track */}
      <div
        style={{
          position: 'relative',
          height: 48,
          marginBottom: 12,
        }}
      >
        {/* Horizontal hairline */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: 1,
            background: 'var(--border)',
          }}
        />

        {/* Ticks */}
        {checkpoints.map((cp, i) => {
          const xPos = xPct(cp);
          const color = tickColor(cp.enrichmentStatus ?? 'pending');
          return (
            <div
              key={cp.cid + i}
              role="button"
              tabIndex={0}
              aria-label={`Checkpoint ${shortCid(cp.cid)} at block ${blockFmt(cp.publishedAtBlock)}`}
              style={{
                position: 'absolute',
                top: '50%',
                left: `${xPos}%`,
                transform: 'translate(-50%, -50%)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltip({
                  x: rect.left + rect.width / 2,
                  y: rect.top,
                  entry: cp,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
              onFocus={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltip({
                  x: rect.left + rect.width / 2,
                  y: rect.top,
                  entry: cp,
                });
              }}
              onBlur={() => setTooltip(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setTooltip(null);
              }}
            >
              {/* Tick mark */}
              <div
                style={{
                  width: 10,
                  height: 10,
                  border: `1px solid ${color}`,
                  borderRadius: 'var(--radius-1)',
                  background: 'var(--bg-elevated)',
                  transition: `background var(--dur-fast) var(--ease-linear)`,
                }}
              />
              {/* Block label below */}
              <div
                style={{
                  position: 'absolute',
                  top: 14,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--fg-dim)',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.06em',
                }}
              >
                {blockFmt(cp.publishedAtBlock)}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tooltip — fixed to viewport */}
      {tooltip && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y - 8,
            transform: 'translate(-50%, -100%)',
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-2)',
            padding: '8px 12px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--fg)',
            pointerEvents: 'none',
            zIndex: 'var(--z-overlay)' as unknown as number,
            boxShadow: 'var(--shadow-float)',
            lineHeight: 1.6,
            minWidth: 180,
          }}
        >
          {/* CID (always shown) */}
          <div style={{ color: 'var(--accent)', marginBottom: 2 }}>
            {shortCid(tooltip.entry.cid)}
          </div>

          {/* Agent */}
          <div style={{ color: 'var(--fg-muted)' }}>
            {shortAddr(tooltip.entry.agentId)}
          </div>

          {/* Block */}
          <div style={{ color: 'var(--fg-dim)', marginTop: 2 }}>
            Block {blockFmt(tooltip.entry.publishedAtBlock)}
          </div>

          {/* Enriched fields */}
          {tooltip.entry.enrichmentStatus === 'ok' ? (
            <>
              {/* name + version */}
              {(tooltip.entry.name || tooltip.entry.implName) && (
                <div style={{ marginTop: 6, color: 'var(--fg)' }}>
                  {tooltip.entry.name || tooltip.entry.implName}
                  {tooltip.entry.version ? ` v${tooltip.entry.version}` : ''}
                </div>
              )}

              {/* codeDigest */}
              {tooltip.entry.codeDigest && (
                <div style={{ color: 'var(--fg-dim)', fontSize: 10, marginTop: 2 }}>
                  {shortCid(tooltip.entry.codeDigest, 12, 8)}
                </div>
              )}

              {/* frozenResolvedRate */}
              {tooltip.entry.frozenResolvedRate !== null && (
                <div style={{ marginTop: 4, color: 'var(--fg-muted)' }}>
                  frozen eval: {pct(tooltip.entry.frozenResolvedRate)}
                </div>
              )}

              {/* held-out delta vs parent (#820 AC#2) — slate-scoped both sides */}
              {tooltip.entry.heldOutDelta !== null && (
                <div style={{ marginTop: 2, color: deltaColor(tooltip.entry.heldOutDelta) }}>
                  held-out vs parent: {signedPct(tooltip.entry.heldOutDelta)}
                </div>
              )}

              {/* verifiedFrozen badge */}
              {tooltip.entry.verifiedFrozen && (
                <div style={{ marginTop: 6 }}>
                  <StatusChip kind="ok" label="verified-frozen" />
                </div>
              )}
            </>
          ) : (
            /* enrichment pending/failed caption */
            <div
              style={{
                marginTop: 6,
                color: tooltip.entry.enrichmentStatus === 'failed'
                  ? 'var(--wane)'
                  : 'var(--fg-dim)',
                fontSize: 10,
              }}
            >
              enrichment {tooltip.entry.enrichmentStatus ?? 'pending'}
            </div>
          )}
        </div>
      )}

      {/* Note caption — only shown when non-empty */}
      {note && (
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-dim)',
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {note}
        </div>
      )}
    </div>
  );
}
