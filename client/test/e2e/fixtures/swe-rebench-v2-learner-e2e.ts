import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSolverNets, type JoinedSolverNetConfig } from '../../../src/solver-nets/registry.js';

export const E2E_SWE_JOINED: Record<string, JoinedSolverNetConfig> = {
  'bafy-e2e-swe-learner-full-cycle': {
    manifestCid: 'bafy-e2e-swe-learner-full-cycle',
    name: 'SWE-rebench v2',
    contract: { id: 'swe-rebench-v2', version: 'v1' },
    roles: ['solver'],
  },
};

export async function resolveSweLearnerPluginRoots(): Promise<{
  roots: string[];
  names: string[];
}> {
  const registry = await loadSolverNets({ joinedSolverNets: E2E_SWE_JOINED });
  const net = registry.forSolverType('swe-rebench-v2.v1', 'restoration');
  if (!net) {
    throw new Error('E2E fixture: no restoration SolverNet for swe-rebench-v2.v1');
  }
  const names = net.runtimePlugins.map((p) => p.name);
  const roots = net.runtimePlugins.map((p) => p.root);
  return { roots, names };
}

/** Offline git repo at `workingDir/repo` — no clone, network, or Docker. */
export function seedWorkingRepo(workingDir: string): { baseCommit: string } {
  const repoDir = join(workingDir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' });
  writeFileSync(join(repoDir, 'README.md'), '# e2e base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, encoding: 'utf8' });
  execFileSync('git', ['-c', 'user.email=e2e@jinn.network', '-c', 'user.name=Jinn E2E', 'commit', '-m', 'e2e base'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  return { baseCommit };
}
