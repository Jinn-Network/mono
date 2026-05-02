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
  ) {}

  async collect(_now: Date): Promise<TaskCandidate[]> {
    const generated = await this.generator();
    if (!generated) return [];
    const tasks = Array.isArray(generated) ? generated : [generated];
    return tasks.map((task) => {
      const bucketKey = taskDedupBucketKey(task);
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

function taskDedupBucketKey(task: Task): string {
  const source = task.spec?.['source'];
  const question = task.spec?.['question'];
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const venue = (source as Record<string, unknown>)['venue'];
    const identifiers = (source as Record<string, unknown>)['identifiers'];
    if (typeof venue === 'string' && identifiers && typeof identifiers === 'object' && !Array.isArray(identifiers)) {
      const conditionId = (identifiers as Record<string, unknown>)['conditionId'];
      if (typeof conditionId === 'string' && conditionId.length > 0) {
        return `${venue}:${conditionId}`;
      }
    }
    if (typeof venue === 'string') {
      const url = (source as Record<string, unknown>)['url'];
      const questionText =
        question && typeof question === 'object' && !Array.isArray(question)
          ? (question as Record<string, unknown>)['text']
          : undefined;
      const fallback = typeof url === 'string' && url.trim()
        ? url.trim()
        : typeof questionText === 'string'
          ? questionText.trim()
          : '';
      const normalized = fallback ? normaliseDedupKey(fallback) : '';
      if (normalized) return `${venue}:${normalized}`;
    }
  }
  return task.window
    ? `${task.window.startTs}:${task.window.endTs}`
    : task.id;
}

function normaliseDedupKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}
