#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { main, readConfigEnvFromProcess } from "./bin.js";
import { resolveCorpusBinIoFields } from "./session-host-corpus.js";
import { loadOrCreateLocalCaptureSigner } from "./session-host-signer.js";

/** True when this module is the process entry point rather than an imported module. */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isProcessEntry()) {
  const untilShutdown = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const finish = (): void => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        clearInterval(keepAlive);
        resolve();
      };
      const keepAlive = setInterval(() => {}, 2 ** 30);
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });

  const homeDirectory = process.env.JINN_PLUGIN_HOME ?? join(homedir(), ".jinn-plugin");
  const captureSigner = await loadOrCreateLocalCaptureSigner(homeDirectory);

  const env = readConfigEnvFromProcess();

  process.exitCode = await main(["serve", "--role", "session"], env, {
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
    homeDirectory,
    untilShutdown,
    captureSigner,
    // Same composition root as `bin.ts`: a session host mirrors the public
    // corpus under the same posture a tools host does.
    ...resolveCorpusBinIoFields({ env, homeDirectory }),
  });
}
