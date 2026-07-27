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
import {
  assertSanitizedDependencyError,
  createAuthorityBearingError,
  type SanitizedOperation,
} from "../test/authority-markers.js";

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

  test("sanitizes errors whose not-pinned classification fields throw", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const injected = new Error();
    Object.defineProperty(injected, "message", {
      configurable: true,
      get() {
        throw createAuthorityBearingError("message getter failed");
      },
    });
    Object.defineProperty(injected, "response", {
      configurable: true,
      value: { status: 500 },
    });
    kubo.failNextPinList = injected;
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("hostile classifier")),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "DEPENDENCY_UNAVAILABLE",
          "local-pin-read",
          "unavailable",
        ),
    );
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

  test("maps malformed local pin-list CIDs as dependency protocol failures", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    kubo.localListCidOverride = "not-a-cid";
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("malformed local pin")),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "IO_FAILURE",
          "local-pin-read",
          "protocol-failure",
        ),
    );
  });

  test("maps malformed remote pin-add CIDs as dependency protocol failures", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    kubo.remoteAddCidOverride = "not-a-cid";
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
      remotePinService: "operator-pins",
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("malformed remote add")),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "IO_FAILURE",
          "remote-pin-write",
          "protocol-failure",
        ),
    );
  });

  test("maps malformed remote pin-list CIDs as dependency protocol failures", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    kubo.remoteListCidOverride = "not-a-cid";
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
      remotePinService: "operator-pins",
    });

    await assert.rejects(
      repository.putArtifact(encoder.encode("malformed remote list")),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "IO_FAILURE",
          "remote-pin-read",
          "protocol-failure",
        ),
    );
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
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "REFERENCE_CONFLICT",
          "block-write",
          "protocol-failure",
        ),
    );
  });

  test("sanitizes dependency causes and maps aborts at awaited boundaries", async () => {
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
        assertSanitizedDependencyError(
          error,
          "DEPENDENCY_UNAVAILABLE",
          "block-write",
          "unavailable",
        ),
    );

    const dependencyAbort = new Error("dependency timed out");
    dependencyAbort.name = "AbortError";
    kubo.failNextPut = dependencyAbort;
    await assert.rejects(
      repository.putArtifact(encoder.encode("dependency abort")),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "DEPENDENCY_UNAVAILABLE",
          "block-write",
          "unavailable",
        ),
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

  test("maps explicit writer denial and quota failures without exposing causes", async () => {
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
          assertSanitizedDependencyError(
            error,
            "ACCESS_DENIED",
            "block-write",
            "access-denied",
          ),
      );
    }
  });

  test("sanitizes injected Kubo failures at every client boundary", async () => {
    const cases: ReadonlyArray<{
      readonly configure: (
        kubo: FakeKubo,
        error: Error,
      ) => void;
      readonly operation: SanitizedOperation;
      readonly remotePinService?: string;
    }> = [
      {
        configure: (kubo, error) => {
          kubo.failNextPut = error;
        },
        operation: "block-write",
      },
      {
        configure: (kubo, error) => {
          kubo.failNextPinList = error;
        },
        operation: "local-pin-read",
      },
      {
        configure: (kubo, error) => {
          kubo.failNextRemoteAdd = error;
        },
        operation: "remote-pin-write",
        remotePinService: "operator-pins",
      },
      {
        configure: (kubo, error) => {
          kubo.failNextRemoteList = error;
        },
        operation: "remote-pin-read",
        remotePinService: "operator-pins",
      },
    ];

    for (const item of cases) {
      const reader = new FakeIpfsBlockReader();
      const kubo = new FakeKubo(reader);
      const injected = createAuthorityBearingError("forbidden");
      Object.defineProperty(injected, "response", {
        configurable: true,
        enumerable: true,
        value: {
          status: 403,
        },
        writable: true,
      });
      item.configure(kubo, injected);
      const repository = new IpfsEvidenceRepository({
        client: kubo.asClient(),
        reader,
        remotePinService: item.remotePinService,
      });

      await assert.rejects(
        repository.putArtifact(
          encoder.encode(`authority-${item.operation}`),
        ),
        (error: unknown) =>
          assertSanitizedDependencyError(
            error,
            "ACCESS_DENIED",
            item.operation,
            "access-denied",
          ),
        item.operation,
      );
    }
  });

  test("sanitizes hostile prototype traps at every Kubo client boundary", async () => {
    const cases: ReadonlyArray<{
      readonly configure: (
        kubo: FakeKubo,
        error: Error,
      ) => void;
      readonly operation: SanitizedOperation;
      readonly remotePinService?: string;
    }> = [
      {
        configure: (kubo, error) => {
          kubo.failNextPut = error;
        },
        operation: "block-write",
      },
      {
        configure: (kubo, error) => {
          kubo.failNextPinList = error;
        },
        operation: "local-pin-read",
      },
      {
        configure: (kubo, error) => {
          kubo.failNextRemoteAdd = error;
        },
        operation: "remote-pin-write",
        remotePinService: "operator-pins",
      },
      {
        configure: (kubo, error) => {
          kubo.failNextRemoteList = error;
        },
        operation: "remote-pin-read",
        remotePinService: "operator-pins",
      },
    ];

    for (const item of cases) {
      const reader = new FakeIpfsBlockReader();
      const kubo = new FakeKubo(reader);
      const injected = new Proxy(
        createAuthorityBearingError("hostile prototype"),
        {
          getPrototypeOf() {
            throw createAuthorityBearingError(
              "hostile prototype inspection",
            );
          },
        },
      );
      item.configure(kubo, injected);
      const repository = new IpfsEvidenceRepository({
        client: kubo.asClient(),
        reader,
        remotePinService: item.remotePinService,
      });

      await assert.rejects(
        repository.putArtifact(
          encoder.encode(`prototype-${item.operation}`),
        ),
        (error: unknown) =>
          assertSanitizedDependencyError(
            error,
            "DEPENDENCY_UNAVAILABLE",
            item.operation,
            "unavailable",
          ),
        item.operation,
      );
    }
  });

  test("sanitizes hostile values returned by readers and Kubo iterators", async () => {
    const reference = createArtifactReference(
      encoder.encode("hostile returned bytes"),
    );
    const hostileBytes = new Proxy(new Uint8Array([1]), {
      getPrototypeOf() {
        throw createAuthorityBearingError(
          "hostile returned bytes prototype",
        );
      },
    });
    const hostileReader: IpfsBlockReader = {
      async getBlock() {
        return hostileBytes;
      },
    };
    const readerRepository = new IpfsEvidenceRepository({
      client: new FakeKubo().asClient(),
      reader: hostileReader,
    });
    await assert.rejects(
      readerRepository.getArtifact(reference),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "IO_FAILURE",
          "block-read",
          "protocol-failure",
        ),
    );

    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const client = kubo.asClient();
    Object.defineProperty(client.pin, "ls", {
      configurable: true,
      value: async function* () {
        yield Object.defineProperty({}, "cid", {
          configurable: true,
          get() {
            throw createAuthorityBearingError(
              "hostile local pin CID getter",
            );
          },
        });
      },
    });
    const kuboRepository = new IpfsEvidenceRepository({
      client,
      reader,
    });
    await assert.rejects(
      kuboRepository.putArtifact(
        encoder.encode("hostile Kubo value"),
      ),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "IO_FAILURE",
          "local-pin-read",
          "protocol-failure",
        ),
    );
  });

  test("reconstructs a returned package error at a later dependency boundary", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    kubo.failNextPut = Object.assign(
      new Error("network unavailable"),
      { code: "ECONNREFUSED" },
    );
    const repository = new IpfsEvidenceRepository({
      client: kubo.asClient(),
      reader,
    });
    let returnedError: unknown;
    try {
      await repository.putArtifact(encoder.encode("owned error"));
    } catch (error) {
      returnedError = error;
    }
    assert.ok(returnedError instanceof Error);

    const mutationResults = [
      Reflect.set(
        returnedError,
        "message",
        createAuthorityBearingError("mutated message").message,
      ),
      Reflect.set(returnedError, "code", "ACCESS_DENIED"),
      Reflect.set(
        returnedError,
        "cause",
        createAuthorityBearingError("mutated cause"),
      ),
    ];
    const injectedReader: IpfsBlockReader = {
      async getBlock() {
        throw returnedError;
      },
    };
    const reinjectedRepository = new IpfsEvidenceRepository({
      client: new FakeKubo().asClient(),
      reader: injectedReader,
    });
    let reconstructedError: unknown;
    try {
      await reinjectedRepository.getArtifact(
        createArtifactReference(encoder.encode("reinjected error")),
      );
    } catch (error) {
      reconstructedError = error;
    }
    assert.notEqual(reconstructedError, returnedError);
    assertSanitizedDependencyError(
      reconstructedError,
      "DEPENDENCY_UNAVAILABLE",
      "block-read",
      "unavailable",
    );
    assert.deepEqual(mutationResults, [false, false, false]);
    assert.equal(Object.isFrozen(returnedError), true);
  });

  test("sanitizes failures thrown by an injected block reader", async () => {
    const reference = createArtifactReference(
      encoder.encode("injected reader"),
    );
    for (const injected of [
      createAuthorityBearingError(),
      new EvidenceRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        `reader failed: ${createAuthorityBearingError().message}`,
        { cause: createAuthorityBearingError() },
      ),
    ]) {
      const reader: IpfsBlockReader = {
        async getBlock() {
          throw injected;
        },
      };
      const repository = new IpfsEvidenceRepository({
        client: new FakeKubo().asClient(),
        reader,
      });

      await assert.rejects(
        repository.getArtifact(reference),
        (error: unknown) =>
          assertSanitizedDependencyError(
            error,
            "DEPENDENCY_UNAVAILABLE",
            "block-read",
            "unavailable",
          ),
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

  test("promptly aborts a non-cooperative injected reader and observes its late rejection", async () => {
    const pendingRead = createDeferred<Uint8Array | null>();
    const readStarted = createDeferred<void>();
    const reader: IpfsBlockReader = {
      getBlock() {
        readStarted.resolve();
        return pendingRead.promise;
      },
    };
    const repository = new IpfsEvidenceRepository({
      client: new FakeKubo().asClient(),
      reader,
    });
    const controller = new AbortController();
    const pending = repository.getArtifact(
      createArtifactReference(encoder.encode("non-cooperative reader")),
      { signal: controller.signal },
    );
    await readStarted.promise;

    controller.abort();
    await assert.rejects(
      settleWithin(pending, 100),
      hasCode("OPERATION_ABORTED"),
    );

    pendingRead.reject(new Error("late reader rejection"));
    await flushLateSettlement();
  });

  test("promptly aborts a non-cooperative block put and observes its late rejection", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const client = kubo.asClient();
    const pendingPut = createDeferred<never>();
    const putStarted = createDeferred<void>();
    Object.defineProperty(client.block, "put", {
      configurable: true,
      value() {
        putStarted.resolve();
        return pendingPut.promise;
      },
    });
    const repository = new IpfsEvidenceRepository({ client, reader });
    const controller = new AbortController();
    const pending = repository.putArtifact(
      encoder.encode("non-cooperative block put"),
      { signal: controller.signal },
    );
    await putStarted.promise;

    controller.abort();
    await assert.rejects(
      settleWithin(pending, 100),
      hasCode("OPERATION_ABORTED"),
    );

    pendingPut.reject(new Error("late block-put rejection"));
    await flushLateSettlement();
    assert.deepEqual(kubo.events, []);
  });

  test("promptly aborts and closes a non-cooperative local pin iterator", async () => {
    const reader = new FakeIpfsBlockReader();
    const kubo = new FakeKubo(reader);
    const client = kubo.asClient();
    const pins = createNonCooperativeAsyncIterable<unknown>();
    Object.defineProperty(client.pin, "ls", {
      configurable: true,
      value() {
        return pins.iterable;
      },
    });
    const repository = new IpfsEvidenceRepository({ client, reader });
    const controller = new AbortController();
    const pending = repository.putArtifact(
      encoder.encode("non-cooperative local pin listing"),
      { signal: controller.signal },
    );
    await pins.started;

    controller.abort();
    await assert.rejects(
      settleWithin(pending, 100),
      hasCode("OPERATION_ABORTED"),
    );
    assert.equal(pins.returnCalls(), 1);

    pins.reject(new Error("late local-pin rejection"));
    await flushLateSettlement();
  });

  test("promptly aborts non-cooperative remote pin add and listing boundaries", async () => {
    {
      const reader = new FakeIpfsBlockReader();
      const kubo = new FakeKubo(reader);
      const client = kubo.asClient();
      const pendingAdd = createDeferred<never>();
      const addStarted = createDeferred<void>();
      Object.defineProperty(client.pin.remote, "add", {
        configurable: true,
        value() {
          addStarted.resolve();
          return pendingAdd.promise;
        },
      });
      const repository = new IpfsEvidenceRepository({
        client,
        reader,
        remotePinService: "operator-pins",
      });
      const controller = new AbortController();
      const pending = repository.putArtifact(
        encoder.encode("non-cooperative remote pin add"),
        { signal: controller.signal },
      );
      await addStarted.promise;

      controller.abort();
      await assert.rejects(
        settleWithin(pending, 100),
        hasCode("OPERATION_ABORTED"),
      );

      pendingAdd.reject(new Error("late remote-pin-add rejection"));
      await flushLateSettlement();
    }

    {
      const reader = new FakeIpfsBlockReader();
      const kubo = new FakeKubo(reader);
      const client = kubo.asClient();
      const pins = createNonCooperativeAsyncIterable<unknown>();
      Object.defineProperty(client.pin.remote, "ls", {
        configurable: true,
        value() {
          return pins.iterable;
        },
      });
      const repository = new IpfsEvidenceRepository({
        client,
        reader,
        remotePinService: "operator-pins",
      });
      const controller = new AbortController();
      const pending = repository.putArtifact(
        encoder.encode("non-cooperative remote pin listing"),
        { signal: controller.signal },
      );
      await pins.started;

      controller.abort();
      await assert.rejects(
        settleWithin(pending, 100),
        hasCode("OPERATION_ABORTED"),
      );
      assert.equal(pins.returnCalls(), 1);

      pins.reject(new Error("late remote-pin-list rejection"));
      await flushLateSettlement();
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
        assertSanitizedDependencyError(
          error,
          "DEPENDENCY_UNAVAILABLE",
          "readback",
          "unavailable",
        ),
    );
  });

  test("preserves a direct in-package readback corruption error", async () => {
    const bytes = encoder.encode("corrupt direct readback");
    const reference = createArtifactReference(bytes);
    const registrationCid = registrationCidForReference(reference);
    const reader = new FakeIpfsBlockReader();
    let registrationReads = 0;
    reader.onCall = (cid) => {
      if (cid !== registrationCid) return;
      registrationReads += 1;
      if (registrationReads === 2) {
        reader.blocks.set(
          registrationCid,
          encoder.encode("corrupt registration\n"),
        );
      }
    };
    const repository = new IpfsEvidenceRepository({
      client: new FakeKubo(reader).asClient(),
      reader,
    });

    await assert.rejects(
      repository.putArtifact(bytes),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: unknown }).code,
          "CONTENT_CORRUPT",
        );
        assert.equal(error.cause, undefined);
        return true;
      },
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

  test("chunks long readback deadlines without narrowing the accepted range", async () => {
    vi.useFakeTimers();
    const warningSpy = vi.spyOn(process, "emitWarning");
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const bytes = encoder.encode("long readback deadline");
      const controller = new AbortController();
      const longReader = hangingReadbackReader(() => {});
      const longRepository = new IpfsEvidenceRepository({
        client: new FakeKubo().asClient(),
        reader: longReader.reader,
        readbackTimeoutMs: 2_147_483_648,
      });
      let settled = false;
      const longPending = longRepository.putArtifact(bytes, {
        signal: controller.signal,
      });
      void longPending.finally(() => {
        settled = true;
      }).catch(() => {});
      await longReader.started;

      const scheduledDelays = timerSpy.mock.calls
        .map((call) => call[1])
        .filter((delay): delay is number => typeof delay === "number");
      assert.equal(scheduledDelays.at(-1), 2_147_483_647);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(settled, false);
      assert.equal(warningSpy.mock.calls.length, 0);

      controller.abort();
      await assert.rejects(longPending, hasCode("OPERATION_ABORTED"));
      assert.equal(vi.getTimerCount(), 0);

      for (const timeoutMs of [0, 10]) {
        const reader = hangingReadbackReader(() => {});
        const repository = new IpfsEvidenceRepository({
          client: new FakeKubo().asClient(),
          reader: reader.reader,
          readbackTimeoutMs: timeoutMs,
        });
        const pending = repository.putArtifact(bytes);
        const rejection = assert.rejects(
          pending,
          hasCode("DEPENDENCY_UNAVAILABLE"),
          String(timeoutMs),
        );
        await reader.started;
        await vi.advanceTimersByTimeAsync(timeoutMs);
        await rejection;
        assert.equal(vi.getTimerCount(), 0);
      }
    } finally {
      timerSpy.mockRestore();
      warningSpy.mockRestore();
      vi.useRealTimers();
    }
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function createNonCooperativeAsyncIterable<T>(): {
  readonly iterable: AsyncIterable<T>;
  readonly reject: (error: unknown) => void;
  readonly returnCalls: () => number;
  readonly started: Promise<void>;
} {
  const step = createDeferred<IteratorResult<T>>();
  const nextStarted = createDeferred<void>();
  let closeCalls = 0;
  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      nextStarted.resolve();
      return step.promise;
    },
    return() {
      closeCalls += 1;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    iterable: iterator,
    reject: step.reject,
    returnCalls: () => closeCalls,
    started: nextStarted.promise,
  };
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("operation did not settle after caller abort")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function flushLateSettlement(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
