/**
 * Child-issue library for the single-surface lifecycle (Stage 2).
 *
 * Findings and reconcile work become ordinary issues targeting a parent PR.
 * Filing is idempotent: at most one open child per parent per kind, keyed by
 * the body marker.
 */

export const CHILD_KINDS = ['review-finding', 'reconcile', 'ci-failure'] as const;
export type ChildKind = (typeof CHILD_KINDS)[number];

export const CHILD_MARKER_PREFIX = '<!-- jinn-autopilot:child';

/** Structured body marker naming the parent PR and child kind. */
export function formatChildMarker(parentPr: number, kind: ChildKind): string {
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) {
    throw new Error(`Invalid parent PR number: ${parentPr}`);
  }
  if (!CHILD_KINDS.includes(kind)) {
    throw new Error(`Invalid child kind: ${kind}`);
  }
  return `<!-- jinn-autopilot:child pr=${parentPr} kind=${kind} -->`;
}

export function parseChildMarker(
  body: string,
): { readonly parentPr: number; readonly kind: ChildKind } | null {
  const match = body.match(
    /<!--\s*jinn-autopilot:child\s+pr=(\d+)\s+kind=(review-finding|reconcile|ci-failure)\s*-->/,
  );
  if (match === null) return null;
  const parentPr = Number(match[1]);
  const kind = match[2] as ChildKind;
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) return null;
  return { parentPr, kind };
}

export function isChildIssueBody(body: string): boolean {
  return parseChildMarker(body) !== null;
}

const CHILD_KIND_LABELS = new Set(['review-finding', 'reconcile', 'ci-failure']);

/**
 * Machine-created child issues carry a body marker plus a kind label.
 * Triage (Blocked on / Effort / Priority) lives on the Project board.
 */
export function isMachineChildIssue(input: {
  readonly body?: string;
  readonly labels?: readonly string[];
}): boolean {
  if (!isChildIssueBody(input.body ?? '')) return false;
  const labels = input.labels ?? [];
  return labels.some((label) => CHILD_KIND_LABELS.has(label));
}

export interface FileChildIssueInput {
  readonly parentPr: number;
  readonly kind: ChildKind;
  readonly title: string;
  readonly body: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly priority: 'p1' | 'p2';
}

export interface ChildIssueRecord {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly parentPr: number;
  readonly kind: ChildKind;
}

export interface ChildIssuePort {
  searchOpenByMarker(marker: string): Promise<readonly ChildIssueRecord[]>;
  listByParentAndKind(
    parentPr: number,
    kind: ChildKind,
  ): Promise<readonly ChildIssueRecord[]>;
  createIssue(input: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }): Promise<{ readonly number: number }>;
  setIssueTypeFix(issueNumber: number): Promise<void>;
  ensureTriageComplete(input: {
    readonly issueNumber: number;
    readonly effort: FileChildIssueInput['effort'];
    readonly priority: FileChildIssueInput['priority'];
  }): Promise<void>;
  closeIssue(issueNumber: number, comment: string): Promise<void>;
}

export type FileChildIssueResult =
  | { readonly number: number; readonly created: boolean; readonly runawayHold?: undefined }
  | { readonly runawayHold: true; readonly priorCount: number };

/**
 * Idempotent child filing. If an open issue already carries the marker for
 * this parent+kind, returns it without creating another. When prior children
 * of the same kind already hit the runaway limit (open or closed), returns
 * `runawayHold` instead of filing another — callers escalate the parent.
 */
export async function fileChildIssue(
  port: ChildIssuePort,
  input: FileChildIssueInput,
): Promise<FileChildIssueResult> {
  const marker = formatChildMarker(input.parentPr, input.kind);
  const existing = await port.searchOpenByMarker(marker);
  if (existing.length > 0) {
    // Heal label-only children filed before Project-field triage.
    await port.ensureTriageComplete({
      issueNumber: existing[0]!.number,
      effort: input.effort,
      priority: input.priority,
    });
    return { number: existing[0]!.number, created: false };
  }

  const priorCount = await countChildrenOfKind(port, input.parentPr, input.kind);
  if (shouldFileRunawayHold(priorCount)) {
    return { runawayHold: true, priorCount };
  }

  const body = input.body.includes(marker)
    ? input.body
    : `${marker}\n\n${input.body.trim()}`;
  const created = await port.createIssue({
    title: input.title,
    body,
    labels: [input.kind],
  });
  await port.setIssueTypeFix(created.number);
  await port.ensureTriageComplete({
    issueNumber: created.number,
    effort: input.effort,
    priority: input.priority,
  });
  return { number: created.number, created: true };
}

export async function findOpenChildren(
  port: ChildIssuePort,
  parentPr: number,
): Promise<readonly ChildIssueRecord[]> {
  const out: ChildIssueRecord[] = [];
  for (const kind of CHILD_KINDS) {
    const listed = await port.listByParentAndKind(parentPr, kind);
    for (const issue of listed) {
      if (issue.state === 'open' && issue.parentPr === parentPr) out.push(issue);
    }
  }
  return out;
}

export async function closeChildrenFor(
  port: ChildIssuePort,
  parentPr: number,
  comment: string,
): Promise<readonly number[]> {
  const open = await findOpenChildren(port, parentPr);
  const closed: number[] = [];
  for (const child of open) {
    await port.closeIssue(child.number, comment);
    closed.push(child.number);
  }
  return closed;
}

/**
 * Count prior children of one kind on one parent (open or closed). Used by
 * the Stage 4 runaway guard (default N=3).
 */
export async function countChildrenOfKind(
  port: ChildIssuePort,
  parentPr: number,
  kind: ChildKind,
): Promise<number> {
  const listed = await port.listByParentAndKind(parentPr, kind);
  return listed.filter((issue) => issue.parentPr === parentPr && issue.kind === kind)
    .length;
}

/** Env knob: when unset or truthy (not 0/false/no/off), children path is armed. */
export function childrenPathEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.JINN_AUTOPILOT_CHILDREN;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

/**
 * Env knob: approval carry-over after tier-0 update-branch.
 * Stage 4 default: unset/empty means on. Disable with 0/false/no/off.
 */
export function carryoverEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.JINN_AUTOPILOT_CARRYOVER;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

export const RUNAWAY_CHILD_LIMIT = 3;

/**
 * Stage 4 runaway guard: the Nth child of a kind should hold the parent
 * instead of filing again.
 */
export function shouldFileRunawayHold(priorCount: number, limit = RUNAWAY_CHILD_LIMIT): boolean {
  return priorCount >= limit;
}
