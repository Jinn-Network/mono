// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import {
  EvidenceRepositoryError,
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { describe, test, vi } from "vitest";

import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  buildArtifactRegistrationBytes,
  buildRecordRegistrationBytes,
  digestToRawCid,
  registrationCidForReference,
  type IpfsBlockReader,
} from "./index.js";
import {
  IpfsEvidenceRepository,
} from "./repository.js";
import {
  FakeIpfsBlockReader,
  FakeKubo,
  rawCidFor,
} from "../test/fake-kubo.js";

const encoder = new TextEncoder();

describe("IpfsEvidenceRepository reads", () => {
  test("requires the exact namespace registration before returning content", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });
    const bytes = encoder.encode("same bytes");
    const execution = createRecordReference("execution-evidence", bytes);
    const evaluation = createRecordReference("result-evaluation", bytes);
    const artifact = createArtifactReference(bytes);
    reader.blocks.set(digestToRawCid(execution.digest), bytes);
    reader.blocks.set(
      registrationCidForReference(execution),
      buildRecordRegistrationBytes(execution),
    );

    assert.deepEqual(await repository.getRecord(execution), bytes);
    assert.equal(await repository.getRecord(evaluation), null);
    assert.equal(await repository.getArtifact(artifact), null);
  });

  test("rejects corrupt registration and missing content behind registration", async () => {
    const reader = new FakeIpfsBlockReader();
    const repository = new IpfsEvidenceRepository({
      client: new FakeKubo(reader).asClient(),
      reader,
    });
    const bytes = encoder.encode("registered");
    const reference = createArtifactReference(bytes);
    const registrationCid = registrationCidForReference(reference);

    reader.blocks.set(registrationCid, encoder.encode("not canonical\n"));
    await assert.rejects(
      repository.getArtifact(reference),
      hasCode("CONTENT_CORRUPT"),
    );

    reader.blocks.set(
      digestToRawCid(reference.digest),
      encoder.encode("wrong bytes"),
    );
    await assert.rejects(
      repository.getArtifact(reference),
      hasCode("CONTENT_CORRUPT"),
    );

    reader.blocks.set(
      registrationCid,
      buildArtifactRegistrationBytes(reference),
    );
    await assert.rejects(
      repository.getArtifact(reference),
      hasCode("CONTENT_CORRUPT"),
    );
  });

  test("returns defensive content copies", async () => {
    const reader = new FakeIpfsBlockReader();
    const repository = new IpfsEvidenceRepository({
      client: new FakeKubo(reader).asClient(),
      reader,
    });
    const bytes = encoder.encode("copy");
    const reference = createArtifactReference(bytes);
    reader.blocks.set(digestToRawCid(reference.digest), bytes);
    reader.blocks.set(
      registrationCidForReference(reference),
      buildArtifactRegistrationBytes(reference),
    );

    const first = await repository.getArtifact(reference);
    first![0] = 0;
    assert.deepEqual(await repository.getArtifact(reference), bytes);
  });
});

