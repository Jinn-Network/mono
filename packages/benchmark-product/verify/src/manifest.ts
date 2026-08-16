import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { EvidenceNativeBundleManifestV5Schema } from "@jinn-network/benchmarking-protocol";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "./profile/errors.js";

export const BUNDLE_FORMAT = "benchmark-product-public-bundle/2" as const;
export const BUNDLE_V4_FORMAT = "benchmark-product-public-bundle/4" as const;
export const BUNDLE_V5_FORMAT = "benchmark-product-public-bundle/5" as const;
export const SUPPORTED_BUNDLE_FORMATS = [BUNDLE_FORMAT, BUNDLE_V4_FORMAT, BUNDLE_V5_FORMAT] as const;
export const BUNDLE_MANIFEST_FILENAME = "bundle.json" as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;

export const BundleManifestFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX),
  bytes: z.number().int().nonnegative(),
});

const LegacyBundleManifestSchema = z.object({
  format: z.union([z.literal(BUNDLE_FORMAT), z.literal(BUNDLE_V4_FORMAT)]),
  files: z.array(BundleManifestFileSchema).min(1),
});

export const BundleManifestSchema = z.union([
  LegacyBundleManifestSchema,
  EvidenceNativeBundleManifestV5Schema,
]);

export type BundleManifest = z.infer<typeof BundleManifestSchema>;

export interface BuiltBundleManifest {
  readonly manifest: BundleManifest;
  readonly bytes: Uint8Array;
  readonly identity: string;
}

export interface VerifiedBundleSnapshot extends BuiltBundleManifest {
  /** Every authenticated file byte string, including bundle.json. Never backed by a pathname. */
  readonly fileBytes: ReadonlyMap<string, Uint8Array>;
}

export interface VerifyBundleSnapshotDeps {
  /** Deterministic adversarial boundary: every byte is already authenticated before this runs. */
  readonly afterManifestValidated?: () => void;
}

