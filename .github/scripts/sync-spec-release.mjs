#!/usr/bin/env node
// Vendor one release of the protocol specification into this tree.
//
// The protocol's documents are authored in Jinn-Network/spec, and this repository consumes
// one pinned release of them (DR-2026-09-03 decision 1). This script is the only sanctioned
// way a vendored byte changes. Given a release tag it reads the release's signed group
// manifests and its documents, verifies them, maps every document to its place in this
// tree, and writes the bytes, a provenance manifest, a copy of the signed manifests, and
// the catalog's pin. With --check it writes nothing and reports what a write would change.
//
// Design commitments, in the order they matter:
//
//   * Everything is verified before anything is written. A release is read whole, checked
//     whole, and planned whole; the first write happens only after the last check.
//   * There is no skip. A missing or mismatching signature, digest, or mapping is an
//     error. So is a document the manifests do not list, and so is a provenance row the
//     release no longer ships.
//   * The trust anchor is never fetched and never inferred. The signing key's identity is
//     its key id and the SHA-256 of its canonical SPKI PEM. It comes from the catalog's
//     pin, or from the command line while the catalog pins nothing, and the key's bytes
//     come from a local file that must hash to that identity.
//   * Provenance rows are the mapping of record. A released document goes where its row
//     says. A document with no row is an error unless --adopt is passed, and --adopt only
//     accepts what the tree itself can show: the file this repository already serves at
//     that path, or, for a path scoped by the source package's name, the same relative
//     path inside that package's declared fixtures, schemas, or profiles.
//
// Fetching is the only network I/O and it is one function. Handed a release directory
// instead of a tag to fetch, the whole sync runs offline, which is how the test suite
// drives it against a release it builds itself. The CLI entry is guarded so `import` is
// side-effect-free.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAYLOAD_TYPE, canonicalPublicKeySha256, verifyEnvelope } from './dsse.mjs';
import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
  loadPlatformCatalog,
  stackPublishedReleaseGroupIds,
  validatePlatformCatalog,
} from './platform-catalog.mjs';
import {
  CANONICAL_IDENTIFIER_ORIGIN,
  enumeratePublicSurfaceAssets,
  hasGitControlSegment,
  jinnIdentifierServedPath,
  publicSurfaceServedPath,
} from './public-surface-assets.mjs';

const SPEC_REPOSITORY = 'Jinn-Network/spec';
export const PROVENANCE_PATH = 'architecture/spec-provenance.v1.json';
export const RELEASE_COPY_DIRECTORY = 'architecture/spec-release';
const SIGNING_KEY_DIRECTORY = '.github/keys';

const RELEASE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const RELEASE_ASSET = /^(.+)\.manifest(?:\.dsse)?\.json$/u;
const VENDORED_SURFACE_FIELDS = ['schemas', 'profiles', 'fixtures'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestAsset = (group) => `${group}.manifest.json`;
const envelopeAsset = (group) => `${group}.manifest.dsse.json`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function listed(paths, limit = 20) {
  const shown = paths.slice(0, limit).map((path) => `\n  ${path}`).join('');
  return paths.length > limit ? `${shown}\n  and ${paths.length - limit} more` : shown;
}

// The entry at `relativePath` below `base`, or a null stat when nothing is there yet. A
// symbolic link anywhere on the way is refused: it would let a release, or a checkout,
// redirect a read or a write outside the tree it claims to name.
function inspectPath(base, relativePath, label) {
  let current = base;
  let stat = null;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return { absolute: resolve(base, ...relativePath.split('/')), stat: null };
      throw new Error(`${label} ${relativePath} cannot be read: ${error?.message ?? String(error)}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} ${relativePath} crosses a symbolic link`);
  }
  return { absolute: current, stat };
}

function readRegularFile(base, relativePath, label) {
  const { absolute, stat } = inspectPath(base, relativePath, label);
  if (!stat) throw new Error(`${label} ${relativePath} is missing`);
  if (!stat.isFile()) throw new Error(`${label} ${relativePath} is not a regular file`);
  return readFileSync(absolute);
}

function requireRepositoryPath(value, label) {
  const segments = typeof value === 'string' ? value.split('/') : [''];
  if (typeof value !== 'string'
    || value.includes('\\')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || hasGitControlSegment(value)) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return value;
}

