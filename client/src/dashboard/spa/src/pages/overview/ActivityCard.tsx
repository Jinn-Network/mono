import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { Activity as ActivityIcon, Pencil, Plus } from 'lucide-react';
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
  /** Harness/impl name the task ran under. */
  implName: string | null;
  /** Unix ms timestamp the run claimed (window-start). */
  windowStartTs: number;
  /** Unix ms timestamp of the last state update. */
  stateUpdatedAt: number;
  /** Optional on-chain delivery tx for explorer linking. */
  deliveryTxHash: string | null;
}

export interface ActivityJoinedNet {
  /** Display name; falls back to manifestCid if absent. */
  name: string;
  /** Manifest CID — the canonical identifier per spec §12. */
  manifestCid?: string;
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

function formatRole(role: ActivityTask['taskRole']): string {
  if (role === 'restoration') return 'solver';
  if (role === 'evaluation') return 'evaluator';
  return '—';
}

function classifyState(state: string): { label: string; tone: StateTone } {
  if (state === 'COMPLETE') return { label: 'Complete', tone: 'good' };
  if (state === 'FAILED') return { label: 'Failed', tone: 'bad' };
  if (ACTIVE_STATES.has(state)) {
    return { label: state.toLowerCase().replace(/_/g, ' '), tone: 'active' };
  }
  return { label: state.toLowerCase().replace(/_/g, ' '), tone: 'neutral' };
}

function stateBadgeVariant(
  tone: StateTone,
): 'destructive' | 'success' | 'default' | 'outline' {
  if (tone === 'bad') return 'destructive';
  if (tone === 'good') return 'success';
  if (tone === 'active') return 'default';
  return 'outline';
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
    return tasks
      .filter((t) => {
        if (t.manifestCid && selected.manifestCid)
          return t.manifestCid === selected.manifestCid;
        return joined.length <= 1;
      })
      .slice(0, 50);
  }, [tasks, selected, joined.length, selectedCid]);

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        role="region"
        aria-label="Activity"
        data-testid="activity-card"
      >
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Activity</CardTitle>
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
                <ScrollArea className="max-h-[360px]">
                  <div data-testid="activity-tasks-table">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Task</TableHead>
                          <TableHead>Role</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead>Started</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filtered.map((t) => {
                          const stateInfo = classifyState(t.state);
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
                              <TableCell>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      className="cursor-help bg-transparent p-0 font-mono text-[12px] text-foreground"
                                    >
                                      {trunc(t.requestId)}
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent>{t.requestId}</TooltipContent>
                                </Tooltip>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {formatRole(t.taskRole)}
                              </TableCell>
                              <TableCell>
                                <Badge variant={stateBadgeVariant(stateInfo.tone)}>
                                  {stateInfo.label}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {formatRelative(
                                  t.windowStartTs || t.stateUpdatedAt,
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </ScrollArea>
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
                  onClick={() => navigate('/operator/memberships')}
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
