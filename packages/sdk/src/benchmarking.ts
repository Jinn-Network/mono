import { createHash } from 'node:crypto';
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

/** Minimal RFC 8785 JCS — identical algorithm to swe-rebench-v2-held-out-slate.ts */
function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Digest(canonical: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function hashCapsuleSet(input: {
  capsuleDigests: string[];
  admissionReceiptRefs: string[];
}): `sha256:${string}` {
  return sha256Digest(
    canonicalJson({
      capsuleDigests: input.capsuleDigests,
      admissionReceiptRefs: input.admissionReceiptRefs,
    }),
  );
}

const CapsuleSetZ = z
  .object({
    capsuleDigests: z.array(z.string().min(1)).min(1),
    admissionReceiptRefs: z.array(z.string().min(1)).min(1),
    setHash: Sha256DigestZ,
  })
  .strict();

const PolicyZ = z
  .object({
    completenessFloor: z.number().finite().gt(0).lte(1),
    replacementPolicy: z.string().min(1),
    eligibilityExclusions: z.array(z.string()),
    cellWindow: z.string().min(1),
    selfEvaluation: z.literal(false),
  })
  .strict();

const BudgetZ = z
  .object({
    perCellFees: z
      .object({
        solveWei: NumericStringZ,
        verdictWei: NumericStringZ,
      })
      .strict(),
    hardCapWei: NumericStringZ,
  })
  .strict();

export const BenchmarkRunV1Schema = z
  .object({
    runId: z.string().min(1),
    consumer: z.string().min(1),
    capsuleSet: CapsuleSetZ,
    configs: z.array(ConfigV1Schema).min(1),
    replicates: z.number().int().gte(1),
    policy: PolicyZ,
    budget: BudgetZ,
    preRegistrationHash: Sha256DigestZ,
  })
  .strict()
  .superRefine((run, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < run.configs.length; i++) {
      const id = run.configs[i]!.configId;
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate configId: ${id}`,
          path: ['configs', i, 'configId'],
        });
      }
      seen.add(id);
    }
  });

export type BenchmarkRunV1 = z.infer<typeof BenchmarkRunV1Schema>;

export function hashBenchmarkRunV1(run: BenchmarkRunV1): `sha256:${string}` {
  const { preRegistrationHash: _omit, ...rest } = run;
  return sha256Digest(canonicalJson(rest));
}

/** Documented alias — identical projection/result as preRegistrationHash computation (AC2). */
export const computeRunHash = hashBenchmarkRunV1;

export function validateBenchmarkRunV1(
  value: unknown,
): BenchmarkValidationResult<BenchmarkRunV1> {
  const parsed = BenchmarkRunV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) };
  const run = parsed.data;
  const issues: BenchmarkValidationIssue[] = [];

  const expectedSet = hashCapsuleSet({
    capsuleDigests: run.capsuleSet.capsuleDigests,
    admissionReceiptRefs: run.capsuleSet.admissionReceiptRefs,
  });
  if (run.capsuleSet.setHash !== expectedSet) {
    issues.push({ path: 'capsuleSet.setHash', message: 'hash mismatch' });
  }

  const expectedPre = hashBenchmarkRunV1(run);
  if (run.preRegistrationHash !== expectedPre) {
    issues.push({ path: 'preRegistrationHash', message: 'hash mismatch' });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: run };
}

const SignatureZ = z
  .object({
    alg: z.literal('eip-191'),
    signer: HexStringZ,
    value: HexStringZ,
  })
  .strict();

export const BenchPreregistrationV1Schema = z
  .object({
    schemaVersion: z.literal('jinn.bench-preregistration.v1'),
    run: BenchmarkRunV1Schema,
    signature: SignatureZ,
  })
  .strict();

export type BenchPreregistrationV1 = z.infer<typeof BenchPreregistrationV1Schema>;

/**
 * Shape + hash checks only — matches SolverNet manifest practice. This does
 * NOT cryptographically verify `signature.value` against `signature.signer`.
 * `ok: true` means the input parses and its content hashes match, not that
 * the EIP-191 signature is valid; callers must not treat it as signature
 * proof. A real `verifyBenchPreregistrationSignature` can land later if
 * cryptographic verification is needed.
 */
export function validateBenchPreregistrationV1(
  value: unknown,
): BenchmarkValidationResult<BenchPreregistrationV1> {
  const parsed = BenchPreregistrationV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) };
  const runCheck = validateBenchmarkRunV1(parsed.data.run);
  if (!runCheck.ok) {
    return {
      ok: false,
      issues: runCheck.issues.map((i) => ({
        path: i.path === '<root>' ? 'run' : `run.${i.path}`,
        message: i.message,
      })),
    };
  }
  return { ok: true, value: parsed.data };
}

const VerificationZ = z
  .object({
    loadout: z.enum(['match', 'mismatch', 'unverifiable']),
    profile: z.enum(['match', 'mismatch', 'unverifiable']),
    isolation: z.string().min(1),
  })
  .strict();

const CostZ = z
  .object({
    reported: z.union([NumericStringZ, z.number().finite().nonnegative()]),
    source: z.string().min(1),
  })
  .strict();

export const CellV1Schema = z
  .object({
    cellKey: z.string().min(1),
    capsuleDigest: z.string().min(1),
    configId: z.string().min(1),
    replicate: z.number().int().nonnegative(),
    attemptEnvelopeCid: z.string().min(1).optional(),
    verdictEnvelopeRef: z.string().min(1).optional(),
    outcome: z.enum(['judged', 'unscorable', 'expired', 'invalidated']),
    verification: VerificationZ,
    judgeIntegrityTier: z.enum(['re-derivable', 'attested-only']),
    solverId: z.string().min(1),
    evaluatorId: z.string().min(1),
    cost: CostZ,
    latencyMs: z.number().finite().nonnegative(),
  })
  .strict();

export type CellV1 = z.infer<typeof CellV1Schema>;

const CloseBoundaryZ = z
  .object({
    blockNumber: z.number().int().positive().optional(),
    timestamp: z.string().min(1),
  })
  .strict();

export const BenchMatrixV1Schema = z
  .object({
    schemaVersion: z.literal('jinn.bench-matrix.v1'),
    runId: z.string().min(1),
    preRegistration: BenchmarkRunV1Schema,
    closeBoundary: CloseBoundaryZ,
    cells: z.array(CellV1Schema),
    exclusions: z.array(
      z.object({ cellKey: z.string().min(1), reason: z.string().min(1) }).strict(),
    ),
    attrition: z
      .object({
        perConfig: z.record(z.string(), z.number().finite().nonnegative()),
        perCapsule: z.record(z.string(), z.number().finite().nonnegative()),
        asymmetryFlags: z.array(z.string()),
      })
      .strict(),
    completeness: z
      .object({
        achieved: z.number().finite().nonnegative(),
        floor: z.number().finite().nonnegative(),
        runOutcome: z.enum(['complete', 'partial', 'cancelled']),
      })
      .strict(),
    matrixHash: Sha256DigestZ,
  })
  .strict()
  .superRefine((matrix, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < matrix.cells.length; i++) {
      const key = matrix.cells[i]!.cellKey;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate cellKey: ${key}`,
          path: ['cells', i, 'cellKey'],
        });
      }
      seen.add(key);
    }
  });

export type BenchMatrixV1 = z.infer<typeof BenchMatrixV1Schema>;

export function hashBenchMatrixV1(matrix: BenchMatrixV1): `sha256:${string}` {
  const { matrixHash: _omit, ...rest } = matrix;
  return sha256Digest(canonicalJson(rest));
}

export function validateBenchMatrixV1(
  value: unknown,
): BenchmarkValidationResult<BenchMatrixV1> {
  const parsed = BenchMatrixV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) };
  const matrix = parsed.data;
  const issues: BenchmarkValidationIssue[] = [];

  const runCheck = validateBenchmarkRunV1(matrix.preRegistration);
  if (!runCheck.ok) {
    for (const i of runCheck.issues) {
      issues.push({
        path: i.path === '<root>' ? 'preRegistration' : `preRegistration.${i.path}`,
        message: i.message,
      });
    }
  }

  const expected = hashBenchMatrixV1(matrix);
  if (matrix.matrixHash !== expected) {
    issues.push({ path: 'matrixHash', message: 'hash mismatch' });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: matrix };
}
