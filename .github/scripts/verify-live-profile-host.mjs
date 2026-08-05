#!/usr/bin/env node
// Fail-closed live-host verification for the platform's public document root.
//
// Building or attesting an artifact is not proof that the public host serves it.
// This gate proves the second half: that the origin serves byte-for-byte the same
// documents, media types and signature that the same run built and attested. It is
// the mechanical form of the hosting runbook's checklist, and it is the gate that
// replaces the unconditional `stable-hosting-blocker`.
//
// Design commitments, in the order they matter:
//
//   * There is no "host unreachable, skip" branch. Its absence is the design. Every
//     step is fatal; internal retries exist only to absorb transport flakiness and
//     can never convert a failure into a pass.
//   * The origin is a parameter. `https://spec.jinn.network` is the default and is
//     mandatory under `--lane stable` (DR-2026-08-04); nothing else is hardcoded.
//   * Identity and location are separate. A document's claimed identifier is a property
//     of its bytes; the verification origin is where those bytes are fetched from. Every
//     identifier -- a document's own `$id`/`profile` and the catalog's registered
//     `resolvableIdentifiers` alike -- resolves against `IDENTIFIER_ORIGIN`, and the
//     resulting served path is then fetched at the origin under verification. That is
//     what makes verifying a preview deployment possible at all: the same attested
//     artifact served anywhere still claims spec.jinn.network.
//   * Anti-fallback probes run last and are load-bearing: a single-page-application
//     catch-all that answers 200 with the same bytes for every path would otherwise
//     make every other check pass vacuously.
//   * Media types compare on type/subtype only. A host appending `charset=utf-8` is
//     conformant; a host serving an extensionless profile as `application/octet-stream`
//     is the failure this gate exists to catch, and that is a type/subtype difference.
//
// Pure logic (origin normalization, media-type comparison, identifier re-derivation,
// public-key digesting, receipt identity) is exported, never throws, and does no I/O,
// so the test suite drives the whole gate offline against an injected fetch. The CLI
// entry is guarded so `import` is side-effect-free.

import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertLiteralRoutePath } from './build-profile-host-bundle.mjs';
import { canonicalJsonBytes, catalogSha256 } from './build-prepublication-bundle.mjs';
import { loadPlatformCatalog } from './platform-catalog.mjs';
import {
  CANONICAL_IDENTIFIER_ORIGIN,
  RETIRED_IDENTIFIER_ORIGIN,
  jinnIdentifierServedPath,
} from './public-surface-assets.mjs';
import { PAYLOAD_TYPE, SIGNATURE_FILE_NAME, verifyEnvelope } from './sign-profile-manifest.mjs';

/**
 * The origin every hosted protocol identifier names, imported rather than restated.
 *
 * A document's claimed identity is a property of its bytes, not of where those bytes are
 * served: the same attested artifact deployed to a preview URL still claims
 * spec.jinn.network. Identity therefore always resolves against *this* origin, while
 * fetching happens at whatever origin is under verification.
 */
export const IDENTIFIER_ORIGIN = CANONICAL_IDENTIFIER_ORIGIN.replace(/\/+$/u, '');
// Under the stable lane the verification origin is not an operator choice: it is the
// canonical origin itself (DR-2026-08-04). One value, not two that must be kept in step.
export const STABLE_ORIGIN = IDENTIFIER_ORIGIN;
export const MANIFEST_FILE_NAME = 'manifest.json';
export const MANIFEST_MEDIA_TYPE = 'application/json';

// `jinnIdentifierServedPath` owns the canonical path-shape rule. Its rules are
// origin-independent, so an identifier under any origin is rebased onto the origin
// that helper knows and handed straight to it -- the rule is reused, never restated.
// That origin is imported rather than restated: the helper rejects the retired apex
// by name, so a stale local copy would fail every document rather than none.

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

// --- pure logic (no I/O, never throws) --------------------------------------

/** @returns {{ origin: string } | { error: string }} */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return { error: 'origin is required' };
  const trimmed = value.trim().replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `origin is not a URL: ${value}` };
  }
  if (parsed.protocol !== 'https:') return { error: `origin must be https, got ${value}` };
  if (parsed.origin !== trimmed) return { error: `origin must be a bare https origin, got ${value}` };
  return { origin: parsed.origin };
}

