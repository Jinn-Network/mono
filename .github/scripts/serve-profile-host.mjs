#!/usr/bin/env node
// A static host for one profile-root deploy bundle, strict enough to be a reference.
//
// `build-profile-host-bundle.mjs` produces a deploy directory plus a generated host
// configuration. Nothing proved that directory is servable: the whole publication path
// was exercised against an injected `fetch`, so extensionless served paths, `@`-prefixed
// fixture directories, path normalization and trailing-slash redirects had never met a
// socket. This server is the missing half. It serves a bundle over real HTTP so the real
// live-host gate can run against a real origin before `spec.jinn.network` exists.
//
// Its strictness is the product, not an implementation convenience:
//
//   * Only paths named by a group's `manifest.json` are served, each with its manifest-declared
//     media type, the digest-derived strong ETag, and the cache lifetime the bundle
//     generator pins. Nothing else exists.
//   * Everything else is a hard 404. No directory index, no trailing-slash redirect, no
//     extension guessing, no case folding, no percent-decoding, no path normalization --
//     a request target is compared as a literal string against the manifest.
//   * The 404 body is a fixed plain-text string that is never a served document, so the
//     gate's anti-fallback probes cannot pass vacuously.
//
// That is the behavior any real host must match. A host that answers more than this is a
// host the gate exists to catch.
//
// Faults are additive, off by default, and exist so the negative half of the conformance
// suite can prove the gate refuses a real misconfigured socket rather than a fake one.
//
// Pure logic (request-target parsing, route loading, fault application, header
// construction, response selection) is exported and does no networking. The CLI entry is
// guarded so `import` is side-effect-free.

import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  IMMUTABLE_CACHE_CONTROL,
  MANIFEST_FILE_NAME,
  MANIFEST_MEDIA_TYPE,
  REVALIDATE_CACHE_CONTROL,
  assertLiteralRoutePath,
  entityTag,
} from './build-profile-host-bundle.mjs';
import { SIGNATURE_FILE_NAME } from './sign-profile-manifest.mjs';

export const NOT_FOUND_BODY = 'not found\n';
export const PUBLIC_KEY_MEDIA_TYPE = 'application/x-pem-file';
export const DEFAULT_PUBLIC_KEY_PATH = 'jinn-profile-manifest.pem';

// Every fault models one thing a real static host does by default and this one refuses to.
export const FAULTS = Object.freeze([
  // A host that "helpfully" redirects a document path to its trailing-slash form.
  'redirect-trailing-slash',
  // A single-page-application catch-all: 200 with the same bytes for every unknown path.
  'spa-catchall',
  // Extensionless profiles served as the generic fallback type, the exact failure the
  // generated configuration exists to prevent.
  'mistype-extensionless',
  // `.schema.json` served as plain `application/json` rather than `application/schema+json`.
  'mistype-schema',
  // One document's bytes drift while its pinned ETag stays put.
  'drift-one-document',
  // A conformant host appending a charset parameter. This one must NOT fail the gate; it
  // is the positive control for the gate's documented type/subtype-only comparison.
  'charset-suffix',
]);

// --- pure logic (no I/O, no networking) -------------------------------------

export function assertKnownFault(fault) {
  if (fault === null || fault === undefined) return null;
  if (!FAULTS.includes(fault)) throw new Error(`unknown fault: ${fault} (known: ${FAULTS.join(', ')})`);
  return fault;
}

/**
 * A request target resolved to a served path, with no normalization whatsoever.
 *
 * A static host that normalizes is a host that serves one document at many URLs, and the
 * identifier law says a document has exactly one address. So `%` is refused outright
 * rather than decoded (no served path needs escaping), `.` and `..` segments are refused
 * rather than resolved, and a trailing slash is a different string, not the same one.
 * @returns {{ path: string } | { error: string }}
 */
export function requestedPath(target) {
  if (typeof target !== 'string' || !target.startsWith('/')) return { error: 'request target must be an absolute path' };
  const withoutQuery = target.split('?')[0].split('#')[0];
  if (withoutQuery.includes('%')) return { error: 'request target is percent-encoded' };
  if (withoutQuery.includes('\\')) return { error: 'request target contains a backslash' };
  const path = withoutQuery.slice(1);
  if (path === '') return { error: 'request target is the bare root' };
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { error: 'request target is not a normalized path' };
  }
  return { path };
}

/** The exact header set the generated host configuration pins, plus a content length. */
export function documentHeaders({ mediaType, sha256, cacheControl, bytes }) {
  return {
    'content-type': mediaType,
    etag: entityTag(sha256),
    'cache-control': cacheControl,
    'content-length': String(bytes.length),
  };
}

