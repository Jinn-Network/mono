/**
 * task.v1 — canonical signed Task document.
 *
 * This is the IPFS-addressed, signed document posted through the deployed
 * router compatibility surface. `solverType` is the protocol join key; `spec`
 * is the SolverType-specific payload.
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

const NoLegacyKindSchema = z.record(z.unknown()).superRefine((spec, ctx) => {
  if (Object.prototype.hasOwnProperty.call(spec, 'kind')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spec.kind is retired; use top-level solverType',
      path: ['kind'],
    });
  }
});

const TaskV1Fields = {
  schemaVersion: z.literal('task.v1'),
  id: z.string().min(1),
  solverType: z.string().min(1),
  role: z.enum(['restoration', 'evaluation']).default('restoration'),
  description: z.string().min(1),
  window: WindowSchema,
  spec: NoLegacyKindSchema,
  eligibility: z.record(z.unknown()),
  creator: CreatorSchema,
  createdAt: z.number().int(),
};

function rejectTopLevelKind<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.passthrough().superRefine((task, ctx) => {
    if (Object.prototype.hasOwnProperty.call(task, 'kind')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'kind is retired; use top-level solverType',
        path: ['kind'],
      });
    }
  }).transform((task) => {
    const { kind: _kind, ...canonical } = task as z.infer<typeof schema> & { kind?: unknown };
    return canonical as z.infer<typeof schema>;
  });
}

export const TaskV1Schema = rejectTopLevelKind(z.object(TaskV1Fields));

export type TaskV1 = z.infer<typeof TaskV1Schema>;

export const SignedTaskV1Schema = rejectTopLevelKind(z.object({
  ...TaskV1Fields,
  signature: SignatureSchema,
}));

export type SignedTaskV1 = z.infer<typeof SignedTaskV1Schema>;

export function parseTaskV1(input: unknown): TaskV1 {
  return TaskV1Schema.parse(input);
}

export function parseSignedTaskV1(input: unknown): SignedTaskV1 {
  return SignedTaskV1Schema.parse(input);
}
