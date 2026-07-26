// SPDX-License-Identifier: Apache-2.0

import {
  EvidenceRepositoryError,
  assertRepositoryOperationActive,
  createArtifactReference,
  createRecordReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordFamily,
  parseEvidenceRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type EvidenceRepositoryCapabilities,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
} from "@jinn-network/evidence-repository";
import {
  CID,
  type KuboRPCClient,
} from "kubo-rpc-client";

import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  digestToRawCid,
  normalizeRawCid,
} from "./cid.js";
import {
  ipfsRepositoryError,
  mapIpfsDependencyError,
} from "./errors.js";
import type { IpfsBlockReader } from "./readers.js";
import {
  buildRegistrationBytes,
  parseRegistrationBytes,
  registrationCidForReference,
} from "./registration.js";

const DEFAULT_READBACK_TIMEOUT_MS = 60_000;
const READBACK_RETRY_DELAY_MS = 25;
const CAPABILITIES: EvidenceRepositoryCapabilities = Object.freeze({
  maxObjectBytes: MAX_STANDARD_IPFS_BLOCK_BYTES,
});

export interface IpfsEvidenceRepositoryOptions {
  readonly client: KuboRPCClient;
  readonly reader: IpfsBlockReader;
  readonly remotePinService?: string;
  readonly readbackTimeoutMs?: number;
}

export interface IpfsRepositoryWriteReceipt<TReference>
  extends RepositoryWriteReceipt<TReference> {
  readonly contentCid: string;
  readonly registrationCid: string;
}

type EvidenceReference = EvidenceRecordReference | EvidenceArtifactReference;

interface RegisteredObject {
  readonly bytes: Uint8Array;
  readonly contentCid: string;
  readonly registrationCid: string;
}

export class IpfsEvidenceRepository implements EvidenceRepository {
  readonly capabilities = CAPABILITIES;

  readonly #client: KuboRPCClient;
  readonly #reader: IpfsBlockReader;
  readonly #remotePinService: string | undefined;
  readonly #readbackTimeoutMs: number;

