import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../bytes.js";
import { ProfilesError } from "../../errors.js";
import { loadFixtureFamily, runStructuralCheck } from "../../testing.js";
import { harborPackageContentHash, type HarborPackageFile } from "./package-digest.js";

const familyDir = fileURLToPath(new URL("../../../fixtures/external-verifier-package-digest", import.meta.url));

const A = "a".repeat(64);
const B = "b".repeat(64);

function checkPackageDigest(input: unknown) {
  const { harness, files } = input as { harness: string; files: HarborPackageFile[] };
  if (harness !== "harbor") {
    throw new ProfilesError("invalid-document", `no content-hash rule for harness "${harness}"`);
  }
  return { contentHash: harborPackageContentHash(files) };
}

describe("harbor package content hash", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBe(5);
    const results = runStructuralCheck(cases, checkPackageDigest);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });

  // This literal sits in the normative text of proposal 0002, section 6. It is repeated here on
  // purpose, apart from the fixture, so the text and the code are compared directly.
  it("gives the worked two-file package the hash the family text states", () => {
    expect(
      harborPackageContentHash([
        { path: "task.toml", sha256: A },
        { path: "tests/test.sh", sha256: B },
      ]),
    ).toBe("d9ab9cb898bc6518b5c3429a7bfd8bf0a6e420be644c8c0c1d2765c25627becf");
  });

  it("is the SHA-256 of one line per file: path, a zero byte, the digest, a newline", () => {
    const lines = `task.toml\0${A}\ntests/test.sh\0${B}\n`;
    expect(harborPackageContentHash([{ path: "tests/test.sh", sha256: B }, { path: "task.toml", sha256: A }]))
      .toBe(sha256Hex(new TextEncoder().encode(lines)));
  });

  it("orders paths by Unicode code point and encodes them as UTF-8", () => {
    const basicPlane = { path: "tests/Ａ.txt", sha256: B };
    const supplementary = { path: "tests/\u{10400}.txt", sha256: A };
    const lines = `${basicPlane.path}\0${B}\n${supplementary.path}\0${A}\n`;
    expect(harborPackageContentHash([supplementary, basicPlane])).toBe(sha256Hex(new TextEncoder().encode(lines)));
  });

  it("does not reorder the caller's list", () => {
    const files = [{ path: "tests/test.sh", sha256: B }, { path: "task.toml", sha256: A }];
    harborPackageContentHash(files);
    expect(files.map((file) => file.path)).toEqual(["tests/test.sh", "task.toml"]);
  });

  it("refuses a file digest that is not 64 lowercase hexadecimal digits", () => {
    for (const sha256 of ["B".repeat(64), "b".repeat(63), `sha256:${B}`, ""]) {
      expect.soft(() => harborPackageContentHash([{ path: "task.toml", sha256 }]), JSON.stringify(sha256))
        .toThrow(ProfilesError);
    }
  });

  it("refuses one path given twice, whether or not the two digests agree", () => {
    expect(() => harborPackageContentHash([{ path: "task.toml", sha256: A }, { path: "task.toml", sha256: A }]))
      .toThrow(ProfilesError);
    expect(() => harborPackageContentHash([{ path: "task.toml", sha256: A }, { path: "task.toml", sha256: B }]))
      .toThrow(ProfilesError);
  });
});
