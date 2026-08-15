import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

function fallbackCandidateFiles(repoRoot, current = repoRoot, prefix = '') {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => (
    left.name.localeCompare(right.name)
  ))) {
    if (entry.name === '.git') continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...fallbackCandidateFiles(repoRoot, absolute, relativePath));
    else files.push(relativePath);
  }
  return files;
}

export function repositoryCandidateFiles(repoRoot, { runGit } = {}) {
  const root = resolve(repoRoot);
  const invokeGit = runGit ?? ((args) => execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let files;
  try {
    const output = invokeGit([
      '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ]);
    files = String(output).split('\0').filter(Boolean);
  } catch (error) {
    if (existsSync(resolve(root, '.git'))) {
      throw new Error(`cannot enumerate repository candidates with git: ${error.message}`);
    }
    files = fallbackCandidateFiles(root);
  }
  return [...new Set(files.map((path) => path.split('\\').join('/')))].sort();
}

export function repositoryCandidateInventory(repoRoot, { candidateFiles, runGit } = {}) {
  const files = [...new Set(
    (candidateFiles ?? repositoryCandidateFiles(repoRoot, { runGit }))
      .map((path) => path.split('\\').join('/')),
  )].sort();
  const fileSet = new Set(files);
  const directories = new Set();
  for (const path of files) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  return { files, fileSet, directories };
}
