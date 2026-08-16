/**
 * Conformance harness — orchestrates Layer 1 + Layer 2 checks.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §4.10.
 *
 * `runConformance({ envelopeCid, options })` fetches the envelope + task +
 * trajectory + (at attested tier) source bundle from IPFS, then runs every
 * Layer 1 and (conditionally) Layer 2 check, and assembles a ConformanceReport.
 *
 * All IPFS fetches can be bypassed by passing pre-loaded objects via
 * ConformanceOptions injection fields — required for test isolation.
 */

import { SignedEnvelopeSchema } from '../types/envelope.js';
import {
  fetchSignedEnvelopeBytesRaw,
  fetchFromIpfs,
  fetchTrajectoryFromIpfs,
  fetchSourceBundleFromIpfs,
} from '../adapters/mech/ipfs.js';
import { parseTask } from '../types/task.js';
import { checkEnvelopeSchema } from './checks/envelope-schema.js';
import { checkPayload } from './checks/payload.js';
import { checkHashAndSignature } from './checks/hash-signature.js';
import { checkTrajectorySchema } from './checks/trajectory-schema.js';
import { checkHashChainIntegrity } from './checks/trajectory-chain.js';
import { checkSpanProfile } from './checks/trajectory-profile.js';
import { checkArtifactVocabulary, checkArtifactLinkage } from './checks/artifacts.js';
import { checkVerdictBackReference, checkVerificationRecord } from './checks/verdict.js';
import { checkSecretScrub } from './checks/secret-scrub.js';
import {
  checkTracedHttpBoundary,
  checkMcpShimBoundary,
  checkSubprocessBoundary,
  checkRawSockets,
  checkDynamicCode,
  checkArtifactEmitPath,
} from './checks/source-static.js';
import {
  checkSeccompPolicy,
  checkNamespacePolicy,
  checkTlsTranscriptCapture,
} from './checks/source-runtime.js';
import {
  summarize,
  overallFromChecks,
  type CheckResult,
  type ConformanceContext,
  type ConformanceOptions,
  type ConformanceReport,
} from './types.js';

// ─── Layer 1 sync checks ──────────────────────────────────────────────────────
// (checkHashAndSignature is async, run separately)

const LAYER1_SYNC_CHECKS: Array<(ctx: ConformanceContext) => CheckResult> = [
  checkEnvelopeSchema,
  checkPayload,
  checkTrajectorySchema,
  checkHashChainIntegrity,
  checkSpanProfile,
  checkArtifactVocabulary,
  checkArtifactLinkage,
  checkVerdictBackReference,
  checkVerificationRecord,
  checkSecretScrub,
];

// ─── Layer 2 static checks ───────────────────────────────────────────────────

const LAYER2_STATIC_CHECKS: Array<(ctx: ConformanceContext) => CheckResult> = [
  checkTracedHttpBoundary,
  checkMcpShimBoundary,
  checkSubprocessBoundary,
  checkRawSockets,
  checkDynamicCode,
  checkArtifactEmitPath,
];

// ─── Layer 2 runtime stubs ───────────────────────────────────────────────────

const LAYER2_RUNTIME_CHECKS: Array<(ctx: ConformanceContext) => CheckResult> = [
  checkSeccompPolicy,
  checkNamespacePolicy,
  checkTlsTranscriptCapture,
];

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RunConformanceArgs {
  envelopeCid: string;
  options?: ConformanceOptions;
}

/**
 * Run the full conformance suite against a signed envelope CID.
 *
 * Steps:
 *  1. Fetch envelope bytes (or use options.envelopeBytes).
 *  2. Parse with SignedEnvelopeSchema.
 *  3. Fetch task by envelope.task.cid (or use options.task).
 *  4. Fetch trajectory if envelope.trajectory?.cid is set (or use options.trajectory).
 *  5. If role === 'verdict', fetch solution envelope bytes (or use options.solutionEnvelopeBytes).
 *  6. If evidenceTier === 'attested' and !skipLayer2, fetch source bundle (or use options.sourceBundle).
 *  7. Run Layer 1 checks.
 *  8. If attested and !skipLayer2, run Layer 2 checks.
 *  9. Assemble ConformanceReport.
 */
