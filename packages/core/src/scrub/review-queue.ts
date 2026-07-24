/**
 * Operator-local review queue for scrub `flag` dispositions (#1973 / design §6.6).
 *
 * Persistence: `~/.jinn-client/scrub-review/queue.jsonl` (one JSON object per
 * line). Traces never leave the machine — this queue is local-only.
 *
 * Unattended publish lanes fail closed while any matching flag remains
 * `pending` (see {@link assertNoUnresolvedFlags}).
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Finding } from './finding.js';
import { resolveDisposition, type PolicyTable } from './policy.js';
import { DEFAULT_POLICY } from './policy.js';

export type ReviewDecision =
  | 'approve-instance'
  | 'redact-instance'
  | 'add-to-allowlist'
  | 'add-to-identity-pack';

export type ReviewItemStatus = 'pending' | 'resolved';

export interface ReviewQueueItem {
  id: string;
  finding: Finding;
  context: { attributeKey: string; snippet: string };
  createdAt: string;
  status: ReviewItemStatus;
  resolution?: { decision: ReviewDecision; resolvedAt: string };
}

export interface ReviewQueueStore {
  listFlagged(filter?: { status?: ReviewItemStatus }): ReviewQueueItem[];
  resolveFlag(id: string, decision: ReviewDecision): ReviewQueueItem;
  enqueue(items: Array<Omit<ReviewQueueItem, 'id' | 'createdAt' | 'status'>>): ReviewQueueItem[];
  /** Fingerprint → latest resolved decision (if any). */
  resolutionFor(finding: Finding): ReviewDecision | undefined;
}

export const DEFAULT_REVIEW_QUEUE_PATH = join(
  homedir(),
  '.jinn-client',
  'scrub-review',
  'queue.jsonl',
);

/** Stable fingerprint for matching a finding across scrub runs. */
export function findingFingerprint(finding: Finding): string {
  const payload = [
    finding.class,
    finding.span.key,
    String(finding.span.start),
    String(finding.span.end),
    finding.evidence.join('|'),
    finding.detector.name,
  ].join('\0');
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function readAll(path: string): ReviewQueueItem[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const items: ReviewQueueItem[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed) as ReviewQueueItem);
    } catch {
      // skip corrupt lines
    }
  }
  return items;
}

function writeAll(path: string, items: ReviewQueueItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = items.map((i) => JSON.stringify(i)).join('\n');
  writeFileSync(path, body.length > 0 ? `${body}\n` : '', 'utf8');
}

/** In-memory review queue for unit tests (no disk I/O). */
export function createMemoryReviewQueueStore(
  seed: ReviewQueueItem[] = [],
): ReviewQueueStore {
  let items = [...seed];
  return {
    listFlagged(filter) {
      if (!filter?.status) return [...items];
      return items.filter((i) => i.status === filter.status);
    },
    enqueue(rawItems) {
      const pendingFingerprints = new Set(
        items.filter((i) => i.status === 'pending').map((i) => findingFingerprint(i.finding)),
      );
      const created: ReviewQueueItem[] = [];
      for (const raw of rawItems) {
        const fp = findingFingerprint(raw.finding);
        if (pendingFingerprints.has(fp)) continue;
        const prior = [...items]
          .reverse()
          .find((i) => findingFingerprint(i.finding) === fp && i.status === 'resolved');
        if (prior) continue;
        const item: ReviewQueueItem = {
          id: randomUUID(),
          finding: raw.finding,
          context: raw.context,
          createdAt: new Date().toISOString(),
          status: 'pending',
        };
        items.push(item);
        pendingFingerprints.add(fp);
        created.push(item);
      }
      return created;
    },
    resolveFlag(id, decision) {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) throw new Error(`review queue: unknown flag id ${id}`);
      const item = items[idx]!;
      if (item.status === 'resolved') {
        throw new Error(`review queue: flag ${id} is already resolved`);
      }
      const updated: ReviewQueueItem = {
        ...item,
        status: 'resolved',
        resolution: { decision, resolvedAt: new Date().toISOString() },
      };
      items = items.map((i, iidx) => (iidx === idx ? updated : i));
      return updated;
    },
    resolutionFor(finding) {
      const fp = findingFingerprint(finding);
      const match = [...items]
        .reverse()
        .find((i) => findingFingerprint(i.finding) === fp && i.status === 'resolved');
      return match?.resolution?.decision;
    },
  };
}

/**
 * File-backed review queue. Latest write wins per id; fingerprints look at the
 * newest resolved entry.
 */