/** Under the stable lane the origin is not an operator choice. */
export function originForLane(value, lane) {
  if (lane !== 'canary' && lane !== 'stable') return { error: `lane must be canary or stable, got ${String(lane)}` };
  const normalized = normalizeOrigin(value);
  if (normalized.error) return normalized;
  if (lane === 'stable' && normalized.origin !== STABLE_ORIGIN) {
    return { error: `stable lane must verify ${STABLE_ORIGIN}, got ${normalized.origin}` };
  }
  return normalized;
}

/** Type/subtype of a Content-Type header, lowercased, parameters dropped. */
export function parseMediaType(value) {
  if (typeof value !== 'string') return null;
  const base = value.split(';')[0].trim().toLowerCase();
  return base === '' ? null : base;
}

export function mediaTypeMatches(headerValue, expected) {
  const actual = parseMediaType(headerValue);
  return actual !== null && actual === parseMediaType(expected);
}

/**
 * Resolve one identifier to the path it must be served at.
 *
 * `identifierOrigin` is the origin identifiers are expected to *name*, never the origin
 * they are fetched from -- the caller composes the served path onto that separately.
 * @returns {{ servedPath: string } | { error: string }}
 */
export function servedPathForIdentifier(identifier, identifierOrigin = IDENTIFIER_ORIGIN, label = 'Jinn identifier') {
  // The retired apex is handed straight to the path rule, which rejects it by name. Left
  // to the generic guard below it would read as "not under spec.jinn.network", which is
  // true but says nothing about why.
  if (typeof identifier === 'string' && identifier.startsWith(RETIRED_IDENTIFIER_ORIGIN)) {
    try {
      return { servedPath: jinnIdentifierServedPath(identifier, label) };
    } catch (error) {
      return { error: error?.message ?? String(error) };
    }
  }
  if (typeof identifier !== 'string' || !identifier.startsWith(`${identifierOrigin}/`)) {
    return { error: `${label} is not under ${identifierOrigin}` };
  }
  let parsed;
  try {
    parsed = new URL(identifier);
  } catch {
    return { error: `${label} is not a URL: ${identifier}` };
  }
  if (parsed.href !== identifier || parsed.origin !== identifierOrigin) {
    return { error: `${label} is not a canonical ${identifierOrigin} identifier: ${identifier}` };
  }
  try {
    return {
      servedPath: jinnIdentifierServedPath(
        `${CANONICAL_IDENTIFIER_ORIGIN}${identifier.slice(identifierOrigin.length + 1)}`,
        label,
      ),
    };
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

/**
 * A served document's self-identifying claim, under the same rule the profile
 * builder applied: JSON only, fixtures excluded (a fixture's `profile` names the
 * vocabulary a record instance conforms to, not where the fixture is served).
 *
 * `identifierOrigin` is the origin a claim must *name* to be a claim about where this
 * document lives, and it defaults to the canonical one. It is deliberately not the
 * verification origin: keying on the latter meant that verifying any origin but
 * spec.jinn.network silently found no claims at all and checked nothing -- a guard that
 * passes precisely because it is testing nothing. A claim naming the retired apex is
 * still a claim here, so it surfaces as a named refusal rather than as that same silence.
 * @returns {{ identifier: string, field: string } | { error: string } | null}
 */
export function selfIdentifyingClaim(servedPath, bytes, identifierOrigin = IDENTIFIER_ORIGIN) {
  if (!servedPath.endsWith('.json') || servedPath.split('/').includes('fixtures')) return null;
  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { error: `${servedPath} is served as JSON but does not parse` };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const claims = [];
  for (const field of ['$id', 'profile']) {
    const identifier = document[field];
    if (typeof identifier !== 'string') continue;
    if (identifier.startsWith(`${identifierOrigin}/`) || identifier.startsWith(RETIRED_IDENTIFIER_ORIGIN)) {
      claims.push({ field, identifier });
    }
  }
  if (claims.length > 1) {
    return { error: `${servedPath} declares multiple self-identifying claims under ${identifierOrigin}` };
  }
  return claims[0] ?? null;
}

/**
 * Canonical SHA-256 of a public key: the key is re-exported as SPKI PEM before
 * digesting, so line endings and trailing whitespace in the published file cannot
 * change the pinned value.
 * @returns {{ sha256: string, pem: string } | { error: string }}
 */
export function canonicalPublicKeySha256(pem) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    return { error: `published public key is not a readable key: ${error?.message ?? String(error)}` };
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    return { error: `published public key must be ed25519, got ${String(key.asymmetricKeyType)}` };
  }
  const canonical = key.export({ type: 'spki', format: 'pem' }).toString();
  return { sha256: createHash('sha256').update(canonical).digest('hex'), pem: canonical };
}

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function checkReceiptIdentity(receipt, { sourceSha, catalogDigest, releaseGroup, lane }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, reason: 'verification receipt is not an object' };
  }
  const mismatches = [
    ['source SHA', receipt.sourceSha, sourceSha],
    ['catalog digest', receipt.catalog?.sha256, catalogDigest],
    ['release group', receipt.releaseGroup, releaseGroup],
    ['lane', receipt.lane, lane],
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length > 0) {
    const [field, actual, expected] = mismatches[0];
    return { ok: false, reason: `verification receipt ${field} is ${String(actual)}, expected ${String(expected)}` };
  }
  const conclusions = receipt.conclusions;
  if (!conclusions || typeof conclusions !== 'object' || Array.isArray(conclusions)
    || Object.keys(conclusions).length === 0) {
    return { ok: false, reason: 'verification receipt declares no gate conclusions' };
  }
  for (const [gate, conclusion] of Object.entries(conclusions).sort()) {
    if (conclusion !== 'success') {
      return { ok: false, reason: `verification receipt gate ${gate} is ${String(conclusion)}, not success` };
    }
  }
  return { ok: true };
}

