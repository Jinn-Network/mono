import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { goldPath, workspacePath, generateRunId } from './substrate-paths';

export interface CopyWorkspaceOptions {
  ops: string[];                    // names of gold ops to include
  substrateRoot?: string;
  runId?: string;                   // override the generated run-id
}

export interface WorkspaceHandle {
  runId: string;
  workspaceRoot: string;            // ~/jinn-dev/workspaces/<run-id>/
  opPaths: Record<string, string>;  // opName → ~/jinn-dev/workspaces/<run-id>/<opName>/
  teardown: () => Promise<void>;
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      await copyDir(s, d);
    } else if (ent.isFile()) {
      await fs.copyFile(s, d);
      const stat = await fs.stat(s);
      await fs.chmod(d, stat.mode);
    }
  }
}

export async function copyWorkspace(opts: CopyWorkspaceOptions): Promise<WorkspaceHandle> {
  const runId = opts.runId ?? generateRunId();
  const opPaths: Record<string, string> = {};

  // Validate every requested op exists in gold first
  for (const opName of opts.ops) {
    const src = goldPath(opName, opts.substrateRoot);
    try {
      await fs.access(src);
    } catch {
      throw new Error(`gold operator ${opName} not found at ${src}`);
    }
  }

  // Copy each op
  for (const opName of opts.ops) {
    const src = goldPath(opName, opts.substrateRoot);
    const dst = workspacePath(runId, opName, opts.substrateRoot);
    await copyDir(src, dst);
    opPaths[opName] = dst;
  }

  const workspaceRoot = path.dirname(opPaths[opts.ops[0]]);

  // Tag the workspace with provenance
  await fs.writeFile(
    path.join(workspaceRoot, '.created-by'),
    JSON.stringify({ runId, createdAt: new Date().toISOString(), ops: opts.ops }, null, 2) + '\n',
  );

  return {
    runId,
    workspaceRoot,
    opPaths,
    teardown: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: substrate-copy <op-name> [<op-name> ...]');
    process.exit(2);
  }
  const handle = await copyWorkspace({ ops: args });
  console.log(JSON.stringify({ runId: handle.runId, workspaceRoot: handle.workspaceRoot, opPaths: handle.opPaths }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