  constructor(options: IpfsEvidenceRepositoryOptions) {
    if (typeof options !== "object" || options === null) {
      throw ipfsRepositoryError(
        "INVALID_REFERENCE",
        "IPFS repository options are required.",
      );
    }
    if (
      options.remotePinService !== undefined &&
      (typeof options.remotePinService !== "string" ||
        options.remotePinService.length === 0)
    ) {
      throw ipfsRepositoryError(
        "INVALID_REFERENCE",
        "remotePinService must be a non-empty configured Kubo service name.",
      );
    }
    const timeout =
      options.readbackTimeoutMs ?? DEFAULT_READBACK_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw ipfsRepositoryError(
        "INVALID_REFERENCE",
        "readbackTimeoutMs must be a non-negative safe integer.",
      );
    }
    this.#client = options.client;
    this.#reader = options.reader;
    this.#remotePinService = options.remotePinService;
    this.#readbackTimeoutMs = timeout;
  }

  async getRecord(
    untrustedReference: EvidenceRecordReference,
    options: RepositoryOperationOptions = {},
  ): Promise<Uint8Array | null> {
    const reference = parseEvidenceRecordReference(untrustedReference);
    return this.#getRegisteredObject(reference, options);
  }

  async getArtifact(
    untrustedReference: EvidenceArtifactReference,
    options: RepositoryOperationOptions = {},
  ): Promise<Uint8Array | null> {
    const reference = parseEvidenceArtifactReference(untrustedReference);
    return this.#getRegisteredObject(reference, options);
  }

  async putRecord(
    untrustedFamily: EvidenceRecordFamily,
    untrustedBytes: Uint8Array,
    options: RepositoryOperationOptions = {},
  ): Promise<IpfsRepositoryWriteReceipt<EvidenceRecordReference>> {
    const bytes = copyPutBytes(untrustedBytes, options);
    const family = parseEvidenceRecordFamily(untrustedFamily);
    return this.#putRegisteredObject(
      createRecordReference(family, bytes),
      bytes,
      options,
    );
  }

  async putArtifact(
    untrustedBytes: Uint8Array,
    options: RepositoryOperationOptions = {},
  ): Promise<IpfsRepositoryWriteReceipt<EvidenceArtifactReference>> {
    const bytes = copyPutBytes(untrustedBytes, options);
    return this.#putRegisteredObject(
      createArtifactReference(bytes),
      bytes,
      options,
    );
  }

  async #getRegisteredObject(
    reference: EvidenceReference,
    options: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    const object = await this.#readRegisteredObject(
      reference,
      options,
      false,
    );
    return object === null ? null : Uint8Array.from(object.bytes);
  }

  async #readRegisteredObject(
    reference: EvidenceReference,
    options: RepositoryOperationOptions,
    missingContentIsAbsent: boolean,
  ): Promise<RegisteredObject | null> {
    assertRepositoryOperationActive(options);
    const registrationCid = registrationCidForReference(reference);
    const registrationBytes = await this.#readBlock(
      registrationCid,
      options,
    );
    assertRepositoryOperationActive(options);
    if (registrationBytes === null) return null;

    let registration;
    try {
      registration = parseRegistrationBytes(registrationBytes);
    } catch (error) {
      if (error instanceof EvidenceRepositoryError) throw error;
      throw ipfsRepositoryError(
        "CONTENT_CORRUPT",
        "The IPFS registration block is invalid.",
        error,
      );
    }
    if (!registrationsEqual(registration.reference, reference)) {
      throw ipfsRepositoryError(
        "CONTENT_CORRUPT",
        "The IPFS registration block does not match its repository reference.",
      );
    }

    const contentCid = digestToRawCid(reference.digest);
    const contentBytes = await this.#readBlock(contentCid, options);
    assertRepositoryOperationActive(options);
    if (contentBytes === null) {
      if (missingContentIsAbsent) return null;
      throw ipfsRepositoryError(
        "CONTENT_CORRUPT",
        "The IPFS registration exists but its content block is absent.",
      );
    }
    if (createArtifactReference(contentBytes).digest !== reference.digest) {
      throw ipfsRepositoryError(
        "CONTENT_CORRUPT",
        "The IPFS content block does not match its repository reference.",
      );
    }

    return {
      bytes: contentBytes,
      contentCid,
      registrationCid,
    };
  }

  async #readBlock(
    cid: string,
    options: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    try {
      assertRepositoryOperationActive(options);
      const bytes = await this.#reader.getBlock(cid, {
        ...options,
        maxBytes: MAX_STANDARD_IPFS_BLOCK_BYTES,
      });
      assertRepositoryOperationActive(options);
      return bytes;
    } catch (error) {
      throw mapIpfsDependencyError(
        error,
        "The configured IPFS read path failed.",
        options.signal,
      );
    }
  }

  async #putRegisteredObject<TReference extends EvidenceReference>(
    reference: TReference,
    bytes: Uint8Array,
    options: RepositoryOperationOptions,
  ): Promise<IpfsRepositoryWriteReceipt<TReference>> {
    assertRepositoryOperationActive(options);
    if (bytes.byteLength > MAX_STANDARD_IPFS_BLOCK_BYTES) {
      throw ipfsRepositoryError(
        "CONTENT_TOO_LARGE",
        "IPFS repository objects must not exceed 2 MiB.",
      );
    }

    const contentCid = digestToRawCid(reference.digest);
    const registrationBytes = buildRegistrationBytes(reference);
    const registrationCid = registrationCidForReference(reference);

    const present = await this.#readRegisteredObject(
      reference,
      options,
      true,
    );
    if (
      present !== null &&
      bytesEqual(present.bytes, bytes) &&
      (await this.#hasCompleteCustody(
        contentCid,
        registrationCid,
        options,
      ))
    ) {
      return receipt(
        reference,
        bytes.byteLength,
        "existing",
        contentCid,
        registrationCid,
      );
    }

    await this.#putAndConfirmLocalPin(contentCid, bytes, options);
    await this.#putAndConfirmLocalPin(
      registrationCid,
      registrationBytes,
      options,
    );
    if (this.#remotePinService !== undefined) {
      await this.#putAndConfirmRemotePin(contentCid, options);
      await this.#putAndConfirmRemotePin(registrationCid, options);
    }
    await this.#confirmReadback(reference, bytes, options);

    return receipt(
      reference,
      bytes.byteLength,
      "created",
      contentCid,
      registrationCid,
    );
  }

  async #hasCompleteCustody(
    contentCid: string,
    registrationCid: string,
    options: RepositoryOperationOptions,
  ): Promise<boolean> {
    if (!(await this.#hasExplicitLocalPin(contentCid, options))) return false;
    if (!(await this.#hasExplicitLocalPin(registrationCid, options))) {
      return false;
    }
    if (this.#remotePinService === undefined) return true;
    if (!(await this.#hasRemotePin(contentCid, options))) return false;
    return this.#hasRemotePin(registrationCid, options);
  }

  async #putAndConfirmLocalPin(
    expectedCid: string,
    bytes: Uint8Array,
    options: RepositoryOperationOptions,
  ): Promise<void> {
    try {
      assertRepositoryOperationActive(options);
      const returnedCid = await this.#client.block.put(bytes, {
        allowBigBlock: false,
        format: "raw",
        mhtype: "sha2-256",
        pin: true,
        signal: options.signal,
        version: 1,
      });
      assertRepositoryOperationActive(options);

      let returnedCanonical: string;
      try {
        returnedCanonical = normalizeRawCid(returnedCid.toString());
      } catch (error) {
        throw ipfsRepositoryError(
          "REFERENCE_CONFLICT",
          "Kubo returned a CID outside the required raw SHA2-256 profile.",
          error,
        );
      }
      if (returnedCanonical !== expectedCid) {
        throw ipfsRepositoryError(
          "REFERENCE_CONFLICT",
          "Kubo returned a CID different from the locally computed CID.",
        );
      }
    } catch (error) {
      throw mapIpfsDependencyError(
        error,
        "Kubo failed to store the required IPFS block.",
        options.signal,
      );
    }

    if (!(await this.#hasExplicitLocalPin(expectedCid, options))) {
      throw ipfsRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        "Kubo did not confirm the required explicit local root pin.",
      );
    }
  }

  async #hasExplicitLocalPin(
    cid: string,
    options: RepositoryOperationOptions,
  ): Promise<boolean> {
    try {
      assertRepositoryOperationActive(options);
      for await (const pin of this.#client.pin.ls({
        paths: decodeRawCid(cid),
        signal: options.signal,
        type: "all",
      })) {
        assertRepositoryOperationActive(options);
        if (
          normalizeRawCid(pin.cid.toString()) === cid &&
          (pin.type === "direct" || pin.type === "recursive")
        ) {
          return true;
        }
      }
      assertRepositoryOperationActive(options);
      return false;
    } catch (error) {
      assertRepositoryOperationActive(options);
      if (isKuboNotPinnedError(error, cid)) return false;
      throw mapIpfsDependencyError(
        error,
        "Kubo failed to confirm an explicit local root pin.",
        options.signal,
      );
    }
  }

  async #putAndConfirmRemotePin(
    cid: string,
    options: RepositoryOperationOptions,
  ): Promise<void> {
    try {
      assertRepositoryOperationActive(options);
      const pin = await this.#client.pin.remote.add(decodeRawCid(cid), {
        background: false,
        service: this.#remotePinService,
        signal: options.signal,
      });
      assertRepositoryOperationActive(options);
      if (
        normalizeRawCid(pin.cid.toString()) !== cid ||
        pin.status !== "pinned"
      ) {
        throw ipfsRepositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "The configured remote pin service did not confirm the required pin.",
        );
      }
      if (!(await this.#hasRemotePin(cid, options))) {
        throw ipfsRepositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "The configured remote pin service did not list the required pin.",
        );
      }
    } catch (error) {
      throw mapIpfsDependencyError(
        error,
        "Kubo failed to establish the required remote pin.",
        options.signal,
      );
    }
  }

  async #hasRemotePin(
    cid: string,
    options: RepositoryOperationOptions,
  ): Promise<boolean> {
    try {
      assertRepositoryOperationActive(options);
      for await (const pin of this.#client.pin.remote.ls({
        cid: [decodeRawCid(cid)],
        service: this.#remotePinService,
        signal: options.signal,
        status: ["pinned"],
      })) {
        assertRepositoryOperationActive(options);
        if (
          normalizeRawCid(pin.cid.toString()) === cid &&
          pin.status === "pinned"
        ) {
          return true;
        }
      }
      assertRepositoryOperationActive(options);
      return false;
    } catch (error) {
      throw mapIpfsDependencyError(
        error,
        "Kubo failed to confirm the required remote pin.",
        options.signal,
      );
    }
  }

  async #confirmReadback(
    reference: EvidenceReference,
    expectedBytes: Uint8Array,
    options: RepositoryOperationOptions,
  ): Promise<void> {
    const deadline = Date.now() + this.#readbackTimeoutMs;
    let lastTransient: EvidenceRepositoryError | undefined;
    while (true) {
      assertRepositoryOperationActive(options);
      try {
        const object = await runReadbackAttempt(
          deadline,
          options,
          (attemptOptions) =>
            this.#readRegisteredObject(
              reference,
              attemptOptions,
              true,
            ),
        );
        if (object !== null) {
          if (!bytesEqual(object.bytes, expectedBytes)) {
            throw ipfsRepositoryError(
              "CONTENT_CORRUPT",
              "IPFS readback bytes do not match the bytes written.",
            );
          }
          return;
        }
      } catch (error) {
        if (error instanceof ReadbackDeadlineExpired) {
          throw ipfsRepositoryError(
            "DEPENDENCY_UNAVAILABLE",
            "The configured IPFS readback deadline expired.",
            lastTransient,
          );
        }
        if (
          !(error instanceof EvidenceRepositoryError) ||
          error.code !== "DEPENDENCY_UNAVAILABLE"
        ) {
          throw error;
        }
        lastTransient = error;
      }

      if (Date.now() >= deadline) {
        throw ipfsRepositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "The configured IPFS readback deadline expired.",
          lastTransient,
        );
      }
      await waitForRetry(
        Math.min(READBACK_RETRY_DELAY_MS, deadline - Date.now()),
        options,
      );
    }
  }
}

