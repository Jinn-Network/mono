import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { DsseSigner } from "./dsse.js";
import {
  KeyBindingSchema,
  deriveStrength,
  sealKeyBinding,
  validateKeyBinding,
} from "./key-binding.js";

const fixedSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3]), keyid: "did:key:z6MkfriendlyWorkingKey" },
];

const VALID_EOA_BINDING = {
  protocol: "https://jinn.network/trust/key-binding/v1" as const,
  agent: "urn:uuid:11111111-1111-4111-8111-111111111111",
  key: {
    publicKey: "0x04abcdef",
    keyid: "did:key:z6MkhaTEeQnCVYnQwFRZmpFotWSU7Fdd5tkVEQxCwPvzMWzz",
    algorithm: "secp256k1",
    didKey: "did:key:z6MkhaTEeQnCVYnQwFRZmpFotWSU7Fdd5tkVEQxCwPvzMWzz",
  },
  voucher: {
    kind: "account" as const,
    did: "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    contractAccount: false,
  },
  relationship: "controls" as const,
  scope: ["deliveries", "verdicts"],
  validFrom: "2026-07-28T00:00:00Z",
  ceremony: {
    type: "eoa" as const,
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  strength: "strong" as const,
  anchors: [],
};

describe("KeyBindingSchema / validateKeyBinding", () => {
  test("a valid binding parses and validateKeyBinding reports conforms:true", async () => {
    const sealed = await sealKeyBinding(VALID_EOA_BINDING, fixedSigner);
    const report = validateKeyBinding(sealed.envelopeBytes);
    expect(report.conforms).toBe(true);
    expect(report.value?.agent).toBe(VALID_EOA_BINDING.agent);
  });

  test("strength is ceremony-derived: a github-human ceremony asserting strength:strong is a conformance FAILURE", async () => {
    const binding = {
      ...VALID_EOA_BINDING,
      voucher: { kind: "github-human" as const, profile: "https://github.com/octocat", id: 1 },
      ceremony: {
        type: "github-human" as const,
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      strength: "strong" as const, // WRONG -- github-human is always weak (§7.2 table)
    };
    // strength/ceremony-type consistency is a semantic conformance rule, not
    // a schema-shape rule, so sealKeyBinding (schema-shape valid) succeeds --
    // the mismatch is only caught by validateKeyBinding's derived check.
    const sealed = await sealKeyBinding(binding, fixedSigner);
    const report = validateKeyBinding(sealed.envelopeBytes);
    expect(report.conforms).toBe(false);
    expect(report.diagnostics.some((d) => d.code === "STRENGTH_MISMATCH")).toBe(true);
  });

  test("deriveStrength: github-human is weak, every other ceremony type is strong (§7.2 table)", () => {
    expect(deriveStrength("github-human")).toBe("weak");
    expect(deriveStrength("eoa")).toBe("strong");
    expect(deriveStrength("safe")).toBe("strong");
    expect(deriveStrength("agentId")).toBe("strong");
    expect(deriveStrength("oidc-machine")).toBe("strong");
  });

  test("scope: [\"bindings\"] is accepted; an unknown scope member fails", () => {
    const withBindingsScope = { ...VALID_EOA_BINDING, scope: ["bindings"] };
    expect(KeyBindingSchema.safeParse(withBindingsScope).success).toBe(true);

    const withUnknownScope = { ...VALID_EOA_BINDING, scope: ["not-a-real-scope"] };
    expect(KeyBindingSchema.safeParse(withUnknownScope).success).toBe(false);
  });

  test("a binding accepted on its envelope signature alone (no ceremony authority check here) still requires a well-formed ceremony reference", () => {
    const missingCeremony = { ...VALID_EOA_BINDING, ceremony: undefined };
    expect(KeyBindingSchema.safeParse(missingCeremony).success).toBe(false);
  });
});

describe("sealKeyBinding pinned-digest golden", () => {
  const goldenPath = fileURLToPath(
    new URL("../fixtures/sealing-v1/key-binding.json", import.meta.url),
  );
  const golden: unknown = JSON.parse(readFileSync(goldenPath, "utf8"));

  const expectedDigestsPath = fileURLToPath(
    new URL("../fixtures/sealing-v1/expected-digests.json", import.meta.url),
  );
  const expectedDigests: Record<string, string> = JSON.parse(
    readFileSync(expectedDigestsPath, "utf8"),
  );

  test("sealKeyBinding produces bytes whose recordDigest matches the pinned golden digest", async () => {
    const sealed = await sealKeyBinding(golden as never, fixedSigner);
    const expected = expectedDigests["key-binding-golden"];
    if (expected === undefined) {
      throw new Error(
        `No pinned digest for "key-binding-golden" yet -- actual digest: ${sealed.recordDigest}\n`
          + "Paste this into fixtures/sealing-v1/expected-digests.json and re-run.",
      );
    }
    expect(sealed.recordDigest).toBe(expected);
  });
});
