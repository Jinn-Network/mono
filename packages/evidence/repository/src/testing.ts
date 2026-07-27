import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  assertEvidenceRepositoryCapabilitiesSlot,
  assertUnchangedEvidenceRepositoryCapabilitiesSlot,
} from "./capabilities.js";
import { assertContentTooLargeRepositoryError } from "./contract-errors.js";
import { assertRepositoryOperationActive } from "./errors.js";
import {
  createArtifactReference,
  createRecordReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
} from "./references.js";
import { loadDeclaredLimitFixtures } from "./testing-fixtures.js";
import {
  EVIDENCE_RECORD_FAMILIES,
  NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type EvidenceRepositoryCapabilities,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
} from "./types.js";

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function recordKey(reference: EvidenceRecordReference): string {
  return `${reference.family}:${reference.digest}`;
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  readonly capabilities =
    NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES;

  readonly #records = new Map<string, Uint8Array>();
  readonly #artifacts = new Map<string, Uint8Array>();

  async putRecord(
    family: EvidenceRecordReference["family"],
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    assertRepositoryOperationActive(options);
    const reference = createRecordReference(family, bytes);
    const key = recordKey(reference);
    const existing = this.#records.has(key);
    if (!existing) {
      this.#records.set(key, cloneBytes(bytes));
    }

    return {
      reference,
      size: bytes.byteLength,
      status: existing ? "existing" : "created",
    };
  }

  async getRecord(
    untrustedReference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    assertRepositoryOperationActive(options);
    const reference = parseEvidenceRecordReference(untrustedReference);
    const bytes = this.#records.get(recordKey(reference));
    return bytes === undefined ? null : cloneBytes(bytes);
  }

  async putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    assertRepositoryOperationActive(options);
    const reference = createArtifactReference(bytes);
    const existing = this.#artifacts.has(reference.digest);
    if (!existing) {
      this.#artifacts.set(reference.digest, cloneBytes(bytes));
    }

    return {
      reference,
      size: bytes.byteLength,
      status: existing ? "existing" : "created",
    };
  }

  async getArtifact(
    untrustedReference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    assertRepositoryOperationActive(options);
    const reference = parseEvidenceArtifactReference(untrustedReference);
    const bytes = this.#artifacts.get(reference.digest);
    return bytes === undefined ? null : cloneBytes(bytes);
  }
}

export interface EvidenceRepositoryContractContext {
  readonly repository: EvidenceRepository;
  readonly createObjectAtDeclaredLimit?: () => Uint8Array;
  readonly createObjectAboveDeclaredLimit?: () => Uint8Array;
  readonly cleanup?: () => Promise<void> | void;
}

export type EvidenceRepositoryContractFactory = (
  name: string,
) => Promise<EvidenceRepositoryContractContext> | EvidenceRepositoryContractContext;