class ReadbackDeadlineExpired extends Error {}

async function runReadbackAttempt<T>(
  deadline: number,
  callerOptions: RepositoryOperationOptions,
  operation: (options: RepositoryOperationOptions) => Promise<T>,
): Promise<T> {
  assertRepositoryOperationActive(callerOptions);
  const controller = new AbortController();
  const callerSignal = callerOptions.signal;
  const deadlineError = new ReadbackDeadlineExpired(
    "The IPFS readback deadline expired.",
  );
  let rejectStop!: (error: EvidenceRepositoryError | Error) => void;
  const stop = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  let deadlineExpired = false;
  const onCallerAbort = () => {
    const error = ipfsRepositoryError(
      "OPERATION_ABORTED",
      "The IPFS repository operation was aborted.",
    );
    rejectStop(error);
    controller.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted === true) onCallerAbort();

  const timer = setTimeout(() => {
    deadlineExpired = true;
    rejectStop(deadlineError);
    controller.abort(deadlineError);
  }, Math.max(0, deadline - Date.now()));

  try {
    return await Promise.race([
      operation({
        ...callerOptions,
        signal: controller.signal,
      }),
      stop,
    ]);
  } catch (error) {
    assertRepositoryOperationActive(callerOptions);
    if (deadlineExpired) throw deadlineError;
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function copyPutBytes(
  value: Uint8Array,
  options: RepositoryOperationOptions,
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw ipfsRepositoryError(
      "CONTENT_CORRUPT",
      "Repository content must be a Uint8Array.",
    );
  }
  assertRepositoryOperationActive(options);
  if (value.byteLength > MAX_STANDARD_IPFS_BLOCK_BYTES) {
    throw ipfsRepositoryError(
      "CONTENT_TOO_LARGE",
      "IPFS repository objects must not exceed 2 MiB.",
    );
  }
  return Uint8Array.from(value);
}

function registrationsEqual(
  actual: EvidenceReference,
  expected: EvidenceReference,
): boolean {
  if (actual.digest !== expected.digest) return false;
  const actualFamily = "family" in actual ? actual.family : undefined;
  const expectedFamily = "family" in expected ? expected.family : undefined;
  return actualFamily === expectedFamily;
}

function receipt<TReference>(
  reference: TReference,
  size: number,
  status: "created" | "existing",
  contentCid: string,
  registrationCid: string,
): IpfsRepositoryWriteReceipt<TReference> {
  return {
    contentCid,
    reference,
    registrationCid,
    size,
    status,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function decodeRawCid(cid: string): CID {
  const canonical = normalizeRawCid(cid);
  return CID.decode(Buffer.from(canonical.slice(1), "hex"));
}

function isKuboNotPinnedError(error: unknown, cid: string): boolean {
  if (!(error instanceof Error) || typeof error !== "object") return false;
  const response =
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null
      ? error.response
      : undefined;
  const status =
    response !== undefined &&
    "status" in response &&
    typeof response.status === "number"
      ? response.status
      : undefined;
  return (
    status === 500 &&
    error.message === `path '${decodeRawCid(cid).toString()}' is not pinned`
  );
}

async function waitForRetry(
  delayMs: number,
  options: RepositoryOperationOptions,
): Promise<void> {
  assertRepositoryOperationActive(options);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const signal = options.signal;
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        ipfsRepositoryError(
          "OPERATION_ABORTED",
          "The IPFS repository operation was aborted.",
        ),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  assertRepositoryOperationActive(options);
}
