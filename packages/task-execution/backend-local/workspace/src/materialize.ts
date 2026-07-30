import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ResourceDescriptor } from "@jinn-network/task-execution-protocol";
import { canonicalLoadoutPath } from "./loadout.js";

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

/** A loadout is a pinned requirement, so it is never normalized like a general Task input. */
export async function materializeLoadout(
  loadout: unknown,
  inputDir: string,
  fetchInput: (descriptor: ResourceDescriptor) => Promise<Uint8Array>,
): Promise<void> {
  await materializeAt(
    loadout as ResourceDescriptor,
    canonicalLoadoutPath(inputDir, loadout),
    fetchInput,
  );
}
