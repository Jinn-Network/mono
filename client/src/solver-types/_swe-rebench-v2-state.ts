/**
 * Persistent generator state for the swe-rebench-v2 task generator.
 * Tracks per-task posted_count, successful_count, last_posted_at across
 * daemon restarts. Stored at `<stateDir>/generator-state.json`.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskCounters {
  posted: number;
  successful: number;
  last_posted_at: number; // ms epoch
  /** On-chain taskId of the most-recent posting for this instance (#802).
   *  Set by CreatorLoop after the post resolves; used by the generator to look
   *  up claim exhaustion via DiscoveryAPI.getInstanceClaimCounts. */
  last_task_id?: string;
}

interface StateFile {
  schemaVersion: 'swe-rebench-v2-generator-state.v1';
  tasks: Record<string, TaskCounters>;
}

export class GeneratorStateStore {
  private stateFile: string;
  private cache: StateFile | null = null;

  constructor(opts: { stateDir: string }) {
    this.stateFile = join(opts.stateDir, 'generator-state.json');
  }

  private async load(): Promise<StateFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      this.cache = JSON.parse(raw);
    } catch {
      this.cache = { schemaVersion: 'swe-rebench-v2-generator-state.v1', tasks: {} };
    }
    return this.cache!;
  }

  private async save(): Promise<void> {
    if (!this.cache) return;
    await mkdir(join(this.stateFile, '..'), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(this.cache, null, 2));
  }

  async getCounters(instance_id: string): Promise<TaskCounters> {
    const state = await this.load();
    return state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
  }

  async recordPosted(instance_id: string, now: number = Date.now()): Promise<void> {
    const state = await this.load();
    const c = state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
    c.posted += 1;
    c.last_posted_at = now;
    state.tasks[instance_id] = c;
    await this.save();
  }

  async recordSuccess(instance_id: string): Promise<void> {
    const state = await this.load();
    const c = state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
    c.successful += 1;
    state.tasks[instance_id] = c;
    await this.save();
  }

  async recordLastTaskId(instance_id: string, taskId: string): Promise<void> {
    const state = await this.load();
    const c = state.tasks[instance_id] ?? { posted: 0, successful: 0, last_posted_at: 0 };
    c.last_task_id = taskId;
    state.tasks[instance_id] = c;
    await this.save();
  }
}