export function describeEvidenceRepositoryContract(
  createContext: EvidenceRepositoryContractFactory,
): void {
  describe("EvidenceRepository contract", () => {
    let capabilities: EvidenceRepositoryCapabilities | undefined;
    let context: EvidenceRepositoryContractContext | undefined;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
      capabilities = assertEvidenceRepositoryCapabilitiesSlot(
        context.repository,
      );
    });

    afterEach(async () => {
      try {
        if (context !== undefined && capabilities !== undefined) {
          assertUnchangedEvidenceRepositoryCapabilitiesSlot(
            context.repository,
            capabilities,
          );
        }
      } finally {
        try {
          await context?.cleanup?.();
        } finally {
          capabilities = undefined;
          context = undefined;
        }
      }
    });

    test("exposes valid, stable, immutable capabilities", () => {
      expect(
        assertEvidenceRepositoryCapabilitiesSlot(
          context!.repository,
        ),
      ).toBe(capabilities);
    });

    test("enforces a declared finite object limit", async () => {
      const repository = context!.repository;
      const maxObjectBytes = capabilities!.maxObjectBytes;
      if (maxObjectBytes === undefined) return;

      const { atLimit, aboveLimit } = loadDeclaredLimitFixtures(
        maxObjectBytes,
        context!,
      );

      const recordReceipt = await repository.putRecord(
        "execution-evidence",
        atLimit,
      );
      const artifactReceipt = await repository.putArtifact(atLimit);
      expect(await repository.getRecord(recordReceipt.reference)).toEqual(
        atLimit,
      );
      expect(await repository.getArtifact(artifactReceipt.reference)).toEqual(
        atLimit,
      );

      const oversizedRecord = createRecordReference(
        "execution-evidence",
        aboveLimit,
      );
      const oversizedArtifact = createArtifactReference(aboveLimit);
      await expectContentTooLarge(() =>
        repository.putRecord("execution-evidence", aboveLimit),
      );
      await expectContentTooLarge(() =>
        repository.putArtifact(aboveLimit),
      );
      expect(await repository.getRecord(oversizedRecord)).toBeNull();
      expect(await repository.getArtifact(oversizedArtifact)).toBeNull();
    });

    test.each(EVIDENCE_RECORD_FAMILIES)(
      "round-trips %s records byte-for-byte",
      async (family) => {
        const bytes = new Uint8Array([
          EVIDENCE_RECORD_FAMILIES.indexOf(family) + 1,
        ]);
        const receipt = await context!.repository.putRecord(family, bytes);

        expect(receipt).toMatchObject({
          reference: createRecordReference(family, bytes),
          size: bytes.byteLength,
          status: "created",
        });
        expect(
          await context!.repository.getRecord(receipt.reference),
        ).toEqual(bytes);
      },
    );

    test("round-trips independent artifact bytes", async () => {
      const bytes = new Uint8Array([255]);
      const receipt = await context!.repository.putArtifact(bytes);

      expect(receipt).toMatchObject({
        reference: createArtifactReference(bytes),
        size: bytes.byteLength,
        status: "created",
      });
      expect(await context!.repository.getArtifact(receipt.reference)).toEqual(
        bytes,
      );
    });

    test("returns null for missing content", async () => {
      const recordBytes = new Uint8Array([16]);
      const artifactBytes = new Uint8Array([17]);

      expect(
        await context!.repository.getRecord(
          createRecordReference("execution-evidence", recordBytes),
        ),
      ).toBeNull();
      expect(
        await context!.repository.getArtifact(
          createArtifactReference(artifactBytes),
        ),
      ).toBeNull();
    });

    test("makes identical writes idempotent", async () => {
      const bytes = new Uint8Array([32]);

      const firstRecord = await context!.repository.putRecord(
        "result-evaluation",
        bytes,
      );
      const secondRecord = await context!.repository.putRecord(
        "result-evaluation",
        bytes,
      );
      expect(firstRecord.status).toBe("created");
      expect(secondRecord).toEqual({ ...firstRecord, status: "existing" });

      const artifactBytes = new Uint8Array([33]);
      const firstArtifact = await context!.repository.putArtifact(artifactBytes);
      const secondArtifact = await context!.repository.putArtifact(artifactBytes);
      expect(firstArtifact.status).toBe("created");
      expect(secondArtifact).toEqual({
        ...firstArtifact,
        status: "existing",
      });
    });

    test("does not expose mutable stored buffers", async () => {
      const source = new Uint8Array([1]);
      const recordReceipt = await context!.repository.putRecord(
        "execution-verification",
        source,
      );
      const artifactReceipt = await context!.repository.putArtifact(source);
      source[0] = 99;

      const firstRecord = await context!.repository.getRecord(
        recordReceipt.reference,
      );
      const firstArtifact = await context!.repository.getArtifact(
        artifactReceipt.reference,
      );
      expect(firstRecord).toEqual(new Uint8Array([1]));
      expect(firstArtifact).toEqual(new Uint8Array([1]));

      firstRecord![0] = 98;
      firstArtifact![0] = 98;
      expect(
        await context!.repository.getRecord(recordReceipt.reference),
      ).toEqual(new Uint8Array([1]));
      expect(
        await context!.repository.getArtifact(artifactReceipt.reference),
      ).toEqual(new Uint8Array([1]));
    });

    test("honors an already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        context!.repository.putArtifact(new Uint8Array(), {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    });
  });
}

async function expectContentTooLarge(
  operation: () => Promise<unknown>,
): Promise<void> {
  let error: unknown;
  try {
    await Promise.resolve().then(operation);
  } catch (caught) {
    error = caught;
  }
  assertContentTooLargeRepositoryError(error);
}
