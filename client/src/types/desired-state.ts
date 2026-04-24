/**
 * Runtime shape of a restoration / evaluation job — wraps SignedIntentV1
 * (see ./intent.ts) plus runtime fields (attempt number, type, etc.).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type RequestId = string;

// ── Window ───────────────────────────────────────────────────────────────────

export const WindowSchema = z.object({
  startTs: z.number().int(),
  endTs: z.number().int(),
});

export type Window = z.infer<typeof WindowSchema>;

// ── RestorationJob schema ─────────────────────────────────────────────────────

export const RestorationJobSchema = z.object({
  id: z.string().optional(),
  description: z.string().min(1),
  context: z.record(z.unknown()).optional(),

  // §3 — optional lifecycle window
  window: WindowSchema.optional(),

  // §3 — typed intent specification; dispatcher on `kind`
  spec: z
    .object({
      kind: z.string(),
    })
    .and(z.record(z.unknown()))
    .optional(),

  // §3 — pre-claim and post-hoc qualifying rules; shape governed by spec.kind
  eligibility: z.record(z.unknown()).optional(),
});

export interface RestorationJob {
  id: string;
  description: string;
  context?: Record<string, unknown>;
  type?: 'restoration' | 'evaluation';
  attemptId?: string;
  attemptNumber?: number;
  restorationRequestId?: string;

  // §3 extensions (all optional for backwards compat)
  window?: Window;
  spec?: { kind: string } & Record<string, unknown>;
  eligibility?: Record<string, unknown>;
}

export function parseRestorationJob(input: unknown): RestorationJob {
  const parsed = RestorationJobSchema.parse(input);
  return {
    id: parsed.id ?? randomUUID(),
    description: parsed.description,
    context: parsed.context,
    window: parsed.window,
    spec: parsed.spec as RestorationJob['spec'],
    eligibility: parsed.eligibility,
  };
}

export interface RestorationRequest {
  requestId: RequestId;
  restorationJob: RestorationJob;
  payment?: string;
  timeout?: number;

  // On-chain provenance from the RestorationJobCreated / MarketplaceRequest event
  intentCid?: string;                 // IPFS CID of the RestorationJob payload
  onchainCreationTx?: `0x${string}`; // tx hash of JinnRouter.createRestorationJob
  onchainCreationBlock?: number;      // block number containing the tx
}

export interface RestorationResult {
  data: string;
  artifacts?: string[];
}

export interface DeliveredResult {
  requestId: RequestId;
  restorationJob: RestorationJob;
  result: RestorationResult;
  deliveryMechAddress: string;
}
