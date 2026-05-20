import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { api } from '../../api/client.js';

/**
 * Live-now pulse band for operator activity surfaces. Replaces the static "Node Status" tile
 * and the conditional AlertBand with a single present-tense band that
 * classifies the daemon into one of four states:
 *
 *   bootstrapping > attention > working > idle (priority order; first match)
 *
 * Reads from /v1/status (cached against the existing ['status'] queryKey
 * used by Overview/HeroStats so we don't double-poll).
 *
 * The band's non-attention CTA points operators at the activity surface.
 * Since issue #219 that surface is a primary section on the Dashboard
 * (/overview); the dedicated /overview/activity page is a focused drilldown.
 * The `activity` prop selects where the band points: on /operator (Settings)
 * it points at the Dashboard so Settings doesn't read as the home for
 * activity; on the activity drilldown it stays on /overview/activity.
 *
 * Attention trigger mirrors today's AlertBand: first error-severity
 * diagnostic from operator.diagnostics, excluding `prediction_solvernet_disabled`.
 * When multiple diagnostics exist, the band shows the highest-priority one
 * + an "N more" pill that links into the same activity surface.
 */

const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED']);

/** Where the band's non-attention CTA + the "N more" pill point. */
export interface ActivityTarget {
  href: string;
  label: string;
}

/** Dashboard activity surface — the canonical home for live activity (#219). */
export const ACTIVITY_TARGET_DASHBOARD: ActivityTarget = {
  href: '/overview',
  label: 'View on Dashboard',
};

/** The dedicated /overview/activity drilldown. */
export const ACTIVITY_TARGET_DRILLDOWN: ActivityTarget = {
  href: '/overview/activity',
  label: 'View activity',
};

export type LiveNowState = 'bootstrapping' | 'attention' | 'working' | 'idle';

export interface LiveNowDerived {
  state: LiveNowState;
  line: string;
  meta: string;
  /** Primary right-side link for the current state. In attention this is the
   *  fix-it action (e.g. `Configure SolverNet`); in the other three states it
   *  is the activity CTA (label/href from the `ActivityTarget`). The action
   *  that's most likely to help operators resolve what they're looking at
   *  wins the right-side slot. */
  cta: { label: string; href: string };
  /** Attention-only: number of additional diagnostics beyond the one shown.
   *  Renders as a small pill linking into the activity surface so the
   *  operator can see the full list. */
  attentionMore?: number;
}

export interface LiveNowStatusInput {
  fleet?: {
    services?: Array<{ index: number; step: string }>;
  };
  activity?: {
    recent?: Array<{ ts: string | null; kind: string }>;
  };
  taskRuns?: {
    totals?: { activeTaskRuns?: number };
    inFlight?: LiveTaskRun[];
    recentTasks?: LiveTaskRun[];
  };
  predictionV1?: {
    operator?: {
      diagnostics?: Array<{
        code: string;
        severity: string;
        message: string;
        configField?: string;
      }>;
    };
    totals?: { activeTaskRuns?: number };
    recentTasks?: LiveTaskRun[];
  };
}

const SERVICE_COMPLETE_STEPS = new Set(['complete', 'safe_binding_pending']);

interface LiveTaskRun {
  state: string;
  taskRole: 'restoration' | 'evaluation' | null;
  stateUpdatedAt: number;
}

function diagnosticHref(diagnostic: { code: string; configField?: string }): string {
  // Harness-related diagnostics belong on /operator → SolverNets → Joined,
  // where each joined SolverNet exposes a per-net harness/plugins/model
  // editor (see JoinedNetCard). The global #harness section is mode-only
  // (train/frozen) and can't resolve "this harness doesn't support
  // <solverType>" — that's a per-SolverNet concern.
  //
  // v1 routes to the section root; deep-linking to a specific manifestCid
  // is gated on the legacy diagnostic emitter learning the joinedSolverNets
  // mapping, which is out of scope for this change. Follow-up: thread
  // manifestCid through `PredictionOperatorDiagnostic` and route to
  // `/operator#solvernets/<cid>/harness`.
  if (diagnostic.code.includes('harness')) {
    return '/operator#solvernets';
  }
  if (diagnostic.configField) {
    return `/operator#solvernets`;
  }
  return '/operator#solvernets';
}

