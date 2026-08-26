/**
 * Contribution ledger — the operator's local receipt of what left their
 * machine (plan Task 4, issue #1311).
 *
 * Append-only JSONL at `~/.jinn-client/harness-layer/ledger.jsonl` by
 * default. Entries carry only persistence-safe fields (the task summary is
 * already scrubbed by capture; redaction `before` values never reach here).
 * The Task 5 fork renders this; Task 7 aggregates over it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { VerifiabilityTierSchema } from './envelope.js';

export const DEFAULT_LEDGER_PATH = join(
  homedir(),
  '.jinn-client',
  'harness-layer',
  'ledger.jsonl',
);

export const LedgerEntrySchema = z.strictObject({
  /** ISO-8601 time the entry was recorded. */
  ts: z.iso.datetime(),
  /** Scrubbed one-line task summary (from the envelope). */
  taskSummary: z.string().min(1),
  /** Published envelope ref (manifest CID) — null when vetoed. */
  envelopeRef: z.string().min(1).nullable(),
  /** ERC-8004 anchor tx hash — null when vetoed or the anchor returned none. */
  anchorTx: z.string().min(1).nullable(),
  verifiabilityTier: VerifiabilityTierSchema,
  status: z.enum(['published', 'vetoed (local only)']),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * Fork-shaped projection of a ledger entry — the row shape the frozen
 * 0.1.2 TUI consumer reads.
 * `state` is absent for published rows; the schema also accepts a `failed`
 * state for forward-compat, even though `toLedgerRow` never emits it.
 */
export const LedgerRowSchema = z.strictObject({
  time: z.string().min(1),
  task: z.string().min(1),
  env: z.string().min(1).nullable(),
  anchor: z.string().min(1).nullable(),
  tier: VerifiabilityTierSchema,
  state: z.enum(['vetoed', 'failed']).optional(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;

/** Project an internal ledger entry into the fork-consumed row shape. */
export function toLedgerRow(entry: LedgerEntry): LedgerRow {
  const base = {
    time: entry.ts,
    task: entry.taskSummary,
    env: entry.envelopeRef,
    anchor: entry.anchorTx,
    tier: entry.verifiabilityTier,
  };
  switch (entry.status) {
    case 'published':
      return base;
    case 'vetoed (local only)':
      return { ...base, state: 'vetoed' };
    default: {
      // Exhaustiveness: a new status forces this branch to fail compilation.
      const _never: never = entry.status;
      return _never;
    }
  }
}

export interface LedgerStore {
  append(entry: LedgerEntry): void;
  /** Entries in append order. */
  list(): LedgerEntry[];
}

/** In-memory ledger (tests, embedders that persist elsewhere). */
export function createMemoryLedger(): LedgerStore {
  const entries: LedgerEntry[] = [];
  return {
    append(entry) {
      entries.push(LedgerEntrySchema.parse(entry));
    },
    list: () => entries,
  };
}

function readEntries(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(LedgerEntrySchema.parse(JSON.parse(line)));
    } catch {
      // A corrupt line must not sink the operator's whole receipt history.
      console.warn(`[harness-layer] skipping malformed ledger line in ${path}`);
    }
  }
  return entries;
}

/** Append-only JSONL file ledger. Creates parent directories on first write. */
export function createFileLedger(path: string = DEFAULT_LEDGER_PATH): LedgerStore {
  return {
    append(entry) {
      const parsed = LedgerEntrySchema.parse(entry);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(parsed) + '\n', 'utf-8');
    },
    list: () => readEntries(path),
  };
}

/** Read the ledger (plan Task 4's `ledger()` surface). Missing file ⇒ empty. */
export function ledger(path: string = DEFAULT_LEDGER_PATH): LedgerEntry[] {
  return readEntries(path);
}
