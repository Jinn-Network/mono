import { rmSync } from "node:fs";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { materializePublicBundle, type MaterializeBundleDeps } from "../bundle/materialize.js";
import { verifyPublicBundle, type PublicBundleVerificationCheck } from "../bundle/verify.js";
import { acquirePublicationLock, type PublicationLock } from "../run/publication-lock.js";
import { readRunState, requireRunState, writeRunState, type RunState } from "../run/state.js";
import { draftPath, publicBundlePath } from "../workspace/layout.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { verifyRunWorkspace } from "./verify.js";
import { runtimeNativeArtifactPublicationPolicy } from "../runtime/adapter.js";

export interface RunPublishInput {
  readonly draftId: string;
  /** Explicit consent to copy complete native runtime artifacts (including Inspect transcripts)
   * into the non-confidential public bundle. Required for runtime-backed drafts. */
  readonly includeNativeArtifacts?: boolean;
}

export interface RunPublishDeps extends MaterializeBundleDeps {
  /** Fault-injection boundary after the final directory is durable, before RunState. */
  readonly beforeRunState?: () => void | Promise<void>;
  /** Race-test boundary while the publication lock is held and RunState is durable. */
  readonly afterRunState?: () => void | Promise<void>;
  /** Fault-injection boundary after RunState is durable, before the lifecycle transition. */
  readonly beforeTransition?: () => void | Promise<void>;
}

/** One additional non-canonical public bundle this invocation materialized (packet P5, spec §8.3
 * option 5) — one per `runState.additionalReports` entry, in that order. */
export interface AdditionalRunPublishResult {
  readonly method: string;
  readonly version: string;
  readonly bundleIdentity: string;
  readonly bundleRelativePath: string;
  readonly checks: readonly PublicBundleVerificationCheck[];
}

export interface RunPublishResult {
  readonly draft: DraftDocument;
  /** The CANONICAL first bundle's identity — the one entry this operation always produced before
   * `additionalAnalyses` existed. */
  readonly bundleIdentity: string;
  readonly bundleRelativePath: string;
  readonly checks: readonly PublicBundleVerificationCheck[];
  /** N-1 additional public bundles, one per additional Report, in the same order. Absent when this
   * run's Report has no additional siblings (packet P5, spec §8.3 option 5). */
  readonly additionalBundles?: readonly AdditionalRunPublishResult[];
}

function relativeBundlePath(draftId: string, identity: string): string {
  return `artifacts/${draftId}/public-bundles/${identity}`;
}

/** Materializes and verifies ONE bundle directory — the canonical bundle when `reportSelector` is
 * absent, an additional sibling when present. Refuses on the `/5` evidence-native format (managed
 * publication must materialize its frozen legacy bundle profile) and on any identity mismatch
 * between what was staged and what the verifier re-derives — the SAME two checks the canonical
 * bundle always ran, now run once per bundle materialized (packet P5: the bundle format is derived
 * PER Report from its own method, so a real multi-method publish can legitimately emit bundles of
 * different formats from the one Run/Matrix — this check must not be hoisted outside the loop). */
async function materializeAndVerifyBundle(
  clockedContext: OperationContext,
  input: RunPublishInput,
  runState: RunState,
  benchmarkSha256: string,
  reportSelector: { readonly method: string; readonly version: string } | undefined,
  deps: RunPublishDeps,
  created: string[],
): Promise<{ readonly identity: string; readonly relativePath: string; readonly checks: readonly PublicBundleVerificationCheck[] }> {
  const materialized = materializePublicBundle({
    workspaceDir: clockedContext.workspaceDir,
    draftId: input.draftId,
    benchmarkSha256,
    runState,
    ...(reportSelector === undefined ? {} : { reportSelector }),
  }, deps);
  // Recorded BEFORE verification, because a refusal from the verifier is exactly the case that used
  // to strand a shippable-looking directory an operator could collect by path (issue #3074).
  if (!materialized.adopted) created.push(materialized.bundleDir);
  const verified = await verifyPublicBundle(materialized.bundleDir);
  if (verified.format === "benchmark-product-public-bundle/5") {
    refuse("conflict", "bundle.json", "managed publication must materialize its frozen legacy bundle profile");
  }
  if (verified.identity !== materialized.identity) {
    refuse("record-integrity", "bundle.json", "materialized bundle identity changed before publication completed");
  }
  return { identity: materialized.identity, relativePath: relativeBundlePath(input.draftId, materialized.identity), checks: verified.checks };
}

