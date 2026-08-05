import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { DsseSigner } from "./dsse.js";
import { RevocationSchema, sealRevocation, validateRevocation } from "./revocation.js";

const fixedSigner: DsseSigner = async () => [
  { signature: new Uint8Array([4, 5, 6]), keyid: "did:key:z6MkfriendlyWorkingKey" },
];

const VALID_REVOCATION = {
  protocol: "https://spec.jinn.network/trust/revocation/v1" as const,
  target: `sha256:${"1".repeat(64)}`,
  revokedBy: "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  effectiveFrom: "2026-07-29T00:00:00Z",
  anchors: [],
};

describe("RevocationSchema / validateRevocation", () => {
  test("a valid revocation parses and validateRevocation reports conforms:true", async () => {
    const sealed = await sealRevocation(VALID_REVOCATION, fixedSigner);
    const report = validateRevocation(sealed.envelopeBytes);
    expect(report.conforms).toBe(true);
    expect(report.value?.target).toBe(VALID_REVOCATION.target);
  });

  test("revokedBy accepts a did:key working-key spelling too", () => {
    const withWorkingKey = {
      ...VALID_REVOCATION,
      revokedBy: "did:key:z6MkhaTEeQnCVYnQwFRZmpFotWSU7Fdd5tkVEQxCwPvzMWzz",
    };
    expect(RevocationSchema.safeParse(withWorkingKey).success).toBe(true);
  });

  test("a missing target (digest of the revoked binding) fails schema", () => {
    const { target: _target, ...missingTarget } = VALID_REVOCATION;
    expect(RevocationSchema.safeParse(missingTarget).success).toBe(false);
  });

  test("a malformed target digest fails schema", () => {
    const badDigest = { ...VALID_REVOCATION, target: "not-a-digest" };
    expect(RevocationSchema.safeParse(badDigest).success).toBe(false);
  });

  test("an unparseable envelope reports conforms:false with diagnostics", () => {
    const report = validateRevocation(new TextEncoder().encode("not an envelope"));
    expect(report.conforms).toBe(false);
    expect(report.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("sealRevocation pinned-digest golden", () => {
  const goldenPath = fileURLToPath(
    new URL("../fixtures/sealing-v1/revocation.json", import.meta.url),
  );
  const golden: unknown = JSON.parse(readFileSync(goldenPath, "utf8"));

  const expectedDigestsPath = fileURLToPath(
    new URL("../fixtures/sealing-v1/expected-digests.json", import.meta.url),
  );
  const expectedDigests: Record<string, string> = JSON.parse(
    readFileSync(expectedDigestsPath, "utf8"),
  );

  test("sealRevocation produces bytes whose recordDigest matches the pinned golden digest", async () => {
    const sealed = await sealRevocation(golden as never, fixedSigner);
    const expected = expectedDigests["revocation-golden"];
    if (expected === undefined) {
      throw new Error(
        `No pinned digest for "revocation-golden" yet -- actual digest: ${sealed.recordDigest}\n`
          + "Paste this into fixtures/sealing-v1/expected-digests.json and re-run.",
      );
    }
    expect(sealed.recordDigest).toBe(expected);
  });
});
