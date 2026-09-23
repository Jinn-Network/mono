// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the human sample blocks in `spec/2026-08-13-colophon-self-serve.md` §5.1 against the
 * reference verifier's render of the committed conformance golden (issue #4416).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { renderVerifiedBundle } from "./cli.js";
import { verifyPublicBundleSnapshot } from "./verify.js";

const SELF_SERVE_SPEC = "spec/2026-08-13-colophon-self-serve.md";
const SPEC_PATH = fileURLToPath(new URL(`../../../../${SELF_SERVE_SPEC}`, import.meta.url));
const GOLDEN_BUNDLE_DIR = fileURLToPath(
  new URL("../fixtures/public-bundle-conformance-v1/golden/", import.meta.url),
);

function extractSpecTextBlock(specMarkdown: string, marker: string): string {
  const markerIndex = specMarkdown.indexOf(marker);
  expect(markerIndex, `${SELF_SERVE_SPEC}: marker for fenced block`).toBeGreaterThanOrEqual(0);
  const after = specMarkdown.slice(markerIndex);
  const open = after.indexOf("```text\n");
  expect(open, `${SELF_SERVE_SPEC}: \`\`\`text opening fence`).toBeGreaterThanOrEqual(0);
  const contentStart = open + "```text\n".length;
  const close = after.indexOf("\n```", contentStart);
  expect(close, `${SELF_SERVE_SPEC}: closing fence`).toBeGreaterThanOrEqual(0);
  return after.slice(contentStart, close);
}

/** Normalizes volatile digests to the spec's §5.1 placeholders. */
function normalizeSection51Sample(text: string): string {
  return text
    .replace(/^Bundle: sha256:[0-9a-f]{64}$/m, "Bundle: sha256:<bundle-id>")
    .replace(/^    key sha256:[0-9a-f]{64}/m, "    key sha256:<publisher-key-fingerprint>");
}

describe("Colophon self-serve spec sample pins", () => {
  test("§5.1 verifier success output matches the spec fenced sample", async () => {
    const specBlock = extractSpecTextBlock(
      readFileSync(SPEC_PATH, "utf8"),
      "Success output starts with the answer:",
    );
    const { verification } = await verifyPublicBundleSnapshot(GOLDEN_BUNDLE_DIR);
    const rendered = renderVerifiedBundle(verification);
    expect(
      normalizeSection51Sample(rendered).trimEnd(),
      `${SELF_SERVE_SPEC} §5.1`,
    ).toBe(specBlock.trimEnd());
  });
});
