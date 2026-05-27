/**
 * LearningCurve — uPlot-based resolved-rate chart.
 *
 * Design:
 *   - Single sky line (#7aa7dc, 1px stroke) over a transparent plot
 *   - y-axis 0..1 formatted as 0%..100% ticks
 *   - x-axis = task index (rolling) or block number (buckets)
 *   - Dotted hairline gridlines (stroke: var(--border), dashed)
 *   - Caps-mono axis labels (11px JetBrains Mono)
 *   - No point markers, no fill, no glow
 *   - Resize-aware via ResizeObserver
 *   - uPlot instance cleaned up on unmount (no leaks)
 *   - Guarded against jsdom / no-DOM environments
 */

import { useRef, useEffect, useState } from 'react';
// uPlot uses `export =` (CommonJS default), so we import the type separately
// and do a dynamic import to avoid SSR/jsdom issues with canvas.
import type uPlotType from 'uplot';
import type { LearningCurveBucket } from '../lib/api';
import { block } from '../lib/format';

// Import uPlot CSS once here
import 'uplot/dist/uPlot.min.css';

export interface LearningCurveSeries {
  rolling: number[];
  label: string;
  color: string;
}

export interface LearningCurveProps {
  buckets: LearningCurveBucket[];
  rolling: number[];
  mode: 'rolling' | 'buckets';
  height?: number;
  /**
   * Optional multi-series payload. When provided with >= 2 entries, the chart
   * renders up to 5 series with distinct stroke colors plus a legend below.
   * When absent or with a single entry, falls back to the canonical single-line
   * rendering driven by the `rolling`/`buckets` props.
   *
   * No protocol-emphasis gold per BRAND.md One-Voice Rule.
   */
  series?: LearningCurveSeries[];
  /**
   * Optional click handler on legend items. When present (and the chart is
   * rendering a multi-series legend), each legend item becomes a `<button>`
   * that fires this handler with the series label. When absent, legend items
   * stay as inert `<span>`s. Lets the view tie chart clicks to URL-state
   * filters without the chart owning URL state.
   */
  onLegendClick?: (label: string) => void;
}

const SKY = '#7aa7dc';
const FONT_MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

// Up-to-5 series palette: sky / sky-muted / sage / rose / lilac. Series
// colors never use gold — gold remains reserved as single-point emphasis
// per the Gold-as-Hint Rule (spec §5.3) and BRAND.md One-Voice Rule.
const SERIES_COLORS = [SKY, '#6b9fc5', '#76c1a4', '#c47fa8', '#a89dd6'];
const MAX_SERIES = 5;

function buildOpts(
  width: number,
  height: number,
  mode: 'rolling' | 'buckets',
  buckets: LearningCurveBucket[],
  seriesCount: number,
  seriesColors: string[],
): object {
  const lineSeries = Array.from({ length: seriesCount }, (_, i) => ({
    stroke: seriesColors[i] ?? SKY,
    width: 1.5,
    points: { show: false },
    fill: undefined,
  }));
  return {
    width,
    height,
    padding: [12, 8, 0, 4],
    cursor: { show: false },
    legend: { show: false },
    series: [{}, ...lineSeries],
    axes: [
      {
        // x-axis
        font: `11px ${FONT_MONO}`,
        stroke: '#7d8ba3',
        ticks: { stroke: '#1f3a66', width: 1 },
        grid: { stroke: '#1f3a66', width: 1, dash: [4, 4] },
        values: (_self: unknown, ticks: number[]) =>
          ticks.map((t) => {
            if (mode === 'buckets') {
              // t is the bucket index, map back to block
              const idx = Math.round(t);
              const bkt = buckets[idx];
              return bkt ? block(bkt.bucketStartBlock) : '';
            }
            return String(Math.round(t));
          }),
      },
      {
        // y-axis
        font: `11px ${FONT_MONO}`,
        stroke: '#7d8ba3',
        ticks: { stroke: '#1f3a66', width: 1 },
        grid: { stroke: '#1f3a66', width: 1, dash: [4, 4] },
        values: (_self: unknown, ticks: number[]) =>
          ticks.map((t) => `${Math.round(t * 100)}%`),
        scale: 'y',
      },
    ],
    scales: {
      x: { auto: true },
      y: { auto: false, range: [0, 1] },
    },
  };
}