// A served path answers to the same path law the origin's own builder applies, so a signed
// manifest cannot name `..`, a Git control file, or a group's root inventory as a document.
function requireServedPath(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} names no path`);
  return jinnIdentifierServedPath(`${CANONICAL_IDENTIFIER_ORIGIN}${value}`, `${label} path ${value}`);
}

function requireReleaseTag(tag) {
  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) {
    throw new Error(`a spec release tag is v<major>.<minor>.<patch>, got ${String(tag)}`);
  }
  return tag;
}

// --- the trust anchor --------------------------------------------------------

/**
 * The key identity a release must be signed by. The catalog's pin is the authority once it
 * exists; the command line supplies it only while the catalog pins nothing. Replacing a
 * pinned key is deliberately not something a sync does.
 * @returns {{ keyId: string, publicKeySha256: string }}
 */
function resolveKeyIdentity(catalog, { keyId, publicKeySha256 }) {
  const pinned = catalog.specPin?.signingKey ?? null;
  if (keyId === undefined && publicKeySha256 === undefined) {
    if (!pinned) {
      throw new Error(
        'no signing key is pinned: the catalog pins no spec release, so --key-id and --public-key-sha256 are required',
      );
    }
    return { keyId: pinned.keyId, publicKeySha256: pinned.publicKeySha256 };
  }
  if (keyId === undefined || publicKeySha256 === undefined) {
    throw new Error('--key-id and --public-key-sha256 must be given together');
  }
  if (!KEY_ID.test(String(keyId))) throw new Error(`--key-id must be one literal path segment, got ${String(keyId)}`);
  if (!SHA256.test(String(publicKeySha256))) {
    throw new Error('--public-key-sha256 must be a lowercase SHA-256 digest');
  }
  if (pinned && (pinned.keyId !== keyId || pinned.publicKeySha256 !== publicKeySha256)) {
    throw new Error(
      `the catalog pins signing key ${pinned.keyId} (${pinned.publicKeySha256}); a sync does not replace a pinned key`,
    );
  }
  return { keyId, publicKeySha256 };
}

/** The key's bytes, accepted only when they hash to the pinned identity. */
function loadSigningKey(path, identity) {
  let pem;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the signing public key ${path}: ${error?.message ?? String(error)}`);
  }
  const canonical = canonicalPublicKeySha256(pem);
  if (canonical.error) throw new Error(`${path}: ${canonical.error}`);
  if (canonical.sha256 !== identity.publicKeySha256) {
    throw new Error(
      `${path} has SPKI PEM sha256 ${canonical.sha256}, but the pinned key ${identity.keyId} is ${identity.publicKeySha256}`,
    );
  }
  return { ...identity, pem: canonical.pem };
}

// --- reading and verifying a release (no network) ----------------------------

function verifyManifestEnvelope({ group, manifestBytes, envelopeBytes, key }) {
  const label = envelopeAsset(group);
  let envelope;
  try {
    envelope = JSON.parse(envelopeBytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isObject(envelope) || envelope.payloadType !== PAYLOAD_TYPE) {
    throw new Error(`${label} payload type is ${String(envelope?.payloadType)}, expected ${PAYLOAD_TYPE}`);
  }
  if (typeof envelope.payload !== 'string') throw new Error(`${label} payload must be a base64 string`);
  if (!Buffer.from(envelope.payload, 'base64').equals(manifestBytes)) {
    throw new Error(`${label} does not envelope the exact bytes of ${manifestAsset(group)}`);
  }
  // Only a signature that names the pinned key id counts. `verifyEnvelope` accepts any
  // signature that verifies, so it is handed the pinned key's signatures and nothing else.
  const signatures = Array.isArray(envelope.signatures)
    ? envelope.signatures.filter((signature) => signature?.keyid === key.keyId)
    : [];
  if (signatures.length === 0) throw new Error(`${label} carries no signature by the pinned key ${key.keyId}`);
  if (!verifyEnvelope({ ...envelope, signatures }, key.pem)) {
    throw new Error(`${label} does not verify against the pinned key ${key.keyId}`);
  }
}

function parseManifest(group, manifestBytes) {
  const label = manifestAsset(group);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isObject(manifest) || manifest.version !== 1) {
    throw new Error(`${label} has manifest version ${String(manifest?.version)}, expected 1`);
  }
  if (manifest.releaseGroup !== group) {
    throw new Error(`${label} names release group ${String(manifest.releaseGroup)}, expected ${group}`);
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new Error(`${label} lists no documents`);
  }
  return manifest.documents.map((entry, index) => {
    const at = `${label} documents[${index}]`;
    if (!isObject(entry)) throw new Error(`${at} must be an object`);
    const path = requireServedPath(entry.path, at);
    if (!SHA256.test(String(entry.sha256))) throw new Error(`${at} (${path}) carries no lowercase SHA-256 digest`);
    if (typeof entry.sourcePackage !== 'string' || entry.sourcePackage === '') {
      throw new Error(`${at} (${path}) names no source package`);
    }
    return { group, path, sha256: entry.sha256, sourcePackage: entry.sourcePackage };
  });
}