// --- I/O shell (fetch injected; default global fetch) -----------------------

const sleep = (ms) => (ms > 0 ? new Promise((done) => { setTimeout(done, ms); }) : Promise.resolve());

function transportRetryable(status) {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * One exact GET. Redirects are never followed: a redirect is a hosting defect, so
 * it must surface as a non-200 status rather than be silently resolved.
 * Retries absorb transport flakiness only -- a 2xx, 3xx or ordinary 4xx answer is
 * returned as-is on the first attempt and never retried.
 * @returns {{ status: number, headers: Headers, bytes: Buffer } | { error: string }}
 */
async function getExact(url, { fetchImpl, timeoutMs, attempts, retryDelayMs }) {
  let last = `GET ${url} failed`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (transportRetryable(response.status) && attempt < attempts) {
        last = `GET ${url} returned ${response.status}`;
        await sleep(retryDelayMs);
        continue;
      }
      return {
        status: response.status,
        redirected: response.redirected === true,
        headers: response.headers,
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    } catch (error) {
      last = `GET ${url} network error: ${error?.message ?? String(error)}`;
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  return { error: last };
}

/** A single fetched document must be 200, undirected, exact media type and exact bytes. */
function checkServedResponse(response, url, { mediaType, bytes }) {
  if (response.error) return response.error;
  if (response.status !== 200) return `${url} returned ${response.status}, expected 200`;
  if (response.redirected) return `${url} was redirected; the host must serve manifest paths exactly`;
  const contentType = response.headers?.get?.('content-type');
  if (!mediaTypeMatches(contentType, mediaType)) {
    return `${url} served content-type ${String(contentType)}, expected ${mediaType}`;
  }
  if (Buffer.compare(response.bytes, bytes) !== 0) {
    return `${url} bytes differ from the attested artifact (served sha256 ${createHash('sha256').update(response.bytes).digest('hex')}, attested ${createHash('sha256').update(bytes).digest('hex')})`;
  }
  return null;
}

/** Run `worker` over `items` with bounded concurrency, stopping at the first failure. */
async function pooled(items, limit, worker) {
  let cursor = 0;
  let failure = null;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === null) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const reason = await worker(items[index]);
      if (reason) failure = reason;
    }
  });
  await Promise.all(runners);
  return failure;
}

const fail = (reason) => ({ ok: false, reason });

