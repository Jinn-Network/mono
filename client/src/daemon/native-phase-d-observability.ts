/**
 * Phase D observability for native-v1 (#2380).
 *
 * Native mode stands up no API server and no `/v1/status` — a flipped operator otherwise goes
 * dark to the Phase D observation window. This module gives native two things:
 *
 *   1. `recordNativeOperatorComposition` — the `native-operator-composition` durable counter,
 *      recorded once per boot when native mode is validly selected. Mirrors `daemon.ts`'s
 *      `legacy-operator-composition` (recorded once the mode passes construction-time checks,
 *      not tied to traffic), so native presence is positive evidence rather than an inference
 *      from legacy silence.
 *   2. `startNativeStatusSnapshotLoop` — periodic durable snapshots of
 *      `phaseDTransitionUsageDiagnostics()` plus instance identity into `<stateDir>/phase-d-
 *      status-snapshot.v1.json`. This is native's status surface: a deploy platform (Railway,
 *      etc.) ships the file, and the Phase D collector reads it, exactly the way it reads
 *      `GET /v1/status.phaseDTransitionUsage` for a legacy instance. No new network exposure is
 *      introduced — the existing public discovery listener's exposure is scoped to the archive
 *      subtree deliberately, and a status route bolted onto that listener would widen the audit
 *      surface of that invariant for no durability benefit over a file.
 */

import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { buildInfo } from '../build-info.js';
import {
  configurePhaseDTransitionUsage,
  phaseDTransitionUsageDiagnostics,
  recordPhaseDTransitionUse,
  type PhaseDTransitionUsageDiagnostics,
} from '../compatibility/phase-d-transition-usage.js';
import type { OperatorVerticalDecision } from './native-vertical-mode.js';
import type { NativeOperatorHealth } from './native-operator-host.js';

export const NATIVE_PHASE_D_USAGE_FILENAME = 'phase-d-transition-usage.v1.json';
export const NATIVE_PHASE_D_STATUS_SNAPSHOT_FILENAME = 'phase-d-status-snapshot.v1.json';

/** The minimal shape this module needs from `NativeProductConfig` (avoids a hard import-time
 *  dependency on the full native product config module for callers that only have the subset). */
export interface NativeStateDirConfig {
  readonly operator: { readonly native: { readonly stateDir: string } };
}

/**
 * Configures the durable counter file under the operator's `stateDir` and records
 * `native-operator-composition` once. Call once, right after native mode has been validly
 * selected (mirrors `daemon.ts`'s `verticalMode === 'legacy'` recording point: after the
 * construction-time checks pass, before any work loop starts).
 */
export function recordNativeOperatorComposition(config: NativeStateDirConfig): void {
  configurePhaseDTransitionUsage(join(config.operator.native.stateDir, NATIVE_PHASE_D_USAGE_FILENAME));
  recordPhaseDTransitionUse('native-operator-composition');
}

export interface NativeStatusSnapshot {
  readonly schemaVersion: 1;
  readonly kind: 'jinn.native-operator-status-snapshot';
  readonly generatedAt: string;
  readonly effectiveMode: 'native-v1';
  readonly implVersion: string;
  readonly reportedSourceSha: string;
  readonly role: NativeOperatorHealth['role'];
  readonly readiness: OperatorVerticalDecision['readiness'];
  readonly health: NativeOperatorHealth;
  readonly phaseDTransitionUsage: PhaseDTransitionUsageDiagnostics;
}

function persistDurable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function buildSnapshot(input: {
  readonly decision: OperatorVerticalDecision;
  readonly health: NativeOperatorHealth;
  readonly now: () => Date;
}): NativeStatusSnapshot {
  return {
    schemaVersion: 1,
    kind: 'jinn.native-operator-status-snapshot',
    generatedAt: input.now().toISOString(),
    effectiveMode: 'native-v1',
    implVersion: buildInfo.implVersion,
    reportedSourceSha: buildInfo.clientGitSha,
    role: input.health.role,
    readiness: input.decision.readiness,
    health: input.health,
    phaseDTransitionUsage: phaseDTransitionUsageDiagnostics(),
  };
}

/** Writes one durable status snapshot to `path`. Pure aside from the filesystem write — no
 *  scheduling, no interval. Exported directly for unit testing and for a future one-shot CLI. */
export function writeNativeStatusSnapshot(input: {
  readonly path: string;
  readonly decision: OperatorVerticalDecision;
  readonly health: NativeOperatorHealth;
  readonly now?: () => Date;
}): NativeStatusSnapshot {
  const snapshot = buildSnapshot({
    decision: input.decision,
    health: input.health,
    now: input.now ?? (() => new Date()),
  });
  persistDurable(input.path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

/** Reads back a durable status snapshot written by `writeNativeStatusSnapshot`, or `undefined`
 *  when the file is absent. Throws on a corrupt/unparseable file — callers (the collector) treat
 *  that as a missing/corrupt observation, invalidating the instance's window. */
export function readNativeStatusSnapshot(path: string): NativeStatusSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NativeStatusSnapshot>;
  if (parsed.schemaVersion !== 1 || parsed.kind !== 'jinn.native-operator-status-snapshot'
    || typeof parsed.generatedAt !== 'string' || parsed.phaseDTransitionUsage === undefined) {
    throw new Error(`invalid native Phase D status snapshot: ${path}`);
  }
  return parsed as NativeStatusSnapshot;
}

export const DEFAULT_NATIVE_STATUS_SNAPSHOT_INTERVAL_MS = 5 * 60_000;

export interface NativeStatusSnapshotLoopHandle {
  readonly stop: () => void;
}

/**
 * Starts the periodic durable-snapshot loop. Writes one snapshot immediately (so a collector
 * never has to wait a full interval after boot) and then on `intervalMs` cadence. `refreshHealth`
 * is called on every tick so the snapshot reflects live health, not a stale boot-time value.
 * A failed tick (health refresh throws, or the write fails) is reported via `onError` and does
 * not stop the loop — a transient failure should not silence all future snapshots.
 */
export function startNativeStatusSnapshotLoop(input: {
  readonly stateDir: string;
  readonly decision: OperatorVerticalDecision;
  readonly refreshHealth: () => Promise<NativeOperatorHealth>;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}): NativeStatusSnapshotLoopHandle {
  const path = join(input.stateDir, NATIVE_PHASE_D_STATUS_SNAPSHOT_FILENAME);
  const tick = (): void => {
    Promise.resolve(input.refreshHealth())
      .then((health) => {
        writeNativeStatusSnapshot({ path, decision: input.decision, health, now: input.now });
      })
      .catch((error: unknown) => { input.onError?.(error); });
  };
  tick();
  const timer = setInterval(tick, input.intervalMs ?? DEFAULT_NATIVE_STATUS_SNAPSHOT_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