function walkDocuments(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkDocuments(join(directory, entry.name), relativePath, found);
    else if (entry.isFile()) found.push(relativePath);
    else throw new Error(`release document ${relativePath} is not a regular file`);
  }
  return found;
}

/**
 * Read one release from disk and verify it against the pinned key.
 *
 * `manifestsDir` holds each group's `<group>.manifest.json` and `<group>.manifest.dsse.json`,
 * named as the release attaches them; `documentsDir` mirrors the served paths. Every group in
 * `groups` must be present and signed, no other group may be, every listed document must
 * hash to the digest its manifest names, and no unlisted document may exist.
 */
function readRelease({ manifestsDir, documentsDir, groups, key }) {
  const documents = new Map();
  const groupRecords = {};
  for (const group of groups) {
    const manifestBytes = readRegularFile(manifestsDir, manifestAsset(group), 'release asset');
    const envelopeBytes = readRegularFile(manifestsDir, envelopeAsset(group), 'release asset');
    verifyManifestEnvelope({ group, manifestBytes, envelopeBytes, key });
    for (const entry of parseManifest(group, manifestBytes)) {
      const earlier = documents.get(entry.path);
      if (earlier) {
        throw new Error(`${entry.path} is listed more than once (${earlier.group} and ${group})`);
      }
      const bytes = readRegularFile(documentsDir, entry.path, 'release document');
      const actual = sha256(bytes);
      if (actual !== entry.sha256) {
        throw new Error(
          `release document ${entry.path} has sha256 ${actual}, but ${manifestAsset(group)} names ${entry.sha256}`,
        );
      }
      documents.set(entry.path, { ...entry, bytes });
    }
    groupRecords[group] = { manifestBytes, envelopeBytes, manifestSha256: sha256(manifestBytes) };
  }
  const unexpectedGroups = [...new Set(readdirSync(manifestsDir)
    .map((name) => RELEASE_ASSET.exec(name)?.[1])
    .filter((group) => group !== undefined && !groups.includes(group)))].sort();
  if (unexpectedGroups.length > 0) {
    throw new Error(
      `the release ships a manifest for ${unexpectedGroups.join(', ')}, which the catalog does not serve at the protocol origin`,
    );
  }
  const unlisted = walkDocuments(documentsDir, '', []).filter((path) => !documents.has(path)).sort();
  if (unlisted.length > 0) {
    throw new Error(`the release holds documents no signed manifest lists:${listed(unlisted)}`);
  }
  return {
    groups: groupRecords,
    documents: [...documents.values()].sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
}

// --- provenance ---------------------------------------------------------------

/** The committed provenance rows, or null when no release has been vendored yet. */
function readProvenance(repoRoot) {
  const { absolute, stat } = inspectPath(repoRoot, PROVENANCE_PATH, 'provenance manifest');
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`${PROVENANCE_PATH} is not a regular file`);
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    throw new Error(`${PROVENANCE_PATH} is not valid JSON`);
  }
  if (!isObject(provenance) || provenance.schemaVersion !== 1 || !Array.isArray(provenance.documents)) {
    throw new Error(`${PROVENANCE_PATH} is not a version 1 provenance manifest`);
  }
  const servedPaths = new Set();
  const repoPaths = new Set();
  for (const [index, row] of provenance.documents.entries()) {
    const at = `${PROVENANCE_PATH} documents[${index}]`;
    if (!isObject(row)) throw new Error(`${at} must be an object`);
    requireServedPath(row.servedPath, at);
    requireRepositoryPath(row.repoPath, `${at} repoPath`);
    if (!SHA256.test(String(row.sha256))) throw new Error(`${at} carries no lowercase SHA-256 digest`);
    if (typeof row.release !== 'string' || !RELEASE_TAG.test(row.release)) {
      throw new Error(`${at} names no release it came from`);
    }
    if (servedPaths.has(row.servedPath)) throw new Error(`${at} repeats served path ${row.servedPath}`);
    if (repoPaths.has(row.repoPath)) throw new Error(`${at} repeats repository path ${row.repoPath}`);
    servedPaths.add(row.servedPath);
    repoPaths.add(row.repoPath);
  }
  return provenance;
}

