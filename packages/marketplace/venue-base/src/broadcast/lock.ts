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
  // Renewal is scoped to (chain_id, sender, holder): a holder whose row was
  // already stolen (different `holder` now on the row) simply renews zero
  // rows -- a silent no-op, never a steal-back.
  const renew = state.db.prepare(
    "UPDATE broadcast_locks SET expires_at_ms = @expiresAtMs"
    + " WHERE chain_id = @chainId AND sender = @sender AND holder = @holder",
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

  // Renew from a timer while the critical section is open (D0a round-1
  // review): a fixed lease acquired once silently lapses mutual exclusion
  // for any critical section that outlives `leaseMs` (P2's multi-attempt
  // `executeSafeTxBatch` retry/backoff can plausibly exceed it). Renew at
  // half the lease window so there is always a full half-lease of slack
  // before the row would actually go stale.
  function startRenewal(chainId: number, sender: Address): () => void {
    const renewIntervalMs = Math.max(1, Math.floor(leaseMs / 2));
    const timer = setInterval(() => {
      renew.run({
        chainId,
        sender: sender.toLowerCase(),
        holder: holderId,
        expiresAtMs: now() + leaseMs,
      });
    }, renewIntervalMs);
    // Never keep the process alive solely to renew a lease.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return () => clearInterval(timer);
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
        const stopRenewal = startRenewal(chainId, sender);
        try {
          return await fn();
        } finally {
          stopRenewal();
          release.run(chainId, sender.toLowerCase(), holderId);
        }
      } finally {
        releaseQueue();
        if (queues.get(key) === gate) queues.delete(key);
      }
    },
  };
}
