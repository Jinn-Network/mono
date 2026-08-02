import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

export type NativeBoundaryViolationKind =
  | 'bridge-delivery-extension'
  | 'compatibility-runtime-edge'
  | 'ephemeral-discovery-key'
  | 'genesis-archive-rescan'
  | 'legacy-card-fallback'
  | 'legacy-document-synthesis'
  | 'multiple-venue-owners'
  | 'permissive-capability-fallback'
  | 'relative-import-escapes-source-root'
  | 'throwing-native-gap-port'
  | 'unresolved-relative-import';

export interface NativeBoundaryViolation {
  readonly kind: NativeBoundaryViolationKind;
  readonly file: string;
  readonly detail: string;
}

export interface NativeProductBoundaryResult {
  readonly files: readonly string[];
  readonly violations: readonly NativeBoundaryViolation[];
}

const COMPATIBILITY_EDGE = /(?:^|\/)(?:bridge(?:\/|[-_])|bridge-legacy-delivery(?:\.[^/]*)?$|composition-root(?:\.[^/]*)?$|daemon(?:\.[^/]*)?$|delivery-watcher(?:\.[^/]*)?$|legacy-task(?:\.[^/]*)?$|task-document(?:\.[^/]*)?$|task-engine(?:\.[^/]*)?$|watcher(?:\.[^/]*)?$)/iu;