describe("IpfsEvidenceRepository writes", () => {
  test("exposes the fixed inert capability snapshot", () => {
    const repository = new IpfsEvidenceRepository({
      client: new FakeKubo().asClient(),
      reader: new FakeIpfsBlockReader(),
    });

    assert.equal(
      repository.capabilities.maxObjectBytes,
      MAX_STANDARD_IPFS_BLOCK_BYTES,
    );
    assert.equal(Object.isFrozen(repository.capabilities), true);
    assert.equal(Object.getPrototypeOf(repository.capabilities), Object.prototype);
    assert.equal(
      Object.prototype.hasOwnProperty.call(repository, "capabilities"),
      true,
    );
  });

  test("rejects invalid, aborted, and oversized writes before copying or effects", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });
    const oversized = new Uint8Array(
      MAX_STANDARD_IPFS_BLOCK_BYTES + 1,
    );
    const small = new Uint8Array([1]);
    const controller = new AbortController();
    controller.abort();
    const copySpy = vi.spyOn(Uint8Array, "from");

    try {
      await assert.rejects(
        repository.putArtifact({} as Uint8Array, {
          signal: controller.signal,
        }),
        hasCode("CONTENT_CORRUPT"),
      );
      await assert.rejects(
        repository.putArtifact(small, { signal: controller.signal }),
        hasCode("OPERATION_ABORTED"),
      );
      await assert.rejects(
        repository.putArtifact(oversized),
        hasCode("CONTENT_TOO_LARGE"),
      );
      await assert.rejects(
        repository.putRecord("execution-evidence", oversized),
        hasCode("CONTENT_TOO_LARGE"),
      );
      assert.equal(copySpy.mock.calls.length, 0);
    } finally {
      copySpy.mockRestore();
    }
    assert.deepEqual(reader.calls, []);
    assert.deepEqual(kubo.events, []);
  });

  test("writes content before registration with exact raw block options and readback", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });
    const bytes = encoder.encode("write exact");
    const reference = createRecordReference("execution-verification", bytes);

    const receipt = await repository.putRecord(
      "execution-verification",
      bytes,
    );

    assert.deepEqual(receipt, {
      reference,
      size: bytes.byteLength,
      status: "created",
      contentCid: rawCidFor(bytes),
      registrationCid: registrationCidForReference(reference),
    });
    assert.equal(kubo.putCalls.length, 2);
    assert.deepEqual(kubo.putCalls[0]!.bytes, bytes);
    assert.deepEqual(
      kubo.putCalls[1]!.bytes,
      buildRecordRegistrationBytes(reference),
    );
    for (const call of kubo.putCalls) {
      assert.deepEqual(call.options, {
        allowBigBlock: false,
        format: "raw",
        mhtype: "sha2-256",
        pin: true,
        signal: undefined,
        version: 1,
      });
    }
    assert.deepEqual(kubo.events, [
      "block.put",
      "pin.ls",
      "block.put",
      "pin.ls",
    ]);
    assert.deepEqual(reader.calls.slice(-2), [
      registrationCidForReference(reference),
      rawCidFor(bytes),
    ]);
  });

  test("reports existing only when content, registration, and configured custody are complete", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
      remotePinService: "operator-pins",
    });
    const bytes = encoder.encode("idempotent");

    const first = await repository.putArtifact(bytes);
    const second = await repository.putArtifact(bytes);

    assert.equal(first.status, "created");
    assert.equal(second.status, "existing");
    assert.equal(kubo.putCalls.length, 2);
    assert.ok(kubo.events.includes("pin.remote.add"));
    assert.ok(kubo.events.includes("pin.remote.ls"));
  });

  test("accepts direct or recursive root custody without a second pin mutation", async () => {
    for (const type of ["direct", "recursive"] as const) {
      const reader = new FakeIpfsBlockReader();
      const kubo = new FakeKubo(reader);
      const bytes = encoder.encode(`explicit-${type}`);
      const reference = createArtifactReference(bytes);
      const contentCid = rawCidFor(bytes);
      const registrationCid = registrationCidForReference(reference);
      reader.blocks.set(contentCid, bytes);
      reader.blocks.set(
        registrationCid,
        buildArtifactRegistrationBytes(reference),
      );
      kubo.localPins.add(contentCid);
      kubo.localPins.add(registrationCid);
      kubo.localPinTypes.set(contentCid, type);
      kubo.localPinTypes.set(registrationCid, type);
      const repository = new IpfsEvidenceRepository({
        client: kubo.asClient(),
        reader,
      });

      const receipt = await repository.putArtifact(bytes);
      assert.equal(receipt.status, "existing");
      assert.equal(kubo.putCalls.length, 0);
      assert.deepEqual(kubo.events, ["pin.ls", "pin.ls"]);
    }
  });

  test("repairs indirect-only custody instead of treating it as explicit", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const bytes = encoder.encode("indirect-only");
    const reference = createArtifactReference(bytes);
    const contentCid = rawCidFor(bytes);
    const registrationCid = registrationCidForReference(reference);
    reader.blocks.set(contentCid, bytes);
    reader.blocks.set(
      registrationCid,
      buildArtifactRegistrationBytes(reference),
    );
    kubo.localPins.add(contentCid);
    kubo.localPins.add(registrationCid);
    kubo.localPinTypes.set(contentCid, "indirect");
    kubo.localPinTypes.set(registrationCid, "indirect");
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });

    const receipt = await repository.putArtifact(bytes);
    assert.equal(receipt.status, "created");
    assert.equal(kubo.putCalls.length, 2);
    assert.equal(kubo.localPinTypes.get(contentCid), "recursive");
    assert.equal(kubo.localPinTypes.get(registrationCid), "recursive");
  });

  test("treats Kubo's exact not-pinned command error as repairable absence", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    kubo.throwWhenPinMissing = true;
    const bytes = encoder.encode("repair pin");
    const reference = createArtifactReference(bytes);
    reader.blocks.set(rawCidFor(bytes), bytes);
    reader.blocks.set(
      registrationCidForReference(reference),
      buildArtifactRegistrationBytes(reference),
    );
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });

    const receipt = await repository.putArtifact(bytes);
    assert.equal(receipt.status, "created");
    assert.equal(kubo.putCalls.length, 2);
  });

  test("passes exact remote service options and repairs expired remote custody", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
      remotePinService: "operator-pins",
    });
    const bytes = encoder.encode("remote options");
    const first = await repository.putArtifact(bytes);
    kubo.remotePins.clear();
    const repaired = await repository.putArtifact(bytes);

    assert.equal(first.status, "created");
    assert.equal(repaired.status, "created");
    assert.ok(kubo.remoteAddCalls.length >= 4);
    for (const call of kubo.remoteAddCalls) {
      assert.deepEqual(call.options, {
        background: false,
        service: "operator-pins",
        signal: undefined,
      });
    }
    for (const call of kubo.remoteListCalls) {
      assert.deepEqual(call.options, {
        cid: [call.options.cid instanceof Array
          ? call.options.cid[0]
          : call.options.cid],
        service: "operator-pins",
        signal: undefined,
        status: ["pinned"],
      });
    }
  });

  test("repairs deterministic content-only partial state", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });
    const bytes = encoder.encode("partial");
    const reference = createArtifactReference(bytes);
    const contentCid = rawCidFor(bytes);
    reader.blocks.set(contentCid, bytes);
    kubo.localPins.add(contentCid);

    const receipt = await repository.putArtifact(bytes);
    assert.equal(receipt.status, "created");
    assert.deepEqual(
      await repository.getArtifact(reference),
      bytes,
    );
  });

  test("repairs registration-only partial state from exact supplied bytes", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });
    const bytes = encoder.encode("registration-only");
    const reference = createArtifactReference(bytes);
    const registrationCid = registrationCidForReference(reference);
    reader.blocks.set(
      registrationCid,
      buildArtifactRegistrationBytes(reference),
    );
    kubo.localPins.add(registrationCid);
    kubo.localPinTypes.set(registrationCid, "recursive");

    await assert.rejects(
      repository.getArtifact(reference),
      hasCode("CONTENT_CORRUPT"),
    );
    const receipt = await repository.putArtifact(bytes);

    assert.equal(receipt.status, "created");
    assert.deepEqual(await repository.getArtifact(reference), bytes);
    assert.equal(receipt.registrationCid, registrationCid);
  });

  test("rejects a structurally valid wrong CID returned by Kubo", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    kubo.returnedCidOverride = rawCidFor(encoder.encode("different"));
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("expected")),
      hasCode("REFERENCE_CONFLICT"),
    );
  });

  test("preserves dependency causes and maps aborts at awaited boundaries", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const cause = Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    });
    kubo.failNextPut = cause;
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("failure")),
      (error: unknown) =>
        hasCode("DEPENDENCY_UNAVAILABLE")(error) &&
        (error as Error & { cause?: unknown }).cause === cause,
    );

    const dependencyAbort = new Error("dependency timed out");
    dependencyAbort.name = "AbortError";
    kubo.failNextPut = dependencyAbort;
    await assert.rejects(
      repository.putArtifact(encoder.encode("dependency abort")),
      (error: unknown) =>
        hasCode("DEPENDENCY_UNAVAILABLE")(error) &&
        (error as Error & { cause?: unknown }).cause === dependencyAbort,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      repository.putArtifact(encoder.encode("abort"), {
        signal: controller.signal,
      }),
      hasCode("OPERATION_ABORTED"),
    );

    const concurrentController = new AbortController();
    const concurrentReader: IpfsBlockReader = {
      async getBlock() {
        concurrentController.abort();
        throw new EvidenceRepositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "dependency failed while caller aborted",
        );
      },
    };
    const concurrentRepository = new IpfsEvidenceRepository({
      client: new FakeKubo().asClient(),
      reader: concurrentReader,
    });
    await assert.rejects(
      concurrentRepository.getArtifact(
        createArtifactReference(encoder.encode("concurrent abort")),
        { signal: concurrentController.signal },
      ),
      hasCode("OPERATION_ABORTED"),
    );
  });

  test("maps explicit writer denial and quota failures without losing causes", async () => {
    for (const cause of [
      Object.assign(new Error("forbidden"), {
        response: { status: 403 },
      }),
      new Error("remote pin quota exceeded"),
    ]) {
      const reader = new FakeIpfsBlockReader();
      const kubo = new FakeKubo(reader);
      kubo.failNextPut = cause;
      const repository = new IpfsEvidenceRepository({
        client: kubo.asClient(),
        reader,
      });
      await assert.rejects(
        repository.putArtifact(encoder.encode("denied")),
        (error: unknown) =>
          hasCode("ACCESS_DENIED")(error) &&
          (error as Error & { cause?: unknown }).cause === cause,
      );
    }
  });

  test("copies caller bytes before the first awaited dependency boundary", async () => {
    const reader = new FakeIpfsBlockReader();
    const repository = new IpfsEvidenceRepository({
      client: new FakeKubo(reader).asClient(),
      reader,
    });
    const bytes = encoder.encode("immutable input");
    const expected = Uint8Array.from(bytes);
    const pending = repository.putArtifact(bytes);
    bytes.fill(0);

    const receipt = await pending;
    assert.deepEqual(await repository.getArtifact(receipt.reference), expected);
  });

  test("checks cancellation immediately after a completed remote effect", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const controller = new AbortController();
    kubo.onEvent = (event) => {
      if (event === "block.put") controller.abort();
    };
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("abort after write"), {
        signal: controller.signal,
      }),
      hasCode("OPERATION_ABORTED"),
    );
    assert.equal(kubo.putCalls.length, 1);
  });

  test("checks cancellation after every reader, writer, and custody boundary", async () => {
    for (const boundary of [
      "reader",
      "block.put",
      "pin.ls",
      "pin.remote.add",
      "pin.remote.ls",
    ]) {
      const reader = new FakeIpfsBlockReader();
      const kubo = new FakeKubo(reader);
      const controller = new AbortController();
      if (boundary === "reader") {
        reader.onCall = () => controller.abort();
      } else {
        kubo.onEvent = (event) => {
          if (event === boundary) controller.abort();
        };
      }
      const repository = new IpfsEvidenceRepository({
        client: kubo.asClient(),
        reader,
        remotePinService: "operator-pins",
      });

      await assert.rejects(
        repository.putArtifact(encoder.encode(`abort-${boundary}`), {
          signal: controller.signal,
        }),
        hasCode("OPERATION_ABORTED"),
        boundary,
      );
    }
  });

  test("retries lagging readback and fails a zero-duration deadline closed", async () => {
    const bytes = encoder.encode("lagging gateway");
    const reference = createArtifactReference(bytes);
    const registrationCid = registrationCidForReference(reference);

    const laggingReader = new FakeIpfsBlockReader();
    laggingReader.scripted.set(registrationCid, [null, null]);
    const laggingRepository = new IpfsEvidenceRepository({
      client: new FakeKubo(laggingReader).asClient(),
      reader: laggingReader,
      readbackTimeoutMs: 100,
    });
    assert.equal(
      (await laggingRepository.putArtifact(bytes)).status,
      "created",
    );
    assert.equal(
      laggingReader.calls.filter((cid) => cid === registrationCid).length,
      3,
    );

    const unavailableReader = new FakeIpfsBlockReader();
    unavailableReader.scripted.set(registrationCid, [null, null]);
    const unavailableRepository = new IpfsEvidenceRepository({
      client: new FakeKubo(unavailableReader).asClient(),
      reader: unavailableReader,
      readbackTimeoutMs: 0,
    });
    await assert.rejects(
      unavailableRepository.putArtifact(bytes),
      hasCode("DEPENDENCY_UNAVAILABLE"),
    );

    const dependencyCause = new Error("gateway unavailable");
    const transient = new EvidenceRepositoryError(
      "DEPENDENCY_UNAVAILABLE",
      "transient read failure",
      { cause: dependencyCause },
    );
    const failingReader = new FakeIpfsBlockReader();
    failingReader.scripted.set(registrationCid, [null, transient]);
    const failingRepository = new IpfsEvidenceRepository({
      client: new FakeKubo(failingReader).asClient(),
      reader: failingReader,
      readbackTimeoutMs: 0,
    });
    await assert.rejects(
      failingRepository.putArtifact(bytes),
      (error: unknown) =>
        hasCode("DEPENDENCY_UNAVAILABLE")(error) &&
        (error as Error & { cause?: unknown }).cause === transient,
    );
  });

  test("bounds every readback attempt and preserves caller-abort precedence", async () => {
    const bytes = encoder.encode("bounded readback");
    let deadlineCancellationObserved = false;
    const deadlineReader = hangingReadbackReader(() => {
      deadlineCancellationObserved = true;
    });
    const deadlineRepository = new IpfsEvidenceRepository({
      client: new FakeKubo().asClient(),
      reader: deadlineReader.reader,
      readbackTimeoutMs: 10,
    });

    await assert.rejects(
      Promise.race([
        deadlineRepository.putArtifact(bytes),
        rejectAfter(250, "readback deadline did not settle"),
      ]),
      hasCode("DEPENDENCY_UNAVAILABLE"),
    );
    assert.equal(deadlineReader.readbackStarted(), true);
    assert.equal(deadlineCancellationObserved, true);

    const controller = new AbortController();
    let callerCancellationObserved = false;
    const callerReader = hangingReadbackReader(() => {
      callerCancellationObserved = true;
    });
    const callerRepository = new IpfsEvidenceRepository({
      client: new FakeKubo().asClient(),
      reader: callerReader.reader,
      readbackTimeoutMs: 1_000,
    });
    const pending = callerRepository.putArtifact(bytes, {
      signal: controller.signal,
    });
    await callerReader.started;
    controller.abort();

    await assert.rejects(pending, hasCode("OPERATION_ABORTED"));
    assert.equal(callerCancellationObserved, true);
  });

  test("concurrent identical puts converge on the same deterministic CIDs", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });
    const bytes = encoder.encode("concurrent");

    const [left, right] = await Promise.all([
      repository.putArtifact(bytes),
      repository.putArtifact(bytes),
    ]);
    assert.deepEqual(left.reference, right.reference);
    assert.equal(left.contentCid, right.contentCid);
    assert.equal(left.registrationCid, right.registrationCid);
    assert.deepEqual(await repository.getArtifact(left.reference), bytes);
  });

  test("fails when configured remote custody is not pinned", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    kubo.remoteStatus = "failed";
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
      remotePinService: "operator-pins",
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("remote pin")),
      hasCode("DEPENDENCY_UNAVAILABLE"),
    );
  });
});

function hangingReadbackReader(
  onCancellation: () => void,
): {
  readonly reader: IpfsBlockReader;
  readonly readbackStarted: () => boolean;
  readonly started: Promise<void>;
} {
  let calls = 0;
  let readbackStarted = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  return {
    reader: {
      async getBlock(_cid, options) {
        calls += 1;
        if (calls === 1) return null;
        readbackStarted = true;
        resolveStarted();
        return new Promise<Uint8Array | null>((_resolve, reject) => {
          const onAbort = () => {
            onCancellation();
            const error = new Error("reader aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (options.signal?.aborted === true) {
            onAbort();
            return;
          }
          options.signal?.addEventListener("abort", onAbort, {
            once: true,
          });
        });
      },
    },
    readbackStarted: () => readbackStarted,
    started,
  };
}

function rejectAfter(delayMs: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), delayMs);
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
