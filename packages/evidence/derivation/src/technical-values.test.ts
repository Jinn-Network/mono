// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { expect, test } from "vitest";

import {
  classifyTechnicalValue,
  isStructurallyValidDsseEnvelope,
} from "./technical-values.js";

const VALID_ED25519_SPKI = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAqfnE8ZD34j7z1uSmKYNHv4yKPlh0v5LNs9oiXFC7Us4=",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");
const VALID_RSA_SPKI = [
  "-----BEGIN PUBLIC KEY-----",
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCsbXbf1hNMMFRwpK308KNw+Shi",
  "8QQL6ZuO62gOTd7TEmOLXnNVZ/YbEHiJmpfJBf3FfH9uWQaekgl1wrg90ZTHDuAl",
  "L+cu/2W+akui3nGXJVLHANkZoxLkYHOE+YckJDUj7HAm9qzGnwfdDQoz1sGAWjZ8",
  "2yqy9wAQNBsOfMU/gQIDAQAB",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");
const VALID_P256_SPKI = [
  "-----BEGIN PUBLIC KEY-----",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtZYHTlG0G3GEYXb1xPGS0HuQdtA2",
  "op2mYU3xM8A5cRGleT3YCFIFseygxTGu9QOx+1AK3qFicxyc/TDE7dT2Xw==",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");
const EMPTY_RSA_SPKI =
  "-----BEGIN PUBLIC KEY-----\nMBQwDQYJKoZIhvcNAQEBBQADAwAwAA==\n-----END PUBLIC KEY-----\n";
const ONE_BYTE_EC_SPKI =
  "-----BEGIN PUBLIC KEY-----\nMBkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDAgAE\n-----END PUBLIC KEY-----\n";
const CREDENTIAL_SHAPED_RSA_SPKI = [
  "-----BEGIN PUBLIC KEY-----",
  "MD4wDQYJKoZIhvcNAQEBBQADLQAwKgQobnBtX2FhYWFhYWFhYWFhYWFhYWFhYWFh",
  "YWFhYWFhYWFhYWFhYWFhYQ==",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");

function derElement(tag: number, content: readonly number[]): number[] {
  if (content.length >= 0x80) {
    throw new Error("test DER helper supports short lengths");
  }
  return [tag, content.length, ...content];
}

function publicKeyPem(
  algorithm: readonly number[],
  subject: readonly number[],
): string {
  const bitString = derElement(0x03, [0, ...subject]);
  const spki = derElement(0x30, [...algorithm, ...bitString]);
  return [
    "-----BEGIN PUBLIC KEY-----",
    Buffer.from(spki).toString("base64"),
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n");
}

const RSA_ALGORITHM = derElement(0x30, [
  ...derElement(0x06, [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]),
  ...derElement(0x05, []),
]);
const P256_ALGORITHM = derElement(0x30, [
  ...derElement(0x06, [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]),
  ...derElement(0x06, [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]),
]);
const P384_ALGORITHM = derElement(0x30, [
  ...derElement(0x06, [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]),
  ...derElement(0x06, [0x2b, 0x81, 0x04, 0x00, 0x22]),
]);

test.each([
  [`sha256:${"a".repeat(64)}`, "digest"],
  [`0x${"b".repeat(64)}`, "transaction-digest"],
  ["bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a", "cid"],
  ["1.2.3", "version"],
])("classifies structurally supported technical value %s", (value, expected) => {
  expect(classifyTechnicalValue(value, { field: expected })).toBe(expected);
});

test("never treats explicit credentials as technical values", () => {
  expect(classifyTechnicalValue("sk-secret-example", { field: "modelId" })).toBe(
    null,
  );
});

test.each([
  `owner/npm_${"a".repeat(36)}`,
  `owner/AIza${"a".repeat(35)}`,
  `owner/github_pat_${"a".repeat(82)}`,
  `owner/rk_live_${"a".repeat(24)}`,
  `owner/0x${"a".repeat(64)}`,
])("credential precedence rejects owner/name-looking value %s", (value) => {
  expect(classifyTechnicalValue(value, { field: "modelId" })).toBeNull();
});

test("accepts only structurally valid SPKI public keys", () => {
  for (const value of [
    VALID_ED25519_SPKI,
    VALID_RSA_SPKI,
    VALID_P256_SPKI,
  ]) {
    expect(classifyTechnicalValue(value, {})).toBe("public-key");
  }
  expect(
    classifyTechnicalValue(
      "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
      {},
    ),
  ).toBeNull();
  for (const value of [
    EMPTY_RSA_SPKI,
    ONE_BYTE_EC_SPKI,
    CREDENTIAL_SHAPED_RSA_SPKI,
  ]) {
    expect(classifyTechnicalValue(value, {})).toBeNull();
  }
});

test("requires an exact canonical pair of positive RSA integers", () => {
  const integer = (content: readonly number[]) => derElement(0x02, content);
  for (const subject of [
    derElement(0x30, [...integer([1])]),
    derElement(0x30, [
      ...integer([1]),
      ...integer([3]),
      ...integer([5]),
    ]),
    derElement(0x30, [...integer([0x80]), ...integer([3])]),
    derElement(0x30, [...integer([0, 1]), ...integer([3])]),
    derElement(0x30, [...integer([1]), ...integer([0])]),
  ]) {
    expect(
      classifyTechnicalValue(publicKeyPem(RSA_ALGORITHM, subject), {}),
    ).toBeNull();
  }
});

test("binds compressed and uncompressed EC point lengths to the named curve", () => {
  expect(
    classifyTechnicalValue(
      publicKeyPem(P256_ALGORITHM, [0x02, ...new Array<number>(32).fill(1)]),
      {},
    ),
  ).toBe("public-key");
  expect(
    classifyTechnicalValue(
      publicKeyPem(P384_ALGORITHM, [0x04, ...new Array<number>(64).fill(1)]),
      {},
    ),
  ).toBeNull();
});

test.each([
  ["c2ln", "dsse-payload"],
  ["c2k=", "dsse-payload"],
  ["", "dsse-payload"],
  ["__8", "dsse-signature"],
  ["__8=", "dsse-signature"],
  ["", "dsse-signature"],
] as const)(
  "accepts padded or unpadded standard/url-safe base64 only in DSSE context",
  (value, structuralRole) => {
    expect(
      classifyTechnicalValue(value, {
        field: structuralRole === "dsse-payload" ? "payload" : "sig",
      }),
    ).toBeNull();
    expect(classifyTechnicalValue(value, { structuralRole })).toBe(
      "dsse-material",
    );
  },
);

test.each([
  {},
  { keyid: "" },
] as const)(
  "accepts Protocol-valid loose DSSE envelopes and optional/empty keyids: %j",
  (keyid) => {
    expect(
      isStructurallyValidDsseEnvelope({
        payloadType: "application/vnd.in-toto+json",
        payload: "e30",
        envelopeExtension: {
          schema: "synthetic-extension",
        },
        signatures: [
          {
            ...keyid,
            sig: "__8",
            signatureExtension: ["synthetic", 1],
          },
        ],
      }),
    ).toBe(true);
  },
);

test.each([
  { payload: "", sig: "c2k=" },
  { payload: "e30", sig: "" },
] as const)(
  "accepts canonical zero-byte DSSE payload/signature fields: %j",
  ({ payload, sig }) => {
    expect(
      isStructurallyValidDsseEnvelope({
        payloadType: "application/vnd.in-toto+json",
        payload,
        signatures: [{ sig }],
      }),
    ).toBe(true);
  },
);

test("rejects behavioral or proxied DSSE extensions without executing them", () => {
  let getterCalls = 0;
  let trapCalls = 0;
  const envelopeExtension = {};
  Object.defineProperty(envelopeExtension, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("extension getter must not execute");
    },
  });
  const signatureExtension = new Proxy(
    {},
    {
      ownKeys() {
        trapCalls += 1;
        throw new Error("extension proxy trap must not execute");
      },
    },
  );
  expect(
    isStructurallyValidDsseEnvelope({
      payloadType: "application/vnd.in-toto+json",
      payload: "e30",
      envelopeExtension,
      signatures: [{ sig: "__8" }],
    }),
  ).toBe(false);
  expect(
    isStructurallyValidDsseEnvelope({
      payloadType: "application/vnd.in-toto+json",
      payload: "e30",
      signatures: [{ sig: "__8", signatureExtension }],
    }),
  ).toBe(false);
  expect(getterCalls).toBe(0);
  expect(trapCalls).toBe(0);
});