/** Bound on waiting for the publication lock to run a refusal's cleanup. Short by design: the
 * caller already has a refusal to return, and leaving an unreferenced directory behind is a far
 * smaller cost than making every contended failure wait out the full publication timeout. */
const REFUSED_CLEANUP_LOCK_TIMEOUT_MS = 2_000;

/** Absolute bundle directories the durable RunState currently names — canonical plus every
 * additional sibling. A directory in this set belongs to a publication that completed, so it must
 * survive this invocation's refusal even if this invocation is the one that created it: a
 * concurrent publisher of the same draft adopts a byte-identical directory rather than refusing,
 * and may already have made it durable. A missing or unreadable RunState names nothing. */
function bundleDirsNamedByRunState(workspaceDir: string, draftId: string): ReadonlySet<string> {
  let state: RunState | undefined;
  try {
    state = readRunState(workspaceDir, draftId);
  } catch {
    state = undefined;
  }
  const named = new Set<string>();
  if (state === undefined) return named;
  if (state.bundleIdentity !== undefined) named.add(publicBundlePath(workspaceDir, draftId, state.bundleIdentity));
  for (const entry of state.additionalBundles ?? []) named.add(publicBundlePath(workspaceDir, draftId, entry.bundleIdentity));
  return named;
}

/** Removes the bundle directories this invocation renamed into place, after it refused to publish
 * them. A refused publication never advances the lifecycle, so leaving the directory behind hands an
 * operator collecting bundles by path something that looks shippable and is not (issue #3074).
 * Adopted directories are never removed — they belong to the publication that created them.
 *
 * The removal runs while the publication lock for this draft is HELD (issue #3194). Bundle
 * materialization happens outside the lock, so a concurrent publisher of the same draft can adopt
 * a directory this invocation created — the EEXIST path proves byte-identity and adopts rather than
 * refusing — and go on to name it in RunState. Running the cleanup under the same lock that
 * serializes publication, and skipping every directory that lock-held read finds named, keeps this
 * invocation's refusal from deleting a bundle a peer has already published.
 *
 * This NARROWS the race rather than closing it. Only the peer's `writeRunState` is inside the lock;
 * its adoption of the directory is not. A peer that has adopted but not yet named its bundle is
 * still invisible to the lock-held read, so `adopt → we take the lock and read → we remove →
 * peer takes the lock and names` remains reachable. Closing it needs adoption itself moved inside
 * the lock (or a materialization-side marker), which is a larger change to where bundles are built.
 *
 * `heldLock` is the caller's lock when the refusal happened inside the locked region; otherwise the
 * lock is acquired for the cleanup alone, under a short timeout — the caller is already returning a
 * refusal and must not be made to wait out the full publication timeout a second time. Both lock
 * failure and removal failure are swallowed — neither may replace the refusal the caller needs to
 * see — and a lock we cannot take means the directories are left in place rather than removed
 * unserialized. */
