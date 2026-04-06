import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

if (!existsSync(distDir)) {
  process.exit(0);
}

const sharedImportRegex = /from (['"])\.\/shared\/([^'"]*)\1/g;
const doubleJsRegex = /\.js\.js/g;

function patchFile(filePath) {
  const original = readFileSync(filePath, 'utf8');
  let updated = original.replace(sharedImportRegex, "from $1./shared/$2.js$1");
  updated = updated.replace(doubleJsRegex, '.js');

  if (updated !== original) {
    writeFileSync(filePath, updated);
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      walk(fullPath);
    } else if (stats.isFile() && fullPath.endsWith('.js')) {
      patchFile(fullPath);
    }
  }
}

walk(distDir);
