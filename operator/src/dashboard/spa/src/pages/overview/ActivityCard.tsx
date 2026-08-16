import { useMemo, useState, type JSX } from 'react';
import { useLocation } from 'wouter';
import { Activity as ActivityIcon, ListTree, Pencil, Plus } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { Separator } from '../../components/ui/separator.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip.js';
import { cn } from '../../lib/utils.js';

/**
 * Activity — the operator's view of their node's work.
 *
 * One `<Card>` with three sibling div sections inside `<CardContent>`:
 *   - Joined SolverNets list (left rail of selectable Buttons)
 *   - Selected SolverNet's tasks (shadcn `<Table>`, state column as Badges)
 *   - Settings panel (roles / harness / model / plugins, Separator between rows)
 *
 * Every interactive surface is a shadcn primitive: Button (ghost / outline /
 * link), Badge (destructive / success / default / outline), Tooltip, ScrollArea.
 * Eyebrow labels stay as plain `<h3>` headings with shared utility classes —
 * shadcn's vocabulary intentionally has no "section heading" component, so
 * matching the brand's eyebrow type comes from tokens, not a primitive.
 */

export interface ActivityTask {
  /** Stable identifier — request ID is the most operator-meaningful one. */
  requestId: string;
  manifestCid: string | null;
  taskRole: 'restoration' | 'evaluation' | null;
  /** Current state in the harness engine state machine (DISCOVERED .. COMPLETE / FAILED). */
  state: string;
  /**
   * SolverType the run executed under (e.g. "swe-rebench-v2.v1"). Stable across
   * the run lifecycle — unlike `manifestCid`, which becomes the delivery/solution
   * CID once delivered. Used to scope rows to the selected SolverNet (#838).
   */
  solverType: string | null;
  /** Harness/impl name the task ran under. */
  implName: string | null;
  /** Unix ms timestamp for the task's execution window start. */
  windowStartTs: number;
  /** Unix ms timestamp captured when this operator successfully claimed the run. */
  runStartedAt: number | null;
  /** Unix ms timestamp of the last state update. */
  stateUpdatedAt: number;
  /** Optional on-chain delivery tx for explorer linking. */
  deliveryTxHash: string | null;
  /** Optional engine failure reason — used to filter "never engaged" rows. */
  failureReason?: string | null;
  /**
   * Task-relative outcome (spec/2026-05-22-run-outcome.md) — the network's
   * verdict on this run, distinct from `state`. `null`/absent renders `—`.
   */
  outcome?: 'pass' | 'fail' | 'awaiting' | 'accepted' | 'rejected' | null;
}

export interface ActivityJoinedNet {
  /** Display name; falls back to manifestCid if absent. */
  name: string;
  /** Manifest CID — the canonical identifier per spec §12. */
  manifestCid?: string;
  /**
   * SolverType for this membership (`${contract.id}.${contract.version}`). Used
   * to scope run rows reliably — delivered runs carry a delivery CID in their
   * `manifestCid`, which never matches the SolverNet manifest CID (#838).
   */
  solverType?: string;
  /** Roles the operator joined under (`solver`, `evaluator`, or legacy `solving`/`evaluating`). */
  roles: string[];
  /** Harness bound to this membership. */
  harness?: string;
  /** Model identifier the harness runs against (e.g. "minimax-m2.7"). */
  model?: string;
  /**
   * Effective plugins for this membership — bundled defaults +
   * catalog-default-included + explicit, minus operator-disabled.
   */
  plugins?: ActivityPlugin[];
}

export interface ActivityPlugin {
  name: string;
  displayName: string;
  defaultIncluded: boolean;
}

export interface ActivityCardProps {
  joined: ActivityJoinedNet[];
  tasks: ActivityTask[];
}

type StateTone = 'good' | 'bad' | 'active' | 'neutral';

/** In-flight subset of the harness state machine. */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'DISCOVERED',
  'CLAIMED',
  'WAITING',
  'PRE_SNAPSHOT',
  'RUNNING',
  'POST_SNAPSHOT',
  'PACKAGING',
  'DELIVERING',
]);

