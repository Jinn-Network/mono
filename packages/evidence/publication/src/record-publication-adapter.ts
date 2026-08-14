// SPDX-License-Identifier: Apache-2.0
/**
 * The Evidence Protocol family is deliberately closed.  This adapter is the
 * only translation point between those families and the kind-neutral record
 * publication coordinator: it never widens repository record references or
 * imports an upper-tier record package.
 */
import {
  executePublicationPlan,
  type CasResult,
  type CasSnapshot,
  type PublicationJournal,
  type PublicationJournalStore,
  type PublicationPlan,
} from "@jinn-network/record-publication";
import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";

const EVIDENCE_ARTIFACT_ROLE =
  "https://spec.jinn.network/roles/evidence-publication-artifact/v1";
const ANNOUNCEMENT_FRAME_ROLE =
  "https://spec.jinn.network/roles/evidence-publication-announcement-frame/v1";

const EVIDENCE_RECORD_KINDS: Record<
  EvidenceRecordReference["family"],
  string
> = {
  "execution-evidence":
    "https://spec.jinn.network/records/execution-evidence/v1",
  "result-evaluation":
    "https://spec.jinn.network/records/result-evaluation/v1",
  "execution-verification":
    "https://spec.jinn.network/records/execution-verification/v1",
};

/** A per-action journal is intentionally non-durable: the legacy journal is
 * the public recovery authority and keeps its v1 bytes/receipts unchanged. */
class ActionJournal implements PublicationJournalStore {
  #snapshot: CasSnapshot<PublicationJournal> | undefined;
  #revision = 0;

  async read(): Promise<CasSnapshot<PublicationJournal> | undefined> {
    return this.#snapshot;
  }

  async compareAndSwap(
    _id: string,
    expectedRevision: string | null,
    next: PublicationJournal,
  ): Promise<CasResult> {
    if ((this.#snapshot?.revision ?? null) !== expectedRevision) {
      return { ok: false };
    }
    const revision = String(++this.#revision);
    this.#snapshot = { revision, value: next };
    return { ok: true, revision };
  }
}

function actionPlan(
  id: string,
  member: PublicationPlan["stages"][number]["members"][number],
): PublicationPlan {
  return {
    id,
    stages: [{ stage: "registration", members: [member] }],
  };
}

async function execute(
  plan: PublicationPlan,
  effect: (idempotencyKey: Sha256Digest) => Promise<void>,
): Promise<void> {
  await executePublicationPlan(plan, {
    journal: new ActionJournal(),
    objects: {
      async putExact() {
        await effect("sha256:0000000000000000000000000000000000000000000000000000000000000000");
      },
    },
    destination: {
      async deliver({ idempotencyKey }) {
        await effect(idempotencyKey as Sha256Digest);
      },
    },
  });
}

export async function executeEvidenceArtifactStore(input: {
  readonly planId: string;
  readonly reference: EvidenceArtifactReference;
  readonly bytes: Uint8Array;
  readonly store: () => Promise<void>;
}): Promise<void> {
  await execute(
    actionPlan(input.planId, {
      id: `artifact:${input.reference.digest}`,
      role: EVIDENCE_ARTIFACT_ROLE,
      digest: input.reference.digest,
      bytes: new Uint8Array(input.bytes),
      mediaType: "application/octet-stream",
      actions: ["store"],
    }),
    input.store,
  );
}

export async function executeEvidenceRecordStore(input: {
  readonly planId: string;
  readonly reference: EvidenceRecordReference;
  readonly bytes: Uint8Array;
  readonly store: () => Promise<void>;
}): Promise<void> {
  await execute(
    actionPlan(input.planId, {
      id: `record:${input.reference.family}:${input.reference.digest}`,
      kind: EVIDENCE_RECORD_KINDS[input.reference.family],
      digest: input.reference.digest,
      bytes: new Uint8Array(input.bytes),
      mediaType: "application/octet-stream",
      authority: { mode: "owner" },
      actions: ["store"],
    }),
    input.store,
  );
}

/**
 * A prepared legacy frame is a role-bearing artifact to the neutral core.
 * The existing evidence journal remains responsible for intent, pending
 * reconciliation and the observable placement receipt around this effect.
 */
export async function executeEvidenceFramePlacement(input: {
  readonly planId: string;
  readonly frameDigest: Sha256Digest;
  readonly frameBytes: Uint8Array;
  readonly place: (idempotencyKey: Sha256Digest) => Promise<void>;
}): Promise<void> {
  await execute(
    actionPlan(input.planId, {
      id: `announcement-frame:${input.frameDigest}`,
      role: ANNOUNCEMENT_FRAME_ROLE,
      digest: input.frameDigest,
      bytes: new Uint8Array(input.frameBytes),
      mediaType: "application/octet-stream",
      actions: ["mirror"],
    }),
    input.place,
  );
}
