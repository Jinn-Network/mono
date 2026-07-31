import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { loadRuntimeTypeScript, relativeFromRoot } from './plugin-tree-guard-common.mjs';

const NETWORK_MODULES = [
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'undici',
];
const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'EventSource'];
const LOCALE_MEMBER_APIS = [
  'localeCompare',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
];
const PROCESS_SURFACES = new Set([
  'env', 'argv', 'stdin', 'stdout', 'stderr', 'exit', 'kill', 'chdir', 'cwd', 'title',
]);
const PROCESS_MODULE_SPECS = new Set(['node:process', 'process']);
const FORBIDDEN_FS_SPECS = new Set(['node:fs', 'fs']);
const FORBIDDEN_CHILD_PROCESS_SPECS = new Set(['node:child_process', 'child_process']);
const BIN_ALLOWED_FS = Object.freeze({
  module: 'node:fs',
  names: new Set(['realpathSync']),
});

const DYNAMIC_EVAL_NAMES = new Set(['eval', 'Function']);

function normalizeModuleSpecifier(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  const slash = specifier.indexOf('/');
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

function moduleRoot(specifier) {
  return normalizeModuleSpecifier(specifier);
}

function isNetworkModule(specifier) {
  const rootName = moduleRoot(specifier);
  return NETWORK_MODULES.some((name) =>
    rootName === name || rootName === `node:${name}` || specifier === name || specifier.startsWith(`${name}/`) || specifier.startsWith(`node:${name}/`));
}

function isForbiddenFs(specifier) {
  const rootName = moduleRoot(specifier);
  return FORBIDDEN_FS_SPECS.has(rootName) || FORBIDDEN_FS_SPECS.has(specifier)
    || specifier.startsWith('fs/') || specifier.startsWith('node:fs/');
}

function isForbiddenChildProcess(specifier) {
  const rootName = moduleRoot(specifier);
  return FORBIDDEN_CHILD_PROCESS_SPECS.has(rootName) || FORBIDDEN_CHILD_PROCESS_SPECS.has(specifier)
    || specifier.startsWith('child_process/') || specifier.startsWith('node:child_process/');
}

function isProcessModule(specifier) {
  const rootName = moduleRoot(specifier);
  return PROCESS_MODULE_SPECS.has(rootName) || PROCESS_MODULE_SPECS.has(specifier)
    || specifier.startsWith('node:process/') || specifier.startsWith('process/');
}

function insideForbiddenRoot(filePath, specifier, forbiddenRoots) {
  if (!specifier.startsWith('.')) return false;
  const resolved = resolve(dirname(filePath), specifier);
  return forbiddenRoots.some((forbiddenRoot) => {
    if (!existsSync(forbiddenRoot)) {
      const rel = relative(forbiddenRoot, resolved);
      return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
    }
    const rel = relative(forbiddenRoot, resolved);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
  });
}

function packageSpecifierMatches(specifier, forbidden) {
  if (forbidden.endsWith('*')) return specifier.startsWith(forbidden.slice(0, -1));
  if (forbidden.endsWith('/')) return specifier.startsWith(forbidden);
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function literalString(node, ts) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function bindingNameText(name, ts) {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

class AliasTable {
  constructor() {
    this.kinds = new Map();
  }

  clone() {
    const next = new AliasTable();
    next.kinds = new Map(this.kinds);
    return next;
  }

  set(name, kind) {
    if (name) this.kinds.set(name, kind);
  }

  get(name) {
    return this.kinds.get(name);
  }
}

function classifyRootIdentifier(name, aliases) {
  if (name === 'process') return 'process';
  if (name === 'globalThis' || name === 'global') return 'global';
  const alias = aliases.get(name);
  return alias ?? null;
}

function resolveAccessChain(expression, ts, aliases) {
  const parts = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
      continue;
    }
    const key = literalString(current.argumentExpression, ts);
    if (key === null) return { dynamic: true, parts: [] };
    parts.unshift(key);
    current = current.expression;
  }

  if (ts.isIdentifier(current)) {
    return { root: current.text, rootKind: classifyRootIdentifier(current.text, aliases), parts };
  }
  if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)) {
    const baseKind = classifyRootIdentifier(current.expression.text, aliases);
    if (baseKind === 'global' && current.name.text === 'process') {
      return { root: `${current.expression.text}.process`, rootKind: 'process', parts };
    }
  }
  return { unknown: true, parts: [] };
}

function isIntlAccess(chain) {
  if (chain.rootKind === 'intl') return true;
  if (chain.root === 'Intl' || chain.rootKind === 'global' && chain.parts[0] === 'Intl') return true;
  if (chain.rootKind === 'global' && chain.parts.length >= 1 && chain.parts[0] === 'Intl') return true;
  return chain.root === 'Intl' || (chain.rootKind === 'global' && chain.parts[0] === 'Intl');
}

function isLocaleMember(chain) {
  const member = chain.parts?.[chain.parts.length - 1];
  return member !== undefined && LOCALE_MEMBER_APIS.includes(member);
}

function isProcessSurface(chain) {
  if (chain.rootKind !== 'process') return false;
  const surface = chain.parts[0];
  return surface !== undefined && PROCESS_SURFACES.has(surface);
}

