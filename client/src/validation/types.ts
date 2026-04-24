/**
 * Validation Registry request/response payload schemas.
 *
 * Scope: §3.3 row "Attestation verification (V2) — Hybrid. On-chain record
 * of challenger verifications via ERC-8004 Validation Registry —
 * validationRequest from a challenger, validationResponse with their
 * off-chain-computed verdict."
 *
 * V1 ships the Validation Registry client (this module + client/src/validation/registry.ts)
 * so it's available for challenger workflows once the verification SDK lands
 * in Plan F / V2. V1 payload schema covers the attestation-verify case; future
 * request types (e.g. 'reproducible-build-verify', 'trajectory-conformance')
 * extend the union.
 */

import { z } from 'zod';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const AttestationVerifyRequestSchema = z.object({
  requestType: z.literal('attestation-verify'),
  envelopeCid: z.string().min(1),
  envelopeHash: HexStringSchema,
  challenger: HexStringSchema, // safe address
  sdkVersion: z.string().min(1),
  createdAt: z.number().int(),
});
export type AttestationVerifyRequest = z.infer<typeof AttestationVerifyRequestSchema>;

const VerifyCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});

export const AttestationVerifyResponseSchema = z.object({
  requestType: z.literal('attestation-verify'),
  envelopeCid: z.string().min(1),
  verdict: z.enum(['valid', 'invalid']),
  checks: z.array(VerifyCheckSchema),
  responder: HexStringSchema,
  respondedAt: z.number().int(),
});
export type AttestationVerifyResponse = z.infer<typeof AttestationVerifyResponseSchema>;
