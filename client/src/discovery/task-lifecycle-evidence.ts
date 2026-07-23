/**
 * Pure assemblers for task lifecycle evidence (#2044).
 *
 * Authoritative spine is built only from task/attempt/verdict rows.
 * Envelope candidates attach last by (requestId, chainId) and never rewrite
 * spine fields. mergeTaskLifecycleEvidence keeps floor authoritative fields
 * and only overlays candidates from the candidate source.
 */
import type {
  AttemptEnvelopeCandidate,
  AuthoritativeAttemptRow,
  AuthoritativeTaskRow,
  AuthoritativeVerdictRow,
  TaskLifecycleEvidence,
  VerdictEnvelopeCandidate,
} from './types.js';

export type RawTaskRow = AuthoritativeTaskRow;
export type RawAttemptRow = Omit<AuthoritativeAttemptRow, 'verdicts' | 'attemptEnvelopeCandidates'>;
export type RawVerdictRow = Omit<AuthoritativeVerdictRow, 'verdictEnvelopeCandidates'>;

function attemptKey(taskId: string, attemptIndex: number, chainId: number): string {
  return `${taskId}|${attemptIndex}|${chainId}`;
}

function reqKey(requestId: string, chainId: number): string {
  return `${requestId.toLowerCase()}|${chainId}`;
}

export function assembleTaskLifecycleEvidence(input: {
  tasks: RawTaskRow[];
  attempts: RawAttemptRow[];
  verdicts: RawVerdictRow[];
  attemptCandidates?: AttemptEnvelopeCandidate[];
  verdictCandidates?: VerdictEnvelopeCandidate[];
}): Map<string, TaskLifecycleEvidence> {
  const out = new Map<string, TaskLifecycleEvidence>();
  for (const task of input.tasks) {
    out.set(task.taskId, {
      taskId: task.taskId,
      authoritative: { task: { ...task }, attempts: [] },
    });
  }

  const attemptsByTask = new Map<string, AuthoritativeAttemptRow[]>();
  for (const a of input.attempts) {
    if (!out.has(a.taskId)) continue;
    const row: AuthoritativeAttemptRow = {
      ...a,
      requestId: a.requestId.toLowerCase() as `0x${string}`,
      operator: a.operator.toLowerCase() as `0x${string}`,
      priorityMech: a.priorityMech.toLowerCase() as `0x${string}`,
      verdicts: [],
      attemptEnvelopeCandidates: [],
    };
    const list = attemptsByTask.get(a.taskId) ?? [];
    list.push(row);
    attemptsByTask.set(a.taskId, list);
  }

  const attemptIndex = new Map<string, AuthoritativeAttemptRow>();
  for (const [taskId, list] of attemptsByTask) {
    list.sort((x, y) => x.attemptIndex - y.attemptIndex);
    for (const row of list) {
      attemptIndex.set(attemptKey(row.taskId, row.attemptIndex, row.chainId), row);
    }
    out.get(taskId)!.authoritative.attempts = list;
  }

  const verdictsByAttempt = new Map<string, AuthoritativeVerdictRow[]>();
  for (const v of input.verdicts) {
    const key = attemptKey(v.taskId, v.attemptIndex, v.chainId);
    if (!attemptIndex.has(key)) continue;
    const row: AuthoritativeVerdictRow = {
      ...v,
      requestId: v.requestId.toLowerCase() as `0x${string}`,
      evaluator: v.evaluator.toLowerCase() as `0x${string}`,
      verdictEnvelopeCandidates: [],
    };
    const list = verdictsByAttempt.get(key) ?? [];
    list.push(row);
    verdictsByAttempt.set(key, list);
  }
  for (const [key, list] of verdictsByAttempt) {
    list.sort((x, y) => x.verdictIndex - y.verdictIndex);
    attemptIndex.get(key)!.verdicts = list;
  }

  const attemptsByReq = new Map<string, AuthoritativeAttemptRow[]>();
  for (const row of attemptIndex.values()) {
    const k = reqKey(row.requestId, row.chainId);
    const list = attemptsByReq.get(k) ?? [];
    list.push(row);
    attemptsByReq.set(k, list);
  }
  for (const c of input.attemptCandidates ?? []) {
    const list = attemptsByReq.get(reqKey(c.requestId, c.chainId));
    if (!list) continue;
    for (const a of list) a.attemptEnvelopeCandidates.push({ ...c });
  }

  const verdictsByReq = new Map<string, AuthoritativeVerdictRow[]>();
  for (const a of attemptIndex.values()) {
    for (const v of a.verdicts) {
      const k = reqKey(v.requestId, v.chainId);
      const list = verdictsByReq.get(k) ?? [];
      list.push(v);
      verdictsByReq.set(k, list);
    }
  }
  for (const c of input.verdictCandidates ?? []) {
    const list = verdictsByReq.get(reqKey(c.requestId, c.chainId));
    if (!list) continue;
    for (const v of list) v.verdictEnvelopeCandidates.push({ ...c });
  }

  return out;
}

function cloneAuthoritative(ev: TaskLifecycleEvidence): TaskLifecycleEvidence {
  return {
    taskId: ev.taskId,
    authoritative: {
      task: { ...ev.authoritative.task },
      attempts: ev.authoritative.attempts.map((a) => ({
        ...a,
        attemptEnvelopeCandidates: [],
        verdicts: a.verdicts.map((v) => ({
          ...v,
          verdictEnvelopeCandidates: [],
        })),
      })),
    },
  };
}

/**
 * Floor-wins merge: deep-clone authoritative spine from `authoritativeSource`,
 * then append candidates from `candidateSource` joined only by
 * (requestId, chainId). Never invents a spine from candidates alone; never
 * copies authoritative fields from the candidate source.
 */
export function mergeTaskLifecycleEvidence(
  authoritativeSource: Map<string, TaskLifecycleEvidence>,
  candidateSource: Map<string, TaskLifecycleEvidence>,
): Map<string, TaskLifecycleEvidence> {
  const out = new Map<string, TaskLifecycleEvidence>();
  for (const [taskId, src] of authoritativeSource) {
    out.set(taskId, cloneAuthoritative(src));
  }
  for (const [taskId, candEv] of candidateSource) {
    const base = out.get(taskId);
    if (!base) continue; // do not invent spine from candidates alone
    const byAttemptReq = new Map<string, (typeof base.authoritative.attempts)[0]>();
    for (const a of base.authoritative.attempts) {
      byAttemptReq.set(reqKey(a.requestId, a.chainId), a);
    }
    for (const ca of candEv.authoritative.attempts) {
      const a = byAttemptReq.get(reqKey(ca.requestId, ca.chainId));
      if (!a) continue;
      a.attemptEnvelopeCandidates.push(...ca.attemptEnvelopeCandidates.map((c) => ({ ...c })));
      const byVerdictReq = new Map(a.verdicts.map((v) => [reqKey(v.requestId, v.chainId), v]));
      for (const cv of ca.verdicts) {
        const v = byVerdictReq.get(reqKey(cv.requestId, cv.chainId));
        if (!v) continue;
        v.verdictEnvelopeCandidates.push(...cv.verdictEnvelopeCandidates.map((c) => ({ ...c })));
      }
    }
  }
  return out;
}
