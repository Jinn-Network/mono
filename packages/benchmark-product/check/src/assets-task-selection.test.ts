// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3416: task-selection provenance on the report face, at headline weight.
 *
 * The operator ruling of 2026-09-24 lands the render as the declared `/10` capability
 * `task-selection`: a header fact row that states the Run's declared mode as its own token, so a
 * claimant-chosen selection reads "claimant-chosen". The row is projected from the claim's
 * `taskSelection` section, which a composed claim carries exactly when its bundle declares the
 * capability and which `claim-consistency` has already rebuilt from the sealed Run. Every page
 * without the section, including every format allocated before `/10`, renders exactly what it did.
 */

import { describe, expect, test } from "vitest";
import { buildPublicAssets, type PublicAssetInput } from "./assets.js";
import { BUNDLE_V10_FORMAT, SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import { goldenInput } from "./testing/golden-asset-input.js";

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array | undefined): string => decoder.decode(bytes);

const MODES = ["claimant-chosen", "fixed-public-set", "drawn-post-lock"] as const;
type Mode = (typeof MODES)[number];

async function declaring(mode: Mode): Promise<PublicAssetInput> {
  const input = await goldenInput(BUNDLE_V10_FORMAT);
  return { ...input, claim: { ...input.claim, taskSelection: { mode } } } as PublicAssetInput;
}

const htmlRow = (mode: Mode): string =>
  `\n<dl class="facts"><div><dt>Task selection</dt><dd>${mode}</dd></div></dl>`;
const textRow = (mode: Mode): string => `Task selection: ${mode}.`;

describe("the header fact row", () => {
  test("index.html states the mode in the header, directly under the scope line", async () => {
    const html = decode(buildPublicAssets(await declaring("claimant-chosen"))["index.html"]);
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    // The blunt value is printed as its token, never softened into prose.
    expect(header).toContain(
      `</p>${htmlRow("claimant-chosen")}\n<p class="neutral">`,
    );
    expect(header.indexOf("<dt>Task selection</dt>")).toBeGreaterThan(header.indexOf('<p class="lede">'));
    expect(html.split("<dt>Task selection</dt>")).toHaveLength(2);
  });

  test("README.md states it beside the scope line", async () => {
    const readme = decode(buildPublicAssets(await declaring("claimant-chosen"))["README.md"]);
    expect(readme).toMatch(/\nScope: [^\n]+\.\n\nTask selection: claimant-chosen\.\n\nReport SHA-256: /u);
    expect(readme.split("Task selection:")).toHaveLength(2);
  });

  test("share.txt states it directly after the scope", async () => {
    const share = decode(buildPublicAssets(await declaring("claimant-chosen"))["share.txt"]);
    expect(share).toMatch(/ replicates · self-run\. Task selection: claimant-chosen\. /u);
  });

  test("each mode renders as its own token", async () => {
    for (const mode of MODES) {
      const assets = buildPublicAssets(await declaring(mode));
      expect(decode(assets["index.html"])).toContain(htmlRow(mode));
      expect(decode(assets["README.md"])).toContain(textRow(mode));
      expect(decode(assets["share.txt"])).toContain(textRow(mode));
    }
  });

  test("the row is the only difference, and the badge and social card do not move", async () => {
    const plain = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    for (const mode of MODES) {
      const assets = buildPublicAssets(await declaring(mode));
      expect(decode(assets["index.html"]).replace(htmlRow(mode), "")).toBe(decode(plain["index.html"]));
      expect(decode(assets["README.md"]).replace(`\n\n${textRow(mode)}`, "")).toBe(decode(plain["README.md"]));
      expect(decode(assets["share.txt"]).replace(` ${textRow(mode)}`, "")).toBe(decode(plain["share.txt"]));
      expect(assets["badge.svg"]).toEqual(plain["badge.svg"]);
      expect(assets["social-card.svg"]).toEqual(plain["social-card.svg"]);
    }
  });

  test("a mode is escaped like every other rendered fact", async () => {
    // The claim schema admits only the three tokens, so this cannot reach a verified page; the
    // builder still never prints a claim string raw.
    const input = await goldenInput(BUNDLE_V10_FORMAT);
    const hostile = { ...input, claim: { ...input.claim, taskSelection: { mode: "<script>x</script>" } } } as unknown as PublicAssetInput;
    const html = decode(buildPublicAssets(hostile)["index.html"]);
    expect(html).toContain("<dd>&lt;script&gt;x&lt;/script&gt;</dd>");
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("no page without the section moves", () => {
  test("every format, rendered without a task-selection section, carries no row", async () => {
    for (const format of SUPPORTED_BUNDLE_FORMATS.filter((candidate) => candidate !== "benchmark-product-public-bundle/5")) {
      const assets = buildPublicAssets(await goldenInput(format));
      for (const [name, bytes] of Object.entries(assets)) {
        expect(decode(bytes), `${format} ${name}`).not.toContain("Task selection");
      }
    }
  });

  test("a stray top-level mode is not a declaration", async () => {
    // Only the verified claim section renders. A caller that passes the mode beside the claim gets
    // the page of a bundle that declared nothing.
    const plain = buildPublicAssets(await goldenInput(BUNDLE_V10_FORMAT));
    const stray = buildPublicAssets({
      ...(await goldenInput(BUNDLE_V10_FORMAT)),
      taskSelection: "claimant-chosen",
    } as unknown as PublicAssetInput);
    for (const [name, bytes] of Object.entries(plain)) expect(stray[name], name).toEqual(bytes);
  });
});
