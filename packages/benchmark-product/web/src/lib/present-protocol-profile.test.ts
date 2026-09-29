import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { presentAnchorProfile, presentProtocolText, SPEC_RELEASE_SERVED_PATHS } from "./present-protocol-profile";

describe("presentAnchorProfile", () => {
  test("names an anchor profile the spec release does not serve by its path, without the origin", () => {
    expect(presentAnchorProfile("https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1"))
      .toBe("rfc3161-tsa/v1");
  });
});

describe("presentProtocolText", () => {
  test("keeps a third-party URL", () => {
    expect(presentProtocolText("https://tsa.example/tsr")).toBe("https://tsa.example/tsr");
  });

  test("keeps an identifier the spec release serves whole, so a reader can follow it", () => {
    const served = "https://spec.jinn.network/task-profiles/binary-judgment/2.0";
    expect(presentProtocolText(`profile ${served}`)).toBe(`profile ${served}`);
  });

  test("names an unserved Jinn identifier by its path, without the origin", () => {
    expect(presentProtocolText("profile https://spec.jinn.network/task-profiles/binary-judgment/1.0"))
      .toBe("profile task-profiles/binary-judgment/1.0");
  });
});

describe("served set", () => {
  test("is the verifier's served set, path for path", () => {
    // The verifier owns the list; this package cannot import it, so it reads the source it copies.
    const source = readFileSync(
      fileURLToPath(new URL("../../../check/src/identifier-presentation.ts", import.meta.url)),
      "utf8",
    );
    const block = /SPEC_RELEASE_SERVED_PATHS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/u.exec(source)?.[1];
    expect(block, "the verifier's served set is no longer readable").toBeDefined();
    const verifier = [...block!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
    expect(verifier.length).toBeGreaterThan(0);
    expect([...SPEC_RELEASE_SERVED_PATHS]).toEqual(verifier);
  });
});
