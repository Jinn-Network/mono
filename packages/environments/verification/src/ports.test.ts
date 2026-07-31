// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ContainerRuntime, VerificationDeps } from "./ports.js";

describe("ports", () => {
  it("types a container runtime with pull-by-digest and a fresh-container run", async () => {
    const runtime: ContainerRuntime = {
      async pullByDigest(request) {
        return { resolvedManifestDigest: request.manifestDigest };
      },
      async runContainer() {
        return {
          containerId: "container-0",
          installExitCodes: [],
          testExitCodes: [1],
          outcomes: { "tests/test_a.py::test_one": "fail" },
          wallSeconds: 4,
          timedOut: false,
        };
      },
    };
    const pull = await runtime.pullByDigest({
      manifestDigest: `sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
    });
    expect(pull.resolvedManifestDigest).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("keeps the injected dependency set to ports plus the declared verifier", () => {
    const keys: (keyof VerificationDeps)[] = [
      "containerRuntime",
      "artifactStore",
      "signer",
      "clock",
      "verifier",
    ];
    expect(keys).toHaveLength(5);
  });
});
