// SPDX-License-Identifier: MIT

/**
 * `yarn e2e:campaign` — run one miniature Policy Optimization campaign end to end.
 *
 * The campaign itself lives in `src/e2e/`, in TypeScript, alongside the test that asserts it.
 * Node cannot execute that directly (type stripping does not rewrite `.js` specifiers onto `.ts`
 * files), and the demo is deliberately absent from `dist/` — it drives the TEP conformance kit,
 * a devDependency, so shipping it would put an unresolvable import in the published tree. So this
 * script compiles it to a scratch directory first, exactly the way `build.mjs` compiles `dist/`,
 * and then runs it. No new dependency, and one command for the operator.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageRoot, ".e2e-build");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");

async function compile() {
  await rm(outDir, { recursive: true, force: true });
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, "-p", "tsconfig.e2e.json"], {
      cwd: packageRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`TypeScript build exited with ${code}`));
    });
  });
}

const argv = process.argv.slice(2);

await compile();
const { parseE2ECampaignArgs, runE2ECampaignCli, USAGE } = await import(
  pathToFileURL(join(outDir, "e2e", "run.js")).href
);

let options;
try {
  options = parseE2ECampaignArgs(argv);
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n`);
  console.error(USAGE);
  process.exit(2);
}

if (options === "help") {
  console.log(USAGE);
  process.exit(0);
}

process.exit(await runE2ECampaignCli(options));
