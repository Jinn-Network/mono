/**
 * Shared evidence-logging + verdict-construction scaffold for Tier 2 scenario
 * callables (T2.1, T2.2).
 *
 * This module factors out the pure boilerplate the callables have in common —
 * timestamped line collection, best-effort flush to the evidence file, and
 * ScenarioVerdict construction — so the callables themselves are left holding
 * only their scenario-specific logic.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { classifyFailure, type ScenarioVerdict } from '../../../scripts/release/scenario-types.js';

/**
 * Collects timestamped evidence lines for one scenario run and flushes them to
 * the evidence file on demand. Flushing is best-effort: a write failure never
 * masks the scenario's primary error.
 */
export class EvidenceLog {
  private readonly lines: string[] = [];

  constructor(private readonly evidencePath: string) {}

  /** Append a timestamped line to the evidence buffer. */
  log(msg: string): void {
    this.lines.push(`[${new Date().toISOString()}] ${msg}`);
  }

  /** Write the buffered lines to the evidence file. Never throws. */
  async flush(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.evidencePath), { recursive: true });
      await fs.writeFile(this.evidencePath, this.lines.join('\n') + '\n');
    } catch {
      // best-effort; don't mask the primary error
    }
  }
}

/** Build a `pass` verdict — used when the scenario's happy path completed. */
export function passVerdict(args: {
  scenarioId: string;
  startedAt: number;
  evidencePath: string;
}): ScenarioVerdict {
  return {
    scenarioId: args.scenarioId,
    verdict: 'pass',
    wallClockMs: Date.now() - args.startedAt,
    evidencePath: args.evidencePath,
    failClass: null,
    failNotes: null,
  };
}

/** Build a `skip` verdict — used for missing-prerequisite / missing-endpoint paths. */
export function skipVerdict(args: {
  scenarioId: string;
  startedAt: number;
  evidencePath: string;
  failNotes: string;
}): ScenarioVerdict {
  return {
    scenarioId: args.scenarioId,
    verdict: 'skip',
    wallClockMs: Date.now() - args.startedAt,
    evidencePath: args.evidencePath,
    failClass: null,
    failNotes: args.failNotes,
  };
}

/** Build a `fail` verdict from a thrown error, classifying the failure. */
export function failVerdict(args: {
  scenarioId: string;
  startedAt: number;
  evidencePath: string;
  error: unknown;
}): ScenarioVerdict {
  return {
    scenarioId: args.scenarioId,
    verdict: 'fail',
    wallClockMs: Date.now() - args.startedAt,
    evidencePath: args.evidencePath,
    failClass: classifyFailure(args.error),
    failNotes: args.error instanceof Error ? args.error.message : String(args.error),
  };
}