function trunc(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatRunType(role: ActivityTask['taskRole']): string {
  if (role === 'restoration') return 'solve';
  if (role === 'evaluation') return 'evaluate';
  return '—';
}

function classifyState(state: string): { label: string; detail: string; tone: StateTone } {
  if (state === 'COMPLETE') return { label: 'succeeded', detail: 'COMPLETE', tone: 'good' };
  if (state === 'FAILED') return { label: 'failed', detail: 'FAILED', tone: 'bad' };
  // RACE_LOST: another operator pruned the on-chain slot before we did any
  // work. Neutral tone, distinct label so operators can tell prunes from
  // genuine failures at a glance (#896).
  if (state === 'RACE_LOST') return { label: 'race-lost', detail: 'RACE_LOST', tone: 'neutral' };
  if (ACTIVE_STATES.has(state)) {
    return { label: 'active', detail: state.toLowerCase().replace(/_/g, ' '), tone: 'active' };
  }
  return { label: state.toLowerCase().replace(/_/g, ' '), detail: state, tone: 'neutral' };
}

function stateBadgeVariant(
  tone: StateTone,
): 'destructive' | 'success' | 'default' | 'outline' {
  if (tone === 'bad') return 'destructive';
  if (tone === 'good') return 'success';
  if (tone === 'active') return 'default';
  return 'outline';
}

/**
 * Classify a run's task-relative outcome (spec/2026-05-22-run-outcome.md) into
 * a label + tone for the Outcome column. `null`/absent → no badge (the cell
 * renders a muted `—`). Solve vs evaluate rows word the `'awaiting'` state
 * differently: a solve run awaits the network's verdict quorum ("awaiting
 * eval"); an evaluate run awaits its own outcome ("awaiting").
 */
function classifyOutcome(
  outcome: ActivityTask['outcome'],
  taskRole: ActivityTask['taskRole'],
): { label: string; tone: StateTone } | null {
  switch (outcome) {
    case 'pass':
      return { label: 'pass', tone: 'good' };
    case 'fail':
      return { label: 'fail', tone: 'bad' };
    case 'awaiting':
      return {
        label: taskRole === 'evaluation' ? 'awaiting' : 'awaiting eval',
        tone: 'neutral',
      };
    case 'accepted':
      return { label: 'accepted', tone: 'good' };
    case 'rejected':
      return { label: 'rejected', tone: 'bad' };
    default:
      return null;
  }
}

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function normaliseRole(role: string): string {
  if (role === 'solving' || role === 'solver') return 'solver';
  if (role === 'evaluating' || role === 'evaluator') return 'evaluator';
  return role;
}

/** Shared eyebrow type for the three column headings. */
const sectionHeading =
  'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground m-0';

function SectionHeading({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return <h3 className={cn(sectionHeading, className)}>{children}</h3>;
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <SectionHeading>{label}</SectionHeading>
      <div className="font-mono text-[12px] text-foreground">{children}</div>
    </div>
  );
}

export function ActivityCard({ joined, tasks }: ActivityCardProps): JSX.Element {
  const [, navigate] = useLocation();
  const [selectedCid, setSelectedCid] = useState<string | null>(
    joined[0]?.manifestCid ?? joined[0]?.name ?? null,
  );

  const selected = useMemo(
    () =>
      joined.find((n) => (n.manifestCid ?? n.name) === selectedCid) ??
      joined[0] ??
      null,
    [joined, selectedCid],
  );

  const filtered = useMemo(() => {
    if (!selected) return [];
    return tasks.filter((t) => {
      // Drop "never engaged" rows — daemon marks them FAILED but no actual
      // work happened. The two known not-engaged signatures both surface in
      // failureReason: (1) "impl not ready" / "not enabled" when the harness
      // for the role isn't configured (the operator joined evaluator but
      // hasn't enabled it yet); (2) `runStartedAt === null` for opportunities
      // the daemon never even started.
      if (t.state === 'FAILED') {
        if (t.runStartedAt === null) return false;
        const reason = (t.failureReason ?? '').toLowerCase();
        if (reason.includes('not ready') || reason.includes('not enabled')) {
          return false;
        }
      }
      // SolverNet scoping: only restrict when the operator has joined multiple
      // SolverNets. Scope by solverType — it is stable across the run lifecycle.
      // A run's `manifestCid` becomes the delivery/solution CID once delivered
      // (it never equals the SolverNet manifest CID), so the old manifestCid
      // equality silently hid every COMPLETE/settled run, making a healthy node
      // look like "all failed" (#838). manifestCid stays as a back-compat
      // fallback for older payloads that don't carry solverType.
      if (joined.length <= 1) return true;
      if (t.solverType && selected.solverType)
        return t.solverType === selected.solverType;
      if (t.manifestCid && selected.manifestCid)
        return t.manifestCid === selected.manifestCid;
      return true;
    });
  }, [tasks, selected, joined.length, selectedCid]);

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        role="region"
        aria-label="Activity"
        data-testid="activity-card"
      >
        <CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
          <div className="flex items-center gap-2">
            <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <CardTitle>Activity</CardTitle>
          </div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="activity-view-event-log"
            onClick={() => navigate('/events')}
          >
            <ListTree className="h-3 w-3" aria-hidden="true" />
            View event log
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid items-start gap-6 [grid-template-columns:minmax(160px,200px)_minmax(0,1fr)_minmax(180px,220px)]">
            {/* ── LEFT: JOINED SOLVERNETS ─────────────────────────────── */}
            <div
              data-testid="activity-joined"
              className="flex min-w-0 flex-col gap-3"
            >
              <SectionHeading>Joined</SectionHeading>

              {joined.length === 0 ? (
                <p className="m-0 font-mono text-[12px] text-muted-foreground">
                  No SolverNets joined.
                </p>
              ) : (
                <ScrollArea className="max-h-[280px]">
                  <div className="flex flex-col gap-1 pr-2">
                    {joined.map((n) => {
                      const key = n.manifestCid ?? n.name;
                      const isActive =
                        key === (selected?.manifestCid ?? selected?.name);
                      return (
                        <Button
                          key={key}
                          variant="ghost"
                          size="sm"
                          data-testid={`activity-joined-row-${key}`}
                          data-state={isActive ? 'active' : undefined}
                          aria-current={isActive ? 'true' : undefined}
                          onClick={() => setSelectedCid(key)}
                          className={cn(
                            'h-auto w-full justify-start gap-0 rounded-sm border-l-2 px-2.5 py-1.5 font-mono text-[12px] normal-case tracking-normal',
                            isActive
                              ? 'border-l-primary bg-accent text-foreground'
                              : 'border-l-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
                          )}
                        >
                          <span className="truncate">{n.name}</span>
                        </Button>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}

              <Button
                variant="outline"
                size="sm"
                data-testid="activity-join-more"
                onClick={() => navigate('/operator/registry')}
                className="self-start"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                Join more SolverNets
              </Button>
            </div>

            {/* ── MIDDLE: TASKS TABLE ─────────────────────────────────── */}
            <div
              data-testid="activity-tasks"
              className="flex min-w-0 flex-col gap-3"
            >
              {selected && (
                <h2 className="m-0 font-serif text-[20px] font-normal leading-tight text-foreground">
                  {selected.name}
                </h2>
              )}

              {filtered.length === 0 ? (
                <p className="m-0 font-mono text-[12px] text-muted-foreground">
                  No task runs recorded yet.
                </p>
              ) : (
                <div data-testid="activity-tasks-table">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Run</TableHead>
                        <TableHead>Task</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Outcome</TableHead>
                        <TableHead>Started</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((t) => {
                        const stateInfo = classifyState(t.state);
                        const outcomeInfo = classifyOutcome(t.outcome, t.taskRole);
                        const isActive = stateInfo.tone === 'active';
                        return (
                          <TableRow
                            key={t.requestId}
                            data-active={isActive ? 'true' : undefined}
                            data-testid={`activity-task-row-${t.requestId}`}
                            className={cn(
                              'border-l-2',
                              isActive
                                ? 'border-l-primary bg-primary/[0.06]'
                                : 'border-l-transparent',
                            )}
                          >
                            <TableCell className="text-muted-foreground">
                              {formatRunType(t.taskRole)}
                            </TableCell>
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    className="bg-transparent p-0 font-mono text-[12px] text-[var(--accent-sky)] underline-offset-4 hover:underline"
                                    onClick={() => navigate(`/events?requestId=${encodeURIComponent(t.requestId)}`)}
                                  >
                                    {trunc(t.requestId)}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>{t.requestId}</TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    className="cursor-help bg-transparent p-0"
                                  >
                                    <Badge variant={stateBadgeVariant(stateInfo.tone)}>
                                      {stateInfo.label}
                                    </Badge>
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent>{stateInfo.detail}</TooltipContent>
                              </Tooltip>
                            </TableCell>
                            <TableCell>
                              {outcomeInfo ? (
                                <Badge variant={stateBadgeVariant(outcomeInfo.tone)}>
                                  {outcomeInfo.label}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatRelative(t.runStartedAt ?? t.stateUpdatedAt)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            {/* ── RIGHT: SETTINGS ─────────────────────────────────────── */}
            <div
              data-testid="activity-settings"
              className="flex min-w-0 flex-col gap-3"
            >
              <div className="flex items-baseline justify-between">
                <SectionHeading>Settings</SectionHeading>
                <Button
                  variant="link"
                  size="sm"
                  data-testid="activity-settings-edit"
                  onClick={() => navigate('/operator/claim-policy')}
                  className="h-auto gap-1 p-0 text-[11px] uppercase tracking-[0.14em]"
                >
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                  Edit
                </Button>
              </div>

              {!selected ? (
                <p className="m-0 font-mono text-[12px] text-muted-foreground">
                  No SolverNet selected.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  <SettingRow label="Roles">
                    {selected.roles.length === 0 ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {selected.roles.map((r) => (
                          <Badge key={r} variant="outline">
                            {normaliseRole(r)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </SettingRow>

                  <Separator />

                  <SettingRow label="Harness">{selected.harness ?? '—'}</SettingRow>

                  <Separator />

                  <SettingRow label="Model">
                    <span
                      className={cn(
                        !selected.model && 'text-muted-foreground',
                      )}
                    >
                      {selected.model ?? '—'}
                    </span>
                  </SettingRow>

                  <Separator />

                  <SettingRow label="Plugins">
                    {!selected.plugins || selected.plugins.length === 0 ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {selected.plugins.map((p) => (
                          <li
                            key={p.name}
                            data-testid={`activity-plugin-${p.name}`}
                            className="flex items-center gap-2 overflow-hidden"
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="cursor-help truncate bg-transparent p-0 text-left font-mono text-[12px] text-foreground"
                                >
                                  {p.displayName}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>{p.name}</TooltipContent>
                            </Tooltip>
                            {p.defaultIncluded && (
                              <Badge variant="secondary" className="shrink-0">
                                default
                              </Badge>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </SettingRow>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
