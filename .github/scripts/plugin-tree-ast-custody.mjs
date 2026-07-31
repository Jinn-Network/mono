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
const BIN_MUTATING_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
]);
const BIN_OBJECT_MUTATORS = new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']);
const BIN_REFLECT_MUTATORS = new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']);
const BIN_ALLOWED_PROCESS_ARG_CALLEES = new Set(['main', 'resolveRuntimeConfig']);
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
  binEnv: 'binEnv',
  binArgv: 'binArgv',
  reflect: 'reflect',
  module: 'module',
});

function scriptKindForPath(filePath, ts) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return null;
}

function unwrapExpression(expr, ts) {
  let current = expr;
  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression?.(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function isModuleModule(specifier) {
  const rootName = moduleRoot(specifier);
  return rootName === 'node:module' || rootName === 'module'
    || specifier.startsWith('node:module/') || specifier.startsWith('module/');
}

function isCodeLoadingUrl(specifier) {
  return /^(data|file|https?):/i.test(specifier);
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

function importCreatesLocalShadow(specifier) {
  if (specifier === null) return false;
  if (isProcessModule(specifier)) return false;
  return true;
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
  if (name === 'Reflect') return AUTH.reflect;
  if (name === 'module') return AUTH.module;
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

function resolveProcessRoot(expr, ts, scope) {
  const unwrapped = unwrapExpression(expr, ts);
  if (ts.isCallExpression(unwrapped)) {
    if (authorityFromExpression(unwrapped, ts, scope) === AUTH.process) {
      return { kind: 'process' };
    }
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const innerAuth = authorityFromExpression(unwrapped.expression, ts, scope);
    if (innerAuth === AUTH.process) {
      const member = unwrapped.name.text;
      if (member === 'env') return { kind: 'env' };
      if (member === 'argv') return { kind: 'argv' };
      if (member === 'stdout') return { kind: 'stdout' };
      if (member === 'stderr') return { kind: 'stderr' };
      if (member === 'exitCode') return { kind: 'exitCode' };
      if (member === 'once' || member === 'off') return { kind: member };
      return { kind: 'process' };
    }
  }
  if (ts.isIdentifier(unwrapped)) {
    if (scope.lookup(unwrapped.text) === AUTH.process) {
      return { kind: 'process' };
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const inner = unwrapExpression(unwrapped.expression, ts);
    if (ts.isIdentifier(inner)) {
      if ((inner.text === 'globalThis' || inner.text === 'global') && unwrapped.name.text === 'process') {
        return { kind: 'process' };
      }
      const idAuth = scope.lookup(inner.text) ?? globalAuthForIdentifier(inner.text);
      if (idAuth === AUTH.global && unwrapped.name.text === 'process') {
        return { kind: 'process' };
      }
    }
    if (ts.isIdentifier(inner) && inner.text === 'process' && scope.lookup('process') === AUTH.process) {
      const member = unwrapped.name.text;
      if (member === 'env') return { kind: 'env' };
      if (member === 'argv') return { kind: 'argv' };
      if (member === 'stdout') return { kind: 'stdout' };
      if (member === 'stderr') return { kind: 'stderr' };
      if (member === 'exitCode') return { kind: 'exitCode' };
      if (member === 'once' || member === 'off') return { kind: member };
    }
  }
  return null;
}

function resolveProcessEnvArgvRoot(expr, ts, scope) {
  const unwrapped = unwrapExpression(expr, ts);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const processRoot = resolveProcessRoot(unwrapped, ts, scope);
    if (processRoot?.kind === 'env' || processRoot?.kind === 'argv') {
      return processRoot.kind;
    }
  }
  return null;
}

function resolveEnvArgvMutationRoot(expr, ts, scope) {
  const unwrapped = unwrapExpression(expr, ts);
  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    const root = resolveProcessRoot(unwrapped.expression, ts, scope);
    if (root?.kind === 'env' || root?.kind === 'argv') {
      return root.kind;
    }
  }
  return null;
}

function binEnvArgvLabel(auth) {
  if (auth === AUTH.binEnv) return 'env';
  if (auth === AUTH.binArgv) return 'argv';
  return null;
}

function globalMemberAuth(baseAuth, member) {
  if (baseAuth === AUTH.global && member === 'process') return AUTH.process;
  if (baseAuth === AUTH.global && member === 'eval') return AUTH.eval;
  if (baseAuth === AUTH.global && member === 'Function') return AUTH.Function;
  if (baseAuth === AUTH.global && NETWORK_GLOBALS.has(member)) return AUTH[member];
  if (baseAuth === AUTH.module && member === 'require') return AUTH.require;
  if (baseAuth === AUTH.reflect && member === 'get') return AUTH.reflect;
  return null;
}

function authorityFromReflectGet(callExpr, ts, scope) {
  const args = callExpr.arguments ?? [];
  if (args.length < 2) return AUTH.local;
  const targetAuth = authorityFromExpression(args[0], ts, scope);
  const key = literalString(args[1], ts);
  if (targetAuth === AUTH.global || targetAuth === AUTH.process) {
    if (key === 'process') return AUTH.process;
    if (key === 'eval') return AUTH.eval;
    if (key === 'Function') return AUTH.Function;
    if (key && NETWORK_GLOBALS.has(key)) return AUTH[key];
    if (key === null) return AUTH.global;
  }
  return AUTH.local;
}

function authorityFromExpression(expr, ts, scope) {
  const unwrapped = unwrapExpression(expr, ts);
  if (ts.isIdentifier(unwrapped)) {
    return scope.lookup(unwrapped.text) ?? AUTH.local;
  }
  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapExpression(unwrapped.expression, ts);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'get') {
      const baseAuth = authorityFromExpression(callee.expression, ts, scope);
      if (baseAuth === AUTH.reflect || (ts.isIdentifier(callee.expression) && callee.expression.text === 'Reflect')) {
        return authorityFromReflectGet(unwrapped, ts, scope);
      }
    }
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const inner = unwrapExpression(unwrapped.expression, ts);
    const member = unwrapped.name.text;
    if (ts.isIdentifier(inner)) {
      const idAuth = scope.lookup(inner.text) ?? globalAuthForIdentifier(inner.text);
      const memberAuth = globalMemberAuth(idAuth, member);
      if (memberAuth) return memberAuth;
    }
    const exprAuth = authorityFromExpression(unwrapped.expression, ts, scope);
    if (exprAuth === AUTH.process) {
      if (member === 'env') return AUTH.process;
      if (member === 'argv') return AUTH.process;
    }
    if (ts.isIdentifier(inner) && inner.text === 'Intl' && scope.lookup('Intl') === AUTH.Intl) return AUTH.Intl;
    if (LOCALE_MEMBER_APIS.has(member)) return AUTH.localeFn;
    if (exprAuth === AUTH.Function && member === 'prototype') return AUTH.Function;
    if (exprAuth === AUTH.Function && (member === 'call' || member === 'apply' || member === 'bind')) {
      return AUTH.Function;
    }
    return AUTH.local;
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const baseAuth = authorityFromExpression(unwrapped.expression, ts, scope);
    const key = literalString(unwrapped.argumentExpression, ts);
    const memberAuth = key ? globalMemberAuth(baseAuth, key) : null;
    if (memberAuth) return memberAuth;
    if (baseAuth === AUTH.global && key === null) return AUTH.global;
    if (key && LOCALE_MEMBER_APIS.has(key)) return AUTH.localeFn;
    return AUTH.local;
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return authorityFromExpression(unwrapped.right, ts, scope);
  }
  return AUTH.local;
}

function bindPattern(pattern, auth, ts, scope, ctx) {
  if (ctx.isBinEntry && (auth === AUTH.process || auth === AUTH.global || auth === AUTH.require || auth === AUTH.eval)) {
    ctx.add('forbidden bin process alias');
    return;
  }
  if (!ctx.isBinEntry && auth === AUTH.process) {
    ctx.add('destructured process authority');
  }
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
      if (ctx.isBinEntry && auth === AUTH.process) {
        ctx.add('forbidden bin process alias');
        continue;
      }
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

function bindFromInitializer(name, initializer, ts, scope, ctx) {
  const unwrapped = unwrapExpression(initializer, ts);
  let auth = authorityFromExpression(initializer, ts, scope);
  const envArgvRoot = resolveProcessEnvArgvRoot(initializer, ts, scope);
  if (ctx.isBinEntry && envArgvRoot) {
    ctx.add(`forbidden bin process.${envArgvRoot} alias`);
    if (ts.isIdentifier(name)) {
      scope.declare(name.text, envArgvRoot === 'env' ? AUTH.binEnv : AUTH.binArgv);
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      bindPattern(name, envArgvRoot === 'env' ? AUTH.binEnv : AUTH.binArgv, ts, scope, ctx);
    }
    return;
  }
  if (ts.isCallExpression(unwrapped)) {
    const callee = unwrapExpression(unwrapped.expression, ts);
    if (ts.isIdentifier(callee) && callee.text === 'createRequire') {
      ctx.add('code-loading createRequire');
      auth = AUTH.require;
    }
  }
  if (ctx.isBinEntry && (auth === AUTH.process || auth === AUTH.global || auth === AUTH.require || auth === AUTH.eval)) {
    ctx.add('forbidden bin process alias');
    return;
  }
  if (ts.isIdentifier(name)) {
    scope.declare(name.text, auth);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    bindPattern(name, auth, ts, scope, ctx);
  }
}

function isAllowedBinImport(specifier, node, ts) {
  if (!specifier) return false;
  const allowed = BIN_ALLOWED_IMPORTS.find((entry) => entry.module === specifier);
  if (!allowed || !ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return false;
  if (clause.name) return false;
  if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  const names = clause.namedBindings.elements.map((element) => element.name.text);
  return names.length === allowed.names.length
    && names.every((name) => allowed.names.includes(name))
    && clause.namedBindings.elements.every((element) =>
      (element.propertyName?.text ?? element.name.text) === element.name.text
      || allowed.names.includes(element.propertyName?.text ?? element.name.text));
}

function expressionContains(candidate, target, ts) {
  if (candidate === target) return true;
  if (ts.isPropertyAccessExpression(candidate)) {
    return expressionContains(candidate.expression, target, ts);
  }
  if (ts.isElementAccessExpression(candidate)) {
    return expressionContains(candidate.expression, target, ts);
  }
  return false;
}

function assignmentOperatorKinds(ts) {
  return new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);
}

function resolveBinProcessMutationRoot(expr, ts, scope) {
  const processRoot = resolveProcessRoot(expr, ts, scope);
  if (processRoot?.kind) return processRoot.kind;
  return resolveEnvArgvMutationRoot(expr, ts, scope);
}

function isAssignmentToExpression(node, target, ts, assignOps) {
  let current = node.parent;
  while (current) {
    if (ts.isBinaryExpression(current) && assignOps.has(current.operatorToken.kind)
      && expressionContains(current.left, target, ts)) {
      return true;
    }
    if (ts.isDeleteExpression(current) && expressionContains(current.expression, target, ts)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isBinEnvArgvAliasMutation(node, ts, scope, member, assignOps) {
  const unwrapped = unwrapExpression(node, ts);
  if (!ts.isPropertyAccessExpression(unwrapped) && !ts.isElementAccessExpression(unwrapped)) {
    return false;
  }
  const base = unwrapExpression(unwrapped.expression, ts);
  if (!ts.isIdentifier(base)) return false;
  const label = binEnvArgvLabel(scope.lookup(base.text));
  if (!label) return false;
  if (member && BIN_MUTATING_METHODS.has(member)) return true;
  return isAssignmentToExpression(node, node, ts, assignOps);
}

function isBinProcessMutation(node, ts, member, assignOps) {
  if (!['env', 'argv', 'process'].includes(member)) return false;
  return isAssignmentToExpression(node, node, ts, assignOps);
}

function checkBinMutatorCall(callee, args, ts, scope, add) {
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const owner = unwrapExpression(callee.expression, ts);
  const ownerName = ts.isIdentifier(owner) ? owner.text : null;
  if (ownerName === 'Object' && BIN_OBJECT_MUTATORS.has(method) && args[0]) {
    const target = resolveBinProcessMutationRoot(args[0], ts, scope);
    if (target) add(`forbidden bin process ${target} mutation`);
  }
  if (ownerName === 'Reflect' && BIN_REFLECT_MUTATORS.has(method) && args[0]) {
    const target = resolveBinProcessMutationRoot(args[0], ts, scope);
    if (target) add(`forbidden bin process ${target} mutation`);
  }
}

function checkBinProcessArgumentPassing(callee, args, ts, scope, add) {
  let calleeName = null;
  const unwrappedCallee = unwrapExpression(callee, ts);
  if (ts.isIdentifier(unwrappedCallee)) calleeName = unwrappedCallee.text;
  if (BIN_ALLOWED_PROCESS_ARG_CALLEES.has(calleeName ?? '')) return;
  for (const arg of args) {
    if (!arg) continue;
    const root = resolveBinProcessMutationRoot(arg, ts, scope);
    if (root === 'env' || root === 'argv' || root === 'process') {
      add(`forbidden bin process ${root} argument`);
    }
  }
}

function predeclareStatement(stmt, scope, ts, ctx) {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    scope.declare(stmt.name.text, AUTH.local);
  }
  if (ts.isClassDeclaration(stmt) && stmt.name) {
    scope.declare(stmt.name.text, AUTH.local);
  }
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        scope.declare(decl.name.text, AUTH.local);
      } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        bindPattern(decl.name, AUTH.local, ts, scope, ctx);
      }
    }
  }
  if (ts.isImportDeclaration(stmt) && stmt.importClause) {
    const specifier = literalString(stmt.moduleSpecifier, ts);
    if (!importCreatesLocalShadow(specifier)) return;
    if (stmt.importClause.name) scope.declare(stmt.importClause.name.text, AUTH.local);
    if (stmt.importClause.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
      for (const element of stmt.importClause.namedBindings.elements) {
        scope.declare(element.name.text, AUTH.local);
      }
    }
    if (stmt.importClause.namedBindings && ts.isNamespaceImport(stmt.importClause.namedBindings)) {
      scope.declare(stmt.importClause.namedBindings.name.text, AUTH.local);
    }
  }
  if (ts.isImportEqualsDeclaration(stmt) && stmt.name) {
    scope.declare(stmt.name.text, AUTH.local);
  }
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
  const ctx = { isBinEntry, add };
  const assignOps = assignmentOperatorKinds(ts);

  for (const stmt of sourceFile.statements) {
    predeclareStatement(stmt, scope, ts, ctx);
  }

  function checkImportSpecifier(specifier, node) {
    if (specifier === null) {
      add('nonliteral dynamic import');
      return;
    }
    if (isModuleModule(specifier)) {
      add(`code-loading module ${specifier}`);
      return;
    }
    if (isCodeLoadingUrl(specifier)) {
      add(`code-loading url ${specifier.split(':')[0]}:`);
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
      if (isBinProcessMutation(node, ts, member, assignOps)) {
        add(`forbidden bin process.${member} mutation`);
        return;
      }
      if (!isAllowedBinProcessUse(node, ts, member)) {
        add(`forbidden bin process.${member}`);
      }
      return;
    }
    add(`${via}.${member}`);
  }

  function visitStatementBody(body, currentScope) {
    if (ts.isBlock(body)) {
      visitNode(body, currentScope);
      return;
    }
    const bodyScope = currentScope.child();
    visitNode(body, bodyScope);
  }

  function checkKeyMaterial(name, context) {
    if (KEY_MATERIAL_NAME.test(name)) {
      add(`key-material ${context}: ${name}`);
    }
  }

  function visitNode(node, currentScope) {
    scope = currentScope;

    if (ts.isBlock(node)) {
      const blockScope = currentScope.child();
      for (const stmt of node.statements) {
        predeclareStatement(stmt, blockScope, ts, ctx);
      }
      for (const stmt of node.statements) {
        visitNode(stmt, blockScope);
      }
      return;
    }

    if (ts.isCatchClause(node)) {
      const catchScope = currentScope.child();
      if (node.variableDeclaration) {
        const { name, initializer } = node.variableDeclaration;
        if (initializer) {
          bindFromInitializer(name, initializer, ts, catchScope, ctx);
        } else if (ts.isIdentifier(name)) {
          catchScope.declare(name.text, AUTH.local);
        }
      }
      visitNode(node.block, catchScope);
      return;
    }

    if (ts.isIfStatement(node)) {
      visitNode(node.expression, currentScope);
      visitStatementBody(node.thenStatement, currentScope);
      if (node.elseStatement) visitStatementBody(node.elseStatement, currentScope);
      return;
    }

    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      visitNode(node.expression, currentScope);
      visitStatementBody(node.statement, currentScope);
      return;
    }

    if (ts.isForStatement(node)) {
      if (node.initializer) visitNode(node.initializer, currentScope);
      if (node.condition) visitNode(node.condition, currentScope);
      if (node.incrementor) visitNode(node.incrementor, currentScope);
      visitStatementBody(node.statement, currentScope);
      return;
    }

    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      if (node.initializer) visitNode(node.initializer, currentScope);
      visitNode(node.expression, currentScope);
      visitStatementBody(node.statement, currentScope);
      return;
    }

    if (ts.isSwitchStatement(node)) {
      visitNode(node.expression, currentScope);
      for (const switchCase of node.caseBlock.clauses) {
        for (const element of switchCase.statements) {
          visitNode(element, currentScope);
        }
      }
      return;
    }

    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        currentScope.declare(node.name.text, AUTH.local);
      }
      const fnScope = currentScope.child();
      for (const param of node.parameters ?? []) {
        if (param.initializer) {
          visitNode(param.initializer, currentScope);
        }
        if (ts.isObjectBindingPattern(param.name)) {
          for (const element of param.name.elements ?? []) {
            if (element.initializer) visitNode(element.initializer, currentScope);
          }
        }
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
          bindPattern(param.name, AUTH.local, ts, fnScope, ctx);
        }
      }
      if (node.body) visitNode(node.body, fnScope);
      return;
    }

    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      const specifier = literalString(node.moduleSpecifier, ts);
      checkImportSpecifier(specifier, node);
      if (specifier && ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        if (importCreatesLocalShadow(specifier)) {
          for (const element of node.importClause.namedBindings.elements) {
            currentScope.declare(element.name.text, AUTH.local);
          }
        }
      }
      if (specifier && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings) && importCreatesLocalShadow(specifier)) {
        currentScope.declare(node.importClause.namedBindings.name.text, AUTH.local);
      }
      if (node.importClause?.name && importCreatesLocalShadow(specifier)) {
        currentScope.declare(node.importClause.name.text, AUTH.local);
      }
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
        bindFromInitializer(node.name, node.initializer, ts, currentScope, ctx);
      } else if (ts.isIdentifier(node.name)) {
        currentScope.declare(node.name.text, AUTH.local);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isObjectBindingPattern(node.left) || ts.isArrayBindingPattern(node.left)) {
        bindPattern(node.left, authorityFromExpression(node.right, ts, currentScope), ts, currentScope, ctx);
      } else if (ts.isIdentifier(node.left)) {
        currentScope.declare(node.left.text, authorityFromExpression(node.right, ts, currentScope));
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression, ts);
      if (ctx.isBinEntry) {
        checkBinMutatorCall(callee, node.arguments ?? [], ts, currentScope, add);
        checkBinProcessArgumentPassing(callee, node.arguments ?? [], ts, currentScope, add);
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'get') {
        const reflectAuth = authorityFromExpression(callee.expression, ts, currentScope);
        if (reflectAuth === AUTH.reflect) {
          const targetAuth = authorityFromExpression(node.arguments?.[0], ts, currentScope);
          const key = literalString(node.arguments?.[1], ts);
          if ((targetAuth === AUTH.global || targetAuth === AUTH.process) && key === null) {
            add('dynamic computed Reflect.get access');
          }
          if (targetAuth === AUTH.global && key === 'process') {
            add('Reflect.get globalThis.process');
          }
        }
      }
      if (ctx.isBinEntry && ts.isPropertyAccessExpression(callee)) {
        const member = callee.name.text;
        if (BIN_MUTATING_METHODS.has(member)) {
          const envArgvRoot = resolveProcessEnvArgvRoot(callee.expression, ts, currentScope);
          if (envArgvRoot) {
            add(`forbidden bin process.${envArgvRoot} mutation`);
          } else if (isBinEnvArgvAliasMutation(callee, ts, currentScope, member, assignOps)) {
            add('forbidden bin process alias mutation');
          }
        }
      }
      if (ctx.isBinEntry && ts.isIdentifier(callee)) {
        const label = binEnvArgvLabel(currentScope.lookup(callee.text));
        if (label) add(`forbidden bin process.${label} alias call`);
      }
      if (ts.isIdentifier(callee)) {
        const auth = currentScope.lookup(callee.text);
        if (auth !== AUTH.local) {
          const ambient = auth ?? globalAuthForIdentifier(callee.text);
          if (callee.text === 'createRequire') {
            add('code-loading createRequire');
          }
          if (ambient === AUTH.require) {
            checkImportSpecifier(literalString(node.arguments[0], ts), node);
          }
          if (ambient === AUTH.eval || ambient === AUTH.Function) {
            add(`dynamic evaluation ${callee.text}`);
          }
          if (KEY_CONSTRUCTION_CALLEES.has(callee.text)) {
            add(`key-construction helper ${callee.text}`);
          }
          if (ambient === AUTH.fetch || ambient === AUTH.WebSocket || ambient === AUTH.EventSource) {
            add(`network global ${callee.text}`);
          }
          if (ambient === AUTH.localeFn) {
            add('locale-sensitive aliased call');
          }
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (['call', 'apply', 'bind'].includes(method)) {
          const targetAuth = authorityFromExpression(callee.expression, ts, currentScope);
          if (targetAuth === AUTH.eval || targetAuth === AUTH.Function) {
            add(`dynamic evaluation ${method}`);
          }
          if (targetAuth === AUTH.require) {
            const specIndex = method === 'apply' ? 1 : 0;
            checkImportSpecifier(literalString(node.arguments?.[specIndex], ts), node);
          }
        }
        if (callee.name.text === 'require' && ts.isIdentifier(callee.expression)
          && (currentScope.lookup(callee.expression.text) ?? AUTH.module) === AUTH.module) {
          checkImportSpecifier(literalString(node.arguments?.[0], ts), node);
        }
      }
      if (ts.isElementAccessExpression(callee)) {
        const auth = authorityFromExpression(callee.expression, ts, currentScope);
        if (auth === AUTH.eval || auth === AUTH.Function) add('dynamic evaluation alias call');
      }
      if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        visitNode(callee.left, currentScope);
        const rightAuth = authorityFromExpression(callee.right, ts, currentScope);
        if (rightAuth === AUTH.eval || rightAuth === AUTH.Function) add('dynamic evaluation comma');
        if (rightAuth === AUTH.require) {
          checkImportSpecifier(literalString(node.arguments?.[0], ts), node);
        }
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      visitNode(node.left, currentScope);
      visitNode(node.right, currentScope);
      return;
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
      const member = node.name.text;
      if (ctx.isBinEntry && ts.isIdentifier(node.expression)) {
        const aliasLabel = binEnvArgvLabel(currentScope.lookup(node.expression.text));
        if (aliasLabel) {
          if (isBinEnvArgvAliasMutation(node, ts, currentScope, member, assignOps)) {
            add(`forbidden bin process.${aliasLabel} alias mutation`);
          } else if (member !== 'length') {
            add(`forbidden bin process.${aliasLabel} alias use`);
          }
        }
      }
      if (ctx.isBinEntry && isAssignmentToExpression(node, node, ts, assignOps)) {
        const root = resolveBinProcessMutationRoot(node, ts, currentScope);
        if (root === 'env' || root === 'argv' || root === 'process') {
          add(`forbidden bin process ${root} mutation`);
        }
      }
      const processRoot = resolveProcessRoot(node.expression, ts, currentScope);
      if (processRoot?.kind === 'process') {
        reportProcessAccess(node, member);
      } else if (processRoot?.kind === 'env') {
        if (isBinEntry) {
          if (isBinProcessMutation(node, ts, 'env', assignOps)) {
            add('forbidden bin process.env mutation');
          }
        } else {
          add('process.env');
        }
      } else if ((processRoot?.kind === 'stdout' || processRoot?.kind === 'stderr') && member === 'write') {
        if (isBinEntry) {
          const parent = node.parent;
          if (!ts.isCallExpression(parent) || parent.expression !== node) {
            add(`forbidden bin process.${processRoot.kind}.write`);
          }
        } else {
          add(`process.${processRoot.kind}`);
        }
      } else {
        const auth = authorityFromExpression(node.expression, ts, currentScope);
        if (auth === AUTH.global && member === 'Function') {
          add('globalThis.Function');
        } else if (auth === AUTH.global && member === 'eval') {
          add('globalThis.eval');
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
          if (currentScope.lookup('Intl') === AUTH.Intl) add('Intl');
        }
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const processRoot = resolveProcessRoot(node.expression, ts, currentScope);
      if (processRoot?.kind === 'argv') {
        if (!isBinEntry) add('process.argv');
        return;
      }
      if (processRoot?.kind === 'env') {
        if (isBinEntry) {
          if (isBinProcessMutation(node, ts, 'env', assignOps)) add('forbidden bin process.env mutation');
        } else {
          add('process.env');
        }
        return;
      }
      const auth = authorityFromExpression(node.expression, ts, currentScope);
      const key = literalString(node.argumentExpression, ts);
      const numericIndex = ts.isNumericLiteral(node.argumentExpression);
      if (processRoot?.kind === 'process') {
        if (key === null && !numericIndex) add('dynamic computed process access');
        else reportProcessAccess(node, key ?? String(node.argumentExpression.text));
      } else if (auth === AUTH.global && key === 'process') {
        add('globalThis.process bracket');
      } else if (auth === AUTH.global && (key === 'eval' || key === 'Function')) {
        add(`globalThis.${key}`);
      } else if (key && LOCALE_MEMBER_APIS.has(key)) {
        add(`locale-sensitive ${key}`);
      } else if (auth === AUTH.global && key && NETWORK_GLOBALS.has(key)) {
        add(`network global ${key}`);
      } else if (auth === AUTH.global && key === null && !numericIndex) {
        add('dynamic computed global access');
      }
    }

    if (ts.isTaggedTemplateExpression(node)) {
      const tagAuth = authorityFromExpression(node.tag, ts, currentScope);
      if (tagAuth === AUTH.eval || tagAuth === AUTH.Function) {
        add('dynamic evaluation tagged template');
      }
      if (ts.isIdentifier(node.tag) && (node.tag.text === 'eval' || node.tag.text === 'Function')) {
        add('dynamic evaluation tagged template');
      }
      if (ts.isPropertyAccessExpression(node.tag)) {
        const member = node.tag.name.text;
        const baseAuth = authorityFromExpression(node.tag.expression, ts, currentScope);
        if (baseAuth === AUTH.global && (member === 'eval' || member === 'Function')) {
          add('dynamic evaluation tagged template');
        }
      }
      visitNode(node.tag, currentScope);
      return;
    }

    if (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) {
      if (ctx.isBinEntry) {
        const operand = unwrapExpression(node.operand, ts);
        const envArgvRoot = resolveEnvArgvMutationRoot(operand, ts, currentScope);
        if (envArgvRoot) {
          add(`forbidden bin process.${envArgvRoot} mutation`);
        } else if (isBinEnvArgvAliasMutation(operand, ts, currentScope, undefined, assignOps)) {
          add('forbidden bin process alias mutation');
        }
      }
    }

    if (ts.isBinaryExpression(node) && assignOps.has(node.operatorToken.kind)) {
      if (ctx.isBinEntry) {
        const root = resolveBinProcessMutationRoot(node.left, ts, currentScope);
        if (root === 'env' || root === 'argv' || root === 'process') {
          add(`forbidden bin process ${root} mutation`);
        }
      }
    }

    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.name && ts.isComputedPropertyName(node.name)) {
        visitNode(node.name.expression, currentScope);
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
      if (node.text === 'Intl' && (currentScope.lookup('Intl') ?? AUTH.Intl) === AUTH.Intl) add('Intl');
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
