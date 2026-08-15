#!/usr/bin/env node

/**
 * Generates (default) or `--check`s (drift-detects) `parity-matrix.v1.json` at the package root
 * (BP-14, deliverable 1): a machine-readable capability-parity matrix between the operations
 * facade and the CLI verb registry — `{ schemaVersion, generatedFrom, entries: [{ operation,
 * cliVerb, authorityGated, description }], exclusions: [{ name, reason }] }`.
 *
 * Introspects the BUILT package (`dist/` — run `yarn build` first): the operations facade's own
 * exports (`dist/operations/index.js`), the CLI's own verb registry (`CLI_VERB_NAMES`,
 * `dist/cli/main.js`), and the authority module's own `GATED_OPERATIONS`
 * (`dist/authority/policy.js`) — the three facts that must never drift silently. The
 * operation<->verb / operation<->action / operation<->description association tables come from
 * `dist/cli/parity-map.js`, the SAME module `../src/cli/parity.test.ts` and
 * `../src/cli/parity-matrix.test.ts` import from `src/` — one table, never two hand-typed copies.
 * The actual document-shaping logic lives in `dist/cli/parity-matrix.js`'s
 * `buildParityMatrixDocument`, the exact function `../src/cli/parity-matrix.test.ts` also calls
 * (against `src/`, no build needed) — so this script and that test can never disagree about what
 * the document should look like, only about which build (dist vs. src) they read the live facts
 * from.
 *
 * `authorityGated` is never a hand-typed boolean here: `buildParityMatrixDocument` derives it by
 * checking each operation's action string against the live `GATED_OPERATIONS` set.
 *
 * Usage:
 *   node scripts/generate-parity-matrix.mjs            # (re)writes parity-matrix.v1.json
 *   node scripts/generate-parity-matrix.mjs --check     # exit 1 if the committed file is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");
const outputPath = join(packageRoot, "parity-matrix.v1.json");

function importDist(relativePath) {
  return import(pathToFileURL(join(distDir, relativePath)).href);
}

async function loadBuiltModules() {
  try {
    return await Promise.all([
      importDist("operations/index.js"),
      importDist("cli/main.js"),
      importDist("authority/policy.js"),
      importDist("cli/parity-map.js"),
      importDist("cli/parity-matrix.js"),
    ]);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`cannot import the built package from ${distDir} — run "yarn build" first.\n${detail}`);
  }
}

async function main() {
  const check = process.argv.includes("--check");

  const [operationsModule, mainModule, policyModule, parityMapModule, parityMatrixModule] = await loadBuiltModules();

  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

  const document = parityMatrixModule.buildParityMatrixDocument({
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    operationsModule,
    cliVerbNames: mainModule.CLI_VERB_NAMES,
    gatedOperations: policyModule.GATED_OPERATIONS,
    operationToVerb: parityMapModule.OPERATION_TO_VERB,
    operationToAction: parityMapModule.OPERATION_TO_ACTION,
    operationToDescription: parityMapModule.OPERATION_TO_DESCRIPTION,
    operationToGui: parityMapModule.OPERATION_TO_GUI,
    excludedFacadeExports: parityMapModule.EXCLUDED_FACADE_EXPORTS,
    standaloneCliVerbs: parityMapModule.STANDALONE_CLI_VERBS,
    facadeOperationNames: parityMapModule.facadeOperationNames,
  });
  const rendered = parityMatrixModule.renderParityMatrixDocument(document);

  if (check) {
    let committed;
    try {
      committed = readFileSync(outputPath, "utf8");
    } catch {
      console.error(`generate-parity-matrix --check: ${outputPath} does not exist — run "yarn generate:parity" first.`);
      process.exitCode = 1;
      return;
    }
    if (committed !== rendered) {
      console.error(
        `generate-parity-matrix --check: parity-matrix.v1.json is stale relative to the built operations facade, `
          + `CLI verb registry, or parity-map.ts. Run "yarn generate:parity" and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("generate-parity-matrix --check: parity-matrix.v1.json is up to date.");
    return;
  }

  writeFileSync(outputPath, rendered);
  console.log(
    `generate-parity-matrix: wrote ${outputPath} (${document.entries.length} entries, ${document.exclusions.length} exclusions).`,
  );
}

await main();