async function removeRefusedBundles(
  workspaceDir: string,
  draftId: string,
  bundleDirs: readonly string[],
  heldLock: PublicationLock | undefined,
): Promise<void> {
  if (bundleDirs.length === 0) return;
  let acquired: PublicationLock | undefined;
  if (heldLock === undefined) {
    try {
      acquired = await acquirePublicationLock(workspaceDir, draftId, REFUSED_CLEANUP_LOCK_TIMEOUT_MS);
    } catch {
      return;
    }
  }
  try {
    const named = bundleDirsNamedByRunState(workspaceDir, draftId);
    for (const bundleDir of bundleDirs) {
      if (named.has(bundleDir)) continue;
      try {
        rmSync(bundleDir, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  } finally {
    acquired?.release();
  }
}

/** Gated local immutable publication. The lifecycle transition is deliberately the final write. */
export function runPublish(
  context: OperationContext,
  input: RunPublishInput,
  deps: RunPublishDeps = {},
): Promise<OperationResult<RunPublishResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  return operateAsync({
    context: clockedContext,
    action: "publish",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      // A published bundle is immutable but remains readable and independently reverified. A
      // second `publish` call behaves exactly as it did before additionalAnalyses existed when
      // there are none; when there are, every additional bundle is reverified alongside the
      // canonical one (packet P5).
      if (document.state === "published-bundle") {
        if (runState.bundleIdentity === undefined) {
          refuse("conflict", `runs.${input.draftId}`, "published draft is missing its public bundle identity");
        }
        const bundleRelativePath = relativeBundlePath(input.draftId, runState.bundleIdentity);
        if (runState.bundleRelativePath !== bundleRelativePath) refuse("conflict", `runs.${input.draftId}`, "published draft has a non-canonical bundle target");
        const verified = await verifyPublicBundle(publicBundlePath(clockedContext.workspaceDir, input.draftId, runState.bundleIdentity));
        if (verified.format === "benchmark-product-public-bundle/5") {
          refuse("conflict", "bundle.json", "managed publication cannot adopt an evidence-native bundle identity");
        }
        if (verified.identity !== runState.bundleIdentity) {
          refuse("record-integrity", "bundle.json", "published bundle identity disagrees with RunState");
        }

        const additionalBundles: AdditionalRunPublishResult[] = [];
        for (const entry of runState.additionalBundles ?? []) {
          const entryRelativePath = relativeBundlePath(input.draftId, entry.bundleIdentity);
          if (entry.bundleRelativePath !== entryRelativePath) {
            refuse("conflict", `runs.${input.draftId}`, `published draft has a non-canonical bundle target for "${entry.method}@${entry.version}"`);
          }
          const entryVerified = await verifyPublicBundle(publicBundlePath(clockedContext.workspaceDir, input.draftId, entry.bundleIdentity));
          if (entryVerified.format === "benchmark-product-public-bundle/5") {
            refuse("conflict", "bundle.json", "managed publication cannot adopt an evidence-native bundle identity");
          }
          if (entryVerified.identity !== entry.bundleIdentity) {
            refuse("record-integrity", "bundle.json", "published bundle identity disagrees with RunState");
          }
          additionalBundles.push({
            method: entry.method,
            version: entry.version,
            bundleIdentity: entryVerified.identity,
            bundleRelativePath: entryRelativePath,
            checks: entryVerified.checks,
          });
        }

        return {
          draft: document,
          bundleIdentity: verified.identity,
          bundleRelativePath,
          checks: verified.checks,
          ...(additionalBundles.length === 0 ? {} : { additionalBundles }),
        };
      }
      if (document.state !== "reported") {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — only a reported draft can be published`,
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }
      if (
        runtimeNativeArtifactPublicationPolicy(document.spec.evaluationRuntime) === "explicit-consent"
        && input.includeNativeArtifacts !== true
      ) {
        refuse(
          "validation",
          "includeNativeArtifacts",
          "runtime-backed publication requires explicit approval to include complete native logs and transcripts in the non-confidential bundle",
        );
      }

      // Exactly the workspace skeptic's three checks, before a staging directory exists.
      // Exactly the workspace skeptic's three checks must all have run. An anchored run adds
      // `integrity-anchors` as a fourth, so this gate names the three it requires rather than
      // counting them — a fourth check having also passed is not a reason to refuse.
      const workspaceVerified = await verifyRunWorkspace(clockedContext, input);
      if (
        !workspaceVerified.checks.includes("matrix-rederivation")
        || !workspaceVerified.checks.includes("report-verification")
        || !workspaceVerified.checks.includes("claim-consistency")
      ) {
        refuse("conflict", "publish.preflight", "reported publication requires all three workspace verification checks");
      }

      // The canonical bundle — the one entry this operation always produced before
      // additionalAnalyses existed — followed by one additional bundle per additional Report this
      // run's `report` invocation sealed (packet P5, spec §8.3 option 5: one `publish` invocation
      // emits N bundle directories, one per Report). Each is materialized and verified
      // independently; the bundle FORMAT is derived per Report from its own method
      // (`bundle/materialize.ts`), so a real multi-method publish can legitimately emit bundles of
      // different formats from the one Run/Matrix.
      //
      // Every directory below is unreferenced until `writeRunState` names it. Any refusal before
      // that point removes them again (issue #3074).
      const created: string[] = [];
      let durable = false;
      // Held across the catch so a refusal inside the locked region cleans up before releasing it,
      // and released by the outer finally on every path (issue #3194).
      let publication: PublicationLock | undefined;
      try {
        const canonical = await materializeAndVerifyBundle(clockedContext, input, runState, document.spec.taskSet.benchmarkSha256, undefined, deps, created);
        const additional: AdditionalRunPublishResult[] = [];
        for (const entry of runState.additionalReports ?? []) {
          const selector = { method: entry.method, version: entry.version };
          const materializedEntry = await materializeAndVerifyBundle(clockedContext, input, runState, document.spec.taskSet.benchmarkSha256, selector, deps, created);
          additional.push({
            method: entry.method,
            version: entry.version,
            bundleIdentity: materializedEntry.identity,
            bundleRelativePath: materializedEntry.relativePath,
            checks: materializedEntry.checks,
          });
        }

        publication = await acquirePublicationLock(clockedContext.workspaceDir, input.draftId);
        {
          const latestDocument = readDraftDocument(clockedContext.workspaceDir, input.draftId);
          const latestState = requireRunState(clockedContext.workspaceDir, input.draftId);
          if (latestDocument.state !== "reported" && latestDocument.state !== "published-bundle") {
            refuse("illegal-transition", `drafts.${input.draftId}.state`, `draft changed to ${latestDocument.state} during publication`);
          }
          if (
            latestState.bundleIdentity !== undefined
            && (latestState.bundleIdentity !== canonical.identity || latestState.bundleRelativePath !== canonical.relativePath)
          ) {
            refuse("conflict", "bundle.target", "RunState already names a different immutable public bundle");
          }
          for (const entry of additional) {
            const existing = (latestState.additionalBundles ?? []).find((candidate) => candidate.method === entry.method && candidate.version === entry.version);
            if (existing !== undefined && (existing.bundleIdentity !== entry.bundleIdentity || existing.bundleRelativePath !== entry.bundleRelativePath)) {
              refuse("conflict", "bundle.target", `RunState already names a different immutable public bundle for "${entry.method}@${entry.version}"`);
            }
          }
          const publishedAt = latestDocument.state === "published-bundle"
            ? latestDocument.updatedAt
            : (latestState.publishedAt ?? at);
          await deps.beforeRunState?.();
          writeRunState(clockedContext.workspaceDir, input.draftId, {
            ...latestState,
            bundleIdentity: canonical.identity,
            bundleRelativePath: canonical.relativePath,
            bundleChecks: [...canonical.checks],
            publishedAt,
            ...(additional.length === 0
              ? {}
              : {
                  additionalBundles: additional.map((entry) => ({
                    method: entry.method,
                    version: entry.version,
                    bundleIdentity: entry.bundleIdentity,
                    bundleRelativePath: entry.bundleRelativePath,
                    bundleChecks: [...entry.checks],
                  })),
                }),
          });
          durable = true;
          await deps.afterRunState?.();
          await deps.beforeTransition?.();
          let draft: DraftDocument;
          if (latestDocument.state === "reported") {
            const transitioned = transition("reported", "publish");
            if (!transitioned.ok) refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
            draft = { ...latestDocument, state: transitioned.state, updatedAt: publishedAt };
            atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
          } else {
            draft = latestDocument;
          }
          return {
            draft,
            bundleIdentity: canonical.identity,
            bundleRelativePath: canonical.relativePath,
            checks: canonical.checks,
            ...(additional.length === 0 ? {} : { additionalBundles: additional }),
          };
        }
      } catch (cause) {
        if (!durable) await removeRefusedBundles(clockedContext.workspaceDir, input.draftId, created, publication);
        throw cause;
      } finally {
        publication?.release();
      }
    },
  });
}
