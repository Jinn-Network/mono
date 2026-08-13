export type Sha256Digest = `sha256:${string}`;
export type PublicationStage = "registration" | "accounting" | "report";
export type AuthorityMode = "owner" | "delegate" | "origin-reference";
export type PublicationAction = "store" | "mirror" | "announce" | "verify-origin";

export interface OriginReference {
  readonly source: { readonly agent: string; readonly name: string };
  readonly sequence: string;
  readonly entryDigest: Sha256Digest;
}

export interface PublicationRecord {
  readonly id: string;
  readonly kind: string;
  readonly digest: Sha256Digest;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly authority: { readonly mode: AuthorityMode; readonly origin?: OriginReference };
  readonly actions: readonly PublicationAction[];
  readonly dependsOn?: readonly string[];
}

export interface PublicationArtifact {
  readonly id: string;
  readonly role: string;
  readonly digest: Sha256Digest;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly actions: readonly Exclude<PublicationAction, "announce" | "verify-origin">[];
  readonly dependsOn?: readonly string[];
}

export interface PublicationPlanStage {
  readonly stage: PublicationStage;
  readonly members: readonly (PublicationRecord | PublicationArtifact)[];
}

export interface PublicationPlan {
  readonly id: string;
  readonly stages: readonly PublicationPlanStage[];
}

export interface ExactObjectStore {
  putExact(input: { readonly digest: Sha256Digest; readonly bytes: Uint8Array; readonly mediaType: string }): Promise<void>;
}

export interface PublicationAnnouncementPort {
  announce(input: { readonly idempotencyKey: Sha256Digest; readonly record: PublicationRecord }): Promise<unknown>;
}

/** Host-owned proof/policy seam; the neutral core never infers authorship. */
export interface PublicationAuthorityPort {
  authorizeAnnouncement(input: { readonly record: PublicationRecord; readonly mode: "owner" | "delegate" }): Promise<void>;
}

export interface OriginVerificationPort {
  verifyOrigin(input: { readonly record: PublicationRecord; readonly origin: OriginReference }): Promise<unknown>;
}

export interface PublicationDestinationPort {
  deliver(input: { readonly idempotencyKey: Sha256Digest; readonly member: PublicationRecord | PublicationArtifact; readonly action: "store" | "mirror" }): Promise<unknown>;
}

export interface CasSnapshot<T> { readonly revision: string; readonly value: T; }
export type CasResult = { readonly ok: true; readonly revision: string } | { readonly ok: false };
export interface PublicationJournalStore {
  read(id: string): Promise<CasSnapshot<PublicationJournal> | undefined>;
  compareAndSwap(id: string, expectedRevision: string | null, next: PublicationJournal): Promise<CasResult>;
}

export interface PublicationJournal {
  readonly version: 1;
  readonly planId: string;
  readonly fingerprint: Sha256Digest;
  readonly completed: readonly Sha256Digest[];
  readonly complete: boolean;
}

export interface RecordPublicationDependencies {
  readonly objects: ExactObjectStore;
  readonly journal: PublicationJournalStore;
  readonly announce?: PublicationAnnouncementPort;
  readonly authority?: PublicationAuthorityPort;
  readonly verifyOrigin?: OriginVerificationPort;
  readonly destination?: PublicationDestinationPort;
  /** Test/host seam for crash recovery at the only non-atomic plan boundary. */
  readonly faults?: PublicationFaultInjector;
}

export interface PublicationFaultInjector {
  at(input: { readonly action: PublicationAction; readonly idempotencyKey: Sha256Digest }): Promise<void>;
}

export interface PublicationExecutionReceipt {
  readonly planId: string;
  readonly fingerprint: Sha256Digest;
  readonly completed: readonly Sha256Digest[];
  readonly complete: true;
}

export class PublicationPlanError extends Error {
  constructor(readonly code: "INVALID_PLAN" | "PLAN_CONFLICT" | "JOURNAL_CORRUPT" | "JOURNAL_CONFLICT" | "PORT_MISSING", message: string) {
    super(message); this.name = "PublicationPlanError";
  }
}
