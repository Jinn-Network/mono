#!/usr/bin/env node
// Turn an attested profile root into a deploy directory: the exact attested bytes
// plus one generated static-host configuration file.
//
// The runbook's hard rule is "deploy one exact attested profile-root artifact; never
// rebuild it at the host". This generator is the mechanical form of that rule -- it
// copies, it never authors. Every served document is byte-copied and digest-checked
// against manifest.json on the way out, so a bundle that differs from the attested
// root cannot be produced silently.
//
// The one generated file pins what a static host would otherwise guess: the media
// type of each document (extensionless task and facts profiles have no extension for
// a host to infer from), a digest-derived strong ETag, and cache lifetime. Documents
// are immutable by the identifier law, so they carry `immutable`; the root manifest
// and its signature sidecar are the mutable pointer to an immutable set, so they
// carry `must-revalidate` -- an immutably cached root manifest would make every
// later live-host verification compare stale bytes.
//
// Pure logic (route-path validation, entity tags, the configuration object and its
// bytes, the route-count warning) is exported and does no I/O, so the test suite
// exercises the configuration shape without a filesystem.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { SIGNATURE_FILE_NAME } from './sign-profile-manifest.mjs';

export const HOST_CONFIG_FILE_NAME = 'vercel.json';
export const MANIFEST_FILE_NAME = 'manifest.json';
export const MANIFEST_MEDIA_TYPE = 'application/json';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

// A Vercel configuration is capped at 1024 routes and every `headers` entry consumes
// one. Warn well before the cap so a growing public surface is a planned migration
// rather than a failed deploy.
export const ROUTE_LIMIT = 1024;
export const ROUTE_WARNING_THRESHOLD = 900;

const SHA256 = /^[0-9a-f]{64}$/u;

// `source` is a path pattern, not a literal string: a document served at a path
// containing pattern metacharacters would silently become a matcher. Today every
// served path is plain plus `@`; this keeps that true.
const ROUTE_PATTERN_METACHARACTERS = /[:*+?(){}[\]\\!^$|]/u;

// --- pure logic (no I/O) ----------------------------------------------------

