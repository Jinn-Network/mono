// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #5418: a malformed disclosure-specification extension on a disclosed bundle's Report.
 *
 * A bundle whose closure carries a disclosure record (`/8`, or `/10` declaring
 * `disclosure-specification`) reads the Report's disclosure-specification extension to find that
 * record. `ReportRecordSchema` admits any value at an extension key, so a value the extension's own
 * schema refuses must end in a worded `record-integrity` refusal, not in the schema's thrown issue
 * list, which the reader tool would print as an environment failure.
 *
 * Each bundle is the characterization suite's operator-only `/4` bundle, sealed the way its other
 * variants are: `report.json` edited, `static-bundle.json` re-derived from it, and the manifest
 * re-sealed under the disclosed format. What the reader refuses is therefore the extension, not a
 * stale digest. A bundle carrying no extension at all is the control: it reaches the same block and
 * meets its existing refusal.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { exportStaticBundle } from "@jinn-network/benchmarking-interop";
import { DISCLOSURE_SPECIFICATION_EXTENSION, parseMatrix, parseReport } from "@jinn-network/benchmarking-records";
import { BINARY_QUALIFICATION_CAPABILITY, DISCLOSURE_SPECIFICATION_CAPABILITY } from "./capabilities.js";
import { operatorOnlyBundle } from "./characterization/testing/binary-admission-bundles.js";
import { memberPaths, readJson, writeCanonical } from "./characterization/testing/golden-variants.js";
import { runVerifierCli } from "./cli.js";
import { BUNDLE_V10_FORMAT, BUNDLE_V8_FORMAT, buildBundleManifest } from "./manifest.js";
import { BenchmarkProductError } from "./profile/errors.js";
import { verifyPublicBundle } from "./verify.js";

const MALFORMED_REFUSAL = `report.json carries ${DISCLOSURE_SPECIFICATION_EXTENSION}, but its value is not a resource`
  + " descriptor with a fingerprint of 64 lowercase hex digits";

const DISCLOSED_FORMATS = [
  { name: BUNDLE_V8_FORMAT, manifest: { format: BUNDLE_V8_FORMAT }, label: BUNDLE_V8_FORMAT },
  {
    name: `${BUNDLE_V10_FORMAT} declaring ${DISCLOSURE_SPECIFICATION_CAPABILITY}`,
    manifest: {
      format: BUNDLE_V10_FORMAT,
      capabilities: [BINARY_QUALIFICATION_CAPABILITY, DISCLOSURE_SPECIFICATION_CAPABILITY],
    },
    label: `${BUNDLE_V10_FORMAT} "${DISCLOSURE_SPECIFICATION_CAPABILITY}"`,
  },
] as const;

type DisclosedFormat = (typeof DISCLOSED_FORMATS)[number];

/** A disclosed bundle whose Report carries `extension` at the disclosure-specification key, or no
 * value there at all when it is `undefined`. */
function disclosedBundle(format: DisclosedFormat, extension: unknown): string {
  const bundleDir = operatorOnlyBundle();
  const report = readJson(bundleDir, "report.json");
  if (extension === undefined) delete report[DISCLOSURE_SPECIFICATION_EXTENSION];
  else report[DISCLOSURE_SPECIFICATION_EXTENSION] = extension;
  writeCanonical(bundleDir, "report.json", report);
  writeCanonical(bundleDir, "static-bundle.json", exportStaticBundle(
    parseMatrix(new Uint8Array(readFileSync(join(bundleDir, "matrix.json")))),
    [parseReport(new Uint8Array(readFileSync(join(bundleDir, "report.json"))))],
  ));
  writeFileSync(join(bundleDir, "bundle.json"), buildBundleManifest(bundleDir, memberPaths(bundleDir), format.manifest).bytes);
  return bundleDir;
}

async function refusalOf(bundleDir: string): Promise<BenchmarkProductError> {
  let raised: unknown;
  let threw = false;
  try {
    await verifyPublicBundle(bundleDir);
  } catch (cause) {
    threw = true;
    raised = cause;
  }
  expect(threw, "expected a refusal").toBe(true);
  expect(raised).toBeInstanceOf(BenchmarkProductError);
  return raised as BenchmarkProductError;
}

describe.each(DISCLOSED_FORMATS)("a $name bundle's Report disclosure-specification extension", (format) => {
  test("absent: the bundle reaches the extension and is refused for lacking it", async () => {
    const refused = await refusalOf(disclosedBundle(format, undefined));
    expect(refused.code).toBe("record-integrity");
    expect(refused.issues).toEqual([{
      path: "disclosure-specification",
      message: `a ${format.label} bundle must carry ${DISCLOSURE_SPECIFICATION_EXTENSION} on its Report`,
    }]);
  });

  test.each([
    ["a fingerprint that is not hex", { digest: { sha256: "not-hex" } }],
    ["a descriptor with no fingerprint", { uri: "https://example.invalid/disclosure" }],
    ["a bare string", "a".repeat(64)],
    ["null", null],
  ])("malformed (%s): refused as record-integrity in one worded line", async (_name, extension) => {
    const bundleDir = disclosedBundle(format, extension);
    const refused = await refusalOf(bundleDir);
    expect(refused.code).toBe("record-integrity");
    expect(refused.issues).toEqual([{ path: "report.json", message: MALFORMED_REFUSAL }]);

    // The reader tool: a refusal of the bundle (exit 1), not an environment failure (exit 2).
    const json = await runVerifierCli([bundleDir, "--json"]);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, code: "record-integrity", message: MALFORMED_REFUSAL });
    const human = await runVerifierCli([bundleDir]);
    expect(human.exitCode).toBe(1);
    expect(human.stdout).toBe("");
    // One line, the protocol identifier aliased as on every human refusal line.
    expect(human.stderr).toBe("colophon-check: report.json carries <identifier: see --json>, but its value is not a"
      + " resource descriptor with a fingerprint of 64 lowercase hex digits\n");
  });
});
