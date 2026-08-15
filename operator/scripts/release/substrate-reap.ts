import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { workspacesRoot } from './substrate-paths';

export interface ReapOptions {
  substrateRoot?: string;
  maxAgeDays?: number;             // default 7
}

export interface ReapResult {
  reaped: string[];                // workspace dir names removed
  kept: string[];                  // workspace dir names retained
}

export async function reapWorkspaces(opts: ReapOptions = {}): Promise<ReapResult> {
  const maxAgeDays = opts.maxAgeDays ?? 7;
  const root = workspacesRoot(opts.substrateRoot);
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const reaped: string[] = [];
  const kept: string[] = [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { reaped, kept };
    }
    throw err;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const fullPath = path.join(root, ent.name);
    const createdMs = await workspaceCreatedMs(fullPath);
    if (createdMs < cutoffMs) {
      await fs.rm(fullPath, { recursive: true, force: true });
      reaped.push(ent.name);
    } else {
      kept.push(ent.name);
    }
  }

  return { reaped, kept };
}

/**
 * Resolve a workspace's creation time (ms epoch) for the age check.
 *
 * Prefer the `createdAt` recorded in the `.created-by` provenance file
 * written at workspace creation: a directory's own mtime does not update
 * when files in nested subdirectories change (notably on macOS), so a
 * live workspace can otherwise look stale and be reaped mid-run.
 *
 * Fall back to the directory mtime, with a warning, when `.created-by`
 * is missing or unparseable.
 */
async function workspaceCreatedMs(workspaceDir: string): Promise<number> {
  const createdByPath = path.join(workspaceDir, '.created-by');
  try {
    const raw = await fs.readFile(createdByPath, 'utf-8');
    const parsed = JSON.parse(raw) as { createdAt?: unknown };
    if (typeof parsed.createdAt === 'string') {
      const ms = Date.parse(parsed.createdAt);
      if (!Number.isNaN(ms)) return ms;
    }
    console.error(`reap: ${createdByPath} has no usable createdAt; falling back to dir mtime`);
  } catch {
    console.error(`reap: ${createdByPath} missing or unreadable; falling back to dir mtime`);
  }
  const stat = await fs.stat(workspaceDir);
  return stat.mtimeMs;
}

async function cliMain(): Promise<void> {
  const result = await reapWorkspaces();
  console.log(JSON.stringify(result, null, 2));
  if (result.reaped.length > 0) {
    console.error(`reaped ${result.reaped.length} workspace(s) older than 7 days`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
