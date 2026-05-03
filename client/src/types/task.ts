/**
 * Runtime shape of a Task — wraps SignedTaskV1 plus
 * runtime fields (attempt number, role, etc.).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WindowSchema, type Window } from './window.js';
import { SignedTaskV1Schema, TaskClaimPolicySchema, type SignedTaskV1, type TaskClaimPolicy } from './task-document.js';

export type RequestId = string;

// ── Window (re-exported for backwards compat) ─────────────────────────────────
export { WindowSchema, type Window };

// ── Task schema ─────────────────────────────────────────────────────

export const TaskSchema = z.object({
  id: z.string().optional(),
  description: z.string().min(1).optional(),
  context: z.record(z.unknown()).optional(),
  solverType: z.string().optional(),
  role: z.enum(['restoration', 'evaluation']).optional(),
  attemptId: z.string().optional(),
  attemptNumber: z.number().int().optional(),
  restorationRequestId: z.string().optional(),

  // §3 — optional lifecycle window
  window: WindowSchema.optional(),

  // §3 — typed task payload; dispatcher is top-level `solverType`.
  spec: z.record(z.unknown()).optional(),

  // §3 — pre-claim and post-hoc qualifying rules; shape governed by solverType
  eligibility: z.record(z.unknown()).optional(),

  // TaskCoordinator claim policy. Required on signed task.v1 documents, optional
  // on loose runtime Tasks so tests/configured tasks can use creator defaults.
  claimPolicy: TaskClaimPolicySchema.optional(),

  signedTask: SignedTaskV1Schema.optional(),
});

export interface Task {
  id: string;
  description: string;
  context?: Record<string, unknown>;
  solverType?: string;
  role?: 'restoration' | 'evaluation';
  attemptId?: string;
  attemptNumber?: number;
  restorationRequestId?: string;

  // §3 extensions (all optional for backwards compat)
  window?: Window;
  spec?: Record<string, unknown>;
  eligibility?: Record<string, unknown>;
  claimPolicy?: TaskClaimPolicy;

  signedTask?: SignedTaskV1;
}

export function parseTask(input: unknown): Task {
  const parsed = TaskSchema.parse(input);
  const signedTask = parsed.signedTask;
  const signedRuntime = signedTask as (SignedTaskV1 & {
    context?: Record<string, unknown>;
    attemptId?: string;
    attemptNumber?: number;
    restorationRequestId?: string;
  }) | undefined;
  const description = parsed.description ?? signedTask?.description;
  if (!description) {
    throw new Error('Task requires description (loose field or signedTask.description)');
  }
  const parsedSpec = parsed.spec as Record<string, unknown> | undefined;
  if (parsedSpec && Object.prototype.hasOwnProperty.call(parsedSpec, 'kind')) {
    throw new Error('Task spec.kind is retired; use top-level solverType');
  }
  const solverType = parsed.solverType ?? signedTask?.solverType;
  const spec = parsedSpec ?? signedTask?.spec;
  const claimPolicy = parsed.claimPolicy ?? signedTask?.claimPolicy;
  return {
    id: parsed.id ?? signedTask?.id ?? randomUUID(),
    description,
    context: parsed.context ?? signedRuntime?.context,
    solverType,
    role: parsed.role ?? signedTask?.role,
    attemptId: parsed.attemptId ?? signedRuntime?.attemptId,
    attemptNumber: parsed.attemptNumber ?? signedRuntime?.attemptNumber,
    restorationRequestId: parsed.restorationRequestId ?? signedRuntime?.restorationRequestId,
    window: parsed.window ?? signedTask?.window,
    spec,
    eligibility: parsed.eligibility ?? signedTask?.eligibility,
    claimPolicy,
    signedTask,
  };
}

export interface PostedTask {
  taskId: string;
  taskCid: string;
  txHash?: `0x${string}`;
  blockNumber?: number;
}

export interface TaskAnnouncement {
  taskId: string;
  task: Task;
  taskCid?: string;
  onchainCreationTx?: `0x${string}`;
  onchainCreationBlock?: number;
}

export interface TaskRequest {
  requestId: RequestId;
  taskId?: string;
  attemptIndex?: number;
  task: Task;
  payment?: string;
  timeout?: number;

  // On-chain provenance from the TaskCreated / TaskAttemptCreated event path
  taskCid?: string;                 // IPFS CID of the Task payload
  onchainCreationTx?: `0x${string}`; // tx hash of JinnRouterV3.createTask / claimTask
  onchainCreationBlock?: number;      // block number containing the tx
}

export interface TaskResult {
  data: string;
  artifacts?: string[];
}

export interface DeliveredResult {
  requestId: RequestId;
  task: Task;
  result: TaskResult;
  deliveryMechAddress: string;
}
