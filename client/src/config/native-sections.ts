/**
 * Dark shape-v2 native sections — the config surface the one-swap's native
 * machinery reads (umbrella #2461, DR-2026-08-05, milestone M1).
 *
 * These keys land on the LEGACY `config.json` under `configShapeVersion: 2`,
 * beside `claimPolicy` / `executionWiring[]` / `posting[]` (program §5 naming
 * law). They are deliberately **unused on the current daemon path**: M1 only
 * teaches the loader to accept them, M2 consumes them.
 *
 * Three rules govern this file:
 *
 * 1. **Additive and absent-tolerant.** Every section is optional at the root.
 *    Absent means "not configured", never an error. The root stays non-strict
 *    (legacy tolerance is the point); each section here is `.strict()`, so a
 *    typo inside a configured section is a refusal rather than a silently
 *    dropped field.
 *
 * 2. **No coupling to network selection.** Nothing here names a network, a
 *    chainId, or a contract address, so no combination of these keys can
 *    express "native on mainnet". DR-2026-08-05 decision 8 (refuse and pin)
 *    puts that refusal in the boot gate (`assertNativeDeployment`), where it is
 *    a hard error and never a silent legacy fallback. Chain identity comes from
 *    the pinned `BASE_SEPOLIA_TODAY` deployment, not from operator config.
 *
 * 3. **Enablement is M2's, not the loader's.** `evaluator.enabled` is carried
 *    verbatim and interpreted by nothing. The pre-swap daemon constructs no
 *    native loop, so a stray `enabled: true` is inert — the loader annotates
 *    nothing and refuses nothing on account of it. Mode selection (which loops
 *    a process runs, and the role-scoping the retiring
 *    `NativeOperatorConfigSchema` did with `superRefine`) belongs to M2.
 *
 * This file deliberately does NOT import `daemon/native-product-config.ts`.
 * That schema is the strict, role-scoped shape of the *parallel* native entry
 * point (`native-main.ts`), which retires at stage 5 per DR-2026-08-05
 * decision 1. It is a reference for what the native machinery needs, not a
 * dependency. Field names follow the landed native estate ("names-as-landed",
 * DR-2026-08-05) so M2's read is a direct mapping.
 */

import { isAbsolute } from 'node:path';
import { z } from 'zod/v3';

/**
 * The regex is the whole runtime check. The `.transform()` adds nothing at
 * runtime — it exists so the INFERRED type is the `sha256:${string}` template
 * literal the native composition consumes (`NativeEvaluationMethodDigests`,
 * `deployment.moduleDigest`, `expectedPolicyGenesisDigest`). Without it every
 * consumption site pays a narrowing cast for a shape the parser already
 * guaranteed.
 */
const Sha256Digest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'must be a sha256:<64 lowercase hex> digest')
  .transform((value) => value as `sha256:${string}`);

const AbsolutePath = z.string().min(1).refine(isAbsolute, 'must be an absolute path');

/** The deployment module is imported identically by the daemon and the spawned harness child. */
const ModuleLocation = z
  .string()
  .min(1)
  .refine(
    (value) => isAbsolute(value) || value.startsWith('file:'),
    'must be an absolute path or a file: URL',
  );

/**
 * How a container-graded registration's grader execution is owned.
 *
 * PR #2463 types the in-process binding as `GraderReportSource | "deployment-owned"`.
 * Only the literal is expressible in a config file: a live host
 * `GraderReportSource` object cannot cross the spawned-child boundary, so
 * `"deployment-owned"` — the digest-pinned deployment module constructing its
 * own grader source — is the production value and the only one an operator can
 * declare (#2467, Finding P0-5-A). Keys are a `registrationId` or the
 * registration's evaluation-method URI; which of the two, and which
 * registrations require an entry, is checked at composition, not here.
 */
export const NativeGraderReportBindingSchema = z.literal('deployment-owned');
export type NativeGraderReportBinding = z.infer<typeof NativeGraderReportBindingSchema>;

