// operator/src/native-drill/scenarios/support.ts
/**
 * Shared scaffolding for the six restart-drill scenarios (#2434).
 *
 * Each scenario runs inside a role-host child process. Everything it needs to survive that
 * process's death lives either in the operator's own durable state (SQLite / the requester state
 * directory) or in one of the small external-system journals below, which stand for the systems a
 * real operator restart has to reconcile against: the execution backend and the record publisher.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { documentDigest, serializeCanonicalJson } from '@jinn-network/task-execution-protocol';
import type { DrillCheckpoint } from '../checkpoints.js';
import type { DrillChain } from '../chain.js';
import type { RunObservation } from '../observation.js';

/** How a scenario is being executed. `crash` never returns an observation: it is killed. */
export type ScenarioMode = 'uninterrupted' | 'crash' | 'resume';

export interface ScenarioContext {
  readonly checkpoint: DrillCheckpoint;
  readonly seed: string;
  readonly runId: string;
  /** Durable directory shared by the `crash` and `resume` processes of one pair. */
  readonly stateDir: string;
  readonly mode: ScenarioMode;
  readonly chain: DrillChain;
  /**
   * Called at the injected boundary. In `crash` mode it signals the parent and then never
   * resolves, so the process is SIGKILLed mid-operation with no cooperative unwind. In the other
   * modes it resolves immediately.
   */
  readonly boundary: () => Promise<void>;
}

export type Scenario = (context: ScenarioContext) => Promise<RunObservation | undefined>;

/** The frozen instant every scenario runs at, so a re-run reproduces identical sealed bytes. */
export const DRILL_CLOCK = new Date('2026-08-02T12:00:00.000Z');

export function digestOf(value: unknown): `sha256:${string}` {
  return documentDigest(serializeCanonicalJson(value as Parameters<typeof serializeCanonicalJson>[0]));
}

/**
 * A port the drilled phase must never reach. Touching it throws and names the port, so an
 * unexpected phase transition fails loudly instead of running against a silently empty object.
 */
export function unreachablePort<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(
        `restart drill reached the ${name} port (property ${String(property)}), which this `
        + 'checkpoint does not exercise — the scenario advanced into an unexpected phase',
      );
    },
  });
}

/**
 * A single port member the drilled phase must never call. Used where a port interface is only
 * partly exercised by a checkpoint and a whole-object proxy would not typecheck.
 */
export function unreachableMember<T extends (...args: never[]) => unknown>(name: string): T {
  return ((): never => {
    throw new Error(`restart drill called ${name}, which this checkpoint does not exercise`);
  }) as T;
}

/**
 * A durable append-only journal on disk, standing for an external system's own state. It is read
 * and written by both processes of a crash/resume pair, which is exactly what makes
 * `backend.recover` and publisher idempotency provable across a real process death.
 */
export class ExternalJournal<T> {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  entries(): readonly T[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T[];
    } catch {
      return [];
    }
  }

  append(entry: T): void {
    writeFileSync(this.path, JSON.stringify([...this.entries(), entry]), 'utf8');
  }

  /** Append only when no entry shares `key`; returns whether this call was the one that wrote. */
  appendOnce(key: string, entry: T & { readonly key: string }): boolean {
    if (this.entries().some((existing) => (existing as { key?: string }).key === key)) return false;
    this.append(entry);
    return true;
  }
}

export function journal<T>(context: ScenarioContext, name: string): ExternalJournal<T> {
  return new ExternalJournal<T>(join(context.stateDir, 'external', `${name}.json`));
}

export function storePath(context: ScenarioContext, name = 'operator.sqlite'): string {
  mkdirSync(join(context.stateDir, 'operator'), { recursive: true });
  return join(context.stateDir, 'operator', name);
}

/** The observation mode a completed scenario reports, derived from how it was executed. */
export function observedMode(mode: ScenarioMode): RunObservation['mode'] {
  return mode === 'uninterrupted' ? 'uninterrupted' : 'recovered';
}
