/**
 * Runtime shape of a restoration / evaluation job — wraps SignedIntentV1
 * (see ./intent.ts) plus runtime fields (attempt number, type, etc.).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WindowSchema, type Window } from './window.js';
import { SignedIntentV1Schema, type SignedIntentV1 } from './intent.js';

export type RequestId = string;

// ── Window (re-exported for backwards compat) ─────────────────────────────────
export { WindowSchema, type Window };

// ── RestorationJob schema ─────────────────────────────────────────────────────

export const RestorationJobSchema = z.object({
  id: z.string().optional(),
  description: z.string().min(1).optional(),
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

  // §4 — optional typed signed intent; loose fields hydrate from this when absent
  intent: SignedIntentV1Schema.optional(),
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

  // §4 — typed signed intent (Plan C will migrate consumers to read this directly)
  intent?: SignedIntentV1;
}

export function parseRestorationJob(input: unknown): RestorationJob {
  const parsed = RestorationJobSchema.parse(input);
  const intent = parsed.intent;
  const description = parsed.description ?? intent?.description;
  if (!description) {
    throw new Error('RestorationJob requires description (loose field or intent.description)');
  }
  return {
    id: parsed.id ?? intent?.id ?? randomUUID(),
    description,
    context: parsed.context,
    window: parsed.window ?? intent?.window,
    spec: (parsed.spec ?? intent?.spec) as RestorationJob['spec'],
    eligibility: parsed.eligibility ?? intent?.eligibility,
    intent,
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
