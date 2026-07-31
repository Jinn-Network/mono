import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { compareCodeUnit, loadRuntimeTypeScript, relativeFromRoot } from './plugin-tree-guard-common.mjs';

const NETWORK_MODULES = [
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'undici',
];
const NETWORK_GLOBALS = new Set(['fetch', 'WebSocket', 'EventSource']);
const LOCALE_MEMBER_APIS = new Set([
  'localeCompare', 'toLocaleUpperCase', 'toLocaleLowerCase',
  'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
]);
const BIN_ALLOWED_PROCESS_MEMBERS = new Set(['argv', 'env', 'stdout', 'stderr', 'exitCode', 'once', 'off']);
const BIN_ALLOWED_SIGNALS = new Set(['SIGINT', 'SIGTERM']);
const BIN_ALLOWED_IMPORTS = [
  { module: 'node:fs', names: ['realpathSync'] },
  { module: 'node:os', names: ['homedir'] },
  { module: 'node:path', names: ['join'] },
  { module: 'node:url', names: ['fileURLToPath', 'pathToFileURL'] },
];
const KEY_CONSTRUCTION_CALLEES = new Set([
  'privateKeyToAccount', 'mnemonicToAccount', 'hdKeyToAccount', 'generatePrivateKey',
]);
const KEY_MATERIAL_NAME = /^(?:private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|signer[_-]?key)$/i;
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const AUTH = Object.freeze({
  local: 'local',
  process: 'process',
  global: 'global',
  require: 'require',
  eval: 'eval',
  Function: 'Function',
  fetch: 'fetch',
  WebSocket: 'WebSocket',
  EventSource: 'EventSource',
  Intl: 'Intl',
  localeFn: 'localeFn',
  console: 'console',
});

function scriptKindForPath(filePath, ts) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return null;
}

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
    rootName === name || rootName === `node:${name}`
    || specifier.startsWith(`${name}/`) || specifier.startsWith(`node:${name}/`));
}

function isForbiddenFs(specifier) {
  const rootName = moduleRoot(specifier);
  return rootName === 'node:fs' || rootName === 'fs' || specifier.startsWith('node:fs/') || specifier.startsWith('fs/');
}

function isForbiddenChildProcess(specifier) {
  const rootName = moduleRoot(specifier);
  return rootName === 'node:child_process' || rootName === 'child_process'
    || specifier.startsWith('node:child_process/') || specifier.startsWith('child_process/');
}

function isProcessModule(specifier) {
  const rootName = moduleRoot(specifier);
  return rootName === 'node:process' || rootName === 'process'
    || specifier.startsWith('node:process/') || specifier.startsWith('process/');
}

