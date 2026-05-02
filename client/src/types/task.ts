/**
 * Runtime shape of a Task — wraps SignedTaskV1 plus
 * runtime fields (attempt number, role, etc.).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WindowSchema, type Window } from './window.js';
import { SignedTaskV1Schema, type SignedTaskV1 } from './task-document.js';

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
  taskId: z.string().optional(),
  restorationRequestId: z.string().optional(),

  // §3 — optional lifecycle window
  window: WindowSchema.optional(),

  // TaskCoordinator claim semantics; solverType-specific specs may require it.
  claimPolicy: z.record(z.unknown()).optional(),

  // §3 — typed task payload; dispatcher is top-level `solverType`.
  spec: z.record(z.unknown()).optional(),

  // §3 — pre-claim and post-hoc qualifying rules; shape governed by solverType
  eligibility: z.record(z.unknown()).optional(),

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
  taskId?: string;
  restorationRequestId?: string;

  // §3 extensions (all optional for backwards compat)
  window?: Window;
  claimPolicy?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  eligibility?: Record<string, unknown>;

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
  return {
    id: parsed.id ?? signedTask?.id ?? randomUUID(),
    description,
    context: parsed.context ?? signedRuntime?.context,
    solverType,
    role: parsed.role ?? signedTask?.role,
    attemptId: parsed.attemptId ?? signedRuntime?.attemptId,
    attemptNumber: parsed.attemptNumber ?? signedRuntime?.attemptNumber,
    taskId: parsed.taskId,
    restorationRequestId: parsed.restorationRequestId ?? signedRuntime?.restorationRequestId,
    window: parsed.window ?? signedTask?.window,
    claimPolicy: parsed.claimPolicy ?? signedTask?.claimPolicy,
    spec,
    eligibility: parsed.eligibility ?? signedTask?.eligibility,
    signedTask,
  };
}

export interface TaskRequest {
  requestId: RequestId;
  task: Task;
  payment?: string;
  timeout?: number;

  // TaskCoordinator provenance. Optional until the v3 adapter lands.
  taskId?: string;
  attemptIndex?: number;
  /** True when the adapter already performed TaskCoordinator claimTask(). */
  alreadyClaimed?: boolean;

  // On-chain provenance from the RestorationJobCreated / MarketplaceRequest event
  taskCid?: string;                 // IPFS CID of the Task payload
  onchainCreationTx?: `0x${string}`; // tx hash of JinnRouter.createRestorationJob
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
