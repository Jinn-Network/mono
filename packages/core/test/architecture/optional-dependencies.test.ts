import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tsFiles } from './import-scan.js';

/**
 * Optional dependencies of core (#5395).
 *
 * `@lmoe/gliner-onnx` 0.1.0 reaches `onnxruntime-node` 1.21.0 through
 * `@huggingface/transformers` 3. On Linux x64 that version's postinstall
 * downloads optional CUDA files and fails on any non-200 response. As a
 * required dependency it failed every stock `npm install` of core while that
 * download returned 404. As an optional dependency, npm drops it when its
 * install fails and the install of core succeeds; the GLiNER detector then
 * reports the runtime as unavailable and `maybeBuildPiiDetector` fails closed
 * at publish time.
 *
 * That only holds while core never loads an optional dependency eagerly: a
 * static import of a package npm dropped would fail core at load time.
 */
const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));

/** `@scope/name/deep/path.js` → `@scope/name`; `pkg/deep` → `pkg`. */
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Specifiers of the static imports and re-exports that remain at runtime. */
function staticRuntimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest);
  const specs: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      specs.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined
    ) {
      specs.push((statement.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return specs;
}

describe('core optional dependencies (#5395)', () => {
  it('declares the GLiNER ONNX runtime as optional, not required', () => {
    expect(pkg.dependencies?.['@lmoe/gliner-onnx']).toBeUndefined();
    expect(pkg.optionalDependencies?.['@lmoe/gliner-onnx']).toBeDefined();
  });

  it('loads every optional dependency through a dynamic import only', () => {
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    const offenders: string[] = [];
    for (const file of tsFiles(join(pkgRoot, 'src'))) {
      for (const spec of staticRuntimeSpecifiers(file)) {
        if (optional.has(packageName(spec))) {
          offenders.push(`${file.slice(pkgRoot.length)}: static import of '${spec}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
