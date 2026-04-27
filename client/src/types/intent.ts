/**
 * intent.v1 — canonical signed intent document.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §3.1 (K2).
 *
 * An `intent.v1` is the IPFS-addressed, signed document that declares:
 *   - what objective is being requested (kind + spec)
 *   - who created it (Safe + agent EOA)
 *   - when it was created (UTC ms)
 *   - when it applies (window)
 *   - per-kind eligibility rules
 *
 * Its CID is the root of every knowledge-tree query (restoration envelopes
 * reference `intent.cid`; verdict envelopes reference the same). The signed
 * form is what lives on IPFS; the unsigned canonical form (JCS of intent
 * minus `signature`) is what gets hashed + signed.
 */

import { z } from 'zod';
import { WindowSchema } from './window.js';

const HexStringSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

const CreatorSchema = z.object({
  safeAddress: HexStringSchema,
  agentEoa: HexStringSchema,
});

export const IntentV1Schema = z
  .object({
    schemaVersion: z.literal('intent.v1'),
    id: z.string().min(1),
    kind: z.string().min(1),
    description: z.string().min(1),
    window: WindowSchema,
    spec: z
      .object({ kind: z.string() })
      .and(z.record(z.unknown())),
    eligibility: z.record(z.unknown()),
    creator: CreatorSchema,
    createdAt: z.number().int(),
  })
  .refine((d) => d.kind === d.spec.kind, {
    message: 'top-level kind and spec.kind must match',
    path: ['spec', 'kind'],
  });

export type IntentV1 = z.infer<typeof IntentV1Schema>;

export const SignedIntentV1Schema = z
  .object({
    schemaVersion: z.literal('intent.v1'),
    id: z.string().min(1),
    kind: z.string().min(1),
    description: z.string().min(1),
    window: WindowSchema,
    spec: z.object({ kind: z.string() }).and(z.record(z.unknown())),
    eligibility: z.record(z.unknown()),
    creator: CreatorSchema,
    createdAt: z.number().int(),
    signature: SignatureSchema,
  })
  .refine((d) => d.kind === d.spec.kind, {
    message: 'top-level kind and spec.kind must match',
    path: ['spec', 'kind'],
  });

export type SignedIntentV1 = z.infer<typeof SignedIntentV1Schema>;

export function parseIntentV1(input: unknown): IntentV1 {
  return IntentV1Schema.parse(input);
}

export function parseSignedIntentV1(input: unknown): SignedIntentV1 {
  return SignedIntentV1Schema.parse(input);
}