function isNetworkGlobal(chain) {
  if (!chain.parts) return false;
  const head = chain.parts[0] ?? chain.root;
  return head !== undefined && NETWORK_GLOBALS.includes(head);
}

function recordImportBindings(node, ts, aliases, moduleSpecifier) {
  if (!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node)) return;
  const clause = node.importClause;
  if (!clause) return;

  if (clause.name) {
    aliases.set(clause.name.text, moduleSpecifier === 'process' || moduleSpecifier === 'node:process'
      ? 'process'
      : moduleSpecifier === 'Intl' ? 'intl' : 'module');
  }

  if (!clause.namedBindings) return;

  if (ts.isNamespaceImport(clause.namedBindings)) {
    if (moduleSpecifier === 'process' || moduleSpecifier === 'node:process') {
      aliases.set(clause.namedBindings.name.text, 'process');
    } else if (moduleSpecifier === 'Intl') {
      aliases.set(clause.namedBindings.name.text, 'intl');
    }
    return;
  }

  if (!ts.isNamedImports(clause.namedBindings)) return;
  for (const element of clause.namedBindings.elements) {
    const imported = element.propertyName?.text ?? element.name.text;
    const local = element.name.text;
    if (moduleSpecifier === 'process' || moduleSpecifier === 'node:process') {
      if (PROCESS_SURFACES.has(imported) || imported === 'default') {
        aliases.set(local, 'process-member');
      }
    }
    if (moduleSpecifier === 'Intl' || imported === 'Intl') {
      aliases.set(local, 'intl');
    }
  }
}

function visitBindingPattern(pattern, sourceExpr, ts, aliases) {
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;
      const local = element.name.text;
      const property = element.propertyName ? bindingNameText(element.propertyName, ts) : local;
      if (sourceExpr === 'process' && property && PROCESS_SURFACES.has(property)) {
        aliases.set(local, 'process-member');
      }
      if (sourceExpr === 'global' && property === 'process') {
        aliases.set(local, 'process');
      }
    }
    return;
  }
  if (ts.isIdentifier(pattern) && sourceExpr === 'process') {
    aliases.set(pattern.text, 'process');
  }
}

