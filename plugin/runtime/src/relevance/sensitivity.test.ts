// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { ensureOwnerOnlyFile } from "../capture/paths.js";
import { readOrCreateSensitivityNonce, type SensitivityNonceIO } from "./nonce.js";
import { createSensitivityClassifier, type SensitivityClassifier } from "./sensitivity.js";

const testNonceIo: SensitivityNonceIO = {
  readFile,
  writeFile,
  ensureOwnerOnlyFile,
};

let classifier: SensitivityClassifier;

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "jinn-sensitivity-"));
  classifier = await createSensitivityClassifier({
    noncePath: join(home, "sensitivity-nonce"),
    knownIdentities: [],
    nonceIo: testNonceIo,
  });
});

const excerpt = (text: string) => ({
  text,
  sourceEntityId: "artifact:trace",
  role: "native-trace" as const,
});

describe("sensitivity classification", () => {
  test("passes ordinary session text", async () => {
    const verdict = await classifier.classify(
      excerpt("yarn test failed on src/index.test.ts, rerun with --no-threads"),
    );
    expect(verdict.excluded).toBe(false);
  });

  test("excludes a token-shaped credential", async () => {
    const verdict = await classifier.classify(
      excerpt("export GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"),
    );
    expect(verdict.excluded).toBe(true);
    if (verdict.excluded) expect(verdict.classes).toContain("credential");
  });

  test("excludes a 64-hex private key", async () => {
    const verdict = await classifier.classify(
      excerpt(`private_key ${"a1b2c3d4".repeat(8)}`),
    );
    expect(verdict.excluded).toBe(true);
  });

  test("excludes a URL carrying a credential", async () => {
    const verdict = await classifier.classify(
      excerpt("curl https://user:hunter2@registry.example.test/publish"),
    );
    expect(verdict.excluded).toBe(true);
    if (verdict.excluded) expect(verdict.classes).toContain("url-credential");
  });

  test("excludes an environment dump", async () => {
    const verdict = await classifier.classify(
      excerpt("AWS_REGION=us-east-1\nDATABASE_URL=postgres://x\nNODE_ENV=production\n"),
    );
    expect(verdict.excluded).toBe(true);
  });

  test("does NOT exclude the operator's own home path", async () => {
    const verdict = await classifier.classify(
      excerpt("open /Users/ritsu/life's-work/jinn-mono/client/src/main.ts"),
    );
    expect(verdict.excluded).toBe(false);
  });

  test("does NOT exclude a content digest", async () => {
    const verdict = await classifier.classify(
      excerpt(`record sha256:${"f".repeat(64)} validated`),
    );
    expect(verdict.excluded).toBe(false);
  });

  test("a verdict never carries the offending text", async () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    const verdict = await classifier.classify(excerpt(`token ${secret}`));
    expect(JSON.stringify(verdict)).not.toContain(secret);
  });

  test("a throwing detector excludes, it does not admit", async () => {
    const failing = await createSensitivityClassifier({
      noncePath: join(await mkdtemp(join(tmpdir(), "jinn-sens2-")), "nonce"),
      knownIdentities: [],
      nonceIo: testNonceIo,
      detectors: [
        {
          descriptor: {
            id: "explodes",
            version: "1.0.0",
            implementationDigest: `sha256:${"0".repeat(64)}`,
            reproducibility: "byte-stable",
          },
          detect: () => Promise.reject(new Error("detector blew up")),
        },
      ],
    });
    const verdict = await failing.classify(excerpt("harmless text"));
    expect(verdict.excluded).toBe(true);
    if (verdict.excluded) expect(verdict.classes).toContain("detector-failure");
  });
});

describe("sensitivity nonce", () => {
  test("is created owner-only, is long enough, and is stable across reads", async () => {
    const home = await mkdtemp(join(tmpdir(), "jinn-nonce-"));
    const path = join(home, "sensitivity-nonce");
    const first = await readOrCreateSensitivityNonce(path, testNonceIo);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(await readOrCreateSensitivityNonce(path, testNonceIo)).toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