export async function verifyLiveProfileHost({
  profileRoot,
  receipt,
  receiptSha256,
  sourceSha,
  catalogDigest,
  releaseGroup,
  lane,
  origin: requestedOrigin,
  publicKeyUrl,
  expectPublicKeySha256,
  resolvableIdentifiers = [],
  fetch: fetchImpl = globalThis.fetch,
  concurrency = 8,
  timeoutMs = 20000,
  attempts = 3,
  retryDelayMs = 500,
  run = {},
  now = () => new Date(),
}) {
  // --- 0. inputs -----------------------------------------------------------
  if (!COMMIT_SHA.test(String(sourceSha))) return fail('--source-sha must be a 40-character lowercase commit SHA');
  if (!SHA256.test(String(catalogDigest))) return fail('--catalog-digest must be a lowercase SHA-256 digest');
  if (!SHA256.test(String(expectPublicKeySha256))) {
    return fail('--expect-public-key-sha256 must be a lowercase SHA-256 digest');
  }
  if (typeof publicKeyUrl !== 'string' || !publicKeyUrl.startsWith('https://')) {
    return fail('--public-key-url must be an https URL');
  }
  const resolvedOrigin = originForLane(requestedOrigin, lane);
  if (resolvedOrigin.error) return fail(resolvedOrigin.error);
  const origin = resolvedOrigin.origin;
  const options = { fetchImpl, timeoutMs, attempts, retryDelayMs };
  const once = { fetchImpl, timeoutMs, attempts: 1, retryDelayMs: 0 };

  // --- 1. receipt identity -------------------------------------------------
  const identity = checkReceiptIdentity(receipt, { sourceSha, catalogDigest, releaseGroup, lane });
  if (!identity.ok) return fail(identity.reason);

  // --- 2. same-run binding: the local root is the artifact the receipt names --
  const root = resolve(profileRoot);
  const localManifestPath = join(root, MANIFEST_FILE_NAME);
  if (!existsSync(localManifestPath)) return fail(`attested profile root has no ${MANIFEST_FILE_NAME}: ${profileRoot}`);
  const localManifestBytes = readFileSync(localManifestPath);
  const localManifestSha256 = createHash('sha256').update(localManifestBytes).digest('hex');
  const profileSurface = receipt.surfaces?.profile;
  if (localManifestSha256 !== profileSurface?.manifestSha256) {
    return fail('local profile manifest is not the artifact the verification receipt names');
  }
  let localManifest;
  try {
    localManifest = JSON.parse(localManifestBytes.toString('utf8'));
  } catch {
    return fail(`local ${MANIFEST_FILE_NAME} is not valid JSON`);
  }
  if (canonicalJsonBytes(localManifest.documents) !== canonicalJsonBytes(profileSurface.documents)) {
    return fail('local profile manifest documents differ from the verification receipt inventory');
  }
  const localSignaturePath = join(root, SIGNATURE_FILE_NAME);
  if (!existsSync(localSignaturePath)) {
    return fail(`attested profile root has no ${SIGNATURE_FILE_NAME}; a live host must serve a signed manifest`);
  }
  const localSignatureBytes = readFileSync(localSignaturePath);
  const localSignatureSha256 = createHash('sha256').update(localSignatureBytes).digest('hex');
  if (localSignatureSha256 !== profileSurface.signature?.sha256) {
    return fail('local profile manifest signature is not the sidecar the verification receipt names');
  }

  // --- 3. the hosted manifest ----------------------------------------------
  const manifestUrl = `${origin}/${MANIFEST_FILE_NAME}`;
  const hostedManifest = await getExact(manifestUrl, options);
  const manifestFailure = checkServedResponse(hostedManifest, manifestUrl, {
    mediaType: MANIFEST_MEDIA_TYPE,
    bytes: localManifestBytes,
  });
  if (manifestFailure) return fail(manifestFailure);

  // --- 4. the hosted signature and the published key ------------------------
  const signatureUrl = `${origin}/${SIGNATURE_FILE_NAME}`;
  const hostedSignature = await getExact(signatureUrl, options);
  const signatureFailure = checkServedResponse(hostedSignature, signatureUrl, {
    mediaType: MANIFEST_MEDIA_TYPE,
    bytes: localSignatureBytes,
  });
  if (signatureFailure) return fail(signatureFailure);

  let envelope;
  try {
    envelope = JSON.parse(hostedSignature.bytes.toString('utf8'));
  } catch {
    return fail(`${signatureUrl} is not valid JSON`);
  }
  if (envelope?.payloadType !== PAYLOAD_TYPE) {
    return fail(`${signatureUrl} payload type is ${String(envelope?.payloadType)}, expected ${PAYLOAD_TYPE}`);
  }
  if (typeof envelope.payload !== 'string') return fail(`${signatureUrl} payload must be a base64 string`);
  if (Buffer.compare(Buffer.from(envelope.payload, 'base64'), hostedManifest.bytes) !== 0) {
    return fail(`${signatureUrl} does not envelope the exact bytes the host serves at ${manifestUrl}`);
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    return fail(`${signatureUrl} carries no signature`);
  }
  const keyids = envelope.signatures.map(({ keyid }) => keyid);
  if (keyids.some((keyid) => typeof keyid !== 'string' || keyid.length === 0)) {
    return fail(`${signatureUrl} does not name its key id`);
  }

  const publicKeyResponse = await getExact(publicKeyUrl, options);
  if (publicKeyResponse.error) return fail(publicKeyResponse.error);
  if (publicKeyResponse.status !== 200) {
    return fail(`${publicKeyUrl} returned ${publicKeyResponse.status}, expected 200`);
  }
  const publicKey = canonicalPublicKeySha256(publicKeyResponse.bytes.toString('utf8'));
  if (publicKey.error) return fail(publicKey.error);
  if (publicKey.sha256 !== expectPublicKeySha256) {
    return fail(`${publicKeyUrl} SPKI PEM sha256 is ${publicKey.sha256}, expected ${expectPublicKeySha256}`);
  }
  if (!verifyEnvelope(envelope, publicKey.pem)) {
    return fail(`${signatureUrl} does not verify against the key published at ${publicKeyUrl}`);
  }

  // --- 5/6. every document, and its own self-identifying claim -------------
  const documents = localManifest.documents;
  const documentFailure = await pooled(documents, concurrency, async ({ path, sha256, mediaType }) => {
    try {
      assertLiteralRoutePath(path, 'profile manifest document path');
    } catch (error) {
      return error?.message ?? String(error);
    }
    const localBytes = readFileSync(join(root, ...path.split('/')));
    if (createHash('sha256').update(localBytes).digest('hex') !== sha256) {
      return `attested profile root document ${path} does not match its own manifest digest`;
    }
    const url = `${origin}/${path}`;
    const response = await getExact(url, options);
    const failure = checkServedResponse(response, url, { mediaType, bytes: localBytes });
    if (failure) return failure;

    // Identity resolves canonically; the served path it yields is compared with the path
    // this document was actually fetched from at the origin under verification.
    const claim = selfIdentifyingClaim(path, response.bytes);
    if (claim?.error) return claim.error;
    if (claim) {
      const derived = servedPathForIdentifier(claim.identifier, IDENTIFIER_ORIGIN, `${path} ${claim.field}`);
      if (derived.error) return derived.error;
      if (derived.servedPath !== path) {
        return `${url} declares ${claim.field} ${claim.identifier}, which resolves to ${derived.servedPath}, not ${path}`;
      }
    }
    return null;
  });
  if (documentFailure) return fail(documentFailure);

  // --- 7. the registered identifiers actually dereference -------------------
  const servedPaths = new Set(documents.map(({ path }) => path));
  const releasePackages = new Set(localManifest.packages ?? []);
  const registered = resolvableIdentifiers.filter((entry) => releasePackages.has(entry?.owner));
  for (const entry of registered) {
    // Registered identifiers are canonical protocol names, so they resolve against the
    // canonical origin and are then dereferenced at the origin under verification.
    const derived = servedPathForIdentifier(
      entry.identifier,
      IDENTIFIER_ORIGIN,
      `resolvableIdentifiers ${entry.identifier}`,
    );
    if (derived.error) return fail(derived.error);
    const identifierUrl = `${origin}/${derived.servedPath}`;
    if (entry.resolution === 'document') {
      const declared = documents.find(({ path }) => path === entry.entryPoint);
      if (!declared) return fail(`${entry.identifier} names entry point ${entry.entryPoint}, which is not a served document`);
      if (derived.servedPath !== entry.entryPoint) {
        return fail(`${entry.identifier} resolves to ${derived.servedPath}, not its entry point ${entry.entryPoint}`);
      }
      const response = await getExact(identifierUrl, options);
      const failure = checkServedResponse(response, identifierUrl, {
        mediaType: declared.mediaType,
        bytes: readFileSync(join(root, ...declared.path.split('/'))),
      });
      if (failure) return fail(failure);
    } else if (entry.resolution === 'prefix') {
      if (servedPaths.has(derived.servedPath)) {
        return fail(`${entry.identifier} is registered as a prefix but the manifest serves a document at it`);
      }
      const bare = await getExact(identifierUrl, once);
      if (bare.error) return fail(bare.error);
      if (bare.status === 200) {
        return fail(`${identifierUrl} is a registered prefix but the host answers 200 at the bare identifier`);
      }
      const declared = documents.find(({ path }) => path === entry.entryPoint);
      if (!declared) return fail(`${entry.identifier} names entry point ${entry.entryPoint}, which is not a served document`);
      const entryUrl = `${origin}/${entry.entryPoint}`;
      const response = await getExact(entryUrl, options);
      const failure = checkServedResponse(response, entryUrl, {
        mediaType: declared.mediaType,
        bytes: readFileSync(join(root, ...declared.path.split('/'))),
      });
      if (failure) return fail(failure);
    } else {
      return fail(`${entry.identifier} declares unknown resolution ${String(entry.resolution)}`);
    }
  }

  // --- 8. anti-fallback probes ---------------------------------------------
  // A catch-all that answers 200 for everything makes every check above vacuous.
  const probes = [
    `${origin}/${randomUUID()}`,
    `${origin}/${MANIFEST_FILE_NAME}.sha256`,
    `${origin}/@jinn-network/not-a-published-package-${randomUUID()}/package.json`,
  ];
  for (const probe of probes) {
    const response = await getExact(probe, once);
    if (response.error) return fail(`anti-fallback probe could not be completed: ${response.error}`);
    if (response.status === 200) {
      return fail(`${probe} answers 200; the host has a catch-all that makes byte verification vacuous`);
    }
  }

  // --- 9. the live-host receipt --------------------------------------------
  const liveHostReceipt = {
    schemaVersion: 1,
    origin,
    sourceSha,
    catalogDigest,
    releaseGroup,
    lane,
    verificationReceiptSha256: receiptSha256,
    profileManifestSha256: localManifestSha256,
    documentsVerified: documents.length,
    resolvableIdentifiersVerified: registered.length,
    signature: {
      sidecarSha256: localSignatureSha256,
      keyids,
      publicKeyUrl,
      publicKeySha256: publicKey.sha256,
    },
    run: { id: run.id ?? null, url: run.url ?? null },
    verifiedAt: now().toISOString(),
  };
  return {
    ok: true,
    reason: `${origin} serves the attested manifest, ${documents.length} documents and a verifying signature`,
    receipt: liveHostReceipt,
  };
}