export function assertLiteralRoutePath(path, label = 'served path') {
  if (typeof path !== 'string' || path === '') {
    throw new Error(`${label} must be a non-empty forward-slash path`);
  }
  const segments = path.split('/');
  if (path.includes('\\')
    || isAbsolute(path)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a normalized relative path: ${path}`);
  }
  if (ROUTE_PATTERN_METACHARACTERS.test(path)) {
    throw new Error(`${label} contains host route-pattern metacharacters: ${path}`);
  }
  return path;
}

/** RFC 9110 strong entity tag derived from the manifest digest. */
export function entityTag(sha256, label = 'document digest') {
  if (!SHA256.test(String(sha256))) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return `"sha256-${sha256}"`;
}

function headerEntry({ path, mediaType, sha256, cacheControl }) {
  assertLiteralRoutePath(path);
  if (typeof mediaType !== 'string' || mediaType.trim() === '') {
    throw new Error(`served path ${path} has no media type`);
  }
  return {
    source: `/${path}`,
    headers: [
      { key: 'Content-Type', value: mediaType },
      { key: 'ETag', value: entityTag(sha256, `${path} digest`) },
      { key: 'Cache-Control', value: cacheControl },
    ],
  };
}

/**
 * Build the static-host configuration for one profile root.
 * @param documents manifest.documents (path, sha256, mediaType)
 * @param rootDocuments the generated root files (manifest.json, optional sidecar)
 */
export function hostConfig({ documents, rootDocuments }) {
  if (!Array.isArray(documents)) throw new Error('profile manifest documents must be an array');
  if (documents.length === 0) throw new Error('profile manifest declares no documents');
  const seen = new Set();
  for (const { path } of documents) {
    if (seen.has(path)) throw new Error(`profile manifest repeats document path ${path}`);
    seen.add(path);
  }
  for (const { path } of rootDocuments) {
    if (seen.has(path)) throw new Error(`generated root file ${path} collides with a served document`);
    seen.add(path);
  }
  if (seen.has(HOST_CONFIG_FILE_NAME)) {
    throw new Error(`the profile root serves ${HOST_CONFIG_FILE_NAME}, which the host reads as configuration`);
  }

  const ordered = [...rootDocuments, ...[...documents].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))];
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    cleanUrls: false,
    trailingSlash: false,
    headers: ordered.map(({ path, mediaType, sha256, cacheControl }) => headerEntry({
      path,
      mediaType,
      sha256,
      cacheControl: cacheControl ?? IMMUTABLE_CACHE_CONTROL,
    })),
  };
}

export function hostConfigBytes(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function routeWarnings(routeCount) {
  if (routeCount > ROUTE_LIMIT) {
    return [`${routeCount} host routes exceeds the ${ROUTE_LIMIT}-route configuration limit`];
  }
  if (routeCount >= ROUTE_WARNING_THRESHOLD) {
    return [`${routeCount} host routes is within ${ROUTE_LIMIT - routeCount} of the ${ROUTE_LIMIT}-route configuration limit`];
  }
  return [];
}

// --- I/O shell --------------------------------------------------------------

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function walkFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`profile root contains symbolic link ${path}`);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`profile root contains unsupported entry ${path}`);
  }
  return files.sort();
}

function insideRoot(child, parent) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function prepareOutputRoot(outDir) {
  const outputRoot = resolve(outDir);
  if (existsSync(outputRoot)) {
    const stat = lstatSync(outputRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`output directory must be a real directory: ${outDir}`);
    }
    if (readdirSync(outputRoot).length > 0) {
      throw new Error(`refusing to write a host bundle into a non-empty directory: ${outDir}`);
    }
  } else {
    mkdirSync(outputRoot, { recursive: true });
  }
  return outputRoot;
}

export function buildProfileHostBundle({ profileRoot, outDir }) {
  const root = resolve(profileRoot);
  const manifestPath = join(root, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) throw new Error(`profile root has no ${MANIFEST_FILE_NAME}: ${profileRoot}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`profile root ${MANIFEST_FILE_NAME} is not valid JSON: ${error?.message ?? String(error)}`);
  }
  if (!Array.isArray(manifest.documents)) throw new Error('profile manifest documents must be an array');

  const rootDocuments = [{
    path: MANIFEST_FILE_NAME,
    mediaType: MANIFEST_MEDIA_TYPE,
    sha256: sha256Of(readFileSync(manifestPath)),
    cacheControl: REVALIDATE_CACHE_CONTROL,
  }];
  const signaturePath = join(root, SIGNATURE_FILE_NAME);
  if (existsSync(signaturePath)) {
    rootDocuments.push({
      path: SIGNATURE_FILE_NAME,
      mediaType: MANIFEST_MEDIA_TYPE,
      sha256: sha256Of(readFileSync(signaturePath)),
      cacheControl: REVALIDATE_CACHE_CONTROL,
    });
  }

  // Exactly the attested set: no undeclared file rides along, no declared file is missing.
  const declared = new Set([
    ...rootDocuments.map(({ path }) => path),
    ...manifest.documents.map(({ path }) => path),
  ]);
  for (const path of walkFiles(root)) {
    if (!declared.has(path)) throw new Error(`profile root contains undeclared file ${path}`);
  }

  const config = hostConfig({ documents: manifest.documents, rootDocuments });
  const outputRoot = prepareOutputRoot(outDir);

  const copies = [
    ...rootDocuments.map(({ path }) => ({ path, sha256: null })),
    ...manifest.documents.map(({ path, sha256 }) => ({ path, sha256 })),
  ];
  for (const { path, sha256 } of copies) {
    assertLiteralRoutePath(path);
    const source = resolve(root, ...path.split('/'));
    const target = resolve(outputRoot, ...path.split('/'));
    if (!insideRoot(source, root) || !insideRoot(target, outputRoot)) {
      throw new Error(`served path escapes its root: ${path}`);
    }
    if (!existsSync(source) || !lstatSync(source).isFile()) {
      throw new Error(`profile root is missing declared document ${path}`);
    }
    if (sha256 !== null) {
      const actual = sha256Of(readFileSync(source));
      if (actual !== sha256) throw new Error(`profile root document digest does not match the manifest for ${path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  writeFileSync(join(outputRoot, HOST_CONFIG_FILE_NAME), hostConfigBytes(config), 'utf8');

  return {
    documentCount: manifest.documents.length,
    fileCount: copies.length,
    routeCount: config.headers.length,
    warnings: routeWarnings(config.headers.length),
  };
}

// --- CLI entry (guarded so `import` is side-effect-free) ---------------------

function parseArgs(argv) {
  const fields = new Map([['--root', 'profileRoot'], ['--out', 'outDir']]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const field = fields.get(flag);
    if (!field) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    parsed[field] = value;
  }
  if (!parsed.profileRoot) throw new Error('--root <attested profile root> is required');
  if (!parsed.outDir) throw new Error('--out <deploy directory> is required');
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { profileRoot, outDir } = parseArgs(process.argv.slice(2));
    const result = buildProfileHostBundle({ profileRoot, outDir });
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    console.log(
      `wrote ${result.fileCount} attested files and ${HOST_CONFIG_FILE_NAME} (${result.routeCount} routes) to ${outDir}`,
    );
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
