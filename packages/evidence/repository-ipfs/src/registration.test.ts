// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import type {
  EvidenceArtifactReference,
  EvidenceRecordReference,
} from "@jinn-network/evidence-repository";

import {
  IPFS_REGISTRATION_PROFILE,
  buildArtifactRegistrationBytes,
  buildRegistrationBytes,
  buildRecordRegistrationBytes,
  parseRegistrationBytes,
  registrationCidForReference,
} from "./registration.js";
import { isIpfsRepositoryError } from "./errors.js";
import {
  AUTHORITY_MARKER_TEXT,
  assertNoAuthorityMarkers,
  createAuthorityBearingError,
} from "../test/authority-markers.js";

const DIGEST =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const vectors = [
  {
    reference: {
      family: "execution-evidence",
      digest: DIGEST,
    } satisfies EvidenceRecordReference,
    line:
      `{"digest":"${DIGEST}","family":"execution-evidence","kind":"record","profile":"jinn.evidence-repository.ipfs-registration","version":1}\n`,
    cid:
      "f0155122045e1f2f2007aacb679d34a8d6f4f8fc7d19f9ebad43c6f31534160392ce74891",
  },
  {
    reference: {
      family: "result-evaluation",
      digest: DIGEST,
    } satisfies EvidenceRecordReference,
    line:
      `{"digest":"${DIGEST}","family":"result-evaluation","kind":"record","profile":"jinn.evidence-repository.ipfs-registration","version":1}\n`,
    cid:
      "f015512206ffa29812bdbfa7df53d2cb55c908501a0f5d859021a3d78bb6835e2d90b7e64",
  },
  {
    reference: {
      family: "execution-verification",
      digest: DIGEST,
    } satisfies EvidenceRecordReference,
    line:
      `{"digest":"${DIGEST}","family":"execution-verification","kind":"record","profile":"jinn.evidence-repository.ipfs-registration","version":1}\n`,
    cid:
      "f01551220c9fd73b6d43a939818982b538727b4165e53e579b160359c3c886ff4cecf5580",
  },
] as const;

