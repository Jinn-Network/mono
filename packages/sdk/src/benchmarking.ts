import { z } from 'zod/v3';

const Sha256DigestZ = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, { message: 'must be sha256:<64 hex chars>' });

const NumericStringZ = z
  .string()
  .regex(/^\d+$/u, { message: 'must be a non-negative integer string (wei)' });

const HexStringZ = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/u, {
    message: 'must be 0x-prefixed hex with at least one hex digit',
  }) as z.ZodType<`0x${string}`>;

const SolveProfileZ = z
  .object({
    harness: z.string().min(1),
    harnessVersionOrDigest: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();

const LoadoutZ = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('artifact'),
      ref: z.string().min(1),
      sha256: Sha256DigestZ,
    })
    .strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);

export const ConfigV1Schema = z
  .object({
    configId: z.string().min(1),
    solveProfile: SolveProfileZ,
    loadout: LoadoutZ,
    envOverrides: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ConfigV1 = z.infer<typeof ConfigV1Schema>;

export interface BenchmarkValidationIssue {
  path: string;
  message: string;
}

export type BenchmarkValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: BenchmarkValidationIssue[] };

function issuesFromZod(error: z.ZodError): BenchmarkValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '<root>',
    message: issue.message,
  }));
}

export function validateConfigV1(value: unknown): BenchmarkValidationResult<ConfigV1> {
  const parsed = ConfigV1Schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: issuesFromZod(parsed.error) };
}