/**
 * Discover the release groups a deploy bundle carries.
 *
 * A bundle holds every stack-published group that shares the origin, and each group's
 * inventory lives at `<group>/manifest.json`. So an immediate subdirectory is a group
 * exactly when the manifest inside it names *that* directory: a document that happens to
 * be served at `profiles/manifest.json` names something else, and stays a document.
 * Nothing is discovered from `vercel.json` -- the host configuration is not the inventory.
 */
function discoverGroups(root) {
  const groups = [];
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const manifestPath = join(root, name, MANIFEST_FILE_NAME);
    if (!existsSync(manifestPath)) continue;
    const bytes = readFileSync(manifestPath);
    let manifest;
    try {
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    if (manifest?.releaseGroup !== name) continue;
    if (!Array.isArray(manifest.documents)) throw new Error('profile manifest documents must be an array');
    groups.push({ name, manifest, bytes });
  }
  return groups;
}

/**
 * Load one bundle directory into the exact route table it may answer on.
 *
 * `kind` records why a path is served: `document` for a manifest-declared document,
 * `root` for a group's manifest and its signature sidecar, `key` for the published
 * signing key. Faults only ever touch documents, so a fault cannot accidentally break the
 * step of the gate it was not written to exercise.
 */
export function loadBundleRoutes(bundleDir, { publicKey = null } = {}) {
  const root = resolve(bundleDir);
  const groups = discoverGroups(root);
  if (groups.length === 0) {
    throw new Error(`bundle has no ${MANIFEST_FILE_NAME} in any immediate subdirectory: ${bundleDir}`);
  }

  const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const routes = new Map();
  const add = (path, entry) => {
    assertLiteralRoutePath(path, 'bundle served path');
    if (routes.has(path)) throw new Error(`bundle serves ${path} twice`);
    routes.set(path, { path, ...entry });
  };

  // Group inventories first, so a document claiming a group's own path trips `add`.
  for (const { name, bytes } of groups) {
    add(`${name}/${MANIFEST_FILE_NAME}`, {
      kind: 'root',
      bytes,
      mediaType: MANIFEST_MEDIA_TYPE,
      sha256: sha256Of(bytes),
      cacheControl: REVALIDATE_CACHE_CONTROL,
    });
    const signaturePath = join(root, name, SIGNATURE_FILE_NAME);
    if (existsSync(signaturePath)) {
      const sidecar = readFileSync(signaturePath);
      add(`${name}/${SIGNATURE_FILE_NAME}`, {
        kind: 'root',
        bytes: sidecar,
        mediaType: MANIFEST_MEDIA_TYPE,
        sha256: sha256Of(sidecar),
        cacheControl: REVALIDATE_CACHE_CONTROL,
      });
    }
  }
  for (const { manifest } of groups) {
    for (const { path, mediaType, sha256 } of manifest.documents) {
      // Documents keep their identifier paths, so they resolve from the bundle root.
      const absolute = join(root, ...String(path).split('/'));
      if (!existsSync(absolute)) throw new Error(`bundle is missing declared document ${path}`);
      // The ETag is the manifest digest, not a digest of what is on disk. That is what the
      // generated configuration pins, and modelling it faithfully is what lets the drift
      // fault look exactly like real bit-rot behind an unchanged strong validator.
      add(path, {
        kind: 'document',
        bytes: readFileSync(absolute),
        mediaType,
        sha256,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
    }
  }
  if (publicKey) {
    const pem = Buffer.from(publicKey.pem, 'utf8');
    add(publicKey.path ?? DEFAULT_PUBLIC_KEY_PATH, {
      kind: 'key',
      bytes: pem,
      mediaType: PUBLIC_KEY_MEDIA_TYPE,
      sha256: sha256Of(pem),
      cacheControl: REVALIDATE_CACHE_CONTROL,
    });
  }
  return { routes };
}

const isExtensionless = (path) => !path.split('/').pop().includes('.');

/**
 * Apply one fault to a loaded route table.
 * @returns {{ routes: Map, catchAll: boolean, redirectDocuments: boolean }}
 */
export function applyFault(routes, fault) {
  assertKnownFault(fault);
  const host = { routes: new Map(routes), catchAll: false, redirectDocuments: false };
  if (!fault) return host;
  if (fault === 'spa-catchall') {
    host.catchAll = true;
    return host;
  }
  if (fault === 'redirect-trailing-slash') {
    host.redirectDocuments = true;
    return host;
  }
  const documents = [...routes.values()].filter(({ kind }) => kind === 'document');
  if (documents.length === 0) throw new Error(`fault ${fault} needs at least one served document`);
  const rewrite = (route, changes) => host.routes.set(route.path, { ...route, ...changes });

  if (fault === 'charset-suffix') {
    for (const route of host.routes.values()) rewrite(route, { mediaType: `${route.mediaType}; charset=utf-8` });
    return host;
  }
  if (fault === 'mistype-extensionless') {
    const affected = documents.filter(({ path }) => isExtensionless(path));
    if (affected.length === 0) throw new Error('fault mistype-extensionless needs an extensionless document');
    for (const route of affected) rewrite(route, { mediaType: 'application/octet-stream' });
    return host;
  }
  if (fault === 'mistype-schema') {
    const affected = documents.filter(({ path }) => path.endsWith('.schema.json'));
    if (affected.length === 0) throw new Error('fault mistype-schema needs a .schema.json document');
    for (const route of affected) rewrite(route, { mediaType: MANIFEST_MEDIA_TYPE });
    return host;
  }
  // drift-one-document: the lexicographically first document, so the failure is reproducible.
  const [target] = documents.map(({ path }) => path).sort();
  const route = host.routes.get(target);
  const drifted = Buffer.from(route.bytes);
  if (drifted.length === 0) throw new Error(`cannot drift empty document ${target}`);
  drifted[drifted.length - 1] ^= 0x01;
  rewrite(route, { bytes: drifted });
  return host;
}

/**
 * The response for one request target.
 * @returns {{ status: number, headers: object, body: Buffer }}
 */
export function respondTo(host, target, method = 'GET') {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { 'content-type': 'text/plain', allow: 'GET, HEAD' }, body: Buffer.from(NOT_FOUND_BODY) };
  }
  const notFound = () => ({
    status: 404,
    headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(NOT_FOUND_BODY)) },
    body: Buffer.from(NOT_FOUND_BODY),
  });
  const requested = requestedPath(target);
  if (requested.error) return notFound();
  const route = host.routes.get(requested.path);
  if (!route) {
    if (!host.catchAll) return notFound();
    const body = Buffer.from('<!doctype html><div id="app"></div>\n');
    return {
      status: 200,
      headers: { 'content-type': 'text/html', 'content-length': String(body.length) },
      body,
    };
  }
  if (host.redirectDocuments && route.kind === 'document') {
    return { status: 308, headers: { location: `/${route.path}/`, 'content-length': '0' }, body: Buffer.alloc(0) };
  }
  return { status: 200, headers: documentHeaders(route), body: route.bytes };
}

