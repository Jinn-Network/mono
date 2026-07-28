import { RECORD_KINDS, cloudEventsFields, referenceBearingFields, sealJson } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  authorizationProfile,
  keyBindingProfile,
  trustPolicyProfile,
} from "./profiles.js";

// Pinned-digest golden documents (plan Task 23 Step 3, mirroring
// protocol/src/fixtures.test.ts's pinned-digest convention): each facts
// profile is a sealed, digest-pinned document. Update these only when a
// field or key ordering changes deliberately.
const EXPECTED_DIGESTS: Record<string, string> = {
  "key-binding": "sha256:7ba7cb95b0089554b0f3abeacc769a2ce0c1152073a3aa5cd2476f080b5763cc",
  "authorization": "sha256:d9b37863c3dbc62ecd12bfee79b481b3a54a4fb2959b7d537bef6c757e8f794e",
  "trust-policy": "sha256:bdcb9d62860d2ae8bdbf37ea51fb172083156d2a8ba6e7ccc0edfe8a86e53090",
};

function expectPinnedDigest(name: string, digest: string) {
  const expected = EXPECTED_DIGESTS[name];
  if (expected === undefined || expected === "sha256:PENDING") {
    throw new Error(
      `No pinned digest for "${name}" yet -- actual digest: ${digest}\n`
        + "Paste this into EXPECTED_DIGESTS and re-run.",
    );
  }
  expect(digest).toBe(expected);
}

describe("facts/trust profile documents", () => {
  it("key-binding profile names the key-binding kind and labels every field record-class", () => {
    expect(keyBindingProfile.kind).toBe(RECORD_KINDS.keyBinding);
    expect(keyBindingProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(keyBindingProfile)).toEqual(["supersedes"]);
    expect(cloudEventsFields(keyBindingProfile).map((field) => field.name)).toEqual(["agent", "relationship", "strength"]);
    expectPinnedDigest("key-binding", sealJson(keyBindingProfile).digest);
  });

  it("authorization profile names the authorization kind and labels every field record-class", () => {
    expect(authorizationProfile.kind).toBe(RECORD_KINDS.authorization);
    expect(authorizationProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(authorizationProfile)).toEqual(["revocation"]);
    expect(cloudEventsFields(authorizationProfile).map((field) => field.name)).toEqual(["issuer"]);
    expectPinnedDigest("authorization", sealJson(authorizationProfile).digest);
  });

  it("trust-policy profile names the trust-policy kind and labels every field record-class", () => {
    expect(trustPolicyProfile.kind).toBe(RECORD_KINDS.trustPolicy);
    expect(trustPolicyProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(trustPolicyProfile)).toEqual(["predecessor"]);
    expect(cloudEventsFields(trustPolicyProfile).map((field) => field.name)).toEqual(["version"]);
    expectPinnedDigest("trust-policy", sealJson(trustPolicyProfile).digest);
  });

  it("no trust facts profile declares a substrate field (the trust layer never carries marketplace substrate)", () => {
    for (const profile of [keyBindingProfile, authorizationProfile, trustPolicyProfile]) {
      expect(profile.fields.some((field) => field.class === "substrate")).toBe(false);
    }
  });

  it("seals to a stable digest independent of source key order (JCS)", () => {
    const sealed = sealJson(keyBindingProfile);
    const shuffled = sealJson({
      protocol: keyBindingProfile.protocol,
      fields: keyBindingProfile.fields,
      kind: keyBindingProfile.kind,
      profile: keyBindingProfile.profile,
    });
    expect(shuffled.digest).toBe(sealed.digest);
    expect(sealed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
