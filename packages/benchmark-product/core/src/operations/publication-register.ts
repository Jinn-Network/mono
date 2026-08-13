/** Prospective/public-after-the-fact Run registration through the neutral publication executor. */

import { RUN_MEDIA_TYPE, RUN_RECORD_KIND, readRunPublicationExtension } from "@jinn-network/benchmarking-records";
import { createDiscoverySourceAnnouncementPort } from "@jinn-network/record-publication";
import { executePublicationPlan, sha256, type PublicationPlan } from "@jinn-network/record-publication";
import { refuse } from "../errors.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { createPublisherAuthorizationArtifact, verifyPublisherAuthorizationArtifact, AUTHORIZATION_MEDIA_TYPE } from "../run/publication-authorization.js";
import {
  BENCHMARK_PUBLICATION_AUTHORIZATION_ROLE,
  createWorkspacePublicationJournal,
  createWorkspacePublicationSource,
  recordPath,
} from "../run/publication-source.js";
import { requireRunState, writeRunState } from "../run/state.js";
import type { OperationContext } from "./context.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface PublicationConfigureInput {
  readonly draftId: string;
  readonly publicBaseUrl: string;
}

export interface PublicationRegisterInput {
  readonly draftId: string;
  /** Location only. Replacing it never changes the source's did:key/name identity. */
  readonly publicBaseUrl?: string;
}

export interface PublicationRegistrationResult {
  readonly source: { readonly agent: string; readonly name: string };
  readonly postHoc: boolean;
  readonly sourceSequence: string;
  readonly recordSha256: string;
}

function publicUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function probeExact(base: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
  let response: Response;
  try { response = await fetch(publicUrl(base, recordPath(digest))); } catch (cause) {
    throw new Error(`public record probe failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) throw new Error(`public record probe returned ${response.status}`);
  const observed = new Uint8Array(await response.arrayBuffer());
  if (sha256(observed) !== digest || observed.length !== bytes.length || !observed.every((byte, index) => byte === bytes[index])) {
    throw new Error("public record probe did not return the exact announced bytes");
  }
}

/** Configure the mutable public locator independently of immutable source identity. */
export function publicationConfigure(
  context: OperationContext,
  input: PublicationConfigureInput,
): Promise<OperationResult<{ publicBaseUrl: string }>> {
  return operateAsync({
    context,
    action: "publication.configure",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const parsed = new URL(input.publicBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") refuse("validation", "publicBaseUrl", "publicBaseUrl must be http(s)");
      const state = requireRunState(context.workspaceDir, input.draftId);
      if (state.publication === undefined) refuse("conflict", `runs.${input.draftId}`, "run has no prospective publication state");
      writeRunState(context.workspaceDir, input.draftId, {
        ...state,
        publication: { ...state.publication, source: { ...state.publication.source, publicBaseUrl: parsed.toString().replace(/\/$/, "") } },
      });
      return { publicBaseUrl: parsed.toString().replace(/\/$/, "") };
    },
  });
}

export function publicationRegister(
  context: OperationContext,
  input: PublicationRegisterInput,
): Promise<OperationResult<PublicationRegistrationResult>> {
  return operateAsync({
    context,
    action: "publication.register",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      let state = requireRunState(context.workspaceDir, input.draftId);
      if (state.publication === undefined || state.runSha256 === undefined || state.closeAt === undefined) {
        refuse("conflict", `runs.${input.draftId}`, "lock the run before registering its exact public record");
      }
      const lockedRunSha256 = state.runSha256;
      const closeAt = state.closeAt;
      let publication = state.publication;
      if (input.publicBaseUrl !== undefined) {
        const configured = new URL(input.publicBaseUrl);
        publication = { ...publication, source: { ...publication.source, publicBaseUrl: configured.toString().replace(/\/$/, "") } };
        state = { ...state, publication };
        writeRunState(context.workspaceDir, input.draftId, state);
      }
      const base = publication.source.publicBaseUrl;
      if (base === undefined) refuse("validation", "publicBaseUrl", "configure a publicBaseUrl before registration so exact records can be retrieved");

      const source = createWorkspacePublicationSource(context.workspaceDir, publication.source.name);
      if (source.source.agent !== publication.source.agentKeyRef) {
        refuse("conflict", "publication.source.agentKeyRef", "workspace signing key changed; source identity cannot be re-attributed");
      }
      await source.writer.recover();
      const runBytes = getSealedBytes(context.workspaceDir, lockedRunSha256);
      const extension = readRunPublicationExtension(JSON.parse(new TextDecoder().decode(runBytes)) as Record<string, unknown>);
      const authorizationRef = extension?.registrationArtifacts.find((artifact) => artifact.role === BENCHMARK_PUBLICATION_AUTHORIZATION_ROLE);
      if (authorizationRef === undefined) refuse("record-integrity", "run.publication", "Run is missing its benchmark-publication authorization artifact");
      const authorizationDigest = authorizationRef.artifact.digest.sha256;
      const authorizationBytes = getSealedBytes(context.workspaceDir, authorizationDigest);
      if (!verifyPublisherAuthorizationArtifact({ workspaceDir: context.workspaceDir, bytes: authorizationBytes, owner: state.owner, publisher: source.source.agent, effectiveNoLaterThan: closeAt })) {
        refuse("record-integrity", "run.publication.authorization", "publisher authorization is invalid, wrong-scoped, or became effective after close");
      }

      const postHoc = state.closedAt !== undefined;
      const timestamp = publication.registration.announcedAt ?? context.clock();
      if (publication.registration.state === "not-started") {
        publication = { ...publication, registration: { ...publication.registration, state: "in-progress", announcedAt: timestamp, postHoc } };
        state = {
          ...state,
          publication,
        };
        writeRunState(context.workspaceDir, input.draftId, state);
      }
      const plan: PublicationPlan = {
        id: `benchmark-registration:${input.draftId}:${lockedRunSha256}`,
        stages: [{
          stage: "registration",
          members: [
            {
              id: "publisher-authorization",
              role: BENCHMARK_PUBLICATION_AUTHORIZATION_ROLE,
              digest: `sha256:${authorizationDigest}`,
              bytes: authorizationBytes,
              mediaType: AUTHORIZATION_MEDIA_TYPE,
              actions: ["store"],
            },
            {
              id: "run",
              kind: RUN_RECORD_KIND,
              digest: `sha256:${lockedRunSha256}`,
              bytes: runBytes,
              mediaType: RUN_MEDIA_TYPE,
              authority: { mode: "owner" },
              actions: ["store", "announce"],
              announcementTimestamp: timestamp,
              dependsOn: ["publisher-authorization"],
            },
          ],
        }],
      };
      let receipt: { sequence: string; entryDigest: `sha256:${string}` } | undefined;
      const announcement = createDiscoverySourceAnnouncementPort({ writer: source.writer });
      await executePublicationPlan(plan, {
        objects: source.artifactStore,
        journal: createWorkspacePublicationJournal(context.workspaceDir, input.draftId),
        authority: { async authorizeAnnouncement({ record }) {
          if (record.authority.mode !== "owner" || record.kind !== RUN_RECORD_KIND) throw new Error("only the workspace-owned Run may be announced");
        } },
        announce: { async announce(value) {
          const announced = await announcement.announce(value);
          const durable = announced as { sequence: string; entryDigest: `sha256:${string}` };
          receipt = durable;
          return durable;
        } },
      });
      // A completed executor journal can be replayed without calling announce, so recover the
      // original receipt from the signed writer state on retry.
      if (receipt === undefined) {
        const durable = await source.writer.readState();
        const match = Object.values(durable?.announcements ?? {}).find((entry) => entry.receipt.record?.digest === `sha256:${lockedRunSha256}`);
        if (match === undefined) throw new Error("registration journal completed without a durable Run announcement receipt");
        receipt = { sequence: match.receipt.sequence, entryDigest: match.receipt.entryDigest };
      }
      await probeExact(base, `sha256:${lockedRunSha256}`, runBytes);
      writeRunState(context.workspaceDir, input.draftId, {
        ...state,
        publication: {
          ...publication,
          registration: {
            state: "complete",
            receipt: { sourceSequence: receipt.sequence, entrySha256: receipt.entryDigest.slice("sha256:".length) },
            announcedAt: timestamp,
            postHoc,
            digests: { run: lockedRunSha256, authorization: authorizationDigest },
          },
        },
      });
      return { source: source.source, postHoc, sourceSequence: receipt.sequence, recordSha256: lockedRunSha256 };
    },
  });
}
