import { spawn } from "node:child_process";

import {
  EvidenceRepositoryError,
  assertRepositoryOperationActive,
  createArtifactReference,
  createRecordReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";

import {
  OCI_EMPTY_JSON_BYTES,
  OCI_EMPTY_JSON_DIGEST,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  buildEvidenceOciManifest,
  canonicalizeEvidenceOciManifest,
  evidenceLookupTag,
  validateEvidenceOciManifest,
} from "./manifest.js";

export interface OrasCliEvidenceRepositoryOptions {
  readonly repository: string;
  readonly orasPath?: string;
  readonly registryConfigPath?: string;
  readonly plainHttp?: boolean;
  readonly insecure?: boolean;
  readonly caFile?: string;
}

export interface OciRepositoryWriteReceipt<TReference>
  extends RepositoryWriteReceipt<TReference> {
  readonly manifestDigest: Sha256Digest;
  readonly canonicalReference: `${string}@${Sha256Digest}`;
  readonly lookupTag: string;
}

interface OrasCommandOptions {
  readonly input?: Uint8Array;
  readonly signal?: AbortSignal;
  readonly missingReturnsNull?: boolean;
}

const ORAS_MINIMUM_VERSION = [1, 3, 0] as const;
const ORAS_MAXIMUM_MAJOR = 2;
const REGISTRY_HOST_PATTERN = /^[a-z0-9.-]+(?::[0-9]+)?$/u;
const REPOSITORY_COMPONENT_PATTERN =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/u;

function errorText(stderr: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(stderr).trim();
}

function isNotFound(text: string): boolean {
  return /(?:not found|manifest unknown|manifest_unknown|404)/iu.test(text);
}

function mapCommandFailure(
  message: string,
  cause?: unknown,
): EvidenceRepositoryError {
  if (
    /(?:unauthorized|access denied|denied|authentication required|401|403)/iu.test(
      message,
    )
  ) {
    return new EvidenceRepositoryError("ACCESS_DENIED", message, { cause });
  }
  if (
    /(?:connection refused|connection reset|no such host|network is unreachable|timeout|temporarily unavailable|service unavailable|502|503|504)/iu.test(
      message,
    )
  ) {
    return new EvidenceRepositoryError(
      "DEPENDENCY_UNAVAILABLE",
      message,
      { cause },
    );
  }
  return new EvidenceRepositoryError("IO_FAILURE", message, { cause });
}

function validateRepositoryName(repository: unknown): string {
  const components =
    typeof repository === "string" ? repository.split("/") : [];
  const host = components.shift();
  if (
    typeof repository !== "string" ||
    host === undefined ||
    !REGISTRY_HOST_PATTERN.test(host) ||
    components.length === 0 ||
    components.some(
      (component) => !REPOSITORY_COMPONENT_PATTERN.test(component),
    ) ||
    repository.includes("@") ||
    repository.includes("://") ||
    repository.slice(repository.lastIndexOf("/") + 1).includes(":")
  ) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      "repository must be a lowercase host/namespace/name without a scheme, tag, or digest.",
    );
  }
  return repository;
}

function validateOptionalPath(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new EvidenceRepositoryError(
      "INVALID_REFERENCE",
      `${name} must be a non-empty filesystem path without NUL bytes.`,
    );
  }
  return value;
}

