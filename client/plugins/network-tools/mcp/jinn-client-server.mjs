#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

function envPath(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function absolutePath(path, base = process.cwd()) {
  return isAbsolute(path) ? path : resolve(base, path);
}

function launcherForServerPath(serverPath, cwd) {
  const args = serverPath.endsWith('.ts')
    ? ['--import', 'tsx', serverPath]
    : [serverPath];
  return { command: process.execPath, args, cwd };
}

function firstExistingServer(root) {
  const distServer = join(root, 'dist', 'mcp', 'server.js');
  if (existsSync(distServer)) return distServer;

  const sourceServer = join(root, 'src', 'mcp', 'server.ts');
  if (existsSync(sourceServer)) return sourceServer;

  return undefined;
}

export function resolveJinnClientMcpLauncher(env = process.env, root = pluginRoot) {
  const explicitServerPath =
    envPath('JINN_NETWORK_TOOLS_MCP_SERVER_PATH', env) ??
    envPath('JINN_CLIENT_MCP_SERVER_PATH', env);
  const explicitClientRoot =
    envPath('JINN_NETWORK_TOOLS_CLIENT_ROOT', env) ??
    envPath('JINN_CLIENT_ROOT', env);

  if (explicitServerPath) {
    const cwd = explicitClientRoot
      ? absolutePath(explicitClientRoot, root)
      : dirname(absolutePath(explicitServerPath, root));
    return launcherForServerPath(absolutePath(explicitServerPath, cwd), cwd);
  }

  const candidateRoots = [
    explicitClientRoot ? absolutePath(explicitClientRoot, root) : undefined,
    // Normal source/package layout: <client>/plugins/network-tools.
    resolve(root, '..', '..'),
    // Allow launching from an unpacked client root or a caller-provided cwd.
    absolutePath(envPath('PWD', env) ?? process.cwd(), root),
  ].filter(Boolean);

  for (const candidateRoot of candidateRoots) {
    const serverPath = firstExistingServer(candidateRoot);
    if (serverPath) return launcherForServerPath(serverPath, candidateRoot);
  }

  const searched = candidateRoots.join(', ');
  throw new Error(
    `Unable to find the Jinn client MCP server. Set JINN_NETWORK_TOOLS_MCP_SERVER_PATH or JINN_NETWORK_TOOLS_CLIENT_ROOT. Searched: ${searched}`,
  );
}

export function startJinnClientMcpServer(env = process.env, root = pluginRoot) {
  const launcher = resolveJinnClientMcpLauncher(env, root);
  const child = spawn(launcher.command, launcher.args, {
    cwd: launcher.cwd,
    env,
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardSigint = () => forwardSignal('SIGINT');
  const forwardSigterm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);

  child.on('exit', (code, signal) => {
    process.off('SIGINT', forwardSigint);
    process.off('SIGTERM', forwardSigterm);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on('error', (err) => {
    console.error(`[network-tools] Failed to launch Jinn client MCP server: ${err.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startJinnClientMcpServer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[network-tools] ${message}`);
    process.exit(1);
  }
}