export function createReviewQueueStore(path: string = DEFAULT_REVIEW_QUEUE_PATH): ReviewQueueStore {
  return {
    listFlagged(filter) {
      const all = readAll(path);
      if (!filter?.status) return all;
      return all.filter((i) => i.status === filter.status);
    },

    enqueue(rawItems) {
      mkdirSync(dirname(path), { recursive: true });
      const existing = readAll(path);
      const pendingFingerprints = new Set(
        existing
          .filter((i) => i.status === 'pending')
          .map((i) => findingFingerprint(i.finding)),
      );
      const created: ReviewQueueItem[] = [];
      for (const raw of rawItems) {
        const fp = findingFingerprint(raw.finding);
        if (pendingFingerprints.has(fp)) continue;
        // Skip if already resolved for this fingerprint.
        const prior = [...existing]
          .reverse()
          .find((i) => findingFingerprint(i.finding) === fp && i.status === 'resolved');
        if (prior) continue;
        const item: ReviewQueueItem = {
          id: randomUUID(),
          finding: raw.finding,
          context: raw.context,
          createdAt: new Date().toISOString(),
          status: 'pending',
        };
        appendFileSync(path, `${JSON.stringify(item)}\n`, 'utf8');
        pendingFingerprints.add(fp);
        created.push(item);
      }
      return created;
    },

    resolveFlag(id, decision) {
      const all = readAll(path);
      const idx = all.findIndex((i) => i.id === id);
      if (idx < 0) {
        throw new Error(`review queue: unknown flag id ${id}`);
      }
      const item = all[idx]!;
      if (item.status === 'resolved') {
        throw new Error(`review queue: flag ${id} is already resolved`);
      }
      const updated: ReviewQueueItem = {
        ...item,
        status: 'resolved',
        resolution: { decision, resolvedAt: new Date().toISOString() },
      };
      all[idx] = updated;
      writeAll(path, all);
      return updated;
    },

    resolutionFor(finding) {
      const fp = findingFingerprint(finding);
      const match = [...readAll(path)]
        .reverse()
        .find((i) => findingFingerprint(i.finding) === fp && i.status === 'resolved');
      return match?.resolution?.decision;
    },
  };
}

/** Convenience exports bound to the default operator-local path. */
const defaultStore = createReviewQueueStore();

export function listFlagged(filter?: { status?: ReviewItemStatus }): ReviewQueueItem[] {
  return defaultStore.listFlagged(filter);
}

export function resolveFlag(id: string, decision: ReviewDecision): ReviewQueueItem {
  return defaultStore.resolveFlag(id, decision);
}

export function enqueueFlags(
  items: Array<Omit<ReviewQueueItem, 'id' | 'createdAt' | 'status'>>,
  store: ReviewQueueStore = defaultStore,
): ReviewQueueItem[] {
  return store.enqueue(items);
}

/**
 * Thrown when redact-mode scrub leaves unresolved `flag` dispositions.
 * Unattended publish must not proceed over an open flag (design §6.5).
 */
export class UnresolvedFlagError extends Error {
  readonly findings: Finding[];
  readonly queueIds: string[];

  constructor(findings: Finding[], queueIds: string[] = []) {
    const n = findings.length;
    super(
      `unresolved-flag: ${n} scrub finding(s) require review — publish aborted ` +
        `(run \`jinn scrub review\` to resolve; ids: ${queueIds.slice(0, 5).join(', ') || 'n/a'})`,
    );
    this.name = 'UnresolvedFlagError';
    this.findings = findings;
    this.queueIds = queueIds;
  }
}

export interface FlagDispositionOptions {
  policy?: PolicyTable;
  /** Attributes bag used to build review-queue context snippets. */
  attributes?: Record<string, unknown>;
  store?: ReviewQueueStore;
  /**
   * When true (default for redact-mode publish), enqueue + throw if any flag
   * remains unresolved. Check-mode distill sets this false (rejection is via
   * redactions / rejected bit instead).
   */
  failClosed?: boolean;
}

/**
 * Apply review-queue resolutions to flag findings, enqueue new pending flags,
 * and optionally fail closed.
 *
 * - `approve-instance` / allowlist / identity-pack → treat as pass (no throw)
 * - `redact-instance` → caller should promote to redact (returned in `toRedact`)
 * - unresolved → enqueue + throw when `failClosed`
 */
export function processFlagFindings(
  findings: Finding[],
  opts: FlagDispositionOptions = {},
): {
  unresolved: Finding[];
  toRedact: Finding[];
  toPass: Finding[];
  enqueued: ReviewQueueItem[];
} {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const store = opts.store ?? defaultStore;
  const attributes = opts.attributes ?? {};

  const flagged = findings.filter(
    (f) => resolveDisposition(f.class, f.confidence, policy) === 'flag',
  );

  const unresolved: Finding[] = [];
  const toRedact: Finding[] = [];
  const toPass: Finding[] = [];
  const toEnqueue: Array<Omit<ReviewQueueItem, 'id' | 'createdAt' | 'status'>> = [];

  for (const finding of flagged) {
    const decision = store.resolutionFor(finding);
    if (decision === 'redact-instance') {
      toRedact.push(finding);
      continue;
    }
    if (
      decision === 'approve-instance' ||
      decision === 'add-to-allowlist' ||
      decision === 'add-to-identity-pack'
    ) {
      toPass.push(finding);
      continue;
    }
    unresolved.push(finding);
    const value = attributes[finding.span.key];
    const text = typeof value === 'string' ? value : '';
    const snippet = text.slice(
      Math.max(0, finding.span.start - 40),
      Math.min(text.length, finding.span.end + 40),
    );
    toEnqueue.push({
      finding,
      context: { attributeKey: finding.span.key, snippet },
    });
  }

  const enqueued = toEnqueue.length > 0 ? store.enqueue(toEnqueue) : [];
  return { unresolved, toRedact, toPass, enqueued };
}

/**
 * Fail closed when unresolved flags remain after {@link processFlagFindings}.
 */
export function assertNoUnresolvedFlags(
  findings: Finding[],
  opts: FlagDispositionOptions = {},
): void {
  if (opts.failClosed === false) return;
  const { unresolved, enqueued } = processFlagFindings(findings, opts);
  if (unresolved.length === 0) return;
  throw new UnresolvedFlagError(
    unresolved,
    enqueued.map((e) => e.id),
  );
}
