import { Link } from 'wouter';
import { ActivitySections } from './overview/ActivitySections.js';

/**
 * /overview/activity — the dedicated activity drilldown page.
 *
 * The activity surface itself (In flight + Recent) also renders inline as a
 * primary section on /overview (the Dashboard) — see `ActivitySections`,
 * shared between both placements (issue #219). This page keeps a focused,
 * full-width view of the same surface for operators who want it on its own.
 */

export interface OverviewActivityPageProps {
  /** Override poll interval (tests). */
  pollIntervalMs?: number;
}

export function OverviewActivityPage({
  pollIntervalMs = 5_000,
}: OverviewActivityPageProps = {}): JSX.Element {
  return (
    <main
      data-testid="overview-activity"
      style={{
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        maxWidth: '960px',
        margin: '0 auto',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        <h1
          style={{
            fontFamily: "'Instrument Serif', 'Times New Roman', serif",
            fontSize: '32px',
            fontWeight: 400,
            margin: 0,
            color: 'var(--fg)',
          }}
        >
          Activity
        </h1>
        <Link
          href="/overview"
          data-testid="overview-activity-back"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '11px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--accent-sky)',
            textDecoration: 'none',
          }}
        >
          ← Overview
        </Link>
      </header>

      <ActivitySections pollIntervalMs={pollIntervalMs} />
    </main>
  );
}
