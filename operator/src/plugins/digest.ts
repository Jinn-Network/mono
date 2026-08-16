import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(root, path));
    if (st.isFile()) out.push(path);
  }
  return out;
}

export function digestDirectory(root: string): string {
  const hash = createHash('sha256');
  for (const file of walk(root)) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