describe("IPFS repository registration profile", () => {
  test("freezes exact bytes and registration CIDs for all record families", () => {
    assert.equal(
      IPFS_REGISTRATION_PROFILE,
      "jinn.evidence-repository.ipfs-registration",
    );
    for (const vector of vectors) {
      const bytes = buildRecordRegistrationBytes(vector.reference);
      assert.equal(decoder.decode(bytes), vector.line);
      assert.equal(registrationCidForReference(vector.reference), vector.cid);
      assert.deepEqual(parseRegistrationBytes(bytes), {
        kind: "record",
        reference: vector.reference,
      });
    }
  });

  test("keeps the artifact namespace separate from every record family", () => {
    const reference = { digest: DIGEST } satisfies EvidenceArtifactReference;
    const line =
      `{"digest":"${DIGEST}","kind":"artifact","profile":"jinn.evidence-repository.ipfs-registration","version":1}\n`;
    const bytes = buildArtifactRegistrationBytes(reference);

    assert.equal(decoder.decode(bytes), line);
    assert.equal(
      registrationCidForReference(reference),
      "f015512203be2cf6e4dbae57487b58ea315520f2689b32c80aeaaab2b9b5e9904b8362c5f",
    );
    assert.deepEqual(parseRegistrationBytes(bytes), {
      kind: "artifact",
      reference,
    });
    assert.ok(
      vectors.every(
        (vector) =>
          registrationCidForReference(vector.reference) !==
          registrationCidForReference(reference),
      ),
    );
  });

  test("rejects noncanonical, malformed, and unknown registration forms", () => {
    const canonical = vectors[0]!.line;
    for (const value of [
      canonical.slice(0, -1),
      ` ${canonical}`,
      canonical.replace(',"version":1}', ',"version":2}'),
      canonical.replace(
        ',"version":1}',
        ',"extra":true,"version":1}',
      ),
      canonical.replace(
        `"digest":"${DIGEST}"`,
        `"digest":"${DIGEST}","digest":"${DIGEST}"`,
      ),
      canonical.replace('"kind":"record"', '"kind":"unknown"'),
      canonical.replace('"execution-evidence"', '"unknown-family"'),
      canonical.replace(DIGEST, `sha256:${"A".repeat(64)}`),
    ]) {
      assert.throws(
        () => parseRegistrationBytes(encoder.encode(value)),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "CONTENT_CORRUPT",
        value,
      );
    }
  });

  test("constructors reject invalid repository references", () => {
    assert.throws(
      () =>
        buildRecordRegistrationBytes({
          family: "execution-evidence",
          digest: `sha256:${"A".repeat(64)}`,
        } as EvidenceRecordReference),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "INVALID_REFERENCE",
    );
  });

  test("maps hostile reference inspection to package-owned errors", () => {
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw createAuthorityBearingError("reference descriptor");
        },
        getPrototypeOf() {
          throw createAuthorityBearingError("reference prototype");
        },
        has() {
          throw createAuthorityBearingError("reference membership");
        },
      },
    );
    const recordFamilyGetter = Object.defineProperties(
      { digest: DIGEST },
      {
        family: authorityGetter("family"),
      },
    ) as unknown as EvidenceRecordReference;
    const recordDigestGetter = Object.defineProperties(
      { family: "execution-evidence" },
      {
        digest: authorityGetter("digest"),
      },
    ) as EvidenceRecordReference;
    const artifactDigestGetter = Object.defineProperties(
      {},
      {
        digest: authorityGetter("digest"),
      },
    ) as EvidenceArtifactReference;

    const cases: ReadonlyArray<{
      readonly label: string;
      readonly run: () => unknown;
    }> = [
      {
        label: "record builder proxy",
        run: () =>
          buildRecordRegistrationBytes(
            proxy as EvidenceRecordReference,
          ),
      },
      {
        label: "artifact builder proxy",
        run: () =>
          buildArtifactRegistrationBytes(
            proxy as EvidenceArtifactReference,
          ),
      },
      {
        label: "generic builder proxy",
        run: () =>
          buildRegistrationBytes(
            proxy as EvidenceArtifactReference,
          ),
      },
      {
        label: "CID helper proxy",
        run: () =>
          registrationCidForReference(
            proxy as EvidenceArtifactReference,
          ),
      },
      {
        label: "record builder family getter",
        run: () => buildRecordRegistrationBytes(recordFamilyGetter),
      },
      {
        label: "record builder digest getter",
        run: () => buildRecordRegistrationBytes(recordDigestGetter),
      },
      {
        label: "artifact builder digest getter",
        run: () =>
          buildArtifactRegistrationBytes(artifactDigestGetter),
      },
      {
        label: "generic builder family getter",
        run: () => buildRegistrationBytes(recordFamilyGetter),
      },
      {
        label: "CID helper digest getter",
        run: () =>
          registrationCidForReference(artifactDigestGetter),
      },
    ];

    for (const entry of cases) {
      assert.throws(
        entry.run,
        (error: unknown) =>
          assertStableInvalidReference(error, entry.label),
        entry.label,
      );
    }
  });

  test("rejects inherited references without invoking inherited accessors", () => {
    const inheritedRecord = Object.create({
      digest: DIGEST,
      family: "execution-evidence",
    }) as EvidenceRecordReference;
    const inheritedArtifact = Object.create({
      digest: DIGEST,
    }) as EvidenceArtifactReference;

    for (const [label, run] of [
      [
        "record",
        () => buildRecordRegistrationBytes(inheritedRecord),
      ],
      [
        "artifact",
        () => buildArtifactRegistrationBytes(inheritedArtifact),
      ],
      [
        "generic",
        () => buildRegistrationBytes(inheritedRecord),
      ],
      [
        "CID",
        () => registrationCidForReference(inheritedArtifact),
      ],
    ] as const) {
      assert.throws(
        run,
        (error: unknown) => assertStableInvalidReference(error, label),
        label,
      );
    }
  });

  test("snapshots required fields without traversing cyclic or hostile extras", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const record = {
      digest: DIGEST,
      extra: cyclic,
      family: "execution-evidence",
    } as EvidenceRecordReference & { readonly extra: unknown };
    Object.defineProperty(record, "hostile", authorityGetter("extra"));
    const artifact = {
      digest: DIGEST,
      extra: cyclic,
    } as EvidenceArtifactReference & { readonly extra: unknown };
    Object.defineProperty(artifact, "hostile", authorityGetter("extra"));

    assert.equal(
      decoder.decode(buildRecordRegistrationBytes(record)),
      vectors[0]!.line,
    );
    assert.equal(
      decoder.decode(buildRegistrationBytes(record)),
      vectors[0]!.line,
    );
    assert.equal(
      registrationCidForReference(record),
      vectors[0]!.cid,
    );
    assert.equal(
      decoder.decode(buildArtifactRegistrationBytes(artifact)),
      `{"digest":"${DIGEST}","kind":"artifact","profile":"jinn.evidence-repository.ipfs-registration","version":1}\n`,
    );
  });
});

function authorityGetter(label: string): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: true,
    get() {
      throw `${AUTHORITY_MARKER_TEXT}/${label}`;
    },
  };
}

function assertStableInvalidReference(
  error: unknown,
  label: string,
): boolean {
  assert.ok(error instanceof Error, label);
  assert.equal(
    (error as Error & { code?: unknown }).code,
    "INVALID_REFERENCE",
    label,
  );
  assert.equal(error.cause, undefined, label);
  assert.equal(Object.isFrozen(error), true, label);
  assert.equal(isIpfsRepositoryError(error), true, label);
  assertNoAuthorityMarkers(error);
  return true;
}
