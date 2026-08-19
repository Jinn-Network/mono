/** Git tree object SHA over sealed task material. The DeepSWE v1.1 pin is a git tree SHA, so it is recomputed from bytes, never asserted. */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const TREE_MODE = "40000";
const BLOB_MODE = "100644";
const EXECUTABLE_BLOB_MODE = "100755";

function gitObjectId(type: "blob" | "tree", body: Uint8Array): Buffer {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${body.byteLength}\0`, "utf8"))
    .update(body)
    .digest();
}

/** Git orders tree entries by name, comparing directory names as if they ended in `/`. */
function treeEntry(mode: string, name: string, objectId: Buffer): { readonly sortKey: Buffer; readonly encoded: Buffer } {
  const nameBytes = Buffer.from(name, "utf8");
  return {
    sortKey: mode === TREE_MODE ? Buffer.concat([nameBytes, Buffer.from("/", "utf8")]) : nameBytes,
    encoded: Buffer.concat([Buffer.from(`${mode} `, "utf8"), nameBytes, Buffer.from([0]), objectId]),
  };
}

/** Undefined when the directory holds no recordable entry; git records no empty trees. */
function treeBody(directory: string): Buffer | undefined {
  const entries: Array<{ readonly sortKey: Buffer; readonly encoded: Buffer }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new TypeError(`git tree hashing refuses symlink ${entry.name}`);
    if (entry.isDirectory()) {
      const body = treeBody(absolute);
      if (body === undefined) continue;
      entries.push(treeEntry(TREE_MODE, entry.name, gitObjectId("tree", body)));
    } else if (entry.isFile()) {
      const bytes = new Uint8Array(readFileSync(absolute));
      const mode = (lstatSync(absolute).mode & 0o100) === 0 ? BLOB_MODE : EXECUTABLE_BLOB_MODE;
      entries.push(treeEntry(mode, entry.name, gitObjectId("blob", bytes)));
    } else {
      throw new TypeError(`git tree hashing refuses non-regular entry ${entry.name}`);
    }
  }
  if (entries.length === 0) return undefined;
  entries.sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
  return Buffer.concat(entries.map((entry) => entry.encoded));
}

/**
 * Equal to `git write-tree` over the same bytes: the 40-hex git tree object id of `root`.
 * No ignore handling — every present file is hashed, so untracked build residue in a copied
 * checkout moves the SHA and is refused loudly rather than silently wearing the official pin.
 */
export function computeGitTreeSha(root: string): string {
  const canonical = realpathSync(root);
  if (!lstatSync(canonical).isDirectory()) throw new TypeError("git tree hashing requires a directory");
  return gitObjectId("tree", treeBody(canonical) ?? Buffer.alloc(0)).toString("hex");
}