function scanSourceFile(filePath, content, options) {
  const ts = loadRuntimeTypeScript();
  const {
    repoRoot,
    forbiddenPackages = [],
    forbiddenRoots = [],
    isBinEntry = false,
  } = options;
  const label = relativeFromRoot(filePath);
  const violations = [];
  const add = (detail) => violations.push(`${label} -> ${detail}`);

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const aliases = new AliasTable();

  function checkImportSpecifier(specifier, node, { allowBinFs = false } = {}) {
    if (specifier === null) {
      add('nonliteral dynamic import');
      return;
    }

    if (forbiddenPackages.some((forbidden) => packageSpecifierMatches(specifier, forbidden))) {
      add(specifier);
      return;
    }
    if (insideForbiddenRoot(filePath, specifier, forbiddenRoots)) {
      add(specifier);
      return;
    }
    if (isNetworkModule(specifier)) {
      add(`network module ${specifier}`);
      return;
    }
    if (isProcessModule(specifier) && !isBinEntry) {
      add(`import ${specifier}`);
      return;
    }
    if (isForbiddenChildProcess(specifier)) {
      add(specifier);
      return;
    }
    if (isForbiddenFs(specifier)) {
      if (allowBinFs && specifier === BIN_ALLOWED_FS.module && ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const invalid = !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)
          || clause.namedBindings.elements.length !== 1
          || clause.namedBindings.elements[0].name.text !== 'realpathSync'
          || (clause.namedBindings.elements[0].propertyName?.text ?? 'realpathSync') !== 'realpathSync';
        if (invalid) add(`forbidden fs import ${specifier}`);
        return;
      }
      add(specifier);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalString(node.moduleSpecifier, ts);
      checkImportSpecifier(specifier, node, { allowBinFs: isBinEntry });
      if (specifier) recordImportBindings(node, ts, aliases, moduleRoot(specifier));
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalString(node.moduleSpecifier, ts);
      checkImportSpecifier(specifier, node);
    }

    if (ts.isImportCall?.(node) || node.kind === ts.SyntaxKind.ImportCall) {
      const specifier = literalString(node.arguments?.[0], ts);
      checkImportSpecifier(specifier, node);
    }

    if (ts.isCallExpression(node)) {
      const calleeText = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (calleeText === 'require' || calleeText === 'import') {
        const specifier = node.arguments[0] ? literalString(node.arguments[0], ts) : null;
        checkImportSpecifier(specifier, node);
      }
      if (calleeText && DYNAMIC_EVAL_NAMES.has(calleeText)) {
        add(`dynamic evaluation ${calleeText}`);
      }
      const evalAlias = ts.isIdentifier(node.expression) ? aliases.get(node.expression.text) : null;
      if (evalAlias === 'eval' || evalAlias === 'Function') {
        add('dynamic evaluation alias');
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      add('dynamic evaluation Function');
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.initializer) && node.initializer.text === 'process') {
        const local = ts.isIdentifier(node.name) ? node.name.text : null;
        if (local) aliases.set(local, 'process');
      }
      if (ts.isIdentifier(node.initializer) && (node.initializer.text === 'globalThis' || node.initializer.text === 'global')) {
        const local = ts.isIdentifier(node.name) ? node.name.text : null;
        if (local) aliases.set(local, 'global');
      }
      if (ts.isPropertyAccessExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && (node.initializer.expression.text === 'globalThis' || node.initializer.expression.text === 'global')
        && node.initializer.name.text === 'process'
        && ts.isIdentifier(node.name)) {
        aliases.set(node.name.text, 'process');
      }
      if (ts.isIdentifier(node.initializer) && node.initializer.text === 'Intl' && ts.isIdentifier(node.name)) {
        aliases.set(node.name.text, 'intl');
      }
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer)) {
        const source = node.initializer.text === 'process' ? 'process'
          : (node.initializer.text === 'globalThis' || node.initializer.text === 'global') ? 'global'
            : node.initializer.text;
        visitBindingPattern(node.name, source, ts, aliases);
        if (aliases.get(node.initializer.text) === 'process') {
          visitBindingPattern(node.name, 'process', ts, aliases);
        }
      }
      if (ts.isObjectBindingPattern(node.name)
        && ts.isPropertyAccessExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && (node.initializer.expression.text === 'globalThis' || node.initializer.expression.text === 'global')
        && node.initializer.name.text === 'process') {
        visitBindingPattern(node.name, 'process', ts, aliases);
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const chain = resolveAccessChain(node, ts, aliases);
      if (chain.dynamic) {
        const expr = node.expression;
        const processRelated = (ts.isIdentifier(expr) && (classifyRootIdentifier(expr.text, aliases) === 'process' || aliases.get(expr.text) === 'process'))
          || (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)
            && (expr.expression.text === 'globalThis' || expr.expression.text === 'global')
            && expr.name.text === 'process');
        if (!isBinEntry && processRelated) {
          add('dynamic computed ambient access');
        }
      } else if (isProcessSurface(chain) && !isBinEntry) {
        add(`process.${chain.parts[0]}`);
      } else if (isLocaleMember(chain)) {
        add(`locale-sensitive ${chain.parts[chain.parts.length - 1]}`);
      } else if (isIntlAccess(chain)) {
        add('Intl');
      } else if (isNetworkGlobal(chain)) {
        add(`network global ${chain.parts[0] ?? chain.root}`);
      } else if (chain.rootKind === 'process-member' && !isBinEntry) {
        add('process alias member');
      }
      if (!isBinEntry && chain.rootKind === 'global' && chain.parts[0] === 'process' && chain.parts[1] && PROCESS_SURFACES.has(chain.parts[1])) {
        add(`globalThis.process.${chain.parts[1]}`);
      }
    }

    if (ts.isIdentifier(node) && aliases.get(node.text) === 'process-member' && !isBinEntry) {
      const parent = node.parent;
      if (!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent)) {
        add('process destructured member');
      }
    }

    if (ts.isIdentifier(node) && NETWORK_GLOBALS.includes(node.text)) {
      const parent = node.parent;
      if ((ts.isCallExpression(parent) && parent.expression === node)
        || (ts.isNewExpression(parent) && parent.expression === node)) {
        add(`network global ${node.text}`);
      }
    }

    if (ts.isIdentifier(node) && node.text === 'Intl') {
      add('Intl');
    }

    if (ts.isIdentifier(node) && aliases.get(node.text) === 'intl') {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) || ts.isNewExpression(parent)) {
        add('Intl alias');
      }
    }

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && aliases.get(node.expression.text) === 'process' && !isBinEntry) {
      if (PROCESS_SURFACES.has(node.name.text)) {
        add(`process alias ${node.name.text}`);
      }
    }

    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && !isBinEntry) {
      const processAlias = node.expression.text === 'process' || aliases.get(node.expression.text) === 'process';
      if (processAlias) {
        const key = literalString(node.argumentExpression, ts);
        if (key && PROCESS_SURFACES.has(key)) add(`process alias ${key}`);
        if (key === null) add('dynamic computed ambient access');
      }
    }

    if (ts.isIdentifier(node) && node.text === 'console') {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && ['log', 'info', 'debug', 'table', 'dir'].includes(parent.name.text)) {
        if (!isBinEntry) add(`console ${parent.name.text}`);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations.sort();
}

export function scanProductionSources(packages, scanOptions) {
  return packages.flatMap((pkg) => pkg.productionSourceFiles.flatMap((filePath) => {
    const content = scanOptions.readFile(filePath);
    const isBinEntry = filePath.endsWith('/src/bin.ts') || filePath.endsWith('\\src\\bin.ts');
    return scanSourceFile(filePath, content, {
      ...scanOptions,
      isBinEntry,
      repoRoot: scanOptions.repoRoot,
    });
  })).sort();
}

export {
  insideForbiddenRoot,
  isForbiddenChildProcess,
  isForbiddenFs,
  isNetworkModule,
  isProcessModule,
  packageSpecifierMatches,
  scanSourceFile,
};
