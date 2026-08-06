/**
 * The durable adoption-receipt sink for the fleet requester (one-swap M5f, umbrella #2461). The
 * work-client adoption leg (`native-requester/work-client/delivery.ts`) is pure and product-shape
 * free: it hands an {@link AdoptionDecision} to an injected {@link AdoptionReceiptSink}. This is the
 * host's durable implementation — one JSON receipt per posted task under the requester's own state
 * directory, next to the associations `request()` writes, so an adopted delivery survives restarts
 * and a reconcile tick does not re-adopt (nor re-log) a task it already adopted.
 *
 * Idempotent by content address: a receipt is written once; a second `publish` for the same task
 * with the SAME `deliveryDigest` is a no-op, and a divergent one throws — a task adopting a
 * different delivery than the one already on record is a bug, never a silent overwrite.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdoptionDecision, AdoptionReceiptSink } from '../native-requester/work-client/index.js';

export interface AdoptionReceiptStore extends AdoptionReceiptSink {
  /** True once a durable receipt exists for `taskId` (decimal). */
  has(taskId: string): Promise<boolean>;
  /** The recorded decision for `taskId`, or undefined if none. */
  read(taskId: string): Promise<AdoptionDecision | undefined>;
  /** Every recorded adoption decision (unordered). */
  all(): Promise<readonly AdoptionDecision[]>;
}

/** Filenames are decimal task ids; guard against a non-decimal id leaking into a path. */
function receiptName(taskId: string): string {
  if (!/^[0-9]+$/u.test(taskId)) {
    throw new Error(`adoption receipt taskId must be a decimal string, received ${JSON.stringify(taskId)}`);
  }
  return `${taskId}.json`;
}

async function readDecision(path: string): Promise<AdoptionDecision | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AdoptionDecision;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function createFileAdoptionReceiptStore(input: { readonly dir: string }): AdoptionReceiptStore {
  const path = (taskId: string): string => join(input.dir, receiptName(taskId));

  return {
    async publish(decision: AdoptionDecision): Promise<void> {
      const target = path(decision.taskId);
      const existing = await readDecision(target);
      if (existing !== undefined) {
        if (existing.deliveryDigest !== decision.deliveryDigest) {
          throw new Error(
            `adoption receipt for task ${decision.taskId} already records delivery ${existing.deliveryDigest}; `
            + `refusing to overwrite with ${decision.deliveryDigest}`,
          );
        }
        return;
      }
      await mkdir(input.dir, { recursive: true });
      // Atomic write: a crashed process never leaves a half-written receipt that reads as adopted.
      const tmp = join(input.dir, `.${decision.taskId}.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(decision), 'utf8');
      await rename(tmp, target);
    },

    async has(taskId: string): Promise<boolean> {
      return (await readDecision(path(taskId))) !== undefined;
    },

    async read(taskId: string): Promise<AdoptionDecision | undefined> {
      return readDecision(path(taskId));
    },

    async all(): Promise<readonly AdoptionDecision[]> {
      let names: string[];
      try {
        names = (await readdir(input.dir)).filter((name) => name.endsWith('.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const decisions = await Promise.all(names.map((name) => readDecision(join(input.dir, name))));
      return decisions.filter((value): value is AdoptionDecision => value !== undefined);
    },
  };
}