// --- a throwaway loopback certificate ---------------------------------------
//
// The live-host gate refuses any origin that is not `https`, and it is right to: a
// protocol origin served over cleartext is not the thing being verified. So the local
// harness has to be a real TLS listener. Node ships no certificate *generator*, only a
// parser, so the DER is assembled here -- roughly a hundred lines of ASN.1, against the
// alternative of shelling out to `openssl` (absent or LibreSSL-shaped on some hosts) or
// committing a private key to the repository. The key is generated per run, lives in
// memory, and is trusted only by the child process the suite hands it to.

function derLength(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  for (let value = size; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const der = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const derSequence = (...parts) => der(0x30, Buffer.concat(parts));
const derSet = (...parts) => der(0x31, Buffer.concat(parts));
const derOid = (hex) => der(0x06, Buffer.from(hex, 'hex'));
const derInteger = (bytes) => der(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const derBitString = (content, unusedBits = 0) => der(0x03, Buffer.concat([Buffer.from([unusedBits]), content]));
const derBoolean = (value) => der(0x01, Buffer.from([value ? 0xff : 0x00]));
const derUtcTime = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return der(0x17, Buffer.from(
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`,
    'ascii',
  ));
};

const ED25519_ALGORITHM = derSequence(derOid('2b6570'));
const COMMON_NAME_OID = '550403';
const BASIC_CONSTRAINTS_OID = '551d13';
const KEY_USAGE_OID = '551d0f';
const EXTENDED_KEY_USAGE_OID = '551d25';
const SUBJECT_ALT_NAME_OID = '551d11';
const SERVER_AUTH_OID = '2b06010505070301';

const derExtension = (oidHex, critical, value) => derSequence(
  derOid(oidHex),
  ...(critical ? [derBoolean(true)] : []),
  der(0x04, value),
);

function pemBlock(label, bytes) {
  const base64 = bytes.toString('base64').replace(/(.{64})/gu, '$1\n').replace(/\n$/u, '');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

/**
 * A self-signed Ed25519 certificate for `127.0.0.1` and `localhost`, usable both as the
 * listener's certificate and, via `NODE_EXTRA_CA_CERTS`, as the one trust anchor a child
 * process needs. `CA:TRUE` is what makes the second use work.
 * @returns {{ key: string, cert: string }}
 */
export function selfSignedLoopbackCertificate({ validityHours = 24, now = new Date() } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const name = derSequence(derSet(derSequence(
    derOid(COMMON_NAME_OID),
    der(0x0c, Buffer.from('jinn-local-profile-host', 'utf8')),
  )));
  const tbsCertificate = derSequence(
    der(0xa0, derInteger(Buffer.from([2]))),
    derInteger(randomBytes(16)),
    ED25519_ALGORITHM,
    name,
    derSequence(
      derUtcTime(new Date(now.getTime() - 3_600_000)),
      derUtcTime(new Date(now.getTime() + validityHours * 3_600_000)),
    ),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, derSequence(
      derExtension(BASIC_CONSTRAINTS_OID, true, derSequence(derBoolean(true))),
      // digitalSignature (bit 0) + keyCertSign (bit 5): 0b1000_0100, two unused bits.
      derExtension(KEY_USAGE_OID, true, derBitString(Buffer.from([0x84]), 2)),
      derExtension(EXTENDED_KEY_USAGE_OID, false, derSequence(derOid(SERVER_AUTH_OID))),
      derExtension(SUBJECT_ALT_NAME_OID, false, derSequence(
        der(0x82, Buffer.from('localhost', 'ascii')),
        der(0x87, Buffer.from([127, 0, 0, 1])),
      )),
    )),
  );
  const certificate = derSequence(
    tbsCertificate,
    ED25519_ALGORITHM,
    derBitString(sign(null, tbsCertificate, privateKey)),
  );
  const cert = pemBlock('CERTIFICATE', certificate);
  // Parsing what was just assembled turns a silent DER mistake into a loud one here
  // rather than into an opaque TLS handshake failure three call sites later.
  new X509Certificate(cert);
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

// --- listener ---------------------------------------------------------------

/**
 * Start a listener over one bundle directory.
 * @param bundleDir the deploy directory produced by build-profile-host-bundle.mjs
 * @param port 0 (the default) takes an ephemeral port; a leaked fixed port is a flake
 * @param fault one of FAULTS, or null for conformant behavior
 * @param tls `{ key, cert }` to serve https; omitted serves cleartext http
 * @param publicKey `{ pem, path }` to also serve the published signing key
 * @returns {Promise<{ url: string, origin: string, port: number, documentCount: number,
 *   requests: Array<{ target: string, method: string, status: number }>, close: () => Promise<void> }>}
 */
export async function startProfileHost({
  bundleDir,
  port = 0,
  fault = null,
  tls = null,
  publicKey = null,
} = {}) {
  const { routes } = loadBundleRoutes(bundleDir, { publicKey });
  const host = applyFault(routes, assertKnownFault(fault));
  // Every request is recorded so a caller can prove a sweep happened rather than infer it
  // from the sweeper's own report. A verifier that answered from a cache, skipped
  // documents, or never connected leaves a log that says so.
  const observed = [];
  const handler = (request, response) => {
    const { status, headers, body } = respondTo(host, request.url ?? '', request.method ?? 'GET');
    observed.push({ target: request.url ?? '', method: request.method ?? 'GET', status });
    response.writeHead(status, headers);
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  };
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((done, failed) => {
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', failed);
      done();
    });
  });
  const boundPort = server.address().port;
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${boundPort}`;
  return {
    origin,
    url: origin,
    port: boundPort,
    documentCount: [...routes.values()].filter(({ kind }) => kind === 'document').length,
    requests: observed,
    close: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

// --- CLI entry (guarded so `import` is side-effect-free) ---------------------

export function parseArgs(argv) {
  const fields = new Map([['--bundle', 'bundleDir'], ['--port', 'port'], ['--fault', 'fault']]);
  const parsed = { port: '0', fault: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const field = fields.get(flag);
    if (!field) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    parsed[field] = value;
  }
  if (!parsed.bundleDir) throw new Error('--bundle <deploy directory> is required');
  if (!/^\d+$/u.test(parsed.port)) throw new Error('--port must be a port number');
  assertKnownFault(parsed.fault);
  return { ...parsed, port: Number(parsed.port) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { bundleDir, port, fault } = parseArgs(process.argv.slice(2));
    const server = await startProfileHost({ bundleDir, port, fault });
    console.log(`serving ${server.documentCount} documents from ${bundleDir} at ${server.origin}${fault ? ` (fault: ${fault})` : ''}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
