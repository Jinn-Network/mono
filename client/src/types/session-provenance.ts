import { z } from 'zod/v3';

export const SessionProvenanceSchema = z.object({
  sessionId: z.string().min(1),
  capturedAt: z.string().datetime(),
  originatingTool: z.object({
    name: z.string(),
    version: z.string().optional(),
  }),
  repo: z.object({
    remoteUrl: z.string().optional(),
    commitHash: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    branch: z.string().optional(),
  }).optional(),
  license: z.object({
    spdxId: z.string().optional(),
    operatorAssertion: z.enum(['asserted', 'unspecified']),
  }),
});

export type SessionProvenance = z.infer<typeof SessionProvenanceSchema>;
