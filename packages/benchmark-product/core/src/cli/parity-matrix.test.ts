/**
 * BP-14, deliverable 1: proves the committed `parity-matrix.v1.json` (package root) is exactly
 * what `scripts/generate-parity-matrix.mjs` would produce right now. This test calls the exact
 * same `buildParityMatrixDocument` (`./parity-matrix.ts`) the generator's own `main()` calls, fed
 * here with the LIVE `src/` values (the operations facade, `CLI_VERB_NAMES`, `GATED_OPERATIONS`,
 * and `./parity-map.ts`'s tables) that vitest resolves directly — no `dist/` build required, so
 * `yarn test` catches drift even before `yarn build` has ever run (see the package README's own
 * documented `typecheck` -> `test` -> `build` order). A drifted committed file — someone added or
 * renamed an operation, a verb, or an authority grant without re-running `yarn generate:parity` —
 * fails this test with a byte-diff-legible message.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { GATED_OPERATIONS } from "../authority/policy.js";
import * as operations from "../operations/index.js";
import { CLI_VERB_NAMES } from "./main.js";
import { buildParityMatrixDocument, renderParityMatrixDocument } from "./parity-matrix.js";
import {
  EXCLUDED_FACADE_EXPORTS,
  facadeOperationNames,
  OPERATION_TO_ACTION,
  OPERATION_TO_DESCRIPTION,
  OPERATION_TO_GUI,
  OPERATION_TO_VERB,
  STANDALONE_CLI_VERBS,
} from "./parity-map.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PackageJson {
  readonly name: string;
  readonly version: string;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

describe("parity-matrix.v1.json is generated (BP-14, deliverable 1)", () => {
  test("the committed artifact matches what generate-parity-matrix.mjs would produce right now", () => {
    const packageJson = readPackageJson();

    const document = buildParityMatrixDocument({
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      operationsModule: operations,
      cliVerbNames: CLI_VERB_NAMES,
      gatedOperations: GATED_OPERATIONS,
      operationToVerb: OPERATION_TO_VERB,
      operationToAction: OPERATION_TO_ACTION,
      operationToDescription: OPERATION_TO_DESCRIPTION,
      operationToGui: OPERATION_TO_GUI,
      excludedFacadeExports: EXCLUDED_FACADE_EXPORTS,
      standaloneCliVerbs: STANDALONE_CLI_VERBS,
      facadeOperationNames,
    });
    const rendered = renderParityMatrixDocument(document);

    let committed: string;
    try {
      committed = readFileSync(join(packageRoot, "parity-matrix.v1.json"), "utf8");
    } catch {
      throw new Error(
        "parity-matrix.v1.json does not exist at the package root — run `yarn generate:parity` (after `yarn build`) and commit the result",
      );
    }

    expect(
      committed,
      "parity-matrix.v1.json is stale relative to the operations facade / CLI verb registry / parity-map.ts — run `yarn generate:parity` (after `yarn build`) and commit the result",
    ).toBe(rendered);

    const gui = (JSON.parse(committed) as {
      entries: Array<{ operation: string; gui: { status: string; action?: string; deferredTo?: string } }>;
    }).entries;
    expect(gui.find((entry) => entry.operation === "initWorkspace")?.gui).toEqual({
      status: "shipped",
      action: "workspace.init",
    });
    expect(gui.find((entry) => entry.operation === "runLock")?.gui).toEqual({
      status: "shipped",
      action: "run.lock",
    });
    expect(gui.find((entry) => entry.operation === "runLaunch")?.gui).toEqual({
      status: "shipped",
      action: "run.launch",
    });
    expect(gui.find((entry) => entry.operation === "runResults")?.gui).toEqual({
      status: "shipped",
      action: "run.results",
    });
    expect(gui.find((entry) => entry.operation === "runReport")?.gui).toEqual({
      status: "shipped",
      action: "run.report",
    });
    expect(gui.find((entry) => entry.operation === "runVerify")?.gui).toEqual({
      status: "shipped",
      action: "run.verify",
    });
    expect(gui.filter((entry) => entry.gui.status === "deferred")).toEqual([]);
  });
});