export function LearningCurve({
  buckets,
  rolling,
  mode,
  height = 220,
  series,
  onLegendClick,
}: LearningCurveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<unknown>(null);

  // Hover state — tracks which legend entry is currently hovered/focused so
  // we can surface the "→ filter to this" hint on the active entry only.
  // Pattern A (inline state + opacity) matches Leaderboard.tsx — this file
  // uses no CSS rules, only inline styles.
  const [hoveredLegend, setHoveredLegend] = useState<number | null>(null);

  // Resolve effective multi-series payload. When `series` is provided with
  // >= 2 entries, we override the single-line rendering. Otherwise we keep
  // the canonical single-series rolling/buckets behaviour.
  const effectiveSeries = series && series.length >= 2 ? series.slice(0, MAX_SERIES) : null;

  useEffect(() => {
    // Guard: jsdom / SSR has no proper canvas support
    if (
      typeof document === 'undefined' ||
      typeof window === 'undefined' ||
      !containerRef.current
    ) {
      return;
    }

    // Build the data series
    let xs: number[];
    let yseries: (number | null)[][];
    let colors: string[];

    if (effectiveSeries) {
      // Multi-series rolling — xs is the index range of the longest series;
      // shorter series are padded with null so uPlot anchors to the same axis.
      const longest = Math.max(...effectiveSeries.map((s) => s.rolling.length));
      xs = Array.from({ length: longest }, (_, i) => i);
      yseries = effectiveSeries.map((s) => {
        const padded: (number | null)[] = Array.from({ length: longest }, (_, i) =>
          i < s.rolling.length ? s.rolling[i] ?? null : null,
        );
        return padded;
      });
      colors = effectiveSeries.map((s) => s.color);
    } else if (mode === 'buckets') {
      xs = buckets.map((_, i) => i);
      yseries = [buckets.map((b) => b.rate)];
      colors = [SKY];
    } else {
      xs = rolling.map((_, i) => i);
      yseries = [rolling];
      colors = [SKY];
    }

    if (xs.length === 0) {
      return;
    }

    const w = containerRef.current.clientWidth || 600;

    // Guard against React StrictMode double-invoke: if cleanup runs before the
    // async import resolves, we must not construct (or must immediately destroy)
    // the orphaned uPlot instance.
    let cancelled = false;

    // Using a local alias to hold the constructor after dynamic import
    let UPlot: (typeof uPlotType) | undefined;
    let instance: unknown;

    async function init() {
      try {
        const mod = await import('uplot');

        // StrictMode / fast-refresh safety: bail if the effect was cleaned up
        // while the dynamic import was in-flight.
        if (cancelled || !containerRef.current) return;

        // uPlot uses `export =` — the constructor is either at mod or mod.default
        // depending on the bundler. We cast to handle both.
        UPlot = (mod as unknown as { default?: typeof uPlotType }).default
          ?? (mod as unknown as typeof uPlotType);

        const opts = buildOpts(w, height, mode, buckets, yseries.length, colors);

        instance = new UPlot(
          opts as uPlotType.Options,
          [xs, ...yseries] as unknown as uPlotType.AlignedData,
          containerRef.current,
        );

        // Check again: cleanup may have run between construction and assignment.
        if (cancelled) {
          try {
            (instance as { destroy?: () => void }).destroy?.();
          } catch (_e) {
            // ignore
          }
          return;
        }

        plotRef.current = instance;
      } catch (_e) {
        // Silently skip in environments where uPlot can't render (jsdom, canvas-less)
      }
    }

    void init();

    // ResizeObserver for width updates
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || !plotRef.current) return;
        const newW = entry.contentRect.width;
        if (newW > 0) {
          try {
            (plotRef.current as { setSize: (s: { width: number; height: number }) => void }).setSize({ width: newW, height });
          } catch (_e) {
            // ignore
          }
        }
      });
      if (containerRef.current) {
        ro.observe(containerRef.current);
      }
    }

    return () => {
      // Signal the async init not to construct (or to immediately destroy) the instance.
      cancelled = true;
      ro?.disconnect();
      try {
        (plotRef.current as { destroy?: () => void } | null)?.destroy?.();
      } catch (_e) {
        // ignore
      }
      plotRef.current = null;
      // Clear the container children to avoid double-mount in strict mode
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, rolling, mode, height, effectiveSeries]);

  const isEmpty = effectiveSeries
    ? effectiveSeries.every((s) => s.rolling.length === 0)
    : mode === 'buckets'
      ? buckets.length === 0
      : rolling.length === 0;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {isEmpty ? (
        <div
          style={{
            height,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--fg-dim)',
            letterSpacing: '0.08em',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
          }}
        >
          No data yet
        </div>
      ) : (
        <div
          ref={containerRef}
          style={{ width: '100%' }}
          data-testid="learning-curve-plot"
        />
      )}
      {effectiveSeries && (
        <div
          data-testid="learning-curve-legend"
          style={{
            marginTop: 8,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          {effectiveSeries.map((s, i) => {
            const content = (
              <>
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 10,
                    height: 2,
                    background: s.color,
                  }}
                />
                {s.label}
              </>
            );
            const key = `${i}:${s.label}`;
            if (onLegendClick) {
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onLegendClick(s.label)}
                  onMouseEnter={() => setHoveredLegend(i)}
                  onMouseLeave={() =>
                    setHoveredLegend((prev) => (prev === i ? null : prev))
                  }
                  onFocus={() => setHoveredLegend(i)}
                  onBlur={() =>
                    setHoveredLegend((prev) => (prev === i ? null : prev))
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    letterSpacing: 'inherit',
                    textTransform: 'inherit',
                    color: 'inherit',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                >
                  {content}
                  <span
                    data-hover-hint="true"
                    className="legend-hover-hint"
                    style={{
                      marginLeft: 6,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 8,
                      letterSpacing: '0.04em',
                      color: 'var(--fg-dim)',
                      opacity: hoveredLegend === i ? 1 : 0,
                      transition: 'opacity 80ms linear',
                      pointerEvents: 'none',
                    }}
                  >
                    → filter to this
                  </span>
                </button>
              );
            }
            return (
              <span
                key={key}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {content}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Exported for callers that want to consume the canonical series palette. */
export const LEARNING_CURVE_SERIES_COLORS = SERIES_COLORS;
