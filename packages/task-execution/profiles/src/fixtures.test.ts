import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { serializeCanonicalJson } from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes } from "./index.js";

// Cross-tree parity (program §7.15/§7.1): profiles re-implements sealing locally, but its
// canonical bytes MUST be byte-identical to the TEP protocol sealer's for the same value.
// `task-execution-protocol` exports `serializeCanonicalJson` (its canonical-bytes helper), so
// the equivalence is asserted directly here rather than carried only by a pinned-digest comment.
describe("cross-tree sealer byte-compatibility (task-execution-protocol)", () => {
  it("produces identical canonical bytes to the TEP protocol sealer for the key-order-sensitive record", async () => {
    const value = JSON.parse(
      await readFile(new URL("../fixtures/equivalence/key-order-sensitive.json", import.meta.url), "utf8"),
    );
    expect(canonicalJsonBytes(value)).toEqual(serializeCanonicalJson(value));
  });
});
