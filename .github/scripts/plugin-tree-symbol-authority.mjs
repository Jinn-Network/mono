import { dirname } from 'node:path';

import { loadRuntimeTypeScript } from './plugin-tree-guard-common.mjs';

export const AUTH = Object.freeze({
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
  vm: 'vm',
  binMutator: 'binMutator',
});

export function globalAuthForIdentifier(name) {
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

function scriptKindForPath(filePath, ts) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

function createVirtualHost(filePath, files, ts) {
  const currentDirectory = dirname(filePath);
  return {
    getSourceFile(name, languageVersion) {
      if (!files.has(name)) return undefined;
      return ts.createSourceFile(
        name,
        files.get(name),
        languageVersion,
        true,
        scriptKindForPath(name, ts),
      );
    },
    writeFile() {},
    getCurrentDirectory: () => currentDirectory,
    getDirectories: () => [],
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
    getCanonicalFileName: (name) => name,
    getNewLine: () => '\n',
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    useCaseSensitiveFileNames: () => true,
  };
}

/** Hermetic Program + TypeChecker for one scanned file and optional virtual siblings. */
export function createCustodyProgram(filePath, content, extraFiles = {}) {
  const ts = loadRuntimeTypeScript();
  const files = new Map([[filePath, content]]);
  for (const [path, text] of Object.entries(extraFiles)) {
    files.set(path, text);
  }
  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: true,
    esModuleInterop: true,
  };
  const host = createVirtualHost(filePath, files, ts);
  const program = ts.createProgram([filePath], compilerOptions, host);
  const sourceFile = program.getSourceFile(filePath);
  return { ts, program, checker: program.getTypeChecker(), sourceFile };
}

function isImportLikeDeclaration(ts, decl) {
  if (!decl) return false;
  if (ts.isImportSpecifier(decl) || ts.isNamespaceImport(decl) || ts.isImportClause(decl)) return true;
  if (ts.isImportEqualsDeclaration(decl) || ts.isExternalModuleReference(decl)) return true;
  const parent = decl.parent;
  if (!parent) return false;
  return ts.isImportClause(parent)
    || ts.isImportSpecifier(parent)
    || ts.isNamespaceImport(parent)
    || ts.isImportEqualsDeclaration(parent)
    || ts.isExternalModuleReference(parent);
}

function isLocalBindingDeclaration(ts, decl) {
  return ts.isVariableDeclaration(decl)
    || ts.isFunctionDeclaration(decl)
    || ts.isFunctionExpression(decl)
    || ts.isParameter(decl)
    || ts.isClassDeclaration(decl)
    || ts.isPropertyDeclaration(decl)
    || ts.isBindingElement(decl)
    || ts.isEnumDeclaration(decl)
    || ts.isTypeAliasDeclaration(decl)
    || ts.isInterfaceDeclaration(decl)
    || ts.isModuleDeclaration(decl);
}

export class CustodyAuthorityContext {
  constructor(ts, checker, sourceFile) {
    this.ts = ts;
    this.checker = checker;
    this.sourceFile = sourceFile;
    /** @type {Map<string, string>} */
    this.provenance = new Map();
  }

  resolveSymbol(symbol) {
    if (!symbol) return symbol;
    if (symbol.flags & this.ts.SymbolFlags.Alias) {
      try {
        return this.checker.getAliasedSymbol(symbol);
      } catch {
        return symbol;
      }
    }
    return symbol;
  }

  symbolKey(symbol) {
    if (!symbol) return null;
    const decl = symbol.declarations?.[0];
    if (!decl) return `sym:${String(symbol.escapedName)}:${symbol.id ?? 'noid'}`;
    return `${decl.getSourceFile().fileName}:${decl.getStart()}:${String(symbol.escapedName)}`;
  }

  provenanceForSymbol(symbol) {
    const key = this.symbolKey(this.resolveSymbol(symbol));
    return key ? this.provenance.get(key) : undefined;
  }

  setProvenanceForSymbol(symbol, auth) {
    const key = this.symbolKey(this.resolveSymbol(symbol));
    if (key) this.provenance.set(key, auth);
  }

  setProvenanceForNode(nameNode, auth) {
    if (!nameNode) return;
    const symbol = this.checker.getSymbolAtLocation(nameNode);
    if (symbol) this.setProvenanceForSymbol(symbol, auth);
  }

  hasLocalUserBinding(symbol, referenceNode) {
    const decls = symbol.declarations ?? [];
    const refFile = referenceNode.getSourceFile();
    for (const decl of decls) {
      if (decl.getSourceFile() !== refFile) continue;
      if (isImportLikeDeclaration(this.ts, decl)) continue;
      if (isLocalBindingDeclaration(this.ts, decl)) return true;
    }
    return false;
  }

  importBindingAuth(node) {
    if (!this.ts.isIdentifier(node)) return null;
    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol) return null;
    for (const decl of symbol.declarations ?? []) {
      if (isImportLikeDeclaration(this.ts, decl)) return AUTH.local;
    }
    return null;
  }

  isAmbientGlobalIdentifier(node) {
    if (!this.ts.isIdentifier(node)) return false;
    const globalAuth = globalAuthForIdentifier(node.text);
    if (!globalAuth) return false;

    if (this.importBindingAuth(node) === AUTH.local) return false;

    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol) return true;

    const resolved = this.resolveSymbol(symbol);
    const tracked = this.provenanceForSymbol(resolved);
    if (tracked !== undefined) {
      return tracked !== AUTH.local && tracked !== AUTH.binEnv && tracked !== AUTH.binArgv;
    }

    const decls = resolved.declarations ?? [];
    if (decls.length === 0) return true;

    for (const decl of decls) {
      if (isImportLikeDeclaration(this.ts, decl)) return false;
    }

    for (const decl of decls) {
      if (decl.getSourceFile().isDeclarationFile) return true;
    }

    return !this.hasLocalUserBinding(resolved, node);
  }

  lookupIdentifier(node) {
    if (!this.ts.isIdentifier(node)) return AUTH.local;
    const importAuth = this.importBindingAuth(node);
    if (importAuth !== null) return importAuth;

    const symbol = this.checker.getSymbolAtLocation(node);
    if (symbol) {
      const resolved = this.resolveSymbol(symbol);
      const tracked = this.provenanceForSymbol(resolved);
      if (tracked !== undefined) return tracked;
    }
    if (this.isAmbientGlobalIdentifier(node)) {
      return globalAuthForIdentifier(node.text) ?? AUTH.local;
    }
    return AUTH.local;
  }

  ambientAuthForIdentifier(node) {
    if (!this.ts.isIdentifier(node)) return null;
    if (!this.isAmbientGlobalIdentifier(node)) return null;
    return globalAuthForIdentifier(node.text);
  }
}
