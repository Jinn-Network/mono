/**
 * Product composition for the public Record Discovery source.  The source identity is the
 * workspace report key's did:key; the workspace filesystem supplies both the durable writer's
 * CAS documents and the immutable public object tree.  URLs are intentionally absent here:
 * they are locators configured in RunState, never source identity.
 */

import { createHash, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { DISCOVERY_SIGNING_SCOPE, recordPath, type SourceIdentity } from "@jinn-network/record-discovery-protocol";
import {
  createDurableSourceWriter,
  type CasSnapshot,
  type CasWriteResult,
  type DurableSourceAppendIntent,
  type DurableSourceSigner,
  type DurableSourceState,
  type SourceAppendIntentStore,
  type SourceStateStore,
} from "@jinn-network/record-discovery-serve";
import { createArchiveHttpHandler, createFsBlobStore, IMMUTABLE_CACHE_CONTROL } from "@jinn-network/record-discovery-transport-http";
import { sha256 as publicationSha256, type CasResult, type PublicationJournal, type PublicationJournalStore } from "@jinn-network/record-publication";
import { atomicWriteFileSync, fsyncDirectorySync, readFileIfExistsSync } from "../fs/atomic.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { publicationJournalPath, publicationServeRoot, publicationStatePath } from "../workspace/layout.js";

const text = new TextEncoder();
const AUTHORIZATION_MEDIA_TYPE = "application/vnd.jinn.benchmark-publication.authorization.v1+json";

function opaqueId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function revision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function readJson<T>(path: string): T | undefined {
  const bytes = readFileIfExistsSync(path);
  return bytes === undefined ? undefined : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
}

/** Filesystem CAS for the writer's small state/intent documents. */
function sourceCasStore<T>(workspaceDir: string, sourceId: string, kind: "state" | "intent"): {
  read(): Promise<CasSnapshot<T> | undefined>;
  compareAndSwap(expected: string | null, next: T | undefined): Promise<CasWriteResult>;
} {
  const path = publicationStatePath(workspaceDir, opaqueId(sourceId), kind);
  return {
    async read() {
      const value = readJson<T>(path);
      return value === undefined ? undefined : { revision: revision(value), value };
    },
    async compareAndSwap(expected, next) {
      const current = readJson<T>(path);
      const currentRevision = current === undefined ? null : revision(current);
      if (currentRevision !== expected) return { ok: false };
      if (next === undefined) {
        // The source writer only clears a successfully committed intent.
        if (existsSync(path)) {
          unlinkSync(path);
          fsyncDirectorySync(dirname(path));
        }
        return { ok: true, revision: revision(undefined) };
      }
      atomicWriteFileSync(path, JSON.stringify(next));
      return { ok: true, revision: revision(next) };
    },
  };
}

function sourceSigner(workspaceDir: string): DurableSourceSigner {
  const key = loadOrCreateReportSigningKey(workspaceDir);
  return {
    keyId: key.keyId,
    scope: DISCOVERY_SIGNING_SCOPE,
    async sign(pae) {
      return [{ keyid: key.keyId, sig: key.sign(pae) }];
    },
    verify(pae, signature) {
      return cryptoVerify(null, Buffer.from(pae), key.publicKey, Buffer.from(signature));
    },
  };
}

export interface WorkspacePublicationSource {
  readonly source: SourceIdentity;
  readonly writer: ReturnType<typeof createDurableSourceWriter>;
  readonly artifactStore: {
    putExact(input: { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array; readonly mediaType: string }): Promise<void>;
    getExact(digest: `sha256:${string}`): Promise<Uint8Array | undefined>;
  };
}

/** Creates/reopens the one stable source for this workspace. */
export function createWorkspacePublicationSource(workspaceDir: string, sourceName: string): WorkspacePublicationSource {
  const signer = sourceSigner(workspaceDir);
  const source: SourceIdentity = { agent: signer.keyId, name: sourceName };
  const sourceId = `${source.agent}\u001f${source.name}`;
  const root = publicationServeRoot(workspaceDir);
  mkdirSync(root, { recursive: true });
  const blobs = createFsBlobStore(root);
  const stateCas = sourceCasStore<DurableSourceState>(workspaceDir, sourceId, "state");
  const intentCas = sourceCasStore<DurableSourceAppendIntent>(workspaceDir, sourceId, "intent");
  const states: SourceStateStore = {
    read: () => stateCas.read(),
    compareAndSwap: (_id, expected, next) => stateCas.compareAndSwap(expected, next),
  };
  const intents: SourceAppendIntentStore = {
    read: async () => {
      const value = await intentCas.read();
      // `undefined` serialized as a tombstone is equivalent to a cleared intent.
      return value?.value === undefined ? undefined : value;
    },
    compareAndSwap: (_id, expected, next) => intentCas.compareAndSwap(expected, next),
  };
  return {
    source,
    writer: createDurableSourceWriter({ source, signer, blobs, states, intents }),
    artifactStore: {
      async putExact({ digest, bytes, mediaType }) {
        const path = `/publication-artifacts/sha256/${digest.slice("sha256:".length)}`;
        await blobs.putImmutable(path, bytes, mediaType);
      },
      async getExact(digest) {
        const stored = await blobs.get(`/publication-artifacts/sha256/${digest.slice("sha256:".length)}`);
        return stored === undefined ? undefined : stored.bytes;
      },
    },
  };
}

/** Durable neutral-plan journal, CAS-shaped so record-publication owns retry semantics. */
export function createWorkspacePublicationJournal(workspaceDir: string, draftId: string): PublicationJournalStore {
  const path = publicationJournalPath(workspaceDir, draftId);
  return {
    async read() {
      const value = readJson<PublicationJournal>(path);
      return value === undefined ? undefined : { revision: revision(value), value };
    },
    async compareAndSwap(_id, expected, next): Promise<CasResult> {
      const current = readJson<PublicationJournal>(path);
      if ((current === undefined ? null : revision(current)) !== expected) return { ok: false };
      atomicWriteFileSync(path, JSON.stringify(next));
      return { ok: true, revision: revision(next) };
    },
  };
}

/** Plain Request/Response composition for a future web mount (PUB-14 owns mounting). */
export function createWorkspacePublicationHttpHandler(workspaceDir: string): (request: Request) => Promise<Response> {
  const blobs = createFsBlobStore(publicationServeRoot(workspaceDir));
  const archive = createArchiveHttpHandler({ reader: blobs });
  return async (request) => {
    const path = new URL(request.url).pathname;
    const artifact = /^\/publication-artifacts\/sha256\/([a-f0-9]{64})$/.exec(path);
    if (artifact !== null) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      const object = await blobs.get(path);
      if (object === undefined) return new Response(null, { status: 404 });
      if (publicationSha256(object.bytes) !== `sha256:${artifact[1]}`) return new Response(null, { status: 409 });
      return new Response(request.method === "HEAD" ? null : object.bytes, {
        status: 200,
        headers: { "content-type": object.contentType, "cache-control": IMMUTABLE_CACHE_CONTROL },
      });
    }
    return archive(request);
  };
}

export const BENCHMARK_PUBLICATION_AUTHORIZATION_ROLE = "https://spec.jinn.network/artifacts/benchmark-publication-authorization/v1";
export const BENCHMARK_PUBLICATION_AUTHORIZATION_SCOPE = "jinn:benchmark-publication";
export { AUTHORIZATION_MEDIA_TYPE, recordPath };