const SOURCE_PATTERNS: readonly {
  readonly kind: NativeBoundaryViolationKind;
  readonly pattern: RegExp;
  readonly detail: string;
}[] = [
  {
    kind: 'legacy-card-fallback',
    pattern: /\bacceptLegacyCards\s*:\s*true\b/u,
    detail: 'native graph enables legacy cards',
  },
  {
    kind: 'permissive-capability-fallback',
    pattern: /\bcapabilityMatch\s*[:=]\s*async\s*\([^)]*\)\s*=>\s*\(\s*\{\s*ok\s*:\s*true\b/su,
    detail: 'native graph installs the permissive capability fallback',
  },
  {
    kind: 'genesis-archive-rescan',
    pattern: /\barchive\s*\.\s*since\s*\(\s*(['"])\s*\1\s*\)/u,
    detail: 'native graph rescans the archive from an empty cursor',
  },
  {
    kind: 'ephemeral-discovery-key',
    pattern: /ephemeral-discovery-key/u,
    detail: 'native graph contains the ephemeral discovery identity marker',
  },
  {
    kind: 'legacy-document-synthesis',
    pattern: /\bsynthesizeLegacyExecutionDocuments\b/u,
    detail: 'native graph synthesizes bridge-era Task or Submission records',
  },
  {
    kind: 'bridge-delivery-extension',
    pattern: /\b(?:deliveryExtensions|legacyRestorationResultFromDelivery|hasLegacyDeliveryExtension)\b/u,
    detail: 'native graph installs or reads a bridge Delivery extension',
  },
];

function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  if (clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.length === 0
    || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportClauseHasRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) return true;
  return node.exportClause.elements.length === 0
    || node.exportClause.elements.some((element) => !element.isTypeOnly);
}

/** Extracts only runtime static/re-export and literal dynamic relative-import edges. */
export function runtimeRelativeImports(source: string, fileName = 'module.ts'): string[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const add = (value: string): void => {
    if (isRelative(value) && !found.includes(value)) found.push(value);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && importClauseHasRuntimeValue(node.importClause)) {
      add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text);
    } else if (ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && exportClauseHasRuntimeValue(node)) {
      add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]!)) {
      add(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function moduleCandidates(from: string, specifier: string): string[] {
  const raw = resolve(dirname(from), specifier);
  const extension = extname(raw);
  const candidates = extension === '.js'
    ? [raw.slice(0, -3) + '.ts', raw.slice(0, -3) + '.tsx', raw]
    : extension === '.mjs'
      ? [raw.slice(0, -4) + '.mts', raw.slice(0, -4) + '.ts', raw]
      : extension === '.cjs'
        ? [raw.slice(0, -4) + '.cts', raw.slice(0, -4) + '.ts', raw]
        : extension.length > 0
          ? [raw]
          : [raw, `${raw}.ts`, `${raw}.tsx`, resolve(raw, 'index.ts'), resolve(raw, 'index.tsx')];
  return [...new Set(candidates)];
}

function resolveRelativeModule(sourceRoot: string, from: string, specifier: string): {
  readonly resolved?: string;
  readonly escaped: boolean;
} {
  const candidates = moduleCandidates(from, specifier);
  const escaped = candidates.every((candidate) => !inside(sourceRoot, candidate));
  if (escaped) return { escaped: true };
  const resolved = candidates.find((candidate) => inside(sourceRoot, candidate)
    && existsSync(candidate) && statSync(candidate).isFile());
  return resolved === undefined ? { escaped: false } : { resolved, escaped: false };
}

function hasThrow(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (ts.isThrowStatement(candidate)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function nodeName(node: ts.Node): string | undefined {
  if ('name' in node) {
    const name = (node as { readonly name?: ts.Node }).name;
    if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) return name.text;
  }
  return undefined;
}

function throwingGapPorts(parsed: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      && /gap/iu.test(nodeName(node) ?? '') && hasThrow(node)) {
      found.push(nodeName(node)!);
    } else if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && /gap/iu.test(node.name.text)
      && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      && hasThrow(node.initializer)) {
      found.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function venueOwnerSites(parsed: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && /^(?:create|open)BaseVenue$/u.test(node.expression.text)) {
      found.push(`${node.expression.text}@${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === 'BaseVenue') {
      found.push(`new BaseVenue@${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function violationsForSource(file: string, source: string): {
  readonly violations: NativeBoundaryViolation[];
  readonly venueOwners: string[];
} {
  const violations = SOURCE_PATTERNS.flatMap(({ kind, pattern, detail }) => pattern.test(source)
    ? [{ kind, file, detail } satisfies NativeBoundaryViolation]
    : []);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const name of throwingGapPorts(parsed)) {
    violations.push({ kind: 'throwing-native-gap-port', file, detail: `${name} throws` });
  }
  return { violations, venueOwners: venueOwnerSites(parsed) };
}

/** Recursively inspects the actual runtime-reachable native product source graph. */
export function inspectNativeProductBoundary(input: {
  readonly sourceRoot: string;
  readonly entries: readonly string[];
}): NativeProductBoundaryResult {
  const sourceRoot = resolve(input.sourceRoot);
  const pending = input.entries.map((entry) => resolve(entry));
  const files = new Set<string>();
  const violations: NativeBoundaryViolation[] = [];
  const venueOwners: Array<{ readonly file: string; readonly site: string }> = [];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    if (!inside(sourceRoot, file)) {
      violations.push({
        kind: 'relative-import-escapes-source-root', file,
        detail: `entry is outside ${sourceRoot}`,
      });
      continue;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      violations.push({ kind: 'unresolved-relative-import', file, detail: 'entry does not resolve' });
      continue;
    }
    files.add(file);
    const source = readFileSync(file, 'utf8');
    const local = violationsForSource(file, source);
    violations.push(...local.violations);
    venueOwners.push(...local.venueOwners.map((site) => ({ file, site })));

    for (const specifier of runtimeRelativeImports(source, file)) {
      if (COMPATIBILITY_EDGE.test(specifier.replaceAll('\\', '/'))) {
        violations.push({
          kind: 'compatibility-runtime-edge', file,
          detail: `native runtime imports ${specifier}`,
        });
      }
      const next = resolveRelativeModule(sourceRoot, file, specifier);
      if (next.escaped) {
        violations.push({
          kind: 'relative-import-escapes-source-root', file,
          detail: `${specifier} escapes ${sourceRoot}`,
        });
      } else if (next.resolved === undefined) {
        violations.push({
          kind: 'unresolved-relative-import', file,
          detail: `${specifier} does not resolve`,
        });
      } else {
        pending.push(next.resolved);
      }
    }
  }

  if (venueOwners.length > 1) {
    const first = venueOwners[0]!;
    violations.push({
      kind: 'multiple-venue-owners',
      file: first.file,
      detail: venueOwners.map(({ file, site }) => `${relative(sourceRoot, file)}:${site}`).join(', '),
    });
  }

  return {
    files: [...files].sort(),
    violations: violations.sort((left, right) =>
      `${left.file}\0${left.kind}\0${left.detail}`.localeCompare(`${right.file}\0${right.kind}\0${right.detail}`)),
  };
}
