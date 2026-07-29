// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { makeSecretsSigner } from "./sign.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("makeSecretsSigner", () => {
  test("reads the evaluator key only when Attestation Issuer invokes the signer", async () => {
    const secrets = await mkdtemp(join(tmpdir(), "jinn-evaluation-signer-"));
    temporaryRoots.push(secrets);
    const handle = "evaluator-agent-key.pem";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

    // Construction succeeds while the handle is absent: key custody is resolved at sign time.
    const signer = makeSecretsSigner(secrets, handle);
    await writeFile(join(secrets, handle), privatePem, { mode: 0o600 });

    const preAuthEncoding = new TextEncoder().encode(
      "DSSEv1 31 application/vnd.in-toto+json 7 payload",
    );
    const [produced] = await signer({
      payloadType: "application/vnd.in-toto+json",
      payloadBytes: new TextEncoder().encode("payload"),
      preAuthEncoding,
    });

    expect(
      verify(null, preAuthEncoding, publicKey, produced.signature),
    ).toBe(true);
    expect(JSON.stringify(produced)).not.toContain("PRIVATE KEY");

    // A later call re-resolves the handle instead of retaining key bytes in the signer closure.
    await rm(join(secrets, handle));
    await expect(signer({
      payloadType: "application/vnd.in-toto+json",
      payloadBytes: new Uint8Array(),
      preAuthEncoding,
    })).rejects.toThrow();
  });

  test.each(["../key.pem", "/tmp/key.pem", "nested/key.pem", ""])(
    "refuses a signer handle outside secrets/: %j",
    (handle) => {
      expect(() => makeSecretsSigner("/attempt/secrets", handle)).toThrow(
        "signer handle",
      );
    },
  );
});
