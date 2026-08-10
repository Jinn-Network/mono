import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { materializePublicBundle, type MaterializeBundleDeps } from "../bundle/materialize.js";
import { verifyPublicBundle, type PublicBundleVerificationCheck } from "../bundle/verify.js";
import { acquirePublicationLock } from "../run/publication-lock.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { draftPath, publicBundlePath } from "../workspace/layout.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { verifyRunWorkspace } from "./verify.js";

export interface RunPublishInput {
  readonly draftId: string;
}

export interface RunPublishDeps extends MaterializeBundleDeps {
  /** Fault-injection boundary after the final directory is durable, before RunState. */
  readonly beforeRunState?: () => void | Promise<void>;
  /** Race-test boundary while the publication lock is held and RunState is durable. */
  readonly afterRunState?: () => void | Promise<void>;
  /** Fault-injection boundary after RunState is durable, before the lifecycle transition. */
  readonly beforeTransition?: () => void | Promise<void>;
}

export interface RunPublishResult {
  readonly draft: DraftDocument;
  readonly bundleIdentity: string;
  readonly bundleRelativePath: string;
  readonly checks: readonly PublicBundleVerificationCheck[];
}

function relativeBundlePath(draftId: string, identity: string): string {
  return `artifacts/${draftId}/public-bundles/${identity}`;
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
      // A published bundle is immutable but remains readable and independently reverified.
      if (document.state === "published-bundle") {
        if (runState.bundleIdentity === undefined) {
          refuse("conflict", `runs.${input.draftId}`, "published draft is missing its public bundle identity");
        }
        const bundleRelativePath = relativeBundlePath(input.draftId, runState.bundleIdentity);
        if (runState.bundleRelativePath !== bundleRelativePath) refuse("conflict", `runs.${input.draftId}`, "published draft has a non-canonical bundle target");
        const verified = await verifyPublicBundle(publicBundlePath(clockedContext.workspaceDir, input.draftId, runState.bundleIdentity));
        if (verified.identity !== runState.bundleIdentity) {
          refuse("record-integrity", "bundle.json", "published bundle identity disagrees with RunState");
        }
        return {
          draft: document,
          bundleIdentity: verified.identity,
          bundleRelativePath,
          checks: verified.checks,
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

      // Exactly the workspace skeptic's three checks, before a staging directory exists.
      const workspaceVerified = await verifyRunWorkspace(clockedContext, input);
      if (
        workspaceVerified.checks.length !== 3
        || !workspaceVerified.checks.includes("matrix-rederivation")
        || !workspaceVerified.checks.includes("report-verification")
        || !workspaceVerified.checks.includes("claim-consistency")
      ) {
        refuse("conflict", "publish.preflight", "reported publication requires all three workspace verification checks");
      }

      const materialized = materializePublicBundle({
        workspaceDir: clockedContext.workspaceDir,
        draftId: input.draftId,
        benchmarkSha256: document.spec.taskSet.benchmarkSha256,
        runState,
      }, deps);
      const verified = await verifyPublicBundle(materialized.bundleDir);
      if (verified.identity !== materialized.identity) {
        refuse("record-integrity", "bundle.json", "materialized bundle identity changed before publication completed");
      }
      const bundleRelativePath = relativeBundlePath(input.draftId, materialized.identity);
      const publication = await acquirePublicationLock(clockedContext.workspaceDir, input.draftId);
      try {
        const latestDocument = readDraftDocument(clockedContext.workspaceDir, input.draftId);
        const latestState = requireRunState(clockedContext.workspaceDir, input.draftId);
        if (latestDocument.state !== "reported" && latestDocument.state !== "published-bundle") {
          refuse("illegal-transition", `drafts.${input.draftId}.state`, `draft changed to ${latestDocument.state} during publication`);
        }
        if (
          latestState.bundleIdentity !== undefined
          && (latestState.bundleIdentity !== materialized.identity || latestState.bundleRelativePath !== bundleRelativePath)
        ) {
          refuse("conflict", "bundle.target", "RunState already names a different immutable public bundle");
        }
        const publishedAt = latestDocument.state === "published-bundle"
          ? latestDocument.updatedAt
          : (latestState.publishedAt ?? at);
        await deps.beforeRunState?.();
        writeRunState(clockedContext.workspaceDir, input.draftId, {
          ...latestState,
          bundleIdentity: materialized.identity,
          bundleRelativePath,
          bundleChecks: [...verified.checks],
          publishedAt,
        });
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
        return { draft, bundleIdentity: materialized.identity, bundleRelativePath, checks: verified.checks };
      } finally {
        publication.release();
      }
    },
  });
}
