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
  "key-binding": "sha256:c2f21e1a74d5428403ac5925f209fd6b0d85508a8fb029629e71fe328690a82c",
  "authorization": "sha256:986c5c1a2572fcba504edb8ea12aabca16cd975f22b0e3aa4c3ed0110d095bb4",
  "trust-policy": "sha256:f2ffd2163fbe0c0d0d485dfc0d5e33af9d77ccec555c302fb476790577abab8b",
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