export interface BuildBundleManifestOptions {
  /** Defaults to v2 so existing producer and golden bytes remain immutable. */
  readonly format?: typeof BUNDLE_FORMAT | typeof BUNDLE_V4_FORMAT;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function validateRelativePath(path: string): void {
  if (
    path === ""
    || path === "."
    || path === BUNDLE_MANIFEST_FILENAME
    || isAbsolute(path)
    || path.includes("\\")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
    || posix.normalize(path) !== path
  ) {
    refuse("record-integrity", "bundle.manifest.path", `unsafe or reserved bundle path "${path}"`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function readRegularFile(bundleDir: string, path: string, allowManifest = false): Uint8Array {
  if (allowManifest && path === BUNDLE_MANIFEST_FILENAME) {
    // bundle.json is reserved from the file list but is itself authenticated by the same reader.
  } else {
    validateRelativePath(path);
  }
  const absolute = join(bundleDir, ...path.split("/"));
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    refuse("record-integrity", path, `manifest entry "${path}" is missing`);
  }
  if (stat.isSymbolicLink()) {
    refuse("record-integrity", path, `manifest entry "${path}" is a symbolic link`);
  }
  if (!stat.isFile()) {
    refuse("record-integrity", path, `manifest entry "${path}" is not a regular file`);
  }
  if (stat.nlink !== 1) {
    refuse("record-integrity", path, `manifest entry "${path}" must not be hard-linked`);
  }
  const root = realpathSync(bundleDir);
  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch {
    refuse("record-integrity", path, `manifest entry "${path}" cannot be resolved inside the bundle`);
  }
  if (!isInside(root, resolved)) {
    refuse("record-integrity", path, `manifest entry "${path}" resolves outside the bundle`);
  }

  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    refuse("record-integrity", path, `manifest entry "${path}" could not be opened without following links`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      refuse("record-integrity", path, `manifest entry "${path}" changed identity while it was opened`);
    }
    const bytes = new Uint8Array(readFileSync(fd));
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      refuse("record-integrity", path, `manifest entry "${path}" changed while it was authenticated`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function walkTree(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      refuse("record-integrity", path, `bundle contains symbolic link "${path}"`);
    }
    if (stat.isDirectory()) {
      const resolvedRoot = realpathSync(root);
      const resolvedDirectory = realpathSync(absolute);
      if (!isInside(resolvedRoot, resolvedDirectory)) {
        refuse("record-integrity", path, `bundle directory "${path}" resolves outside the bundle`);
      }
      files.push(...walkTree(root, absolute));
    } else if (stat.isFile()) {
      files.push(path);
    } else {
      refuse("record-integrity", path, `bundle contains non-regular entry "${path}"`);
    }
  }
  return files;
}

export function buildBundleManifest(
  bundleDir: string,
  filePaths: readonly string[],
  options: BuildBundleManifestOptions = {},
): BuiltBundleManifest {
  const seen = new Set<string>();
  const files = [...filePaths]
    .map((path) => {
      validateRelativePath(path);
      if (seen.has(path)) {
        refuse("record-integrity", "bundle.manifest.files", `duplicate bundle path "${path}"`);
      }
      seen.add(path);
      const bytes = readRegularFile(bundleDir, path);
      return { path, sha256: sha256(bytes), bytes: bytes.length };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = BundleManifestSchema.parse({ format: options.format ?? BUNDLE_FORMAT, files });
  const bytes = canonicalJsonBytes(manifest);
  return { manifest, bytes, identity: sha256(bytes) };
}

export function verifyBundleManifest(bundleDir: string): BuiltBundleManifest {
  const snapshot = verifyBundleSnapshot(bundleDir);
  return { manifest: snapshot.manifest, bytes: snapshot.bytes, identity: snapshot.identity };
}

/** Authenticates the complete tree once and returns the exact immutable byte snapshot used by
 * every semantic verifier. No consumer may reopen a pathname after this boundary. */
export function verifyBundleSnapshot(
  bundleDir: string,
  deps: VerifyBundleSnapshotDeps = {},
): VerifiedBundleSnapshot {
  const absoluteRoot = resolve(bundleDir);
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(absoluteRoot);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      refuse("record-integrity", "bundle", "bundle directory is missing");
    }
    throw cause;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    refuse("record-integrity", "bundle", "bundle root must be a real directory");
  }
  const canonicalRoot = realpathSync(absoluteRoot);

  const bytes = readRegularFile(canonicalRoot, BUNDLE_MANIFEST_FILENAME, true);

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("record-integrity", BUNDLE_MANIFEST_FILENAME, "bundle.json is not valid UTF-8 JSON");
  }
  const parsed = BundleManifestSchema.safeParse(raw);
  if (!parsed.success) {
    refuse("record-integrity", BUNDLE_MANIFEST_FILENAME, "bundle.json does not satisfy the manifest schema");
  }
  const canonical = canonicalJsonBytes(parsed.data);
  if (!equalBytes(bytes, canonical)) {
    refuse("record-integrity", BUNDLE_MANIFEST_FILENAME, "bundle.json bytes are not the exact canonical manifest encoding");
  }

  const seen = new Set<string>();
  let previous = "";
  for (const entry of parsed.data.files) {
    validateRelativePath(entry.path);
    if (seen.has(entry.path)) {
      refuse("record-integrity", "bundle.manifest.files", `duplicate bundle path "${entry.path}"`);
    }
    if (previous !== "" && entry.path <= previous) {
      refuse("record-integrity", "bundle.manifest.files", "manifest files are not in strict path order");
    }
    seen.add(entry.path);
    previous = entry.path;
    const fileBytes = readRegularFile(canonicalRoot, entry.path);
    if (fileBytes.length !== entry.bytes) {
      refuse("record-integrity", entry.path, `byte length mismatch for "${entry.path}"`);
    }
    if (sha256(fileBytes) !== entry.sha256) {
      refuse("record-integrity", entry.path, `digest mismatch for "${entry.path}"`);
    }
  }

  const actual = new Set(walkTree(canonicalRoot));
  const expected = new Set([BUNDLE_MANIFEST_FILENAME, ...seen]);
  for (const path of expected) {
    if (!actual.has(path)) refuse("record-integrity", path, `manifest entry "${path}" is missing`);
  }
  for (const path of actual) {
    if (!expected.has(path)) refuse("record-integrity", path, `bundle contains unexpected file "${path}"`);
  }

  const fileBytes = new Map<string, Uint8Array>([[BUNDLE_MANIFEST_FILENAME, bytes]]);
  for (const entry of parsed.data.files) {
    const authenticated = readRegularFile(canonicalRoot, entry.path);
    if (authenticated.length !== entry.bytes || sha256(authenticated) !== entry.sha256) {
      refuse("record-integrity", entry.path, `manifest entry "${entry.path}" changed during snapshot authentication`);
    }
    fileBytes.set(entry.path, authenticated);
  }
  deps.afterManifestValidated?.();
  return { manifest: parsed.data, bytes, identity: sha256(bytes), fileBytes };
}
