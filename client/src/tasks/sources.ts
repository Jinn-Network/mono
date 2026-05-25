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

/**
 * Filter a config-level tasks[] array to only entries that can be posted via
 * the production adapter (i.e. those with a solverNetManifestCid).
 *
 * This is the guard for issue #415: a tasks[] entry without a manifest CID
 * will always throw PermanentError in signTaskDocument, causing the creator loop
 * to backoff and retry indefinitely. Filtering here prevents the entry from ever
 * entering the posting cycle and emits a one-time warning per dropped entry at
 * startup.
 *
 * Only call this on the config-level tasks[] array (the production path). Do not
 * apply it to Task objects created in tests or via other in-memory sources.
 */
export function filterBindableTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => {
    if (!task.solverNetManifestCid) {
      console.warn(
        `[creator] Skipping configured task "${task.id}": missing solverNetManifestCid. ` +
        `Legacy tasks[] entries without a SolverNet manifest binding can never be posted ` +
        `(spec §14 BINDING rule). Remove this entry from your config or add a solverNetManifestCid.`,
      );
      return false;
    }
    return true;
  });
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
