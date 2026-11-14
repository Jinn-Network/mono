import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { presentAnchorProfile, presentProtocolText, SPEC_RELEASE_SERVED_PATHS } from "./present-protocol-profile";

/** A file of the verifier package; this package cannot import it, so it reads the source it copies. */
function verifierFile(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../check/${path}`, import.meta.url)), "utf8");
}

/** The cases both copies of the presenter run (#4818). */
const SHARED_CASES: readonly { readonly shape: string; readonly input: string; readonly presented: string }[] =
  JSON.parse(verifierFile("src/testing/identifier-presentation-cases.json")).cases;

/** The parts of a presenter's source that decide what is rewritten and what name it gets. */
function rewriteRule(source: string): Record<string, string | undefined> {
  const declaration = (name: string) =>
    new RegExp(`^(?:export )?function ${name}\\b[\\s\\S]*?^\\}$`, "mu").exec(source)?.[0].replace(/^export /u, "");
  return {
    origin: /^const SPEC_ORIGIN = .*$/mu.exec(source)?.[0],
    candidate: /^const PROTOCOL_IDENTIFIER_CANDIDATE =\n.*$/mu.exec(source)?.[0],
    internal: /^const INTERNAL_PROTOCOL_URL =\n.*$/mu.exec(source)?.[0],
    served: declaration("resolvesAtSpecOrigin"),
    alias: declaration("presentProtocolAlias"),
    // The verifier passes its alias in as `alias`; this copy calls `presentProtocolAlias` directly.
    replacer: /^export function (?:rewriteInternalProtocolIdentifiers|presentProtocolText)\([\s\S]*?\): string \{\n([\s\S]*?^\})$/mu
      .exec(source)?.[1].replaceAll("presentProtocolAlias(", "alias("),
  };
}

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

  test("names an unserved protocol identifier by its path, without the origin", () => {
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

describe("shared presentation cases", () => {
  test.each(SHARED_CASES)("$shape", ({ input, presented }) => {
    expect(presentProtocolText(input)).toBe(presented);
  });
});

describe("rewrite rule", () => {
  test("is the verifier's, character for character", () => {
    // Catches a case added to one copy and not the other even when no shared case reaches it.
    const verifier = rewriteRule(verifierFile("src/identifier-presentation.ts"));
    expect(Object.entries(verifier).filter(([, part]) => part === undefined).map(([name]) => name)).toEqual([]);
    expect(rewriteRule(readFileSync(fileURLToPath(new URL("./present-protocol-profile.ts", import.meta.url)), "utf8")))
      .toEqual(verifier);
  });

  test("the verifier's reader pass hands its alias through unchanged", () => {
    expect(verifierFile("src/identifier-presentation.ts")).toMatch(
      /^export function presentInternalProtocolIdentifiers\(text: string\): string \{\n {2}return rewriteInternalProtocolIdentifiers\(text, presentProtocolAlias\);\n\}$/mu,
    );
  });
});
