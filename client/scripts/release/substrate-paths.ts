import * as path from 'node:path';
import * as os from 'node:os';

export function defaultSubstrateRoot(): string {
  return path.join(process.env.HOME || os.homedir(), 'jinn-dev');
}

export function goldPath(opName: string, substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(substrateRoot, 'operators', opName);
}

export function workspacesRoot(substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(substrateRoot, 'workspaces');
}

export function workspacePath(runId: string, opName: string, substrateRoot: string = defaultSubstrateRoot()): string {
  return path.join(workspacesRoot(substrateRoot), runId, opName);
}

export function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}
