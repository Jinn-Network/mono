/**
 * The evidence join (cutover stage 1, Task 11): `packages/task-execution/backend-local`
 * (the assembly package) declares `EvidenceBindingPorts` and deliberately refuses to import
 * `@jinn-network/evidence-local-runtime` — its own architecture test forbids it. The operator
 * runtime (`client/`) is the composition root, so the join that actually opens the local
 * runtime and hands it to the assembly package as concrete `EvidenceBindingPorts` lives here.
 */
import {
  openLocalEvidenceRuntime,
  type LocalEvidenceRuntime,
} from '@jinn-network/evidence-local-runtime';
import type {
  EvidenceBindingPorts,
  EvidenceIndexingOutcome,
} from '@jinn-network/task-execution-backend-local';

export interface OperatorEvidence {
  readonly runtime: LocalEvidenceRuntime;
  readonly ports: EvidenceBindingPorts;
  close(): Promise<void>;
}

/**
 * Open the local evidence runtime rooted at `input.rootDir` (by convention
 * `<earningDir>/../evidence`) and bind it to the assembly package's
 * `EvidenceBindingPorts` shape.
 */
export async function openOperatorEvidence(input: {
  readonly rootDir: string;
  readonly signal?: AbortSignal;
}): Promise<OperatorEvidence> {
  const runtime = await openLocalEvidenceRuntime({
    rootDir: input.rootDir,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let closed = false;
  return {
    runtime,
    ports: {
      repository: runtime.repository,
      catalog: runtime.catalog,
      awaitIndexed: (reference): Promise<EvidenceIndexingOutcome> =>
        runtime.awaitIndexed(reference) as Promise<EvidenceIndexingOutcome>,
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await runtime.close();
    },
  };
}