function pinOf({ tag, key, release }) {
  return {
    tag,
    groups: Object.fromEntries(Object.entries(release.groups).map(([group, record]) => [
      group,
      { manifestSha256: record.manifestSha256 },
    ])),
    signingKey: { keyId: key.keyId, publicKeySha256: key.publicKeySha256 },
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// --- mapping ------------------------------------------------------------------

// Where an unmapped document goes, read from the tree and never guessed. First: the file
// this repository already serves at that path, under the one served-path law the profile
// builder applies. Second, for a document this tree does not hold yet: a path scoped by
// its source package's name is that same relative path inside the package. Anything else
// has no rule, so it is refused and named.
function createAdopter(repoRoot, packages) {
  const servedInTree = new Map();
  for (const asset of enumeratePublicSurfaceAssets({ repoRoot, packages, validateUniqueClaims: false })) {
    if (!VENDORED_SURFACE_FIELDS.includes(asset.kind)) continue;
    const key = `${asset.package} ${publicSurfaceServedPath(asset)}`;
    servedInTree.set(key, [...(servedInTree.get(key) ?? []), asset.path]);
  }
  return (pkg, servedPath) => {
    const inTree = servedInTree.get(`${pkg.name} ${servedPath}`) ?? [];
    if (inTree.length > 1) {
      throw new Error(`${servedPath} is served by more than one file of ${pkg.name}: ${inTree.join(', ')}`);
    }
    if (inTree.length === 1) return inTree[0];
    const scope = `${pkg.name}/`;
    return servedPath.startsWith(scope) ? `${pkg.directory}/${servedPath.slice(scope.length)}` : null;
  };
}

function assertInsideVendoredSurface(pkg, repoPath, servedPath) {
  requireRepositoryPath(repoPath, `the repository path for ${servedPath}`);
  const roots = VENDORED_SURFACE_FIELDS.flatMap((field) => pkg.catalog.publicSurface[field]);
  if (!roots.some((root) => repoPath.startsWith(`${pkg.directory}/${root}/`))) {
    throw new Error(
      `${servedPath} maps to ${repoPath}, which is outside the schemas, profiles, and fixtures ${pkg.name} declares`,
    );
  }
}

// Key order is what a reviewer reads, so the marker sits beside the surface it describes.
function withPinnedMarker(pkg, pinned) {
  const entries = Object.entries(pkg).filter(([key]) => key !== 'pinned');
  if (!pinned) return Object.fromEntries(entries);
  const at = entries.findIndex(([key]) => key === 'publicSurface') + 1;
  return Object.fromEntries([...entries.slice(0, at), ['pinned', true], ...entries.slice(at)]);
}

function pinnedCatalogBytes(repoRoot, pin, pinnedNames) {
  const current = readRegularFile(repoRoot, PLATFORM_CATALOG_PATH, 'catalog').toString('utf8');
  const catalog = JSON.parse(current);
  // The catalog is hand-authored. It is rewritten only when doing so changes nothing but
  // the pin, which holds exactly when the file is already in the form JSON.stringify emits.
  if (jsonBytes(catalog).toString('utf8') !== current) {
    throw new Error(`${PLATFORM_CATALOG_PATH} is not in canonical two-space JSON form; refusing to rewrite it`);
  }
  const next = {
    ...catalog,
    specPin: pin,
    packages: catalog.packages.map((pkg) => withPinnedMarker(pkg, pinnedNames.has(pkg.name))),
  };
  validatePlatformCatalog(next, { repoRoot });
  return jsonBytes(next);
}

function plannedWrite(repoRoot, kind, repoPath, bytes, extra = {}) {
  const { absolute, stat } = inspectPath(repoRoot, repoPath, 'write target');
  if (stat && !stat.isFile()) throw new Error(`write target ${repoPath} is not a regular file`);
  const treeSha256 = stat ? sha256(readFileSync(absolute)) : null;
  const action = treeSha256 === null ? 'create' : treeSha256 === sha256(bytes) ? 'identical' : 'change';
  return { kind, repoPath, bytes, action, treeSha256, sha256: sha256(bytes), ...extra };
}

/**
 * Decide everything a sync would write, and refuse if any document cannot be placed.
 * Reads the tree and writes nothing.
 */
function planSpecSync({ repoRoot, tag, key, release, adopt }) {
  const root = repoRoot;
  const catalog = loadPlatformCatalog(root);
  const packages = new Map(loadCatalogPackages(root).map((pkg) => [pkg.name, pkg]));
  const rows = new Map((readProvenance(root)?.documents ?? []).map((row) => [row.servedPath, row]));
  const released = new Set(release.documents.map(({ path }) => path));

  for (const document of release.documents) {
    const pkg = packages.get(document.sourcePackage);
    if (!pkg) {
      throw new Error(
        `${document.path} names source package ${document.sourcePackage}, which the catalog does not hold`,
      );
    }
    if (pkg.catalog.releaseGroup !== document.group) {
      throw new Error(
        `${document.path} is listed by ${document.group}, but its source package ${pkg.name} is in ${pkg.catalog.releaseGroup}`,
      );
    }
  }
  // A published release does not change. If the catalog already pins this tag, the release
  // must still be the bytes that were pinned; only a new tag moves the manifest digests.
  if (catalog.specPin?.tag === tag) {
    const pinnedGroups = Object.keys(catalog.specPin.groups).sort();
    if (pinnedGroups.join(' ') !== Object.keys(release.groups).sort().join(' ')) {
      throw new Error(
        `release ${tag} ships manifests for ${Object.keys(release.groups).sort().join(', ')}, but the catalog pins ${pinnedGroups.join(', ')} for that tag`,
      );
    }
    for (const group of pinnedGroups) {
      const pinnedDigest = catalog.specPin.groups[group].manifestSha256;
      if (release.groups[group].manifestSha256 !== pinnedDigest) {
        throw new Error(
          `release ${tag} ships a ${group} manifest with sha256 ${release.groups[group].manifestSha256}, but the catalog pins ${pinnedDigest} for that tag`,
        );
      }
    }
  }
  const orphans = [...rows.keys()].filter((servedPath) => !released.has(servedPath)).sort();
  if (orphans.length > 0) {
    throw new Error(`provenance rows name documents the release does not ship:${listed(orphans)}`);
  }

  const unmapped = release.documents.filter(({ path }) => !rows.has(path));
  const adopter = adopt && unmapped.length > 0
    ? createAdopter(root, [...new Set(unmapped.map(({ sourcePackage }) => sourcePackage))].sort()
      .map((name) => packages.get(name)))
    : null;
  const unplaced = [];
  const placed = new Map();
  const documents = [];
  for (const document of release.documents) {
    const pkg = packages.get(document.sourcePackage);
    const row = rows.get(document.path);
    const repoPath = row ? row.repoPath : adopter ? adopter(pkg, document.path) : null;
    if (repoPath === null) {
      unplaced.push(document.path);
      continue;
    }
    assertInsideVendoredSurface(pkg, repoPath, document.path);
    if (placed.has(repoPath)) {
      throw new Error(`${document.path} and ${placed.get(repoPath)} both map to ${repoPath}`);
    }
    placed.set(repoPath, document.path);
    documents.push({ ...document, repoPath, mapping: row ? 'row' : 'adopted' });
  }
  if (unplaced.length > 0) {
    throw new Error(adopt
      ? `no provenance row and no rule in this tree places these released documents:${listed(unplaced)}`
      : `these released documents have no provenance row (pass --adopt to map the ones this tree can place):${listed(unplaced)}`);
  }

  const pin = pinOf({ tag, key, release });
  const pinnedNames = new Set(documents.map(({ sourcePackage }) => sourcePackage));
  const writes = [
    ...documents.map((document) => plannedWrite(root, 'document', document.repoPath, document.bytes, {
      servedPath: document.path,
      mapping: document.mapping,
    })),
    ...Object.entries(release.groups).flatMap(([group, record]) => [
      plannedWrite(root, 'release', `${RELEASE_COPY_DIRECTORY}/${manifestAsset(group)}`, record.manifestBytes),
      plannedWrite(root, 'release', `${RELEASE_COPY_DIRECTORY}/${envelopeAsset(group)}`, record.envelopeBytes),
    ]),
    plannedWrite(root, 'provenance', PROVENANCE_PATH, jsonBytes({
      schemaVersion: 1,
      repository: SPEC_REPOSITORY,
      release: pin,
      documents: documents.map(({ path, repoPath, sha256: digest }) => ({
        servedPath: path,
        repoPath,
        sha256: digest,
        release: tag,
      })),
    })),
    plannedWrite(root, 'catalog', PLATFORM_CATALOG_PATH, pinnedCatalogBytes(root, pin, pinnedNames)),
  ];
  const wasPinned = new Set(catalog.packages.filter((pkg) => pkg.pinned === true).map(({ name }) => name));
  return {
    repository: SPEC_REPOSITORY,
    tag,
    pin,
    groups: Object.fromEntries(Object.entries(release.groups).map(([group, record]) => [group, {
      manifestSha256: record.manifestSha256,
      documents: documents.filter((document) => document.group === group).length,
    }])),
    writes,
    catalog: {
      pinBefore: catalog.specPin,
      marked: [...pinnedNames].filter((name) => !wasPinned.has(name)).sort(),
      unmarked: [...wasPinned].filter((name) => !pinnedNames.has(name)).sort(),
      pinned: [...pinnedNames].sort(),
    },
  };
}

/** Write a plan. Every target is inspected again, so a path that changed since planning is refused. */
function applySpecSync(repoRoot, plan) {
  for (const write of plan.writes) {
    if (write.action === 'identical') continue;
    const { absolute, stat } = inspectPath(repoRoot, write.repoPath, 'write target');
    if (stat && !stat.isFile()) throw new Error(`write target ${write.repoPath} is not a regular file`);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, write.bytes);
  }
}

export function formatReport(plan, { check }) {
  const of = (kind) => plan.writes.filter((write) => write.kind === kind);
  const count = (writes, action) => writes.filter((write) => write.action === action).length;
  const documents = of('document');
  const lines = [
    `spec release ${plan.repository} ${plan.tag}`,
    `signing key ${plan.pin.signingKey.keyId} (SPKI PEM sha256 ${plan.pin.signingKey.publicKeySha256})`,
    ...Object.entries(plan.groups).map(([group, record]) => (
      `${group}: signature verified, manifest sha256 ${record.manifestSha256}, ${record.documents} documents match their digests`
    )),
    `mapping: ${documents.filter(({ mapping }) => mapping === 'row').length} by provenance row, ${documents.filter(({ mapping }) => mapping === 'adopted').length} adopted from this tree`,
    `documents: ${count(documents, 'identical')} identical, ${count(documents, 'change')} to change, ${count(documents, 'create')} to create`,
    ...documents.filter(({ action }) => action !== 'identical').map((write) => (
      `  ${write.action} ${write.repoPath} (${write.treeSha256 ?? 'absent'} -> ${write.sha256})`
    )),
    ...[...of('release'), ...of('provenance')].map((write) => `${write.repoPath}: ${write.action}`),
    `${PLATFORM_CATALOG_PATH}: ${of('catalog')[0].action}`,
    `  specPin ${plan.catalog.pinBefore === null ? 'null' : plan.catalog.pinBefore.tag} -> ${plan.tag}`,
    `  pinned packages: ${plan.catalog.pinned.length} (${plan.catalog.marked.length} newly marked, ${plan.catalog.unmarked.length} unmarked)`,
    ...plan.catalog.marked.map((name) => `    mark ${name}`),
    ...plan.catalog.unmarked.map((name) => `    unmark ${name}`),
  ];
  const pending = plan.writes.filter((write) => write.action !== 'identical').length;
  lines.push(check
    ? `check only: nothing written; a sync would write ${pending} files`
    : `wrote ${pending} files`);
  return `${lines.join('\n')}\n`;
}

// --- fetching a release (the only network I/O) ---------------------------------

function defaultGit(args) {
  execFileSync('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

/**
 * Bring one release to disk in the layout `readRelease` reads: the signed manifests each
 * group attaches to the GitHub release, and the `documents/` tree at the tag. Nothing here
 * is trusted for being fetched; `readRelease` verifies every byte against the pinned key.
 */
export async function fetchRelease({
  tag,
  groups,
  into,
  repository = SPEC_REPOSITORY,
  fetch: fetchImpl = globalThis.fetch,
  runGit = defaultGit,
  timeoutMs = 60000,
}) {
  requireReleaseTag(tag);
  for (const name of groups.flatMap((group) => [manifestAsset(group), envelopeAsset(group)])) {
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`GET ${url} failed: ${error?.message ?? String(error)}`);
    }
    if (response.status !== 200) {
      throw new Error(`GET ${url} returned ${response.status}; release ${tag} must attach ${name}`);
    }
    writeFileSync(join(into, name), Buffer.from(await response.arrayBuffer()));
  }
  const source = join(into, 'source');
  try {
    // Line endings are bytes here: a checkout that converted them would fail every digest.
    runGit([
      '-c', 'core.autocrlf=false',
      'clone', '--quiet', '--depth', '1', '--branch', tag,
      `https://github.com/${repository}.git`, source,
    ]);
  } catch (error) {
    throw new Error(`cannot fetch ${repository} at ${tag}: ${error?.stderr?.toString().trim() || error?.message || String(error)}`);
  }
  const documentsDir = join(source, 'documents');
  let stat = null;
  try {
    stat = lstatSync(documentsDir);
  } catch {
    // Reported below: a release without the tree is not a release this script can vendor.
  }
  if (!stat?.isDirectory()) throw new Error(`${repository} at ${tag} has no documents directory`);
  return { manifestsDir: into, documentsDir };
}

// --- the whole sync ------------------------------------------------------------

export async function syncSpecRelease({
  repoRoot,
  tag,
  releaseDir,
  check = false,
  adopt = false,
  keyId,
  publicKeySha256,
  publicKeyPath,
  fetch: fetchImpl,
  runGit,
}) {
  const root = resolve(repoRoot);
  const catalog = loadPlatformCatalog(root);
  if (tag === undefined && catalog.specPin === null) {
    throw new Error('--tag is required: the catalog pins no spec release to sync');
  }
  const releaseTag = requireReleaseTag(tag ?? catalog.specPin.tag);
  const identity = resolveKeyIdentity(catalog, { keyId, publicKeySha256 });
  const key = loadSigningKey(
    publicKeyPath ?? join(root, ...SIGNING_KEY_DIRECTORY.split('/'), `${identity.keyId}.pub`),
    identity,
  );
  const groups = stackPublishedReleaseGroupIds(catalog);
  if (groups.length === 0) throw new Error('the catalog serves no release group at the protocol origin');
  let scratch = null;
  try {
    let source;
    if (releaseDir !== undefined) {
      source = { manifestsDir: resolve(releaseDir), documentsDir: resolve(releaseDir, 'documents') };
    } else {
      scratch = mkdtempSync(join(tmpdir(), 'jinn-spec-release-'));
      source = await fetchRelease({ tag: releaseTag, groups, into: scratch, fetch: fetchImpl, runGit });
    }
    const release = readRelease({ ...source, groups, key });
    const plan = planSpecSync({ repoRoot: root, tag: releaseTag, key, release, adopt });
    if (!check) applySpecSync(root, plan);
    return plan;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

const VALUE_FLAGS = new Map([
  ['--tag', 'tag'],
  ['--release-dir', 'releaseDir'],
  ['--root', 'repoRoot'],
  ['--key-id', 'keyId'],
  ['--public-key-sha256', 'publicKeySha256'],
  ['--public-key', 'publicKeyPath'],
]);

export function parseArgs(argv) {
  const parsed = { repoRoot: process.cwd(), check: false, adopt: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') parsed.check = true;
    else if (flag === '--adopt') parsed.adopt = true;
    else if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      parsed[VALUE_FLAGS.get(flag)] = value;
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return parsed;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = await syncSpecRelease(options);
    process.stdout.write(formatReport(plan, { check: options.check }));
  } catch (error) {
    process.stderr.write(`spec release sync failed: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
