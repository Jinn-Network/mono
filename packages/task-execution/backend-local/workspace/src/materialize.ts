import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { canonicalLoadoutPin, type CanonicalLoadoutPin } from "./loadout.js";
import {
  assertHarnessStatePackageMaterializable,
  hashHarnessStatePackage,
  hashMaterializedHarnessStateTree,
  writeHarnessStatePackage,
  type HarnessStateTreeEntry,
} from "./harness-state-package.js";
import { toSha256Digest } from "./sha256-digest.js";

export class ContentCorruptionError extends Error {
  readonly code = "content-corruption";
  constructor() { super("fetched input digest does not match its declared sha256"); }
}

/** Standard, padded base64 only; Buffer's decoder intentionally accepts looser spellings. */
function decodeCanonicalBase64(content: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content)) {
    throw new ContentCorruptionError();
  }
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content) throw new ContentCorruptionError();
  return bytes;
}

async function materializeAt(
  descriptor: ResourceDescriptor,
  target: string,
  fetchInput: (descriptor: ResourceDescriptor) => Promise<Uint8Array>,
): Promise<void> {
  const bytes = descriptor.content === undefined ? await fetchInput(descriptor) : decodeCanonicalBase64(descriptor.content);
  const expected = descriptor.digest?.sha256;
  if (expected !== undefined && createHash("sha256").update(bytes).digest("hex") !== expected) throw new ContentCorruptionError();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o400 });
}

export async function materializeInput(
  descriptor: ResourceDescriptor,
  inputDir: string,
  fetchInput: (descriptor: ResourceDescriptor) => Promise<Uint8Array>,
): Promise<void> {
  await materializeAt(
    descriptor,
    join(inputDir, basename(descriptor.name ?? descriptor.uri ?? "input")),
    fetchInput,
  );
}

/**
 * Decodes a fetched `jinn.harness-state.v1` package blob: UTF-8 JSON
 * `{ entries: HarnessStateTreeEntry[] }`. The transport encoding itself is out of this unit's
 * scope (owned by the #2117-2120 checkpoint train for any cross-operator flow) — this is the
 * minimal local placeholder that lets `fetchInput`'s existing `(descriptor) => Promise<Uint8Array>`
 * shape carry a whole tree instead of a single file, with no change to that signature or to the
 * dir-provisioner call site. Malformed JSON or shape is a `ContentCorruptionError`: the fetched
 * bytes are not a package this kind can materialize.
 */
function decodeHarnessStatePackage(bytes: Uint8Array): readonly HarnessStateTreeEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ContentCorruptionError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new ContentCorruptionError();
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new ContentCorruptionError();
  for (const entry of entries) {
    if (
      typeof entry !== "object" || entry === null
      || typeof (entry as { path?: unknown }).path !== "string"
      || !["file", "symlink", "special"].includes((entry as { kind?: unknown }).kind as string)
      || ((entry as { content?: unknown }).content !== undefined && typeof (entry as { content?: unknown }).content !== "string")
    ) throw new ContentCorruptionError();
  }
  return entries as readonly HarnessStateTreeEntry[];
}

/**
 * Kind-aware `jinn.harness-state.v1` materialization (substrate §4.2). Fail-closed on any
 * profile-ignored root present in the package BEFORE any byte reaches the filesystem, then
 * digest-verifies the in-memory description against the pin, writes the tree, and re-hashes what
 * actually landed on disk as a round-trip check.
 */
async function materializeHarnessStateLoadout(
  loadout: unknown,
  pin: CanonicalLoadoutPin,
  targetDir: string,
  fetchInput: (descriptor: ResourceDescriptor) => Promise<Uint8Array>,
): Promise<void> {
  const bytes = await fetchInput(loadout as ResourceDescriptor);
  const entries = decodeHarnessStatePackage(bytes);
  // The control, not the digest: a package carrying a profile-ignored root (e.g. an executable
  // `.git/hooks/post-checkout`) can still digest-verify perfectly, because the profile is blind
  // to that root by construction. This refusal is what a digest check alone cannot provide.
  assertHarnessStatePackageMaterializable(entries);
  const digest = hashHarnessStatePackage(entries);
  if (toSha256Digest(digest) !== pin.digest) throw new ContentCorruptionError();
  await writeHarnessStatePackage(entries, targetDir);
  // Round-trip verification (substrate §4.2 — "recomputing the profile hash over the
  // MATERIALIZED tree", not only the in-memory description that produced it).
  const materializedDigest = await hashMaterializedHarnessStateTree(targetDir);
  if (materializedDigest !== digest) throw new ContentCorruptionError();
}

/** A loadout is a pinned requirement, so it is never normalized like a general Task input. */
export async function materializeLoadout(
  loadout: unknown,
  inputDir: string,
  fetchInput: (descriptor: ResourceDescriptor) => Promise<Uint8Array>,
): Promise<void> {
  const pin = canonicalLoadoutPin(loadout);
  const target = join(inputDir, pin.name);
  if (pin.kind === "jinn.harness-state.v1") {
    await materializeHarnessStateLoadout(loadout, pin, target, fetchInput);
    return;
  }
  await materializeAt(loadout as ResourceDescriptor, target, fetchInput);
}