function diagnosticCtaLabel(diagnostic: { code: string }): string {
  if (diagnostic.code.includes('harness')) return 'Configure SolverNet';
  return 'Configure SolverNet';
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${Math.round(ms / 3_600_000)}h`;
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 16);
}

function summarizeStages(tasks: readonly LiveTaskRun[] | undefined): { line: string; longestMs: number } {
  const inFlight = (tasks ?? []).filter((t) => !TERMINAL_STATES.has(t.state));
  const restoring = inFlight.filter((t) => t.taskRole === 'restoration').length;
  const evaluating = inFlight.filter((t) => t.taskRole === 'evaluation').length;
  const total = inFlight.length;
  const longestMs = inFlight.length === 0
    ? 0
    : Date.now() - Math.min(...inFlight.map((t) => t.stateUpdatedAt));

  let line: string;
  if (restoring > 0 && evaluating > 0) {
    line = `${restoring} restoring · ${evaluating} evaluating`;
  } else if (restoring > 0) {
    line = `${restoring} ${restoring === 1 ? 'task' : 'tasks'} restoring`;
  } else if (evaluating > 0) {
    line = `${evaluating} ${evaluating === 1 ? 'task' : 'tasks'} evaluating`;
  } else {
    line = `${total} ${total === 1 ? 'task' : 'tasks'} in flight`;
  }
  return { line, longestMs };
}

/**
 * `true` when the operator has at least one joined SolverNet. The daemon's
 * diagnostic pipeline already gates `prediction_solvernet_missing` on this
 * (#239), but the daemon only re-reads `joinedSolverNets` on restart — so a
 * stale `prediction_solvernet_missing` diagnostic survives in the live status
 * payload between a successful join and the next restart. `deriveLiveNow`
 * gates the banner on the SPA's freshly-polled `joinedSolverNets` map so the
 * attention banner clears the moment the join lands (#333).
 */
function hasJoinedSolverNet(
  joinedSolverNets: Record<string, unknown> | undefined,
): boolean {
  return Boolean(joinedSolverNets) && Object.keys(joinedSolverNets!).length > 0;
}

export function deriveLiveNow(
  status: LiveNowStatusInput | undefined,
  joinedSolverNets?: Record<string, unknown>,
  activity: ActivityTarget = ACTIVITY_TARGET_DRILLDOWN,
): LiveNowDerived {
  // `ActivityTarget` is structurally the `cta` shape, so the band's
  // non-attention CTA is the activity target verbatim.
  const viewActivityCta = activity;

  // Bootstrapping: any service not at a complete-equivalent step.
  const services = status?.fleet?.services ?? [];
  if (services.length > 0) {
    const completeCount = services.filter((s) => SERVICE_COMPLETE_STEPS.has(s.step)).length;
    if (completeCount < services.length) {
      const nextStep = services.find((s) => !SERVICE_COMPLETE_STEPS.has(s.step))?.step ?? '—';
      return {
        state: 'bootstrapping',
        line: `${completeCount}/${services.length} services complete`,
        meta: `next: ${nextStep}`,
        cta: viewActivityCta,
      };
    }
  }

  // Attention: first error-severity diagnostic (mirrors today's AlertBand).
  // Right-side CTA is the diagnostic's fix-it action (`Configure harness`,
  // `Configure prediction`, etc.) — the operator goes there to resolve, not
  // to /overview/activity. The `N more` pill (when set) handles "see all
  // current attentions" by linking into the activity page.
  //
  // `prediction_solvernet_missing` is additionally suppressed once the
  // operator has a joined SolverNet — the live status payload can carry a
  // stale copy until the daemon restarts and re-reads `joinedSolverNets`
  // (#333). Gating on the SPA's freshly-polled join map keeps the "No active
  // SolverNet configured" banner from contradicting the joined list.
  const operatorHasJoined = hasJoinedSolverNet(joinedSolverNets);
  const diagnostics = (status?.predictionV1?.operator?.diagnostics ?? []).filter(
    (d) =>
      d.severity === 'error' &&
      d.code !== 'prediction_solvernet_disabled' &&
      !(d.code === 'prediction_solvernet_missing' && operatorHasJoined),
  );
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    const more = diagnostics.length - 1;
    return {
      state: 'attention',
      line: first.message,
      meta: '',
      cta: { label: diagnosticCtaLabel(first), href: diagnosticHref(first) },
      ...(more > 0 ? { attentionMore: more } : {}),
    };
  }

  // Working: any in-flight task runs, regardless of SolverNet.
  const taskRunStatus = status?.taskRuns;
  const activeCount = taskRunStatus?.totals?.activeTaskRuns ?? status?.predictionV1?.totals?.activeTaskRuns ?? 0;
  if (activeCount > 0) {
    const genericInFlight = taskRunStatus?.inFlight ?? taskRunStatus?.recentTasks;
    const summary = summarizeStages(genericInFlight ?? status?.predictionV1?.recentTasks);
    return {
      state: 'working',
      line: summary.line,
      meta: summary.longestMs > 0 ? `longest in flight ${formatElapsed(summary.longestMs)}` : '',
      cta: viewActivityCta,
    };
  }

  // Idle: no in-flight tasks, no diagnostics, fleet healthy.
  const lastTs = (status?.activity?.recent ?? [])
    .map((e) => e.ts)
    .filter((ts): ts is string => Boolean(ts))
    .sort()
    .at(-1);
  return {
    state: 'idle',
    line: 'waiting for next task',
    meta: lastTs ? `idle since ${formatTimeOfDay(lastTs)}` : '',
    cta: viewActivityCta,
  };
}

export const LIVE_NOW_TONE: Record<LiveNowState, { dot: string; eyebrow: string; border: string }> = {
  bootstrapping: { dot: 'var(--accent-sky)', eyebrow: 'Now · Bootstrapping', border: 'var(--border)' },
  attention: { dot: 'var(--break-red)', eyebrow: 'Now · Needs attention', border: 'var(--border-accent)' },
  working: { dot: 'var(--vow-green)', eyebrow: 'Now · Live', border: 'var(--border)' },
  idle: { dot: 'var(--fg-muted)', eyebrow: 'Now · Live', border: 'var(--border)' },
};

export const LIVE_NOW_STATE_LABEL: Record<LiveNowState, string> = {
  bootstrapping: 'BOOTSTRAPPING',
  attention: 'ATTENTION',
  working: 'WORKING',
  idle: 'IDLE',
};

interface BootstrapWithJoined {
  joinedSolverNets?: Record<string, unknown>;
}

export interface LiveNowBandProps {
  /**
   * Where the band's activity links point. Defaults to the dedicated
   * /overview/activity drilldown. /operator passes `ACTIVITY_TARGET_DASHBOARD`
   * so Settings points at the Dashboard rather than reading as the home for
   * activity (#219).
   */
  activity?: ActivityTarget;
}

export function LiveNowBand({
  activity = ACTIVITY_TARGET_DRILLDOWN,
}: LiveNowBandProps = {}): JSX.Element {
  const { data } = useQuery<LiveNowStatusInput>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<LiveNowStatusInput>,
    refetchInterval: 5_000,
  });
  // Bootstrap carries the operator's joined-SolverNet map. Sharing the
  // ['bootstrap'] query key with Overview/Operator avoids a double-poll;
  // the join flow invalidates ['operator', 'joined'] but the bootstrap
  // refetch interval picks the map change up within 30s either way.
  const { data: bootstrap } = useQuery<BootstrapWithJoined>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap() as Promise<BootstrapWithJoined>,
    refetchInterval: 30_000,
  });
  const derived = deriveLiveNow(data, bootstrap?.joinedSolverNets, activity);
  const tone = LIVE_NOW_TONE[derived.state];
  const stateLabel = LIVE_NOW_STATE_LABEL[derived.state];

  return (
    <section
      data-testid="live-now-band"
      data-state={derived.state}
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${tone.border}`,
        borderRadius: '10px',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '16px',
        }}
      >
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
          }}
        >
          {tone.eyebrow}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {derived.attentionMore !== undefined && (
            <Link
              href={activity.href}
              data-testid="live-now-attention-more"
              style={{
                fontSize: '10px',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--accent-gold)',
                border: '1px solid var(--border-accent)',
                borderRadius: '4px',
                padding: '2px 8px',
                textDecoration: 'none',
              }}
            >
              {derived.attentionMore} more
            </Link>
          )}
          <Link
            href={derived.cta.href}
            data-testid="live-now-cta"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: '30px',
              fontSize: '11px',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: derived.state === 'attention' ? 'var(--bg-sunken)' : 'var(--accent-sky)',
              background: derived.state === 'attention' ? 'var(--accent-sky)' : 'transparent',
              border: '1px solid var(--accent-sky)',
              borderRadius: 'var(--radius-2)',
              padding: '0 12px',
              textDecoration: 'none',
            }}
          >
            {derived.cta.label} →
          </Link>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
        <span
          aria-hidden="true"
          style={{
            color: tone.dot,
            fontSize: '18px',
            lineHeight: 1,
          }}
        >
          ●
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: 1 }}>
          <span
            data-testid="live-now-line"
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, SF Mono, Menlo, monospace",
              fontSize: '14px',
              fontWeight: 500,
              color: 'var(--fg)',
              lineHeight: 1.45,
              wordBreak: 'break-word',
              letterSpacing: 0,
            }}
          >
            <span
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--fg-muted)',
                marginRight: '10px',
                letterSpacing: '0.12em',
              }}
            >
              {stateLabel}
            </span>
            {derived.line}
          </span>
          {derived.meta && (
            <span
              data-testid="live-now-meta"
              style={{ fontSize: '12px', color: 'var(--fg-muted)' }}
            >
              {derived.meta}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
