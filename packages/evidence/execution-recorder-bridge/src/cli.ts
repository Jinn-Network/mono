// SPDX-License-Identifier: Apache-2.0

import { createFilesystemEvidenceRepository } from "@jinn-network/evidence-repository/fs";

import { toRecorderBridgeErrorPayload } from "./errors.js";
import { serveExecutionRecorderBridge } from "./server.js";

const USAGE = "Usage: jinn-execution-recorder-bridge --repository-root <path>\n";

function parseRepositoryRoot(args: readonly string[]): string | undefined {
  let repositoryRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--repository-root") return undefined;
    if (repositoryRoot !== undefined) return undefined;
    const value = args[index + 1];
    if (value === undefined) return undefined;
    repositoryRoot = value;
    index += 1;
  }
  return repositoryRoot;
}

/**
 * Filesystem Repository startup composition and command-line validation for
 * the published `jinn-execution-recorder-bridge` executable. Never writes a
 * raw dependency error message (which may embed a local path) to standard
 * error — startup failures are sanitized the same way dispatch errors are.
 */
export async function runExecutionRecorderBridgeCli(options: {
  readonly args: readonly string[];
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly error: NodeJS.WritableStream;
}): Promise<number> {
  const repositoryRoot = parseRepositoryRoot(options.args);
  if (repositoryRoot === undefined) {
    options.error.write(USAGE);
    return 2;
  }

  let repository;
  try {
    repository = await createFilesystemEvidenceRepository({
      rootDir: repositoryRoot,
    });
  } catch (error) {
    const payload = toRecorderBridgeErrorPayload(error);
    options.error.write(`${payload.message}\n`);
    return 1;
  }

  await serveExecutionRecorderBridge({
    repository,
    input: options.input,
    output: options.output,
  });
  return 0;
}
