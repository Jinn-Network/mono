// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { classifyTechnicalValue } from "./technical-values.js";

const VALID_ED25519_SPKI = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAqfnE8ZD34j7z1uSmKYNHv4yKPlh0v5LNs9oiXFC7Us4=",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");

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
  expect(classifyTechnicalValue(VALID_ED25519_SPKI, {})).toBe("public-key");
  expect(
    classifyTechnicalValue(
      "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
      {},
    ),
  ).toBeNull();
});

test.each([
  ["c2ln", "dsse-payload"],
  ["c2k=", "dsse-payload"],
  ["__8", "dsse-signature"],
  ["__8=", "dsse-signature"],
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
