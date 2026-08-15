import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProfilesError } from "../errors.js";
import { parseTaskProfile, sealTaskProfile } from "./seal.js";

const fixture = (relativePath: string) =>
  readFile(new URL(`../../fixtures/task-profile/${relativePath}`, import.meta.url), "utf8");

describe("task-profile document schema + sealing", () => {
  it("round-trips and matches the pinned golden digest", async () => {
    const golden = JSON.parse(await fixture("golden/minimal-profile.json"));
    const pinned = (await fixture("golden/minimal-profile.sha256")).trim();
    const sealed = sealTaskProfile(golden);
    expect(sealed.digest).toBe(pinned);
    expect(parseTaskProfile(sealed.bytes)).toEqual(golden);
  });

  it("rejects a requirementKeys entry with no declared comparisonClass", async () => {
    const bad = JSON.parse(await fixture("adversarial/requirement-key-no-class.json"));
    expect.assertions(2);
    try {
      sealTaskProfile(bad);
    } catch (error) {
      expect(error).toBeInstanceOf(ProfilesError);
      expect((error as ProfilesError).code).toBe("invalid-document");
    }
  });

  it("rejects the wrong task-profile format URI", async () => {
    const bad = JSON.parse(await fixture("adversarial/wrong-format-uri.json"));
    expect.assertions(2);
    try {
      sealTaskProfile(bad);
    } catch (error) {
      expect(error).toBeInstanceOf(ProfilesError);
      expect((error as ProfilesError).code).toBe("invalid-document");
    }
  });
});
