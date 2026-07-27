/**
 * Runtime shape of a Task — wraps SignedTaskV1 plus
 * runtime fields (attempt number, role, etc.).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import { WindowSchema, type Window } from './window.js';
import {
  SignedTaskV1Schema,
  TaskClaimPolicySchema,
  ExecutionRequestSchema,
  type SignedTaskV1,
  type TaskClaimPolicy,
  type ExecutionRequest,
} from './task-document.js';

export type RequestId = string;

// ── Window (re-exported for backwards compat) ─────────────────────────────────
export { WindowSchema, type Window };

// ── Task schema ─────────────────────────────────────────────────────

export const TaskSchema = z.object({
  id: z.string().optional(),
  description: z.string().min(1).optional(),
  context: z.record(z.unknown()).optional(),
  /**
   * @deprecated Derived from `${contractId}.${contractVersion}` post Task 24
   * of spec/2026-05-05-solvernet-creation-and-launch.md. Kept on the runtime
   * Task for migration-period routing; new code should rely on
   * `contractId` / `contractVersion` and on `solverNetManifestCid` for
   * protocol identity.
   */
  solverType: z.string().optional(),
  /** SolverNet contract id (e.g. `prediction`). Spec §14. */
  contractId: z.string().optional(),
  /** SolverNet contract version (e.g. `v1`). Spec §14. */
  contractVersion: z.string().optional(),
  /**
   * BINDING — IPFS CID of the launched SolverNet manifest. The on-chain
   * `manifestDigest` is `keccak256(solverNetManifestCid)`. Required for
   * tasks posted through the production adapter (mech); optional on the
   * runtime Task type so tests / kitchen-sink consumers don't have to
   * supply it for paths that never hit `postTask`.
   */
  solverNetManifestCid: z.string().optional(),
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

  // Generic execution-profile pin (issue #2039). See ExecutionRequestSchema.
  executionRequest: ExecutionRequestSchema.optional(),

  signedTask: SignedTaskV1Schema.optional(),
});

export interface Task {
  id: string;
  description: string;
  context?: Record<string, unknown>;
  /**
   * @deprecated Derived from `${contractId}.${contractVersion}` post Task 24
   * of spec/2026-05-05-solvernet-creation-and-launch.md.
   */
  solverType?: string;
  /** SolverNet contract id (e.g. `prediction`). Spec §14. */
  contractId?: string;
  /** SolverNet contract version (e.g. `v1`). Spec §14. */
  contractVersion?: string;
  /**
   * BINDING — IPFS CID of the launched SolverNet manifest. The on-chain
   * `manifestDigest` is `keccak256(solverNetManifestCid)`. Required for
   * tasks posted through the production adapter (mech).
   */
  solverNetManifestCid?: string;
  role?: 'restoration' | 'evaluation';
  attemptId?: string;
  attemptNumber?: number;
  restorationRequestId?: string;

  // §3 extensions (all optional for backwards compat)
  window?: Window;
  spec?: Record<string, unknown>;
  eligibility?: Record<string, unknown>;
  claimPolicy?: TaskClaimPolicy;

  /** Generic execution-profile pin (issue #2039). See ExecutionRequestSchema. */
  executionRequest?: ExecutionRequest;

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
  const contractId = parsed.contractId ?? signedTask?.contractId;
  const contractVersion = parsed.contractVersion ?? signedTask?.contractVersion;
  const solverNetManifestCid = parsed.solverNetManifestCid ?? signedTask?.solverNetManifestCid;
  const spec = parsedSpec ?? signedTask?.spec;
  const claimPolicy = parsed.claimPolicy ?? signedTask?.claimPolicy;
  const executionRequest = parsed.executionRequest ?? signedTask?.executionRequest;
  return {
    id: parsed.id ?? signedTask?.id ?? randomUUID(),
    description,
    context: parsed.context ?? signedRuntime?.context,
    solverType,
    contractId,
    contractVersion,
    solverNetManifestCid,
    role: parsed.role ?? signedTask?.role,
    attemptId: parsed.attemptId ?? signedRuntime?.attemptId,
    attemptNumber: parsed.attemptNumber ?? signedRuntime?.attemptNumber,
    restorationRequestId: parsed.restorationRequestId ?? signedRuntime?.restorationRequestId,
    window: parsed.window ?? signedTask?.window,
    spec,
    eligibility: parsed.eligibility ?? signedTask?.eligibility,
    claimPolicy,
    executionRequest,
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
  /** Transaction that emitted the task's canonical TaskCreated event. */
  onchainCreationTx?: `0x${string}`;
  /** Block that emitted the task's canonical TaskCreated event. */
  onchainCreationBlock?: number;
  /** Event that surfaced this opportunity when it is not TaskCreated itself. */
  onchainOpportunityTx?: `0x${string}`;
  onchainOpportunityBlock?: number;
}

export interface TaskRequest {
  requestId: RequestId;
  taskId?: string;
  attemptIndex?: number;
  task: Task;
  payment?: string;
  timeout?: number;

  // Canonical task provenance. These always refer to TaskCreated, never the
  // later TaskAttemptCreated / evaluation-claim event.
  taskCid?: string;                   // IPFS CID of the Task payload
  onchainCreationTx?: `0x${string}`; // tx hash of JinnRouterV3.createTask
  onchainCreationBlock?: number;      // block number containing TaskCreated

  // Claim provenance is kept separate so a later attempt block can never be
  // mistaken for task creation when task.createdAt is assembled.
  onchainClaimTx?: `0x${string}`;
  onchainClaimBlock?: number;
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
