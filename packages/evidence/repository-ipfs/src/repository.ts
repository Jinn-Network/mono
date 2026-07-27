// SPDX-License-Identifier: Apache-2.0

import { isUint8Array } from "node:util/types";

import {
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
  type EvidenceRepositoryError,
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
  ipfsDependencyError,
  ipfsRepositoryError,
  isIpfsRepositoryError,
  mapIpfsDependencyError,
  repositoryErrorCode,
} from "./errors.js";
import type { IpfsBlockReader } from "./readers.js";
import {
  buildRegistrationBytes,
  parseRegistrationBytes,
  registrationCidForReference,
} from "./registration.js";

const DEFAULT_READBACK_TIMEOUT_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
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

interface ReadbackDeadline {
  readonly remainingMs: () => number;
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
    } catch {
      throw ipfsRepositoryError(
        "CONTENT_CORRUPT",
        "The IPFS registration block is invalid.",
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
      const bytes = await awaitCallerAbortable(
        () =>
          this.#reader.getBlock(cid, {
            ...options,
            maxBytes: MAX_STANDARD_IPFS_BLOCK_BYTES,
          }),
        options,
      );
      assertRepositoryOperationActive(options);
      if (bytes === null) return null;
      if (!isUint8Array(bytes)) {
        throw ipfsDependencyError(
          "IO_FAILURE",
          "The configured IPFS read path returned a non-byte value.",
          "block-read",
          "protocol-failure",
        );
      }
      return Uint8Array.from(bytes);
    } catch (error) {
      throw mapIpfsDependencyError(
        error,
        "The configured IPFS read path failed.",
        "block-read",
        options.signal,
        true,
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
      const returnedCid = await awaitCallerAbortable(
        () =>
          this.#client.block.put(bytes, {
            allowBigBlock: false,
            format: "raw",
            mhtype: "sha2-256",
            pin: true,
            signal: options.signal,
            version: 1,
          }),
        options,
      );
      assertRepositoryOperationActive(options);

      let returnedCanonical: string;
      try {
        returnedCanonical = normalizeDependencyRawCid(
          returnedCid,
          "Kubo returned a CID outside the required raw SHA2-256 profile.",
          "block-write",
        );
      } catch {
        throw ipfsDependencyError(
          "REFERENCE_CONFLICT",
          "Kubo returned a CID outside the required raw SHA2-256 profile.",
          "block-write",
          "protocol-failure",
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
        "block-write",
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
      const pins = this.#client.pin.ls({
        paths: decodeRawCid(cid),
        signal: options.signal,
        type: "all",
      });
      for await (const pin of callerAbortableItems(pins, options)) {
        assertRepositoryOperationActive(options);
        const pinCid = dependencyDataProperty(pin, "cid");
        const pinType = dependencyDataProperty(pin, "type");
        if (
          normalizeDependencyRawCid(
            pinCid,
            "Kubo returned a malformed CID from the local pin listing.",
            "local-pin-read",
          ) === cid &&
          (pinType === "direct" || pinType === "recursive")
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
        "local-pin-read",
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
      const pin = await awaitCallerAbortable(
        () =>
          this.#client.pin.remote.add(decodeRawCid(cid), {
            background: false,
            service: this.#remotePinService,
            signal: options.signal,
          }),
        options,
      );
      assertRepositoryOperationActive(options);
      const pinCid = dependencyDataProperty(pin, "cid");
      const pinStatus = dependencyDataProperty(pin, "status");
      if (
        normalizeDependencyRawCid(
          pinCid,
          "The configured remote pin service returned a malformed CID after pinning.",
          "remote-pin-write",
        ) !== cid ||
        pinStatus !== "pinned"
      ) {
        throw ipfsRepositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "The configured remote pin service did not confirm the required pin.",
        );
      }
    } catch (error) {
      throw mapIpfsDependencyError(
        error,
        "Kubo failed to establish the required remote pin.",
        "remote-pin-write",
        options.signal,
      );
    }
    if (!(await this.#hasRemotePin(cid, options))) {
      throw ipfsRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        "The configured remote pin service did not list the required pin.",
      );
    }
  }

  async #hasRemotePin(
    cid: string,
    options: RepositoryOperationOptions,
  ): Promise<boolean> {
    try {
      assertRepositoryOperationActive(options);
      const pins = this.#client.pin.remote.ls({
        cid: [decodeRawCid(cid)],
        service: this.#remotePinService,
        signal: options.signal,
        status: ["pinned"],
      });
      for await (const pin of callerAbortableItems(pins, options)) {
        assertRepositoryOperationActive(options);
        const pinCid = dependencyDataProperty(pin, "cid");
        const pinStatus = dependencyDataProperty(pin, "status");
        if (
          normalizeDependencyRawCid(
            pinCid,
            "The configured remote pin service returned a malformed CID from its pin listing.",
            "remote-pin-read",
          ) === cid &&
          pinStatus === "pinned"
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
        "remote-pin-read",
        options.signal,
      );
    }
  }

  async #confirmReadback(
    reference: EvidenceReference,
    expectedBytes: Uint8Array,
    options: RepositoryOperationOptions,
  ): Promise<void> {
    const deadline = createReadbackDeadline(this.#readbackTimeoutMs);
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
        if (isReadbackDeadlineExpired(error)) {
          throw ipfsDependencyError(
            "DEPENDENCY_UNAVAILABLE",
            "The configured IPFS readback deadline expired.",
            "readback",
            "unavailable",
          );
        }
        if (
          repositoryErrorCode(error) !== "DEPENDENCY_UNAVAILABLE"
        ) {
          if (isIpfsRepositoryError(error)) throw error;
          throw mapIpfsDependencyError(
            error,
            "The configured IPFS readback failed.",
            "readback",
            options.signal,
            true,
          );
        }
      }

      if (deadline.remainingMs() <= 0) {
        throw ipfsDependencyError(
          "DEPENDENCY_UNAVAILABLE",
          "The configured IPFS readback deadline expired.",
          "readback",
          "unavailable",
        );
      }
      await waitForRetry(
        Math.min(READBACK_RETRY_DELAY_MS, deadline.remainingMs()),
        options,
      );
    }
  }
}

