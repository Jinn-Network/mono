#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveRuntimeConfig } from "./config.js";
import { PluginRuntimeError } from "./errors.js";
import { createLineLogger } from "./logger.js";
import { createPluginRuntime } from "./runtime.js";
import { RUNTIME_VERSION } from "./version.js";

const USAGE = [
  "usage: jinn-plugin-runtime [serve|health]",
  "",
  "  serve    run the runtime until SIGINT or SIGTERM (default)",
  "  health   print one JSON health report and exit",
  "",
  "  --help     print this message",
  "  --version  print the runtime version",
  "",
  "Environment: JINN_PLUGIN_HOME, JINN_PLUGIN_LOG_LEVEL",
].join("\n");

/**
 * Everything the entry point is allowed to touch, injected so tests drive it without a
 * real process, real streams, or real signals.
 */
export interface BinIo {
  /** Reserved for protocol output. Diagnostics never go here. */
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
  /** The default home directory when neither the file nor the environment names one. */
  readonly homeDirectory: string;
  /** Resolves when the process should shut down. */
  readonly untilShutdown: () => Promise<void>;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: BinIo,
): Promise<number> {
  const [command = "serve"] = argv;

  if (command === "--help" || command === "-h") {
    io.writeErr(USAGE);
    return 0;
  }
  if (command === "--version") {
    io.writeOut(RUNTIME_VERSION);
    return 0;
  }
  if (command !== "serve" && command !== "health") {
    io.writeErr(`unknown command: ${command}`);
    io.writeErr(USAGE);
    return 2;
  }

  let config;
  try {
    config = resolveRuntimeConfig({ env, homeDirectory: io.homeDirectory });
  } catch (error) {
    io.writeErr(
      error instanceof PluginRuntimeError ? error.message : `configuration failed: ${String(error)}`,
    );
    return 2;
  }

  const log = createLineLogger(config.logLevel, io.writeErr);
  log.info("configuration resolved", {
    home: config.homeDirectory,
    archive: config.archiveDirectory,
  });

  // No capabilities are wired yet; C4 onward register them here.
  const runtime = createPluginRuntime({ config, capabilities: [], log });

  // Register signal handlers before the first await so the process stays alive under
  // top-level await while serve waits for shutdown.
  const shutdown = command === "serve" ? io.untilShutdown() : null;

  if (command === "health") {
    await runtime.start();
    const report = await runtime.health();
    await runtime.stop();
    io.writeOut(JSON.stringify(report));
    return report.ok ? 0 : 1;
  }

  await runtime.start();
  log.info("runtime listening", { transport: "none" });
  await shutdown!;
  await runtime.stop();
  return 0;
}

/** True when this module is the process entry point rather than an imported module. */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
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

  process.exitCode = await main(process.argv.slice(2), process.env, {
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
    homeDirectory: process.env.JINN_PLUGIN_HOME ?? join(homedir(), ".jinn-plugin"),
    untilShutdown,
  });
}