function parseOrasVersion(output: Uint8Array): readonly [number, number, number] {
  const text = errorText(output);
  const match = /(?:Version:\s*)?(\d+)\.(\d+)\.(\d+)/u.exec(text);
  if (!match) {
    throw new EvidenceRepositoryError(
      "DEPENDENCY_UNAVAILABLE",
      "Unable to determine the installed ORAS version.",
    );
  }
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

function isSupportedOrasVersion(
  version: readonly [number, number, number],
): boolean {
  if (version[0] >= ORAS_MAXIMUM_MAJOR) return false;
  for (let index = 0; index < version.length; index += 1) {
    if (version[index]! > ORAS_MINIMUM_VERSION[index]!) return true;
    if (version[index]! < ORAS_MINIMUM_VERSION[index]!) return false;
  }
  return true;
}

export class OrasCliEvidenceRepository implements EvidenceRepository {
  readonly #repository: string;
  readonly #orasPath: string;
  readonly #registryFlags: readonly string[];

  private constructor(options: OrasCliEvidenceRepositoryOptions) {
    this.#repository = validateRepositoryName(options.repository);
    this.#orasPath = validateOptionalPath(options.orasPath, "orasPath") ?? "oras";

    const flags: string[] = [];
    const registryConfigPath = validateOptionalPath(
      options.registryConfigPath,
      "registryConfigPath",
    );
    const caFile = validateOptionalPath(options.caFile, "caFile");
    for (const [name, value] of [
      ["plainHttp", options.plainHttp],
      ["insecure", options.insecure],
    ] as const) {
      if (value !== undefined && typeof value !== "boolean") {
        throw new EvidenceRepositoryError(
          "INVALID_REFERENCE",
          `${name} must be a boolean when supplied.`,
        );
      }
    }
    if (registryConfigPath !== undefined) {
      flags.push("--registry-config", registryConfigPath);
    }
    if (options.plainHttp === true) flags.push("--plain-http");
    if (options.insecure === true) flags.push("--insecure");
    if (caFile !== undefined) flags.push("--ca-file", caFile);
    this.#registryFlags = Object.freeze(flags);
  }

  static async create(
    options: OrasCliEvidenceRepositoryOptions,
  ): Promise<OrasCliEvidenceRepository> {
    const repository = new OrasCliEvidenceRepository(options);
    const versionOutput = await repository.#runOras(["version"]);
    if (versionOutput === null) {
      throw new EvidenceRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        "Unable to determine the installed ORAS version.",
      );
    }
    const version = parseOrasVersion(versionOutput);
    if (!isSupportedOrasVersion(version)) {
      throw new EvidenceRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        `ORAS ${version.join(".")} is unsupported; expected >=1.3.0 <2.`,
      );
    }
    return repository;
  }

  get repository(): string {
    return this.#repository;
  }

  async #runOras(
    arguments_: readonly string[],
    options: OrasCommandOptions = {},
  ): Promise<Uint8Array | null> {
    assertRepositoryOperationActive({ signal: options.signal });

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.#orasPath, [...arguments_], {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          reject(
            new EvidenceRepositoryError(
              "OPERATION_ABORTED",
              "The ORAS operation was aborted.",
              { cause: error },
            ),
          );
          return;
        }
        reject(
          new EvidenceRepositoryError(
            "DEPENDENCY_UNAVAILABLE",
            "Unable to start the ORAS executable.",
            { cause: error },
          ),
        );
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const settleReject = (error: EvidenceRepositoryError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on("error", () => {
        // A command may reject before consuming stdin; its exit status is the
        // authoritative failure and is handled below.
      });
      child.once("error", (error) => {
        if (options.signal?.aborted || error.name === "AbortError") {
          settleReject(
            new EvidenceRepositoryError(
              "OPERATION_ABORTED",
              "The ORAS operation was aborted.",
              { cause: error },
            ),
          );
          return;
        }
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "ENOENT"
        ) {
          settleReject(
            new EvidenceRepositoryError(
              "DEPENDENCY_UNAVAILABLE",
              "The ORAS executable was not found.",
              { cause: error },
            ),
          );
          return;
        }
        settleReject(
          mapCommandFailure("Unable to execute ORAS.", error),
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        if (options.signal?.aborted || signal !== null) {
          settleReject(
            new EvidenceRepositoryError(
              "OPERATION_ABORTED",
              "The ORAS operation was aborted.",
            ),
          );
          return;
        }
        const output = new Uint8Array(Buffer.concat(stdout));
        if (code === 0) {
          settled = true;
          resolve(output);
          return;
        }
        const commandError = errorText(
          new Uint8Array(Buffer.concat(stderr)),
        );
        if (options.missingReturnsNull && isNotFound(commandError)) {
          settled = true;
          resolve(null);
          return;
        }
        settleReject(
          mapCommandFailure(
            commandError.length > 0
              ? `ORAS failed: ${commandError}`
              : `ORAS exited with status ${String(code)}.`,
          ),
        );
      });

      child.stdin.end(options.input);
    });
  }

  #command(
    command: readonly string[],
    commandOptions: readonly string[],
    target: string,
    trailing?: string,
  ): string[] {
    return [
      ...command,
      ...commandOptions,
      ...this.#registryFlags,
      target,
      ...(trailing === undefined ? [] : [trailing]),
    ];
  }

  async #fetchManifest(
    lookupTag: string,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.#runOras(
      this.#command(
        ["manifest", "fetch"],
        [
          "--media-type",
          OCI_IMAGE_MANIFEST_MEDIA_TYPE,
          "--output",
          "-",
        ],
        `${this.#repository}:${lookupTag}`,
      ),
      { signal: options?.signal, missingReturnsNull: true },
    );
  }

  async #fetchBlob(
    digest: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.#runOras(
      this.#command(
        ["blob", "fetch"],
        ["--output", "-"],
        `${this.#repository}@${digest}`,
      ),
      { signal: options?.signal, missingReturnsNull: true },
    );
  }

  async #pushBlob(
    digest: Sha256Digest,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<void> {
    await this.#runOras(
      this.#command(
        ["blob", "push"],
        ["--size", String(bytes.byteLength), "--no-tty"],
        `${this.#repository}@${digest}`,
        "-",
      ),
      { input: bytes, signal: options?.signal },
    );
  }

  async #pushManifest(
    lookupTag: string,
    manifestBytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<void> {
    await this.#runOras(
      this.#command(
        ["manifest", "push"],
        ["--media-type", OCI_IMAGE_MANIFEST_MEDIA_TYPE],
        `${this.#repository}:${lookupTag}`,
        "-",
      ),
      { input: manifestBytes, signal: options?.signal },
    );
  }

  async #readContent(
    reference: EvidenceRecordReference | EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    const lookupTag = evidenceLookupTag(reference);
    const manifestBytes = await this.#fetchManifest(lookupTag, options);
    if (manifestBytes === null) return null;
    const validation = validateEvidenceOciManifest(
      manifestBytes,
      reference,
    );
    const content = await this.#fetchBlob(reference.digest, options);
    if (content === null) {
      throw new EvidenceRepositoryError(
        "CONTENT_CORRUPT",
        `OCI manifest ${validation.manifestDigest} references a missing content blob.`,
      );
    }
    if (
      content.byteLength !== validation.contentSize ||
      createArtifactReference(content).digest !== reference.digest
    ) {
      throw new EvidenceRepositoryError(
        "CONTENT_CORRUPT",
        `OCI content does not match ${reference.digest}.`,
      );
    }
    return Uint8Array.from(content);
  }

  #receipt<TReference>(
    reference: TReference,
    size: number,
    status: "created" | "existing",
    manifestDigest: Sha256Digest,
    lookupTag: string,
  ): OciRepositoryWriteReceipt<TReference> {
    return {
      reference,
      size,
      status,
      manifestDigest,
      canonicalReference:
        `${this.#repository}@${manifestDigest}` as `${string}@${Sha256Digest}`,
      lookupTag,
    };
  }

  async #putContent<
    TReference extends EvidenceRecordReference | EvidenceArtifactReference,
  >(
    reference: TReference,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<OciRepositoryWriteReceipt<TReference>> {
    assertRepositoryOperationActive(options);
    const lookupTag = evidenceLookupTag(reference);
    const manifest = buildEvidenceOciManifest(reference, bytes.byteLength);
    const expectedManifestBytes =
      canonicalizeEvidenceOciManifest(manifest);
    const expectedManifestDigest =
      createArtifactReference(expectedManifestBytes).digest;
    const existingManifestBytes = await this.#fetchManifest(
      lookupTag,
      options,
    );
    if (existingManifestBytes !== null) {
      let validation;
      try {
        validation = validateEvidenceOciManifest(
          existingManifestBytes,
          reference,
          bytes.byteLength,
        );
      } catch (error) {
        throw new EvidenceRepositoryError(
          "REFERENCE_CONFLICT",
          `OCI lookup tag ${lookupTag} resolves to different content.`,
          { cause: error },
        );
      }
      if (validation.manifestDigest !== expectedManifestDigest) {
        throw new EvidenceRepositoryError(
          "REFERENCE_CONFLICT",
          `OCI lookup tag ${lookupTag} resolves to a noncanonical manifest.`,
        );
      }
      const existingContent = await this.#fetchBlob(reference.digest, options);
      if (
        existingContent === null ||
        existingContent.byteLength !== bytes.byteLength ||
        !Buffer.from(existingContent).equals(Buffer.from(bytes))
      ) {
        throw new EvidenceRepositoryError(
          "CONTENT_CORRUPT",
          `Existing OCI content does not match ${reference.digest}.`,
        );
      }
      return this.#receipt(
        reference,
        bytes.byteLength,
        "existing",
        expectedManifestDigest,
        lookupTag,
      );
    }

    await this.#pushBlob(
      OCI_EMPTY_JSON_DIGEST,
      OCI_EMPTY_JSON_BYTES,
      options,
    );
    await this.#pushBlob(reference.digest, bytes, options);
    await this.#pushManifest(lookupTag, expectedManifestBytes, options);

    const publishedManifestBytes = await this.#fetchManifest(
      lookupTag,
      options,
    );
    if (publishedManifestBytes === null) {
      throw new EvidenceRepositoryError(
        "IO_FAILURE",
        `OCI lookup tag ${lookupTag} disappeared after publication.`,
      );
    }
    let published;
    try {
      published = validateEvidenceOciManifest(
        publishedManifestBytes,
        reference,
        bytes.byteLength,
      );
    } catch (error) {
      throw new EvidenceRepositoryError(
        "REFERENCE_CONFLICT",
        `OCI lookup tag ${lookupTag} changed during publication.`,
        { cause: error },
      );
    }
    if (published.manifestDigest !== expectedManifestDigest) {
      throw new EvidenceRepositoryError(
        "REFERENCE_CONFLICT",
        `OCI lookup tag ${lookupTag} changed during publication.`,
      );
    }
    return this.#receipt(
      reference,
      bytes.byteLength,
      "created",
      expectedManifestDigest,
      lookupTag,
    );
  }

  async putRecord(
    family: EvidenceRecordFamily,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<OciRepositoryWriteReceipt<EvidenceRecordReference>> {
    return this.#putContent(createRecordReference(family, bytes), bytes, options);
  }

  async getRecord(
    untrustedReference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.#readContent(
      parseEvidenceRecordReference(untrustedReference),
      options,
    );
  }

  async putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<OciRepositoryWriteReceipt<EvidenceArtifactReference>> {
    return this.#putContent(createArtifactReference(bytes), bytes, options);
  }

  async getArtifact(
    untrustedReference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.#readContent(
      parseEvidenceArtifactReference(untrustedReference),
      options,
    );
  }
}

export async function createOrasCliEvidenceRepository(
  options: OrasCliEvidenceRepositoryOptions,
): Promise<OrasCliEvidenceRepository> {
  return OrasCliEvidenceRepository.create(options);
}