// --- CLI entry (guarded so `import` is side-effect-free) ---------------------

export function parseArgs(argv) {
  const fields = new Map([
    ['--root', 'profileRoot'],
    ['--receipt', 'receiptPath'],
    ['--repo-root', 'repoRoot'],
    ['--source-sha', 'sourceSha'],
    ['--catalog-digest', 'catalogDigest'],
    ['--release-group', 'releaseGroup'],
    ['--lane', 'lane'],
    ['--origin', 'origin'],
    ['--public-key-url', 'publicKeyUrl'],
    ['--expect-public-key-sha256', 'expectPublicKeySha256'],
    ['--out', 'outputPath'],
  ]);
  const parsed = { repoRoot: process.cwd(), releaseGroup: 'platform-v1', origin: STABLE_ORIGIN };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const field = fields.get(flag);
    if (!field) throw new Error(`unknown argument: ${flag}`);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    parsed[field] = value;
  }
  for (const [field, flag] of [
    ['profileRoot', '--root'],
    ['receiptPath', '--receipt'],
    ['sourceSha', '--source-sha'],
    ['catalogDigest', '--catalog-digest'],
    ['lane', '--lane'],
    ['publicKeyUrl', '--public-key-url'],
    ['expectPublicKeySha256', '--expect-public-key-sha256'],
    ['outputPath', '--out'],
  ]) {
    if (!parsed[field]) throw new Error(`${flag} is required`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    const receiptBytes = readFileSync(resolve(args.receiptPath));
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    // The register lives in the catalog; binding the checkout's catalog digest to the
    // receipt's is what makes reading it here as trustworthy as reading the receipt.
    const actualCatalogDigest = catalogSha256(resolve(args.repoRoot));
    if (actualCatalogDigest !== args.catalogDigest) {
      throw new Error(`checked-out catalog digest is ${actualCatalogDigest}, expected ${args.catalogDigest}`);
    }
    result = await verifyLiveProfileHost({
      ...args,
      receipt,
      receiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
      resolvableIdentifiers: loadPlatformCatalog(resolve(args.repoRoot)).resolvableIdentifiers ?? [],
      run: {
        id: process.env.GITHUB_RUN_ID ?? null,
        url: process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
          ? `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
      },
    });
    if (result.ok) {
      const outputPath = resolve(args.outputPath);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, canonicalJsonBytes(result.receipt), 'utf8');
    }
  } catch (error) {
    result = fail(error?.message ?? String(error));
  }
  console.log(result.ok ? `OK: ${result.reason}` : `FAIL: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}
