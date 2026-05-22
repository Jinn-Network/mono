import type { Task } from '../types/task.js';

/** Returns freshly-built Tasks for this tick, or null to skip. */
export type TaskGenerator = () => Promise<Task | Task[] | null>;

export type TaskPostingPolicy =
  | { kind: 'once_per_safe' }
  | { kind: 'once_per_bucket'; bucketKey: string }
  | { kind: 'interval'; intervalMs: number; scopeKey?: string };

export interface TaskCandidate {
  task: Task;
  sourceKey: string;
  postingPolicy: TaskPostingPolicy;
  /**
   * IPFS CID of the signed Task document, if already uploaded by the caller
   * (e.g. `jinn tasks submit --spec-file`). When present, the posting service
   * uses it to register the Task on the ERC-8004 Identity Registry after a
   * successful on-chain post (best-effort, Plan E).
   */
  taskCid?: string;
  sourceMeta?: {
    solverType?: string;
    bucketKey?: string;
    note?: string;
  };
}

export interface TaskSource {
  sourceKey: string;
  collect(now: Date): Promise<TaskCandidate[]>;
}

export class StaticConfiguredTaskSource implements TaskSource {
  readonly sourceKey = 'configured';

  constructor(private readonly tasks: Task[]) {}

  async collect(_now: Date): Promise<TaskCandidate[]> {
    return this.tasks.map((task) => ({
      task,
      sourceKey: `${this.sourceKey}:${task.id}`,
      postingPolicy: { kind: 'once_per_safe' },
      sourceMeta: { solverType: task.solverType, note: 'configured' },
    }));
  }
}

export class GeneratedTaskSource implements TaskSource {
  constructor(
    readonly sourceKey: string,
    private readonly generator: TaskGenerator,
    private readonly opts: {
      bucketKeyForTask?: (task: Task, index: number) => string | undefined;
    } = {},
  ) {}

  async collect(_now: Date): Promise<TaskCandidate[]> {
    const generated = await this.generator();
    if (!generated) return [];
    const tasks = Array.isArray(generated) ? generated : [generated];
    return tasks.map((task, index) => {
      const overrideBucketKey = this.opts.bucketKeyForTask?.(task, index);
      const bucketKey = overrideBucketKey
        ?? (task.window
          ? `${task.window.startTs}:${task.window.endTs}`
          : task.id);
      return {
        task,
        sourceKey: this.sourceKey,
        postingPolicy: { kind: 'once_per_bucket' as const, bucketKey },
        sourceMeta: {
          solverType: task.solverType,
          bucketKey,
          note: 'generated',
        },
      };
    });
  }
}
