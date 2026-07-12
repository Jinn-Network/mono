/**
 * run-entry.ts — ESM replacement for the CommonJS `require.main === module`
 * idiom under Hardhat 3 (nodenext).
 *
 * Under Hardhat 3, `hardhat run scripts/x.ts` imports the script module via
 * `import(pathToFileURL(script))`, executing its top-level code; there is no
 * `require.main`/`module` binding. Scripts that are ALSO imported by the test
 * suite (e.g. `deploy-task-coordinator-router-v3`, `deploy-stolas-l2`) must not
 * run their `main()` on import — only when invoked directly via `hardhat run`.
 *
 * `isRunEntry(import.meta.url)` returns true exactly when the calling module is
 * the script `hardhat run` was pointed at: it scans `process.argv` for a
 * non-flag argument whose resolved `file://` URL equals the caller's
 * `import.meta.url`. When a test imports the module instead, no argv entry
 * matches and it returns false.
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function isRunEntry(moduleUrl: string): boolean {
  return process.argv.slice(2).some((arg) => {
    if (arg.startsWith("-")) {
      return false;
    }
    try {
      return pathToFileURL(resolve(process.cwd(), arg)).href === moduleUrl;
    } catch {
      return false;
    }
  });
}
