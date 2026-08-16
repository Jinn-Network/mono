// SPDX-License-Identifier: Apache-2.0

import { EnvironmentBuildRecipeV1Schema, type CommandSpec } from './contracts.js';

/**
 * Renders the complete, self-contained Buildx build plan. Source is fetched
 * directly by Git; the Docker build context contains only this Dockerfile.
 */
export function renderDockerfile(input: unknown): string {
  const recipe = EnvironmentBuildRecipeV1Schema.parse(input);
  const workspace = recipe.workspace;
  if (workspace !== '/testbed') throw new Error('environment workspace must be /testbed');
  const lines = [
    `FROM --platform=${recipe.platform} ${recipe.baseImage.reference}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*',
    `RUN git init ${workspace} && git -C ${workspace} remote add origin ${shellQuote(recipe.source.repoUrl)} && git -C ${workspace} fetch --depth=1 origin ${shellQuote(recipe.source.baseCommit)} && git -C ${workspace} checkout --detach ${shellQuote(recipe.source.baseCommit)}`,
    `WORKDIR ${workspace}`,
    ...renderEnvironment(recipe.environment),
    ...recipe.installCommands.map((command) => renderCommand(command, workspace)),
    ...recipe.smokeCommands.map((command) => renderCommand(command, workspace)),
    `RUN test \"$(git -C ${workspace} rev-parse HEAD)\" = ${shellQuote(recipe.source.baseCommit)}`,
    `RUN test -z \"$(git -C ${workspace} status --porcelain)\"`,
  ];
  return `${lines.join('\n')}\n`;
}

function renderEnvironment(environment: Record<string, string>): string[] {
  const entries = Object.entries(environment);
  if (entries.length === 0) return [];
  return [`ENV ${entries.map(([name, value]) => `${environmentName(name)}=${shellQuote(value)}`).join(' ')}`];
}

function renderCommand(command: CommandSpec, workspace: string): string {
  const cwd = command.cwd === undefined ? workspace : `${workspace}/${workspaceRelativePath(command.cwd)}`;
  const env = Object.entries(command.environment ?? {})
    .map(([name, value]) => `export ${environmentName(name)}=${shellQuote(value)}; `)
    .join('');
  return `RUN ${env}cd ${shellQuote(cwd)} && ${[command.bin, ...command.args].map(shellQuote).join(' ')}`;
}

function workspaceRelativePath(cwd: string): string {
  if (
    cwd.startsWith('/') || cwd.includes('\\') || cwd.includes('\0') ||
    cwd.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error(`command cwd must be a workspace-relative path: ${cwd}`);
  }
  return cwd;
}

function environmentName(name: string): string {
  if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  return name;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
