import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LOCATION_PROFILE_HTTPS,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  archivePagePath,
  formatOrigin,
  formatSequence,
  headPath,
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";
import { signHead, writeRecord, writeWellKnownDocument } from "@jinn-network/record-discovery-serve";
import {
  createArchiveHttpHandler,
  createFsBlobStore,
  type ArchiveHttpHandler,
} from "@jinn-network/record-discovery-transport-http";
import { signAnnouncementEntry } from "@jinn-network/marketplace-projector";
import type { NativeEvaluatorPublisherPort } from "./native-evaluator-coordinator.js";

const SOURCE_NAME = "evaluator-records";
const JSON_MEDIA_TYPE = "application/json";
const DELIVERY_ENVELOPE_KIND = "https://jinn.network/records/delivery-envelope/1.0";

interface Receipt {
  readonly location: string;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
}

interface PublisherState {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly last?: { readonly sequence: string; readonly entryDigest: `sha256:${string}`; readonly page: string };
  readonly published: Readonly<Record<string, Receipt>>;
}

export interface NativeEvaluatorPublisher extends NativeEvaluatorPublisherPort {
  readonly handler: ArchiveHttpHandler;
  close(): Promise<void>;
}

export class NativeEvaluatorPublisherOwnershipError extends Error {
  override readonly name = "NativeEvaluatorPublisherOwnershipError";
}

function kind(role: string): string {
  switch (role) {
    case "verdict": return RECORD_KINDS.resultEvaluation;
    case "evaluation-delivery": return RECORD_KINDS.delivery;
    case "evaluation-evidence": return RECORD_KINDS.executionEvidence;
    case "evaluation-delivery-envelope": return DELIVERY_ENVELOPE_KIND;
    default: throw new Error(`unsupported evaluator publication role ${role}`);
  }
}

