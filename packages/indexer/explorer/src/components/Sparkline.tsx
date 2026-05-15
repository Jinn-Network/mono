/**
 * Sparkline — a tiny hand-rolled SVG line chart for trend visualisation.
 *
 * Design (ebu7.7):
 *   - 1px stroke in var(--accent-sky) (default) or the `color` prop
 *   - No fill, no axes, no grid, no points
 *   - A tiny 2px dot on the last data point for visual anchor
 *   - Empty or single-point data → renders nothing (null)
 *   - Values auto-scaled to min..max of the series
 *   - Pure SVG, no deps
 */

export interface SparklineProps {
  /** Data values — any range; auto-scaled min..max within the component. */
  data: number[];
  /** SVG width in px. Default 64. */
  width?: number;
  /** SVG height in px. Default 18. */
  height?: number;
  /** Stroke colour. Default var(--accent-sky). */
  color?: string;
}

/**
 * Maps a value in [domainMin, domainMax] to a pixel coordinate in [0, size].
 * When the domain is flat (all values equal) the line is drawn at the vertical
 * midpoint.
 */
function scaleY(value: number, min: number, max: number, height: number): number {
  if (max === min) return height / 2;
  // SVG y=0 is top; invert so high values go up.
  return height - ((value - min) / (max - min)) * height;
}

export function Sparkline({
  data,
  width = 64,
  height = 18,
  color = 'var(--accent-sky)',
}: SparklineProps): React.ReactElement | null {
  // Need at least 2 points to draw a line.
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);

  const stepX = width / (data.length - 1);

  // Build polyline points string.
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = scaleY(v, min, max, height);
      return `${x},${y}`;
    })
    .join(' ');

  // Last point coordinates for the terminal dot.
  const lastX = (data.length - 1) * stepX;
  const lastY = scaleY(data[data.length - 1], min, max, height);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Terminal dot for visual anchor */}
      <circle cx={lastX} cy={lastY} r={1.5} fill={color} />
    </svg>
  );
}
