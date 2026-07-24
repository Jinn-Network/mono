import { parseChildMarker } from './child-issues.js';
import { gitOid } from './types.js';

const REVIEW_FOLLOW_UP_MARKER_TAG = 'jinn-autopilot:review-follow-up';
const REVIEW_FOLLOW_UP_MARKER_RE = new RegExp(
  `<!--\\s*${REVIEW_FOLLOW_UP_MARKER_TAG}\\s+pr=(\\d+)\\s+head=([0-9a-fA-F]{40})\\s+index=(\\d+)\\s*-->`,
);
/** Fail-closed: follow-up title/body must never inject a child marker (§5.1 / AC2). */
const CHILD_MARKER_SUBSTRING = 'jinn-autopilot:child';

export const MAX_REVIEW_FOLLOW_UPS_PER_PASS = 5;

export type ReviewFollowUpType = 'feat' | 'chore' | 'fix' | 'refactor';
export type ReviewFollowUpEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReviewFollowUpPriority = 'p0' | 'p1' | 'p2' | 'p3' | 'p4';

export interface ReviewFollowUpEntry {
  readonly type: ReviewFollowUpType;
  readonly title: string;
  readonly body: string;
  readonly effort: ReviewFollowUpEffort;
  readonly priority: ReviewFollowUpPriority;
}

export interface FiledReviewFollowUp {
  readonly number: number;
  readonly created: boolean;
  readonly index: number;
}

export interface ReviewFollowUpPort {
  searchOpenByMarker(marker: string): Promise<readonly { readonly number: number }[]>;
  createIssue(input: {
    readonly title: string;
    readonly body: string;
    readonly type: ReviewFollowUpType;
  }): Promise<{ readonly number: number }>;
  ensureTriageComplete(input: {
    readonly issueNumber: number;
    readonly type: ReviewFollowUpType;
    readonly effort: ReviewFollowUpEffort;
    readonly priority: ReviewFollowUpPriority;
  }): Promise<void>;
}

export function formatReviewFollowUpMarker(
  parentPr: number,
  head: string,
  index: number,
): string {
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) {
    throw new Error(`Invalid parent PR number: ${parentPr}`);
  }
  let normalizedHead: string;
  try {
    normalizedHead = gitOid(head.toLowerCase());
  } catch {
    throw new Error(`Invalid head SHA: ${head}`);
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid follow-up index: ${index}`);
  }
  return `<!-- ${REVIEW_FOLLOW_UP_MARKER_TAG} pr=${parentPr} head=${normalizedHead} index=${index} -->`;
}

export function parseReviewFollowUpMarker(
  body: string,
): { readonly parentPr: number; readonly head: string; readonly index: number } | null {
  const match = body.match(REVIEW_FOLLOW_UP_MARKER_RE);
  if (match === null) return null;
  const parentPr = Number(match[1]);
  const index = Number(match[3]);
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return { parentPr, head: match[2]!.toLowerCase(), index };
}

const TYPES = new Set(['feat', 'chore', 'fix', 'refactor']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3', 'p4']);

/**
 * Reject (do not strip) any follow-up title/body that would look like a
 * machine child issue to `parseChildMarker` / `openChildrenByParent`.
 */
export function assertNoChildMarkerInFollowUp(
  title: string,
  body: string,
  entryIndex?: number,
): void {
  const where =
    entryIndex === undefined ? 'Follow-up entry' : `Follow-up entry ${entryIndex}`;
  for (const [field, value] of [
    ['title', title],
    ['body', body],
  ] as const) {
    if (value.includes(CHILD_MARKER_SUBSTRING) || parseChildMarker(value) !== null) {
      throw new Error(
        `${where} ${field} must not contain a child marker (jinn-autopilot:child)`,
      );
    }
  }
}

export function parseReviewFollowUpsPayload(raw: string): ReviewFollowUpEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Follow-ups file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Follow-ups file must be an object with followUps[]');
  }
  const followUps = (parsed as { followUps?: unknown }).followUps;
  if (!Array.isArray(followUps)) {
    throw new Error('Follow-ups file must include followUps[]');
  }
  if (followUps.length > MAX_REVIEW_FOLLOW_UPS_PER_PASS) {
    throw new Error(
      `Follow-ups file has ${followUps.length} entries; at most ${MAX_REVIEW_FOLLOW_UPS_PER_PASS} allowed per pass`,
    );
  }
  return followUps.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Follow-up entry ${index} is malformed`);
    }
    const record = entry as Record<string, unknown>;
    const type = record.type;
    const title = record.title;
    const body = record.body;
    const effort = record.effort;
    const priority = record.priority;
    if (typeof type !== 'string' || !TYPES.has(type)) {
      throw new Error(`Follow-up entry ${index} has invalid type`);
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error(`Follow-up entry ${index} requires a non-empty title`);
    }
    if (typeof body !== 'string') {
      throw new Error(`Follow-up entry ${index} requires a body string`);
    }
    if (typeof effort !== 'string' || !EFFORTS.has(effort)) {
      throw new Error(`Follow-up entry ${index} has invalid effort`);
    }
    if (typeof priority !== 'string' || !PRIORITIES.has(priority)) {
      throw new Error(`Follow-up entry ${index} has invalid priority`);
    }
    const trimmedTitle = title.trim();
    assertNoChildMarkerInFollowUp(trimmedTitle, body, index);
    return {
      type: type as ReviewFollowUpType,
      title: trimmedTitle,
      body,
      effort: effort as ReviewFollowUpEffort,
      priority: priority as ReviewFollowUpPriority,
    };
  });
}

export async function fileReviewFollowUps(
  port: ReviewFollowUpPort,
  input: {
    readonly parentPr: number;
    readonly head: string;
    readonly entries: readonly ReviewFollowUpEntry[];
  },
): Promise<readonly FiledReviewFollowUp[]> {
  if (input.entries.length > MAX_REVIEW_FOLLOW_UPS_PER_PASS) {
    throw new Error(
      `Follow-ups exceed cap of ${MAX_REVIEW_FOLLOW_UPS_PER_PASS}`,
    );
  }
  const filed: FiledReviewFollowUp[] = [];
  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index]!;
    assertNoChildMarkerInFollowUp(entry.title, entry.body, index);
    const marker = formatReviewFollowUpMarker(input.parentPr, input.head, index);
    const existing = await port.searchOpenByMarker(marker);
    if (existing.length > 0) {
      // Create is skipped; triage still runs so a partial prior failure heals.
      await port.ensureTriageComplete({
        issueNumber: existing[0]!.number,
        type: entry.type,
        effort: entry.effort,
        priority: entry.priority,
      });
      filed.push({ number: existing[0]!.number, created: false, index });
      continue;
    }
    const prose =
      `${entry.body.trim()}\n\nFiled from Autopilot review of PR #${input.parentPr} @ \`${input.head.toLowerCase()}\`.`;
    const body = `${marker}\n\n${prose}`;
    const created = await port.createIssue({
      title: entry.title,
      body,
      type: entry.type,
    });
    await port.ensureTriageComplete({
      issueNumber: created.number,
      type: entry.type,
      effort: entry.effort,
      priority: entry.priority,
    });
    filed.push({ number: created.number, created: true, index });
  }
  return filed;
}
