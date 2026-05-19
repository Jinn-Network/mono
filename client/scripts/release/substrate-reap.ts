import * as fs from 'node:fs/promises';
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

  let entries: Awaited<ReturnType<typeof fs.readdir>>;
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
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < cutoffMs) {
      await fs.rm(fullPath, { recursive: true, force: true });
      reaped.push(ent.name);
    } else {
      kept.push(ent.name);
    }
  }

  return { reaped, kept };
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
