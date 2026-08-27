import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestDirectory } from './digest.js';
import { loadSolverPluginManifest } from './manifest.js';
import type {
  LoadedSolverPlugin,
  ResolveSolverPluginOptions,
  SolverPluginEntry,
  SolverPluginSourceKind,
} from './types.js';
import { resolveDefaultStateDir } from '../state-dir.js';

const DEFAULT_VENDOR_ROOT = join(resolveDefaultStateDir(), 'solver-plugins');

export function entrySource(entry: SolverPluginEntry): string {
  return typeof entry === 'string' ? entry : entry.source;
}

function entryName(entry: SolverPluginEntry, fallback: string): string {
  return typeof entry === 'string' ? fallback : entry.name ?? fallback;
}

export function sourceKind(source: string): SolverPluginSourceKind {
  if (source.startsWith('bundled:')) return 'bundled';
  if (source.startsWith('file:') || source.startsWith('path:')) return 'local';
  if (source.startsWith('npm:')) return 'npm';
  if (source.startsWith('git:')) return 'git';
  if (source.startsWith('github:')) return 'github';
  if (source.startsWith('claude:')) return 'claude';
  return 'local';
}

export function safeVendorName(source: string): string {
  return source.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function bundledRoot(defaultRoot?: string): string {
  if (defaultRoot) return defaultRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = resolve(here, '../../plugins');
  const distRoot = resolve(here, '../plugins');
  return existsSync(srcRoot) ? srcRoot : distRoot;
}

function localPathFromSource(source: string): string {
  const raw = source.startsWith('file:') || source.startsWith('path:')
    ? source.slice(source.indexOf(':') + 1)
    : source;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export async function resolveSolverPlugin(
  entry: SolverPluginEntry,
  opts: ResolveSolverPluginOptions = {},
): Promise<LoadedSolverPlugin> {
  const source = entrySource(entry);
  const kind = sourceKind(source);
  const vendorRoot = opts.vendorRoot ?? DEFAULT_VENDOR_ROOT;

  let root: string;
  if (kind === 'bundled') {
    const bundledName = source.slice('bundled:'.length);
    root = join(bundledRoot(opts.bundledRoot), bundledName);
  } else if (kind === 'local') {
    root = localPathFromSource(source);
  } else {
    root = join(vendorRoot, safeVendorName(source));
    if (!existsSync(root)) {
      throw new Error(`SolverPlugin source ${source} is not vendored at ${root}`);
    }
  }

  const { path: manifestPath, manifest } = loadSolverPluginManifest(root);
  const sha256 = digestDirectory(root);
  return {
    name: entryName(entry, manifest.name),
    version: manifest.version,
    supports: manifest.jinn.supports,
    solverType: manifest.jinn.supports[0],
    source,
    sourceKind: kind,
    root,
    manifestPath,
    manifest,
    sha256,
  };
}

export function defaultSolverPluginVendorRoot(): string {
  return DEFAULT_VENDOR_ROOT;
}
