import { describe, expect, it } from "vitest";
import { ProfilesError } from "../errors.js";
import { PayloadValidatorCache } from "./compiled-cache.js";
import { sealTaskProfile } from "./seal.js";
import type { TaskProfileDocument } from "./schema.js";

function makeDoc(description: string): TaskProfileDocument {
  return {
    protocol: "https://jinn.network/profiles/task-profile/1.0",
    profile: "https://jinn.network/task-profiles/example-domain/1.0",
    description,
    payloadSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: true,
    },
    inputConventions: { slots: [] },
    outputConventions: { slots: [] },
    evaluationFamilies: [],
    requirementKeys: [],
  };
}

describe("PayloadValidatorCache", () => {
  it("compiles once per digest and reuses the cached validator", () => {
    const cache = new PayloadValidatorCache();
    const doc = makeDoc("cache reuse fixture");
    const digest = sealTaskProfile(doc).digest;
    const first = cache.get(digest, doc);
    const second = cache.get(digest, doc);
    expect(first).toBe(second);
    expect(first({ note: "hi" })).toEqual({ ok: true });
  });

  it("checkDrift throws unsupported-profile when the cached document's digest does not match the pinned digest", () => {
    const cache = new PayloadValidatorCache();
    const pinned = makeDoc("the pinned document");
    const pinnedDigest = sealTaskProfile(pinned).digest;
    const differentlyDigested = makeDoc("a different document that hashes differently (a newer patch)");
    expect.assertions(2);
    try {
      cache.checkDrift(pinned.profile, pinnedDigest, differentlyDigested);
    } catch (error) {
      expect(error).toBeInstanceOf(ProfilesError);
      expect((error as ProfilesError).code).toBe("unsupported-profile");
    }
  });

  it("checkDrift does not throw when the cached document matches the pinned digest", () => {
    const cache = new PayloadValidatorCache();
    const doc = makeDoc("matches");
    const pinnedDigest = sealTaskProfile(doc).digest;
    expect(() => cache.checkDrift(doc.profile, pinnedDigest, doc)).not.toThrow();
  });
});
