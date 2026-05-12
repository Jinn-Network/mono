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

import { useRef, useEffect } from 'react';
// uPlot uses `export =` (CommonJS default), so we import the type separately
// and do a dynamic import to avoid SSR/jsdom issues with canvas.
import type uPlotType from 'uplot';
import type { LearningCurveBucket } from '../lib/api';
import { block } from '../lib/format';

// Import uPlot CSS once here
import 'uplot/dist/uPlot.min.css';

export interface LearningCurveProps {
  buckets: LearningCurveBucket[];
  rolling: number[];
  mode: 'rolling' | 'buckets';
  height?: number;
}

const SKY = '#7aa7dc';
const FONT_MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

function buildOpts(
  width: number,
  height: number,
  mode: 'rolling' | 'buckets',
  buckets: LearningCurveBucket[],
): object {
  return {
    width,
    height,
    padding: [12, 8, 0, 4],
    cursor: { show: false },
    legend: { show: false },
    series: [
      {},
      {
        stroke: SKY,
        width: 1.5,
        points: { show: false },
        fill: undefined,
      },
    ],
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
}: LearningCurveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<unknown>(null);

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
    let ys: (number | null)[];

    if (mode === 'buckets') {
      xs = buckets.map((_, i) => i);
      ys = buckets.map((b) => b.rate);
    } else {
      xs = rolling.map((_, i) => i);
      ys = rolling;
    }

    if (xs.length === 0) {
      return;
    }

    const w = containerRef.current.clientWidth || 600;

    // Using a local alias to hold the constructor after dynamic import
    let UPlot: (typeof uPlotType) | undefined;
    let instance: unknown;

    async function init() {
      try {
        const mod = await import('uplot');
        // uPlot uses `export =` — the constructor is either at mod or mod.default
        // depending on the bundler. We cast to handle both.
        UPlot = (mod as unknown as { default?: typeof uPlotType }).default
          ?? (mod as unknown as typeof uPlotType);

        const opts = buildOpts(w, height, mode, buckets);

        instance = new UPlot(
          opts as uPlotType.Options,
          [xs as number[], ys as number[]],
          containerRef.current!,
        );
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
  }, [buckets, rolling, mode, height]);

  const isEmpty =
    mode === 'buckets' ? buckets.length === 0 : rolling.length === 0;

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
    </div>
  );
}
