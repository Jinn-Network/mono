// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";

import { KeysFileError, parseKeysFile } from "./index.js";

function spki(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

describe("parseKeysFile", () => {
  test("every object with a keyId and an SPKI key supplies one key, at any depth", () => {
    const [first, second] = [spki(), spki()];
    const keys = parseKeysFile(JSON.stringify({
      format: "anything",
      evaluators: [{ keyId: "one", spkiDerBase64: first, evaluator: "urn:example:one" }],
      nested: { report: { keyId: "two", spkiDerBase64: second } },
      admission: { authorities: [{ keyId: "did:key:z6Mk", role: "a key the file gives no bytes for" }] },
    }));
    expect(keys.map(({ keyId }) => keyId)).toEqual(["one", "two"]);
    expect(keys.map(({ publicKey }) => publicKey.asymmetricKeyType)).toEqual(["ed25519", "ed25519"]);
  });

  test("a bare list works", () => {
    expect(parseKeysFile(JSON.stringify([{ keyId: "one", spkiDerBase64: spki() }]))).toHaveLength(1);
  });

  test("the same key twice under one id is one key", () => {
    const key = spki();
    expect(parseKeysFile(JSON.stringify([{ keyId: "one", spkiDerBase64: key }, { keyId: "one", spkiDerBase64: key }]))).toHaveLength(1);
  });

  test("a key that is not Ed25519 is refused, because no signature could be verified under it", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => parseKeysFile(JSON.stringify([{ keyId: "one", spkiDerBase64: rsa }]))).toThrow(/Ed25519/u);
  });

  test.each([
    ["text that is not JSON", "not json", /not JSON/u],
    ["a file with no keys", "{}", /no keys/u],
    ["a key that does not parse", JSON.stringify([{ keyId: "one", spkiDerBase64: "AAAA" }]), /key one/u],
    ["two keys under one id", JSON.stringify([{ keyId: "one", spkiDerBase64: spki() }, { keyId: "one", spkiDerBase64: spki() }]), /key one/u],
  ])("%s is refused", (_name, text, message) => {
    expect(() => parseKeysFile(text)).toThrow(KeysFileError);
    expect(() => parseKeysFile(text)).toThrow(message);
  });
});