/**
 * One digest every configured registration's evaluation-method descriptor must
 * declare, or an exact per-`registrationId` map for a deployment serving more
 * than one method (PR #2463).
 *
 * The `satisfies` clause is a compile-time seam check against
 * `native-evaluator-composition.ts`'s `NativeEvaluationMethodDigests`: this
 * schema's parsed output must remain assignable to the type the composition
 * accepts, without importing it. Should the two ever diverge, this file stops
 * compiling rather than M2 discovering it at the consumption site.
 */
export type NativeEvaluationMethodDigests =
  | `sha256:${string}`
  | Readonly<Record<string, `sha256:${string}`>>;

export const NativeEvaluationMethodDigestsSchema = z.union([
  Sha256Digest,
  z.record(z.string().min(1), Sha256Digest),
]) satisfies z.ZodType<NativeEvaluationMethodDigests, z.ZodTypeDef, unknown>;

/**
 * The evaluator deployment this operator runs.
 *
 * The four deployment fields are required *when the section is present*: a
 * half-declared deployment (a digest with no module, an `enabled: true` with
 * nothing to enable) is a config error the operator should see at load, not a
 * boot-time surprise. An operator who runs no evaluator omits the section
 * entirely. This mirrors the native schema's `evaluator` block, which requires
 * all four.
 */
export const NativeEvaluatorConfigSchema = z
  .object({
    /**
     * Operator intent only. Interpreted by M2's mode selection; inert on the
     * pre-swap daemon. Absent is NOT "enabled": M2 decides what an omitted
     * flag beside a complete deployment block means.
     */
    enabled: z.boolean().optional(),
    /** Absolute path or file: URL. There is no adapter-empty fallback in native mode. */
    deploymentModule: ModuleLocation,
    /** Digest of the exact module bytes; rechecked before every secret release. */
    moduleDigest: Sha256Digest,
    signerHandle: z.string().min(1),
    evaluationMethodDigest: NativeEvaluationMethodDigestsSchema,
    /**
     * Grader-execution binding per container-graded registration the deployment
     * declares. Omitted entirely for a deployment with no container-graded
     * registration (today's prediction-only shape).
     */
    graderReportSources: z.record(z.string().min(1), NativeGraderReportBindingSchema).optional(),
  })
  .strict();
export type NativeEvaluatorConfig = z.infer<typeof NativeEvaluatorConfigSchema>;

/**
 * Persistent per-role identity stores (encrypted ed25519 custody created by
 * `jinn native keygen`). The role set mirrors the native schema's exactly.
 *
 * Which stores a process *must* have is a function of the loops it runs — M2's
 * mode selection owns that. The one invariant enforced here is
 * role-independent: requester and admission are two distinct signing
 * authorities and may not collapse onto one key file.
 */
export const NativeIdentityStoresConfigSchema = z
  .object({
    requester: AbsolutePath.optional(),
    admission: AbsolutePath.optional(),
    solver: AbsolutePath.optional(),
    evaluator: AbsolutePath.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requester !== undefined && value.requester === value.admission) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['admission'],
        message: 'admission identity store must be distinct from requester custody',
      });
    }
  });
export type NativeIdentityStoresConfig = z.infer<typeof NativeIdentityStoresConfigSchema>;

/** Confirmation depth the native infrastructure treats as finalized. */
export const NativeFinalityConfigSchema = z
  .object({ confirmations: z.number().int().positive() })
  .strict();
export type NativeFinalityConfig = z.infer<typeof NativeFinalityConfigSchema>;

/** Signed trust-roots catalog (policies, anchors, bindings, revocations) — never a private key. */
export const NativeTrustRootsPathSchema = AbsolutePath;

/** Genesis digest the trust catalog's policy chain must resolve to. */
export const NativeTrustPolicyGenesisDigestSchema = Sha256Digest;
