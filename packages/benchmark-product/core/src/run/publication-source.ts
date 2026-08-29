/**
 * Product composition for the public Record Discovery source.  The source identity is the
 * workspace report key's did:key; the workspace filesystem supplies both the durable writer's
 * CAS documents and the immutable public object tree.  URLs are intentionally absent here:
 * they are locators configured in RunState, never source identity.
 */

import { createHash, verify as cryptoVerify } from "node:crypto";
import { constants, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  headPath,
  parseSourceHead,
  parseWireDsseEnvelope,
  recordPath,
  sealJson,
  type SourceHead,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import {
  createDurableSourceWriter,
  writeWellKnownDocument,
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
import { acquirePublicationLock } from "./publication-lock.js";

/** Canonical archive-mount contract shared by registration, accounting, launch, and Report. */
export function normalizePublicArchiveBaseUrl(value: string): string {
  // Validate the spelling before WHATWG URL normalization can erase encoded/raw dot segments or
  // reinterpret a backslash as a path separator. The configured value is a mount, not a URL base
  // that may navigate to a parent directory.
  if (value.includes("\\")) throw new Error("public archive base URL must use a confined URL path");
  const schemeEnd = value.indexOf("://");
  if (schemeEnd >= 0) {
    const afterAuthority = value.slice(schemeEnd + 3);
    const pathStart = afterAuthority.indexOf("/");
    const rawPath = pathStart < 0 ? "" : afterAuthority.slice(pathStart).split(/[?#]/u, 1)[0];
    for (const segment of rawPath.split("/")) {
      let decoded: string;
      try { decoded = decodeURIComponent(segment); } catch {
        throw new Error("public archive base URL must use valid URL encoding");
      }
      if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
        throw new Error("public archive base URL must use a confined URL path");
      }
    }
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("public archive base URL must be http(s)");
  if (parsed.username !== "" || parsed.password !== "") throw new Error("public archive base URL must not contain credentials");
  if (parsed.search !== "" || parsed.hash !== "") throw new Error("public archive base URL must not contain a query or fragment");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

/** `publicBaseUrl` is the exact archive mount; leading slashes never reset it to the origin. */
export function publicArchiveUrl(publicBaseUrl: string, archivePath: string): string {
  const base = normalizePublicArchiveBaseUrl(publicBaseUrl);
  const relative = archivePath.replace(/^\/+/, "");
  let unsafe = relative.length === 0;
  try {
    unsafe ||= relative.split("/").some((segment) => {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    });
  } catch { unsafe = true; }
  if (unsafe) {
    throw new Error("public archive path must be a non-empty confined archive path");
  }
  return new URL(relative, `${base}/`).toString();
}

function opaqueId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function revision(value: unknown): string {
  return createHash("sha256").update(value === undefined ? "undefined" : JSON.stringify(value), "utf8").digest("hex");
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

/**
 * Writes the well-known discovery document for this workspace's one source.
 *
 * The document is the only thing in the served layout a first-time consumer can read without
 * already knowing the archive's page names: `coldSync` starts at `archiveRoot` and walks back to
 * genesis through `prevArchive`. It is derived, not authoritative -- the head and the signed
 * pages are -- so it is rewritten from the writer's committed position after every append rather
 * than maintained as separate state, and `refreshWorkspacePublicationWellKnown` reconstructs it
 * for a source that appended before this workspace ever served anything.
 *
 * `undefined` position means the source has never appended: there is no archive root to point a
 * consumer at, and no document is written.
 */
async function writeSourceWellKnown(
  blobs: { put(path: string, bytes: Uint8Array, contentType: string): Promise<void> },
  source: SourceIdentity,
  writer: Pick<ReturnType<typeof createDurableSourceWriter>, "readState">,
): Promise<boolean> {
  const state = await writer.readState();
  const page = state?.last?.page;
  if (page === undefined) return false;
  await writeWellKnownDocument(blobs, {
    protocol: RECORD_DISCOVERY_VERSION,
    sources: [{
      agent: source.agent,
      name: source.name,
      headPath: headPath(source.name),
      archiveRoot: archivePagePath(source.name, page),
    }],
  });
  return true;
}

export interface WorkspacePublicationSource {
  readonly source: SourceIdentity;
  readonly writer: ReturnType<typeof createDurableSourceWriter>;
  readonly artifactStore: {
    putExact(input: { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array; readonly mediaType: string }): Promise<void>;
    getExact(digest: `sha256:${string}`): Promise<Uint8Array | undefined>;
  };
  /** Exact records owned by the source writer live under Record Discovery's recordPath. */
  readonly recordStore: {
    getExact(digest: `sha256:${string}`): Promise<Uint8Array | undefined>;
  };
  /** Exact signed archive pages, used to reconstruct a capture journal fact after a crash. */
  readonly archiveStore: {
    getExact(page: string): Promise<Uint8Array | undefined>;
  };
  /** Exact signed source head, used to allocate a strictly later frozen append timestamp. */
  readonly head: {
    getExact(): Promise<SourceHead | undefined>;
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
  const writer = createDurableSourceWriter({ source, signer, blobs, states, intents });
  // Every durable position change refreshes the well-known document, so the served layout is
  // consumable by a cold client the moment the append that made it public commits. Both entry
  // points are wrapped because `recover` commits a pending intent -- the crash path advances the
  // position exactly as `append` does.
  //
  // The refresh cannot fail the append that triggered it. The append is already durable at this
  // point and its idempotency key is the announcementId PLUS a fingerprint over the exact input
  // (timestamp included), so a caller that replays after a rethrow with a freshly computed
  // timestamp gets a conflict, not a resumption -- a full-disk moment while writing a DERIVED
  // file would wedge the draft. It is derived, and `startPublicationArchiveServer` rebuilds it on
  // every start, so a failure here is left for that rebuild to heal.
  const refreshWellKnown = async (): Promise<void> => {
    try { await writeSourceWellKnown(blobs, source, writer); } catch { /* healed at serve time */ }
  };
  const servedWriter: typeof writer = {
    readState: () => writer.readState(),
    append: async (command) => {
      const receipt = await writer.append(command);
      await refreshWellKnown();
      return receipt;
    },
    recover: async () => {
      const report = await writer.recover();
      await refreshWellKnown();
      return report;
    },
  };
  return {
    source,
    writer: servedWriter,
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
    recordStore: {
      async getExact(digest) {
        const stored = await blobs.get(recordPath(digest));
        if (stored === undefined) return undefined;
        if (publicationSha256(stored.bytes) !== digest) throw new Error(`source record ${digest} fails its recordPath digest`);
        return stored.bytes;
      },
    },
    archiveStore: {
      async getExact(page) {
        const stored = await blobs.get(archivePagePath(source.name, page));
        return stored === undefined ? undefined : stored.bytes;
      },
    },
    head: {
      async getExact() {
        const stored = await blobs.get(headPath(source.name));
        if (stored === undefined) return undefined;
        if (stored.contentType !== MEDIA_HEAD) throw new Error(`source head content type must be ${MEDIA_HEAD}`);
        const envelope = parseWireDsseEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)));
        if (envelope.envelope.payloadType !== MEDIA_HEAD) throw new Error(`source head payloadType must be ${MEDIA_HEAD}`);
        const pae = dssePreAuthEncoding(MEDIA_HEAD, envelope.payloadBytes);
        let valid = false;
        for (const signature of envelope.signatures) {
          if (signature.keyid === signer.keyId && await signer.verify(pae, signature.signatureBytes)) valid = true;
        }
        if (!valid) throw new Error("source head signature does not verify under the workspace source key");
        const head = parseSourceHead(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes)));
        if (head.origin !== formatOrigin(source.agent, source.name)) throw new Error("source head origin does not match the workspace source");
        if (publicationSha256(envelope.payloadBytes) !== sealJson(head).digest) throw new Error("source head payload is not exact canonical JSON");
        return head;
      },
    },
  };
}

/** Cross-process source serialization. The underlying CAS revisions still detect corruption;
 * this lock makes read/compare/write one single-writer transaction across product processes. */
export async function withWorkspacePublicationSourceLock<T>(
  workspaceDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = await acquirePublicationLock(workspaceDir, "__record-discovery-source__");
  try { return await run(); } finally { lock.release(); }
}

/**
 * Rebuilds the well-known discovery document from the source's committed position. Idempotent,
 * and a no-op returning `false` for a source that has never appended. Taken under the source lock
 * so it never observes a position mid-append.
 */
export async function refreshWorkspacePublicationWellKnown(workspaceDir: string, sourceName: string): Promise<boolean> {
  return withWorkspacePublicationSourceLock(workspaceDir, async () => {
    const source = createWorkspacePublicationSource(workspaceDir, sourceName);
    const blobs = createFsBlobStore(publicationServeRoot(workspaceDir));
    return writeSourceWellKnown(blobs, source.source, source.writer);
  });
}

/** Durable neutral-plan journal, CAS-shaped so record-publication owns retry semantics. */
export function createWorkspacePublicationJournal(workspaceDir: string, draftId: string, stage?: string): PublicationJournalStore {
  const path = publicationJournalPath(workspaceDir, draftId, stage);
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
  const root = publicationServeRoot(workspaceDir);
  const confinedReader = {
    async get(path: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
      const rootReal = await realpath(root);
      const candidate = resolve(root, `.${path.startsWith("/") ? path : `/${path}`}`);
      if (candidate !== resolve(root) && !candidate.startsWith(resolve(root) + sep)) throw new Error("unsafe publication path");
      const readConfined = async (file: string): Promise<Uint8Array | undefined> => {
        let handle;
        try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw cause;
        }
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) throw new Error("publication object is not a regular file");
          const resolved = await realpath(file);
          if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) throw new Error("publication object resolves outside the serving root");
          const current = await stat(resolved);
          if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("publication object changed during confined open");
          return new Uint8Array(await handle.readFile());
        } finally { await handle.close(); }
      };
      const bytes = await readConfined(candidate);
      if (bytes === undefined) return undefined;
      const declared = await readConfined(`${candidate}.content-type`);
      const contentType = declared === undefined
        ? "application/octet-stream"
        : new TextDecoder("utf-8", { fatal: true }).decode(declared);
      // Sidecars are data, never raw header syntax. Keep the accepted form deliberately narrow so
      // a raced or corrupted sidecar cannot smuggle additional response headers.
      if (contentType.length > 512
        || contentType.trim() !== contentType
        || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[^\r\n\0]+)*$/u.test(contentType)) {
        throw new Error("publication content type is invalid");
      }
      return { bytes, contentType };
    },
  };
  const archive = createArchiveHttpHandler({ reader: confinedReader });
  return async (request) => {
    try {
      const path = new URL(request.url).pathname;
      const artifact = /^\/publication-artifacts\/sha256\/([a-f0-9]{64})$/.exec(path);
      if (artifact !== null) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
        const object = await confinedReader.get(path);
        if (object === undefined) return new Response(null, { status: 404 });
        if (publicationSha256(object.bytes) !== `sha256:${artifact[1]}`) return new Response(null, { status: 409 });
        return new Response(request.method === "HEAD" ? null : object.bytes, {
          status: 200,
          headers: {
            "content-type": object.contentType,
            "cache-control": IMMUTABLE_CACHE_CONTROL,
            "x-content-type-options": "nosniff",
          },
        });
      }
      const response = await archive(request);
      const headers = new Headers(response.headers);
      headers.set("x-content-type-options", "nosniff");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch {
      // Confinement failures are indistinguishable from absence on the public surface.
      return new Response(null, { status: 404 });
    }
  };
}

export { recordPath };
