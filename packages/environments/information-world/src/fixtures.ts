import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { CorpusArtifactReader } from "./replay.js";
import type { RequestKeyPolicy } from "./request-key-policy.js";

const fixturesRoot = new URL("../fixtures/", import.meta.url);

const read = async (relativePath: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(fileURLToPath(new URL(relativePath, fixturesRoot))));

const readText = async (relativePath: string): Promise<string> =>
  await readFile(fileURLToPath(new URL(relativePath, fixturesRoot)), "utf8");

export type GoldenName = "synthetic" | "captured" | "extension";

export const loadGoldenBytes = (name: GoldenName): Promise<Uint8Array> =>
  read(`world/${name}.json`);

export const loadGoldenJson = async (name: GoldenName): Promise<unknown> =>
  JSON.parse(await readText(`world/${name}.json`));

export const loadGoldenDigest = async (name: GoldenName): Promise<string> =>
  (await readText(`world/${name}.sha256`)).trim();

/** The bytes behind a corpus entry's ResourceDescriptor, filed by digest. */
export const loadCorpusBody = (digest: string): Promise<Uint8Array> =>
  read(`world/bodies/${digest.replace("sha256:", "")}.bin`);

/** A CorpusArtifactReader over the bundled corpus — the kit's injected port. */
export function fixtureArtifactReader(): CorpusArtifactReader {
  return { read: (descriptor) => loadCorpusBody(descriptor.digest) };
}

export const loadEquivalenceInput = async (which: "a" | "b"): Promise<unknown> =>
  JSON.parse(await readText(`equivalence/input-${which}.json`));

export const loadEquivalenceExpectedDigest = async (): Promise<string> =>
  (JSON.parse(await readText("equivalence/expected-digest.json")) as { digest: string }).digest;

export interface RequestKeyVectorRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: string;
}

export interface RequestKeyVectorGroup {
  readonly name: string;
  readonly policy: RequestKeyPolicy;
  readonly requests: readonly RequestKeyVectorRequest[];
}

export interface RequestKeyRefusalVector {
  readonly name: string;
  readonly policy: RequestKeyPolicy;
  readonly request: RequestKeyVectorRequest;
}

export const loadRequestKeyVectors = async (): Promise<{
  version: string;
  groups: readonly RequestKeyVectorGroup[];
  refusals: readonly RequestKeyRefusalVector[];
}> => JSON.parse(await readText("request-key-v1/vectors.json"));

export interface AdversarialCase {
  readonly name: string;
  /** `seal` — must fail at seal time. `service` — seals, fails service construction.
   *  `none` — seals and materializes; the case proves a labeling or verbatim-serving rule. */
  readonly stage: "seal" | "service" | "none";
  readonly reason: string;
}

export const loadAdversarialManifest = async (): Promise<{
  version: string;
  cases: readonly AdversarialCase[];
}> => JSON.parse(await readText("adversarial-v1/manifest.json"));

export const readAdversarialJson = async (name: string): Promise<unknown> =>
  JSON.parse(await readText(`adversarial-v1/${name}/document.json`));

export const readAdversarialBytes = (name: string): Promise<Uint8Array> =>
  read(`adversarial-v1/${name}/document.json`);