class ReadbackDeadlineExpired extends Error {}

const readbackDeadlineErrors = new WeakSet<object>();

async function runReadbackAttempt<T>(
  deadline: ReadbackDeadline,
  callerOptions: RepositoryOperationOptions,
  operation: (options: RepositoryOperationOptions) => Promise<T>,
): Promise<T> {
  assertRepositoryOperationActive(callerOptions);
  const controller = new AbortController();
  const callerSignal = callerOptions.signal;
  const deadlineError = new ReadbackDeadlineExpired(
    "The IPFS readback deadline expired.",
  );
  readbackDeadlineErrors.add(deadlineError);
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

  const cancelDeadlineTimer = scheduleReadbackDeadline(deadline, () => {
    deadlineExpired = true;
    rejectStop(deadlineError);
    controller.abort(deadlineError);
  });

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
    cancelDeadlineTimer();
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function createReadbackDeadline(timeoutMs: number): ReadbackDeadline {
  const startedAt = Date.now();
  return {
    remainingMs: () =>
      Math.max(0, timeoutMs - Math.max(0, Date.now() - startedAt)),
  };
}

function scheduleReadbackDeadline(
  deadline: ReadbackDeadline,
  onExpired: () => void,
): () => void {
  let canceled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNextChunk = () => {
    if (canceled) return;
    const remainingMs = deadline.remainingMs();
    timer = setTimeout(() => {
      timer = undefined;
      if (deadline.remainingMs() <= 0) {
        onExpired();
      } else {
        scheduleNextChunk();
      }
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, remainingMs)));
  };
  scheduleNextChunk();
  return () => {
    canceled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function copyPutBytes(
  value: Uint8Array,
  options: RepositoryOperationOptions,
): Uint8Array {
  if (!isUint8Array(value)) {
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

function isReadbackDeadlineExpired(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) ||
      typeof error === "function") &&
    readbackDeadlineErrors.has(error)
  );
}

async function awaitCallerAbortable<T>(
  operation: () => T | PromiseLike<T>,
  options: RepositoryOperationOptions,
): Promise<T> {
  assertRepositoryOperationActive(options);
  const signal = options.signal;
  if (signal === undefined) return Promise.resolve(operation());

  let rejectAbort!: (error: EvidenceRepositoryError) => void;
  const callerAbort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  let abortRaised = false;
  const onAbort = () => {
    if (abortRaised) return;
    abortRaised = true;
    rejectAbort(
      ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS repository operation was aborted.",
      ),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let dependency: Promise<T>;
  if (signal.aborted) {
    dependency = new Promise<T>(() => {});
  } else {
    try {
      dependency = Promise.resolve(operation());
    } catch (error) {
      dependency = Promise.reject(error);
    }
  }

  try {
    const result = await Promise.race([dependency, callerAbort]);
    assertRepositoryOperationActive(options);
    return result;
  } catch (error) {
    assertRepositoryOperationActive(options);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function* callerAbortableItems<T>(
  values: AsyncIterable<T>,
  options: RepositoryOperationOptions,
): AsyncGenerator<T, void, undefined> {
  const iterator = values[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    while (true) {
      const step = await awaitCallerAbortable(
        () => iterator.next(),
        options,
      );
      if (step.done) {
        exhausted = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!exhausted) closeIteratorWithoutWaiting(iterator);
  }
}

function closeIteratorWithoutWaiting<T>(
  iterator: AsyncIterator<T>,
): void {
  try {
    const close = iterator.return;
    if (typeof close !== "function") return;
    const result = Reflect.apply(close, iterator, []);
    void Promise.resolve(result).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Hostile cleanup must not delay or replace the primary result.
  }
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

function normalizeDependencyRawCid(
  cid: unknown,
  message: string,
  operation:
    | "block-write"
    | "local-pin-read"
    | "remote-pin-read"
    | "remote-pin-write",
): string {
  try {
    if (
      (typeof cid !== "object" || cid === null) &&
      typeof cid !== "function"
    ) {
      throw new TypeError("Kubo CID value was not an object.");
    }
    const toString = cid.toString;
    if (typeof toString !== "function") {
      throw new TypeError("Kubo CID value did not expose toString().");
    }
    const rendered = Reflect.apply(toString, cid, []) as unknown;
    if (typeof rendered !== "string") {
      throw new TypeError("Kubo CID value did not render as text.");
    }
    return normalizeRawCid(rendered);
  } catch {
    throw ipfsDependencyError(
      "IO_FAILURE",
      message,
      operation,
      "protocol-failure",
    );
  }
}

function isKuboNotPinnedError(error: unknown, cid: string): boolean {
  const responseValue = dependencyDataProperty(error, "response");
  const response =
    (typeof responseValue === "object" && responseValue !== null) ||
    typeof responseValue === "function"
      ? responseValue
      : undefined;
  const responseStatus =
    response === undefined
      ? undefined
      : dependencyDataProperty(response, "status");
  const status =
    typeof responseStatus === "number"
      ? responseStatus
      : undefined;
  const message = dependencyDataProperty(error, "message");
  return (
    status === 500 &&
    message === `path '${decodeRawCid(cid).toString()}' is not pinned`
  );
}

function dependencyDataProperty(
  value: unknown,
  key: string,
): unknown {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
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
