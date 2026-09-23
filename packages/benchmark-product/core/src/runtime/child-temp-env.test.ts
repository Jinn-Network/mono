import { describe, expect, it } from "vitest";

import { inheritedTempEnv, scopedTempEnv } from "./child-temp-env.js";

// The repository-wide scan that once lived here — every `env:` site in this package's `src` must
// carry a temp directory or say why not — now runs from `.github/scripts/child-temp-env-scan.mjs`
// over this package AND the `task-execution` trees. Its root was this package's `src`, so a launch
// plan added one package over was covered by two point assertions and nothing else (#3098). One
// implementation rather than a copy per package: the heuristics are subtle enough that two copies
// would drift, and three follow-ups against them (#3097, #3099) arrived before the second copy did.
describe("child temp-directory environment", () => {
  it("passes through only the caller's non-empty temp variables", () => {
    expect(inheritedTempEnv({ TMPDIR: "/a", TMP: "/b", TEMP: "/c", PATH: "/bin" })).toEqual({
      TMPDIR: "/a",
      TMP: "/b",
      TEMP: "/c",
    });
    expect(inheritedTempEnv({})).toEqual({});
    // An empty value is a RELATIVE path to a child that resolves it, not "use the default".
    expect(inheritedTempEnv({ TMPDIR: "" })).toEqual({});
  });

  it("pins all three names at a scoped directory", () => {
    expect(scopedTempEnv("/run/tmp")).toEqual({ TMPDIR: "/run/tmp", TMP: "/run/tmp", TEMP: "/run/tmp" });
  });
});