async function load(path: string): Promise<PublisherState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PublisherState;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function save(path: string, value: PublisherState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

async function acquire(rootDir: string, source: SourceIdentity): Promise<{ handle: FileHandle; path: string }> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const path = join(rootDir, ".evaluator-publisher-owner");
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, source })}\n`, "utf8");
    await handle.sync();
    return { handle, path };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new NativeEvaluatorPublisherOwnershipError(
        `evaluator-records state path already has a lifecycle owner: ${rootDir}`,
      );
    }
    throw cause;
  }
}

/** Dedicated evaluator source: it never shares the solver publisher's identity, root, or lock. */
export async function openNativeEvaluatorPublisher(input: {
  readonly rootDir: string;
  readonly publicBaseUrl: string;
  readonly source: SourceIdentity;
  readonly signer: { readonly keyId: string; sign(payload: Uint8Array): Uint8Array };
}): Promise<NativeEvaluatorPublisher> {
  if (input.source.name !== SOURCE_NAME) {
    throw new Error(`native evaluator publisher requires source name "${SOURCE_NAME}"`);
  }
  const baseUrl = input.publicBaseUrl.replace(/\/+$/u, "");
  if (baseUrl.length === 0) throw new Error("evaluator publisher publicBaseUrl is required");
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/u, "");
  const owner = await acquire(input.rootDir, input.source);
  const statePath = join(input.rootDir, "source-state.json");
  const records = createFsBlobStore(join(input.rootDir, "public"));
  let state = (await load(statePath)) ?? {
    version: 1 as const,
    source: input.source,
    published: {},
  };
  if (state.version !== 1
    || state.source.agent !== input.source.agent
    || state.source.name !== input.source.name) {
    await owner.handle.close();
    await unlink(owner.path).catch(() => undefined);
    throw new NativeEvaluatorPublisherOwnershipError("evaluator-records root belongs to another source identity");
  }
  let closed = false;
  let append = Promise.resolve();
  const entrySigner = {
    scope: "jinn:discovery-announcements" as const,
    sign: async (pae: Uint8Array) => [{ keyid: input.signer.keyId, sig: input.signer.sign(pae) }],
  };
  const headSigner = {
    sign: async (pae: Uint8Array) => [{ keyid: input.signer.keyId, sig: input.signer.sign(pae) }],
  };

  const publish: NativeEvaluatorPublisherPort["publish"] = async (value) => {
    let resolve!: (receipt: Receipt) => void;
    let reject!: (cause: unknown) => void;
    const response = new Promise<Receipt>((res, rej) => { resolve = res; reject = rej; });
    append = append.then(async () => {
      if (closed) throw new NativeEvaluatorPublisherOwnershipError("evaluator publisher is closed");
      const existing = state.published[value.publication.publicationKey];
      if (existing !== undefined) {
        resolve(existing);
        return;
      }
      if (value.publication.sourceId !== formatOrigin(input.source.agent, input.source.name)) {
        throw new Error("evaluation publication source does not equal the owned source identity");
      }
      if (value.publication.recordDigest !== value.artifact.digest || value.artifact.mediaType === undefined) {
        throw new Error("evaluation publication does not match exact stored artifact metadata");
      }
      const written = await writeRecord(records, value.artifact.bytes, value.artifact.mediaType);
      if (written.digest !== value.publication.recordDigest) {
        throw new Error("evaluation public record write returned a different digest");
      }
      const next = state.last === undefined ? 1n : BigInt(state.last.sequence) + 1n;
      const sequence = formatSequence(next);
      const timestamp = value.publication.createdAt;
      const entry: AnnouncementEntry = {
        protocol: RECORD_DISCOVERY_VERSION,
        source: input.source,
        sequence,
        previous: state.last?.entryDigest ?? null,
        timestamp,
        announcements: [{
          announcementId: value.publication.publicationKey,
          action: "available",
          record: { kind: kind(value.publication.role), digest: value.publication.recordDigest, mediaType: value.artifact.mediaType },
          locations: [{ profile: LOCATION_PROFILE_HTTPS, locator: `${baseUrl}${recordPath(value.publication.recordDigest)}` }],
          facts: {
            evaluationId: value.publication.evaluationId,
            role: value.publication.role,
            name: value.artifact.name,
          },
        }],
      };
      const entryDigest = sealJson(entry).digest;
      const signature = await signAnnouncementEntry(entry, entrySigner);
      const page = sequence;
      await records.put(archivePagePath(input.source.name, page), sealJson({
        protocol: RECORD_DISCOVERY_VERSION,
        source: input.source.name,
        page,
        prevArchive: state.last?.page ?? null,
        entries: [{ entry, signature }],
      }).bytes, JSON_MEDIA_TYPE);
      const head: SourceHead = {
        protocol: RECORD_DISCOVERY_VERSION,
        origin: formatOrigin(input.source.agent, input.source.name),
        sequence,
        entry: entryDigest,
        issuedAt: timestamp,
        refreshBy: new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1000).toISOString(),
      };
      await records.put(
        headPath(input.source.name),
        sealJson(await signHead(head, headSigner)).bytes,
        "application/vnd.jinn.record-discovery.head.v1+json",
      );
      await writeWellKnownDocument(records, {
        protocol: RECORD_DISCOVERY_VERSION,
        sources: [{
          agent: input.source.agent,
          name: input.source.name,
          headPath: headPath(input.source.name),
          archiveRoot: archivePagePath(input.source.name, page),
        }],
      });
      const receipt = { location: `${baseUrl}${written.path}`, sequence, entryDigest };
      state = {
        ...state,
        last: { sequence, entryDigest, page },
        published: { ...state.published, [value.publication.publicationKey]: receipt },
      };
      await save(statePath, state);
      resolve(receipt);
    }).catch(reject);
    return response;
  };

  return {
    sourceId: formatOrigin(input.source.agent, input.source.name),
    publish,
    handler: createArchiveHttpHandler({ reader: records, ...(basePath === "" ? {} : { basePath }) }),
    async close() {
      if (closed) return;
      closed = true;
      await append.catch(() => undefined);
      await owner.handle.close();
      await unlink(owner.path).catch(() => undefined);
    },
  };
}
