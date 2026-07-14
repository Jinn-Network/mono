// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runEnvironmentPublicationCli } from '../src/task-creator/environment/publish-cli.js';

export type EnvironmentPublicationCliArgs = {
  configPath: string;
  outputPath?: string;
};

export function parseEnvironmentPublicationCliArgs(argv: readonly string[]): EnvironmentPublicationCliArgs {
  let configPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error('usage: task-creator-environment-publish --config <strict-config.json> [--output <signed-environment.json>]');
    if (flag === '--config' && configPath === undefined) {
      configPath = value;
      continue;
    }
    if (flag === '--output' && outputPath === undefined) {
      outputPath = value;
      continue;
    }
    throw new Error('usage: task-creator-environment-publish --config <strict-config.json> [--output <signed-environment.json>]');
  }
  if (configPath === undefined) {
    throw new Error('usage: task-creator-environment-publish --config <strict-config.json> [--output <signed-environment.json>]');
  }
  return { configPath, ...(outputPath === undefined ? {} : { outputPath }) };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseEnvironmentPublicationCliArgs(argv);
  const text = await readFile(args.configPath, 'utf8');
  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(text);
  } catch {
    throw new Error('environment publication config must be valid JSON');
  }
  const result = await runEnvironmentPublicationCli({ rawConfig, environment: process.env, outputPath: args.outputPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