export async function runConformance(args: RunConformanceArgs): Promise<ConformanceReport> {
  const options: ConformanceOptions = args.options ?? {};
  const ctx: ConformanceContext = { envelopeCid: args.envelopeCid, options };

  // ── Step 1–2: Envelope ────────────────────────────────────────────────────
  try {
    const bytes = options.envelopeBytes
      ? (options.envelopeBytes instanceof Uint8Array
          ? options.envelopeBytes
          : new Uint8Array(options.envelopeBytes))
      : await fetchEnvelopeBytes(args.envelopeCid, options);
    ctx.envelopeBytes = bytes;

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        ctx.rawEnvelope = parsed as Record<string, unknown>;
      }
    } catch (err) {
      return buildReport(args.envelopeCid, 'self-signed', [
        {
          id: 'envelope.fetch',
          layer: 1,
          passed: false,
          detail: `envelope bytes could not be parsed as JSON: ${(err as Error).message}`,
        },
      ]);
    }

    // Attempt strict parse — store result regardless so checkEnvelopeSchema can
    // report the exact Zod errors.
    const parseResult = SignedEnvelopeSchema.safeParse(parsed);
    if (parseResult.success) {
      ctx.envelope = parseResult.data;
    } else {
      // Store the raw object so downstream checks see it and report appropriately.
      ctx.envelope = parsed as typeof ctx.envelope;
    }
  } catch (err) {
    return buildReport(args.envelopeCid, 'self-signed', [
      {
        id: 'envelope.fetch',
        layer: 1,
        passed: false,
        detail: `envelope could not be fetched: ${(err as Error).message}`,
      },
    ]);
  }

  // ── Step 3: Task ──────────────────────────────────────────────────────────
  if (options.task !== undefined) {
    ctx.task = options.task;
  } else {
    const taskCid = (ctx.envelope as { task?: { cid?: string } } | undefined)?.task?.cid;
    if (taskCid) {
      try {
        ctx.task = parseTask(await fetchFromIpfs(options.ipfsGatewayUrl ?? '', taskCid));
      } catch {
        // Leave undefined — task CID resolution is optional in V1 because many
        // envelope fixtures use stub CIDs. Checks that need the Task skip/fail.
      }
    }
  }

  // ── Step 4: Trajectory ────────────────────────────────────────────────────
  if (options.trajectory !== undefined) {
    ctx.trajectory = options.trajectory;
  } else {
    const trajCid = (ctx.envelope as { trajectory?: { cid?: string } | null } | undefined)
      ?.trajectory?.cid;
    if (trajCid) {
      try {
        ctx.trajectory = await fetchTrajectoryFromIpfs(
          options.ipfsGatewayUrl ?? '',
          trajCid,
        );
      } catch {
        /* leave undefined — trajectory checks will skip */
      }
    }
  }

  // ── Step 5: Solution envelope (for verdict back-ref) ──────────────────
  const envelopeRole = (ctx.envelope as { role?: string } | undefined)?.role;
  if (envelopeRole === 'verdict') {
    if (options.solutionEnvelopeBytes !== undefined || options.restorationEnvelopeBytes !== undefined) {
      const solutionBytes = options.solutionEnvelopeBytes ?? options.restorationEnvelopeBytes!;
      ctx.solutionEnvelopeBytes = solutionBytes instanceof Uint8Array
        ? solutionBytes
        : new Uint8Array(solutionBytes);
      ctx.restorationEnvelopeBytes = ctx.solutionEnvelopeBytes;
    } else {
      const payload = (ctx.envelope as { payload?: Record<string, unknown> } | undefined)?.payload;
      const ref = (payload?.solutionEnvelope ?? payload?.restorationEnvelope) as
        | { cid?: string }
        | undefined;
      const refCid = ref?.cid;
      if (refCid) {
        try {
          ctx.solutionEnvelopeBytes = await fetchEnvelopeBytes(refCid, options);
          ctx.restorationEnvelopeBytes = ctx.solutionEnvelopeBytes;
        } catch {
          /* leave undefined — checkVerdictBackReference captures */
        }
      }
    }
  }

  // ── Step 6: Source bundle (attested tier only) ────────────────────────────
  const envelopeTier = (ctx.envelope as { evidenceTier?: string } | undefined)?.evidenceTier;
  const isAttested = envelopeTier === 'attested';

  if (isAttested && !options.skipLayer2) {
    if (options.sourceBundle !== undefined) {
      ctx.sourceBundle = options.sourceBundle;
    } else {
      const bundleCid = (
        ctx.envelope as { executor?: { source?: { bundleCid?: string } } } | undefined
      )?.executor?.source?.bundleCid;
      if (bundleCid) {
        try {
          ctx.sourceBundle = await fetchSourceBundleFromIpfs(
            options.ipfsGatewayUrl ?? '',
            bundleCid,
          );
        } catch {
          /* leave undefined — static checks will skip */
        }
      }
    }
  }

  // ── Steps 7–8: Run checks ─────────────────────────────────────────────────
  const checks: CheckResult[] = [];

  // Layer 1 sync checks
  for (const fn of LAYER1_SYNC_CHECKS) {
    checks.push(fn(ctx));
  }

  // Layer 1 async check (hash + signature)
  checks.push(await checkHashAndSignature(ctx));

  // Layer 2 checks (attested tier only, unless skipLayer2)
  if (isAttested && !options.skipLayer2) {
    for (const fn of LAYER2_STATIC_CHECKS) {
      checks.push(fn(ctx));
    }
    for (const fn of LAYER2_RUNTIME_CHECKS) {
      checks.push(fn(ctx));
    }
  }

  // ── Step 9: Assemble report ───────────────────────────────────────────────
  const resolvedTier = (envelopeTier as ConformanceReport['envelopeTier']) ?? 'self-signed';
  return buildReport(args.envelopeCid, resolvedTier, checks);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchEnvelopeBytes(
  cid: string,
  options: ConformanceOptions,
): Promise<Uint8Array> {
  // Fetch the exact bytes stored at the CID — no JSON parse/re-encode roundtrip
  // so the bytes hashed here match the bytes hashed at upload time.
  return fetchSignedEnvelopeBytesRaw(options.ipfsGatewayUrl ?? '', cid);
}

function buildReport(
  envelopeCid: string,
  envelopeTier: ConformanceReport['envelopeTier'],
  checks: CheckResult[],
): ConformanceReport {
  const summary = summarize(checks);
  const overall = overallFromChecks(checks);
  const layer1 = checks.filter((c) => c.layer === 1);
  const layer2 = checks.filter((c) => c.layer === 2);
  const layer1Passed = layer1.every((c) => c.skipped === true || c.passed);
  const layer2Passed: boolean | 'N/A' =
    envelopeTier !== 'attested'
      ? 'N/A'
      : layer2.every((c) => c.skipped === true || c.passed);
  return { envelopeCid, envelopeTier, checks, summary, overall, layer1Passed, layer2Passed };
}
