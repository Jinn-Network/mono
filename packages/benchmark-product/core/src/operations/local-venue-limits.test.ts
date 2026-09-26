import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** Neutral-freeze announcement surface spec §7.2, quoted into the printed self-run disclosure (#3401). */
const STREAM_INTEGRITY_DISCLOSURE =
  "This venue's publication source is owner-controlled: the operator holds the signing key and hosts the archive, so they can rewrite the announcement chain from any point, re-sign a shorter or different head, and no reader who had not previously fetched the old head could tell.";

describe("LOCAL_VENUE_LIMITS stream-integrity disclosure (#3401)", () => {
  test("the product, verifier profile, and EXTERNAL-VERIFICATION.md print spec §7.2 in the same words", () => {
    const producer = readFileSync(resolve(here, "run-results.ts"), "utf8");
    const verifier = readFileSync(
      resolve(here, "../../../check/src/profile/run-results.ts"),
      "utf8",
    );
    const doc = readFileSync(resolve(here, "../../../EXTERNAL-VERIFICATION.md"), "utf8");
    expect(producer).toContain(STREAM_INTEGRITY_DISCLOSURE);
    expect(verifier).toContain(STREAM_INTEGRITY_DISCLOSURE);
    expect(doc).toContain(`- ${STREAM_INTEGRITY_DISCLOSURE}`);
    expect(doc).not.toMatch(/The five sealed sentences above do not say this/);
  });
});
