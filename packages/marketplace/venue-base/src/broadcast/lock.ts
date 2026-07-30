// SPDX-License-Identifier: MIT

// Cross-process broadcast serialization (design §6.1 "cross-process lock"). Two independent
// nonce stacks against one Safe and one EOA is the #525/#562/#897 failure class; the
// single-broadcaster rule excludes it inside one process, and this lease excludes it across
// processes sharing one state file.
import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import { BROADCAST_DEFAULTS } from "./classify.js";
import type { VenueStateDatabase } from "../state/database.js";

export interface BroadcastLock {
  withSender<T>(chainId: number, sender: Address, fn: () => Promise<T>): Promise<T>;
}

export interface BroadcastLockOptions {
  readonly leaseMs?: number;
  readonly holderId?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createBroadcastLock(
  state: VenueStateDatabase,
  options: BroadcastLockOptions = {},
): BroadcastLock {
  const leaseMs = options.leaseMs ?? BROADCAST_DEFAULTS.lockLeaseMs;
  const holderId = options.holderId ?? randomUUID();
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // In-process queue: SQLite gives us cross-process exclusion, this gives us fair ordering and
  // avoids every loop in one daemon spinning on the same row.
  const queues = new Map<string, Promise<unknown>>();

  const acquire = state.db.prepare(
    "INSERT INTO broadcast_locks (chain_id, sender, holder, acquired_at_ms, expires_at_ms)"
    + " VALUES (@chainId, @sender, @holder, @acquiredAtMs, @expiresAtMs)"
    + " ON CONFLICT (chain_id, sender) DO UPDATE SET"
    + "   holder = excluded.holder, acquired_at_ms = excluded.acquired_at_ms,"
    + "   expires_at_ms = excluded.expires_at_ms"
    + " WHERE broadcast_locks.expires_at_ms <= @acquiredAtMs",
  );
  const release = state.db.prepare(
    "DELETE FROM broadcast_locks WHERE chain_id = ? AND sender = ? AND holder = ?",
  );

  async function acquireLease(chainId: number, sender: Address): Promise<void> {
    for (;;) {
      const at = now();
      const result = acquire.run({
        chainId,
        sender: sender.toLowerCase(),
        holder: holderId,
        acquiredAtMs: at,
        expiresAtMs: at + leaseMs,
      });
      if (result.changes > 0) return;
      await sleep(25);
    }
  }

  return {
    async withSender<T>(chainId: number, sender: Address, fn: () => Promise<T>): Promise<T> {
      const key = `${chainId}:${sender.toLowerCase()}`;
      const prior = queues.get(key) ?? Promise.resolve();
      let releaseQueue!: () => void;
      const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
      queues.set(key, gate);
      await prior.catch(() => undefined);
      try {
        await acquireLease(chainId, sender);
        try {
          return await fn();
        } finally {
          release.run(chainId, sender.toLowerCase(), holderId);
        }
      } finally {
        releaseQueue();
        if (queues.get(key) === gate) queues.delete(key);
      }
    },
  };
}
