/**
 * Local mineable-trace retention store for task-creator sessions.
 * Spec: spec/2026-07-08-task-creator-v0.md §10. Per mono#1714 local retention
 * is UNCONDITIONAL — the store never leaves the machine; whether a mined task
 * is published off the box is gated separately by the single `share` consent
 * (stamped onto each record as `publishMinedTasksConsent`).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve as resolvePath, join } from 'node:path';

export const MINEABLE_TRACE_STORE_SCHEMA_VERSION = 'mineable-trace-store.v1' as const;
const MINEABLE_TRACE_FILE = 'mineable-traces.json';

export interface MineableTestRun {
  cmd: string;
  exitCode: number;
  at: string;
}

export interface MineableSkillEvent {
  skill: string;
  action: 'loaded' | 'invoked';
}

export interface MineableTraceRecord {
  sourceId: string; // opaque local id; never published
  kind: 'solvernet-execution' | 'harness-session';
  repo: string; // owner/name
  baseCommit: string;
  acceptedDiff: string; // candidate gold (spec §10 field 2)
  testRuns: MineableTestRun[]; // verifier seed (field 3)
  intermediateFailureDiffs: string[]; // negative exemplars (field 4)
  skillEvents: MineableSkillEvent[]; // §12 option value (field 5)
  sourceInstanceId?: string; // set when kind === 'solvernet-execution'
  publishMinedTasksConsent: boolean; // the single `share` consent — may this mint be published
  createdAt: string; // ISO — injected by caller, never Date.now() in the store
}

interface MineableTraceFile {
  schemaVersion: typeof MINEABLE_TRACE_STORE_SCHEMA_VERSION;
  records: Record<string, MineableTraceRecord & { mined?: boolean }>;
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(resolvePath(join(file, '..')), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * Pure assembler: builds a well-formed {@link MineableTraceRecord} from
 * whatever fields a producer (e.g. the engine's pack() hook, Task 7) has in
 * scope, filling optional contract fields (§10) with empty defaults rather
 * than leaving them undefined. `now` is injected so callers stay
 * deterministic in tests — the store itself never calls Date.now().
 */
export function buildMineableRecord(ctx: {
  sourceId: string;
  kind: MineableTraceRecord['kind'];
  repo: string;
  baseCommit: string;
  acceptedDiff: string;
  testRuns?: MineableTestRun[];
  intermediateFailureDiffs?: string[];
  skillEvents?: MineableSkillEvent[];
  sourceInstanceId?: string;
  publishMinedTasksConsent: boolean;
  now: () => string;
}): MineableTraceRecord {
  return {
    sourceId: ctx.sourceId,
    kind: ctx.kind,
    repo: ctx.repo,
    baseCommit: ctx.baseCommit,
    acceptedDiff: ctx.acceptedDiff,
    testRuns: ctx.testRuns ?? [],
    intermediateFailureDiffs: ctx.intermediateFailureDiffs ?? [],
    skillEvents: ctx.skillEvents ?? [],
    ...(ctx.sourceInstanceId !== undefined ? { sourceInstanceId: ctx.sourceInstanceId } : {}),
    publishMinedTasksConsent: ctx.publishMinedTasksConsent,
    createdAt: ctx.now(),
  };
}

export class MineableTraceStore {
  private readonly file: string;
  private cache: MineableTraceFile | null = null;

  constructor(opts: { stateDir: string }) {
    this.file = resolvePath(join(opts.stateDir, MINEABLE_TRACE_FILE));
  }

  private fresh(): MineableTraceFile {
    return {
      schemaVersion: MINEABLE_TRACE_STORE_SCHEMA_VERSION,
      records: {},
    };
  }

  private async load(): Promise<MineableTraceFile> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as MineableTraceFile;
      if (raw.schemaVersion === MINEABLE_TRACE_STORE_SCHEMA_VERSION) {
        this.cache = raw;
        return raw;
      }
    } catch {
      // missing
    }
    this.cache = this.fresh();
    return this.cache;
  }

  /** Unconditional local retention (mono#1714) — the store never leaves the machine. */
  async append(record: MineableTraceRecord): Promise<void> {
    const file = await this.load();
    file.records[record.sourceId] = { ...record };
    await writeJsonAtomic(this.file, file);
    this.cache = file;
  }

  async listUnmined(): Promise<MineableTraceRecord[]> {
    const file = await this.load();
    return Object.values(file.records)
      .filter((r) => !r.mined)
      .map(({ mined: _mined, ...record }) => record);
  }

  async markMined(sourceId: string): Promise<void> {
    const file = await this.load();
    const record = file.records[sourceId];
    if (!record) return;
    record.mined = true;
    await writeJsonAtomic(this.file, file);
    this.cache = file;
  }
}
