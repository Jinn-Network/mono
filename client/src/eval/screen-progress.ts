/**
 * Resumability store for held-out screening (#986).
 *
 * A real exam cut runs base R-runs + a prover over dozens of candidates — many
 * hours of inference. This store persists each candidate's {@link ScreenMeasurement}
 * so an interrupted run (rate limit, crash, disk) resumes instead of restarting:
 * re-running the same command replays cached candidates for free and the
 * `maxCandidates` budget bounds only the NEW work, so a long screen proceeds in
 * budget-sized chunks.
 *
 * Keyed by a `signature` of the measurement-determining config (base model,
 * prover, R, eval-semantics version). A signature mismatch on load → fresh start:
 * cached measurements are only valid for the exact config that produced them
 * (e.g. changing R changes the 0/R determination; a stronger base model changes
 * pass/fail). Stored at `<stateDir>/held-out-screen-progress.json`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScreenMeasurement } from './screen.js';

const SCHEMA_VERSION = 'held-out-screen-progress.v1' as const;

interface ProgressFile {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Config fingerprint; a mismatch invalidates the whole cache (fresh start). */
  signature: string;
  measurements: Record<string, ScreenMeasurement>;
}

export class ScreenProgressStore {
  private readonly file: string;
  private readonly signature: string;
  private data: ProgressFile;

  constructor(opts: { stateDir: string; signature: string }) {
    this.file = join(opts.stateDir, 'held-out-screen-progress.json');
    this.signature = opts.signature;
    this.data = this.load();
  }

  private load(): ProgressFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as ProgressFile;
      if (raw?.schemaVersion === SCHEMA_VERSION && raw.signature === this.signature && raw.measurements) {
        return raw;
      }
    } catch {
      /* absent or corrupt → fresh */
    }
    return { schemaVersion: SCHEMA_VERSION, signature: this.signature, measurements: {} };
  }

  /** Cached measurement for this instance under the current signature, or undefined. */
  get(instance_id: string): ScreenMeasurement | undefined {
    return this.data.measurements[instance_id];
  }

  /** Persist a freshly-measured candidate (atomic-enough: whole-file rewrite). */
  record(instance_id: string, m: ScreenMeasurement): void {
    this.data.measurements[instance_id] = m;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  /** Number of candidates already measured under the current signature. */
  get size(): number {
    return Object.keys(this.data.measurements).length;
  }
}

/** Build the cache signature from the measurement-determining config. */
export function screenSignature(args: {
  baseModel: string;
  proverHarness: string;
  proverModel: string;
  R: number;
  evalSemanticsVersion: string;
}): string {
  return `base=${args.baseModel}|prover=${args.proverHarness}:${args.proverModel}|R=${args.R}|sem=${args.evalSemanticsVersion}`;
}