function insideForbiddenRoot(filePath, specifier, forbiddenRoots) {
  if (!specifier.startsWith('.')) return false;
  const resolved = resolve(dirname(filePath), specifier);
  return forbiddenRoots.some((forbiddenRoot) => {
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
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function bindingNameText(name, ts) {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

function globalAuthForIdentifier(name) {
  if (name === 'process') return AUTH.process;
  if (name === 'globalThis' || name === 'global') return AUTH.global;
  if (name === 'require') return AUTH.require;
  if (name === 'eval') return AUTH.eval;
  if (name === 'Function') return AUTH.Function;
  if (name === 'fetch') return AUTH.fetch;
  if (name === 'WebSocket') return AUTH.WebSocket;
  if (name === 'EventSource') return AUTH.EventSource;
  if (name === 'Intl') return AUTH.Intl;
  if (name === 'console') return AUTH.console;
  return null;
}

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }

  child() {
    return new Scope(this);
  }

  declare(name, auth) {
    this.bindings.set(name, auth);
  }

  lookup(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent ? this.parent.lookup(name) : globalAuthForIdentifier(name);
  }
}

function authorityFromExpression(expr, ts, scope) {
  if (ts.isIdentifier(expr)) {
    return scope.lookup(expr.text) ?? AUTH.local;
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const base = scope.lookup(expr.expression.text) ?? globalAuthForIdentifier(expr.expression.text);
    if ((base === AUTH.global || expr.expression.text === 'globalThis' || expr.expression.text === 'global')
      && expr.name.text === 'process') {
      return AUTH.process;
    }
    if (base === AUTH.global && expr.name.text === 'Function') return AUTH.Function;
    if (base === AUTH.global && NETWORK_GLOBALS.has(expr.name.text)) return AUTH[expr.name.text];
    if (expr.expression.text === 'Intl' || (base === AUTH.Intl)) return AUTH.Intl;
  }
  if (ts.isElementAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const base = scope.lookup(expr.expression.text) ?? globalAuthForIdentifier(expr.expression.text);
    const key = literalString(expr.argumentExpression, ts);
    if ((base === AUTH.global || expr.expression.text === 'globalThis' || expr.expression.text === 'global')
      && key === 'process') {
      return AUTH.process;
    }
    if (base === AUTH.global && key === 'eval') return AUTH.eval;
    if (base === AUTH.global && key === 'Function') return AUTH.Function;
    if (key && LOCALE_MEMBER_APIS.has(key)) return AUTH.localeFn;
  }
  if (ts.isParenthesizedExpression(expr)) {
    return authorityFromExpression(expr.expression, ts, scope);
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return authorityFromExpression(expr.right, ts, scope);
  }
  if (ts.isIdentifier(expr) && expr.text === 'Intl') return AUTH.Intl;
  return AUTH.local;
}

function bindPattern(pattern, auth, ts, scope) {
  if (ts.isIdentifier(pattern)) {
    scope.declare(pattern.text, auth);
    return;
  }
  if (ts.isObjectBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;
      const local = bindingNameText(element.name, ts);
      const property = element.propertyName ? bindingNameText(element.propertyName, ts) : local;
      if (!local) continue;
      if (auth === AUTH.process && property && BIN_ALLOWED_PROCESS_MEMBERS.has(property)) {
        scope.declare(local, AUTH.process);
      } else if (auth === AUTH.global && property === 'process') {
        scope.declare(local, AUTH.process);
      } else if (auth === AUTH.process) {
        scope.declare(local, AUTH.process);
      } else if (NETWORK_GLOBALS.has(property ?? local)) {
        scope.declare(local, AUTH[property ?? local]);
      } else if (property && LOCALE_MEMBER_APIS.has(property)) {
        scope.declare(local, AUTH.localeFn);
      } else {
        scope.declare(local, auth);
      }
    }
  }
}

function bindFromInitializer(name, initializer, ts, scope) {
  const auth = authorityFromExpression(initializer, ts, scope);
  if (ts.isIdentifier(name)) {
    scope.declare(name.text, auth);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    bindPattern(name, auth, ts, scope);
  }
}

function isAllowedBinImport(specifier, node, ts) {
  if (!specifier) return false;
  const allowed = BIN_ALLOWED_IMPORTS.find((entry) => entry.module === specifier);
  if (!allowed || !ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  const names = clause.namedBindings.elements.map((element) => element.name.text);
  return names.length === allowed.names.length
    && names.every((name) => allowed.names.includes(name))
    && clause.namedBindings.elements.every((element) =>
      (element.propertyName?.text ?? element.name.text) === element.name.text
      || allowed.names.includes(element.propertyName?.text ?? element.name.text));
}

function finalizeViolations(violations) {
  return [...new Set(violations)].sort(compareCodeUnit);
}

function isAllowedBinProcessUse(node, ts, member) {
  if (!BIN_ALLOWED_PROCESS_MEMBERS.has(member)) return false;
  if (member === 'once' || member === 'off') {
    const parent = node.parent;
    if (!ts.isCallExpression(parent) || parent.expression !== node) return false;
    const signal = literalString(parent.arguments[0], ts);
    return signal !== null && BIN_ALLOWED_SIGNALS.has(signal);
  }
  if (member === 'stdout' || member === 'stderr') {
    const parent = node.parent;
    return ts.isPropertyAccessExpression(parent)
      && parent.expression === node
      && parent.name.text === 'write'
      && ts.isCallExpression(parent.parent)
      && parent.parent.expression === parent;
  }
  if (member === 'exitCode') {
    let current = node.parent;
    while (current) {
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return current.left === node || (ts.isPropertyAccessExpression(current.left) && current.left.name === node);
      }
      current = current.parent;
    }
    return false;
  }
  return member === 'argv' || member === 'env';
}

function scanSourceFile(filePath, content, options) {
  const ts = loadRuntimeTypeScript();
  const {
    forbiddenPackages = [],
    forbiddenRoots = [],
    isBinEntry = false,
  } = options;
  const label = relativeFromRoot(filePath);
  const violations = [];
  const add = (detail) => violations.push(`${label} -> ${detail}`);

  const ext = SUPPORTED_EXTENSIONS.has('.' + filePath.split('.').pop())
    ? `.${filePath.split('.').pop()}`
    : null;
  const supported = [...SUPPORTED_EXTENSIONS].some((suffix) => filePath.endsWith(suffix));
  if (!supported) {
    add(`unsupported production source extension`);
    return finalizeViolations(violations);
  }

  const scriptKind = scriptKindForPath(filePath, ts);
  if (scriptKind === null) {
    add('unsupported script kind');
    return finalizeViolations(violations);
  }

  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    const pos = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    add(`parse error ${pos.line + 1}:${pos.character + 1} TS${diagnostic.code}`);
  }
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    return finalizeViolations(violations);
  }

  let scope = new Scope();

  function checkImportSpecifier(specifier, node) {
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
    if (isProcessModule(specifier)) {
      add(`import ${specifier}`);
      return;
    }
    if (isForbiddenChildProcess(specifier)) {
      add(specifier);
      return;
    }
    if (isForbiddenFs(specifier)) {
      if (isBinEntry && isAllowedBinImport(specifier, node, ts)) return;
      add(specifier);
    }
  }

  function reportProcessAccess(node, member, via = 'process') {
    if (isBinEntry) {
      if (!isAllowedBinProcessUse(node, ts, member)) {
        add(`forbidden bin process.${member}`);
      }
      return;
    }
    add(`${via}.${member}`);
  }

  function checkKeyMaterial(name, context) {
    if (KEY_MATERIAL_NAME.test(name)) {
      add(`key-material ${context}: ${name}`);
    }
  }

  function visitNode(node, currentScope) {
    scope = currentScope;

    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const fnScope = currentScope.child();
      for (const param of node.parameters ?? []) {
        if (ts.isIdentifier(param.name)) {
          checkKeyMaterial(param.name.text, 'parameter');
          fnScope.declare(param.name.text, AUTH.local);
        } else {
          if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
            for (const element of param.name.elements ?? []) {
              const destructuredName = bindingNameText(element.name, ts);
              if (destructuredName) checkKeyMaterial(destructuredName, 'parameter');
            }
          }
          bindPattern(param.name, AUTH.local, ts, fnScope);
        }
      }
      if (node.body) ts.forEachChild(node.body, (child) => visitNode(child, fnScope));
      return;
    }

    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalString(node.moduleSpecifier, ts);
      checkImportSpecifier(specifier, node);
      if (specifier && ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          currentScope.declare(element.name.text, AUTH.local);
        }
      }
      if (node.importClause?.name) currentScope.declare(node.importClause.name.text, AUTH.local);
    }

    if (ts.isImportEqualsDeclaration(node) && node.moduleReference && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalString(node.moduleReference.expression, ts);
      checkImportSpecifier(specifier, node);
      if (node.name) currentScope.declare(node.name.text, AUTH.local);
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      checkImportSpecifier(literalString(node.moduleSpecifier, ts), node);
    }

    if (ts.isImportCall?.(node) || node.kind === ts.SyntaxKind.ImportCall) {
      checkImportSpecifier(literalString(node.arguments?.[0], ts), node);
    }

    if (ts.isVariableDeclaration(node)) {
      if (node.name && node.initializer) {
        bindFromInitializer(node.name, node.initializer, ts, currentScope);
      } else if (ts.isIdentifier(node.name)) {
        currentScope.declare(node.name.text, AUTH.local);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isObjectBindingPattern(node.left) || ts.isArrayBindingPattern(node.left)) {
        bindPattern(node.left, authorityFromExpression(node.right, ts, currentScope), ts, currentScope);
      } else if (ts.isIdentifier(node.left)) {
        currentScope.declare(node.left.text, authorityFromExpression(node.right, ts, currentScope));
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const auth = currentScope.lookup(callee.text);
        if (auth === AUTH.require) {
          checkImportSpecifier(literalString(node.arguments[0], ts), node);
        }
        if (auth === AUTH.eval || auth === AUTH.Function || callee.text === 'eval' || callee.text === 'Function') {
          add(`dynamic evaluation ${callee.text}`);
        }
        if (KEY_CONSTRUCTION_CALLEES.has(callee.text)) {
          add(`key-construction helper ${callee.text}`);
        }
        if (auth === AUTH.fetch || auth === AUTH.WebSocket || auth === AUTH.EventSource
          || NETWORK_GLOBALS.has(callee.text)) {
          add(`network global ${callee.text}`);
        }
        if (auth === AUTH.localeFn) {
          add('locale-sensitive aliased call');
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (['call', 'apply', 'bind'].includes(method)) {
          const targetAuth = authorityFromExpression(callee.expression, ts, currentScope);
          if (targetAuth === AUTH.eval || targetAuth === AUTH.Function) {
            add(`dynamic evaluation ${method}`);
          }
        }
      }
      if (ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const auth = currentScope.lookup(callee.expression.text);
        if (auth === AUTH.eval || auth === AUTH.Function) add('dynamic evaluation alias call');
      }
      if (ts.isParenthesizedExpression(callee) || (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken)) {
        let inner = callee;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          const rightAuth = authorityFromExpression(inner.right, ts, currentScope);
          if (rightAuth === AUTH.eval || rightAuth === AUTH.Function) add('dynamic evaluation comma');
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const auth = authorityFromExpression(node.expression, ts, currentScope);
      if (auth === AUTH.Function || (ts.isIdentifier(node.expression) && node.expression.text === 'Function')) {
        add('dynamic evaluation Function');
      }
      if (auth === AUTH.WebSocket || auth === AUTH.EventSource
        || (ts.isIdentifier(node.expression) && NETWORK_GLOBALS.has(node.expression.text))) {
        add(`network global ${ts.isIdentifier(node.expression) ? node.expression.text : 'constructor'}`);
      }
      if (auth === AUTH.Intl || (ts.isIdentifier(node.expression) && node.expression.text === 'Intl')) {
        add('Intl');
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const auth = authorityFromExpression(node.expression, ts, currentScope);
      const member = node.name.text;
      if (auth === AUTH.process) {
        reportProcessAccess(node, member);
      } else if (auth === AUTH.global && member === 'process') {
        reportProcessAccess(node, 'process', 'globalThis');
      } else if (auth === AUTH.global && member === 'Function') {
        add('globalThis.Function');
      } else if (auth === AUTH.global && NETWORK_GLOBALS.has(member)) {
        add(`network global ${member}`);
      } else if (LOCALE_MEMBER_APIS.has(member)) {
        add(`locale-sensitive ${member}`);
      } else if (auth === AUTH.Intl) {
        add('Intl alias');
      } else if (auth === AUTH.localeFn) {
        add('locale-sensitive aliased member');
      } else if (auth === AUTH.console) {
        add(`console ${member}`);
      } else if (auth === AUTH.fetch || auth === AUTH.WebSocket || auth === AUTH.EventSource) {
        add(`network global ${member}`);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Intl') {
        add('Intl');
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const auth = authorityFromExpression(node.expression, ts, currentScope);
      const key = literalString(node.argumentExpression, ts);
      if (auth === AUTH.process) {
        if (key === null) add('dynamic computed process access');
        else reportProcessAccess(node, key);
      } else if (auth === AUTH.global && key === 'process') {
        add('globalThis.process bracket');
      } else if (auth === AUTH.global && (key === 'eval' || key === 'Function')) {
        add(`globalThis.${key}`);
      } else if (key && LOCALE_MEMBER_APIS.has(key)) {
        add(`locale-sensitive ${key}`);
      } else if (auth === AUTH.global && key && NETWORK_GLOBALS.has(key)) {
        add(`network global ${key}`);
      }
    }

    if (ts.isIdentifier(node)) {
      const auth = currentScope.lookup(node.text);
      if (auth === AUTH.process) {
        const parent = node.parent;
        if (!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent)) {
          if (!isBinEntry) add('process reference');
        }
      }
      if (auth === AUTH.require && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        checkImportSpecifier(literalString(node.parent.arguments[0], ts), node.parent);
      }
      if (auth === AUTH.eval || auth === AUTH.Function) {
        const parent = node.parent;
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
          add(`dynamic evaluation alias ${node.text}`);
        }
      }
      if (auth === AUTH.fetch || auth === AUTH.WebSocket || auth === AUTH.EventSource) {
        const parent = node.parent;
        if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
          add(`network global alias ${node.text}`);
        }
      }
      if (auth === AUTH.localeFn && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        add('locale-sensitive aliased call');
      }
      if (node.text === 'Intl') add('Intl');
      checkKeyMaterial(node.text, 'identifier');
    }

    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
      const propName = bindingNameText(node.name, ts);
      if (propName) checkKeyMaterial(propName, 'property');
    }

    if (ts.isParameter(node)) {
      if (ts.isIdentifier(node.name)) {
        checkKeyMaterial(node.name.text, 'parameter');
      } else if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
        for (const element of node.name.elements ?? []) {
          const paramName = bindingNameText(element.name, ts);
          if (paramName) checkKeyMaterial(paramName, 'parameter');
        }
      }
    }

    ts.forEachChild(node, (child) => visitNode(child, currentScope));
  }

  visitNode(sourceFile, scope);
  return finalizeViolations(violations);
}

export function scanProductionSources(packages, scanOptions) {
  return packages.flatMap((pkg) => pkg.productionSourceFiles.flatMap((filePath) => {
    const content = scanOptions.readFile(filePath);
    const isBinEntry = filePath.endsWith('/src/bin.ts') || filePath.endsWith('\\src\\bin.ts');
    return scanSourceFile(filePath, content, {
      ...scanOptions,
      isBinEntry,
    });
  })).sort(compareCodeUnit);
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
