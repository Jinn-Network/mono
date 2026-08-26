// Shared support for this suite's temp isolation: the prefix that names the trees it owns, the
// containment guard that decides what may be removed, the path budget that leaves a spawned child
// room to bind a socket, the keep-artifact escape hatch, and the removal itself. Both halves import
// it — the per-test-file sweep in `isolate-tmp.ts` and the per-run sweep in `global-tmp-root.ts` —
// so the two teardowns cannot drift apart.
//
// `rmSync` cannot remove a read-only directory — `unlink` needs the write bit on the *parent*
// directory, and `force: true` only suppresses ENOENT, never EACCES — and the local workspace
// provisioner seals each attempt's `input/` exactly that way (directories 0o500, files 0o400) to
// protect a live attempt's dispatch context from the solver process. That seal is a runtime
// integrity property, not a durability guarantee about test scratch space: it holds for the whole
// life of every test, and a sweep runs only after the last assertion. The per-run sweep meets the
// same seal whenever a worker died before its own sweep could run, so both halves need the repair.
//
// One copy, shared by every Vitest config that wires it — see `isolate-tmp.ts` on why this
// directory is not a workspace package.
import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Names the trees this suite owns. `isolate-tmp.ts` creates with it, and `isSweepableRecord` admits
 * a recorded path for recursive removal only if its first component under the temp directory starts
 * with it. The two have to move together: a rename that reached only the creator would leave the
 * guard rejecting every real root, turning the per-run sweep into a silent no-op.
 *
 * Deliberately short: every character of it is spent from the socket-path budget below.
 */
export const MANAGED_ROOT_PREFIX = "jinn-tmp-";

/**
 * Returns true iff `recorded` is a tree this suite may remove: strictly inside `base`, under a
 * first path component this suite named.
 *
 * A `startsWith` test on the raw string is NOT enough, and the difference is a recursive `rmSync`:
 * `<base>/jinn-tmp-x/../../../victim` passes a prefix test and can point anywhere on the volume.
 * `relative` normalises the `..` away first, so such a record is rejected here.
 *
 * Both sides go through `resolve` and neither through `realpathSync`: on macOS `tmpdir()` reports
 * `/var/folders/…` while its real path is `/private/var/folders/…`, so resolving one side only
 * would reject every legitimate root.
 */
export function isSweepableRecord(recorded: string, base: string): boolean {
  const rel = relative(resolve(base), resolve(recorded));
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return rel.split(sep)[0].startsWith(MANAGED_ROOT_PREFIX);
}

/**
 * Environment flags under which a developer has asked to KEEP the run's artifacts.
 *
 * `packages/benchmark-product/core` has three suites that retain a workspace created with
 * `mkdtemp(join(tmpdir(), …))` behind one of these — the two `src/runtime/inspect/*.integration`
 * files and `src/conformance/publication-release-rehearsal.external`, the last of which also logs
 * the path it retained. This seam owns the parent of every one of those workspaces, so an
 * unconditional sweep would turn each flag into a no-op and that log line into a lie. Honouring
 * them here instead puts every retained artifact under one managed root, which is one `rm -rf` to
 * clean up rather than the scatter they used to leave.
 *
 * One list for every suite the seam covers, including the many that define none of these flags
 * themselves: a flag that meant "keep" in one suite and nothing in another would be worse than no
 * flag at all.
 */
export const KEEP_ARTIFACT_FLAGS = [
  "JINN_KEEP_TEST_TMPDIR",
  "JINN_KEEP_INSPECT_WORKSPACE",
  "COLOPHON_PUBLICATION_RELEASE_KEEP_WORKSPACE",
] as const;

/** Names the keep flag in force, if any. */
export function keepArtifactFlag(): string | undefined {
  return KEEP_ARTIFACT_FLAGS.find((flag) => process.env[flag] === "1");
}

// macOS truncates a unix-domain socket path at 104 bytes (`sizeof(sockaddr_un.sun_path)`), and a
// `spawn`ed child inherits `$TMPDIR`: a tool that binds `$TMPDIR/<tool>/<pid>.sock` spends the rest
// of that budget. Redirecting `$TMPDIR` into a per-file root spends part of it up front, so a
// developer or CI runner whose own `$TMPDIR` is long would otherwise meet the shortfall as an
// `EEXIST`/`EADDRINUSE` inside whichever test happens to spawn a subprocess — a failure that names
// neither this seam nor `$TMPDIR`. Checking the budget here names both.
const SOCKET_PATH_LIMIT = 104; // bytes, including the terminating NUL
// `/tsx-<uid>/<pid>.pipe` at the platform worst case — a five-digit uid and a five-digit pid, which
// is the widest macOS produces. Measured: with this reserve the seam refuses exactly the
// `$TMPDIR` lengths at which the kernel starts truncating that path, and no shorter one.
const CHILD_SOCKET_RESERVE = 21;

/** The longest `$TMPDIR` this seam may publish, in bytes. */
export const MAX_MANAGED_ROOT_BYTES = SOCKET_PATH_LIMIT - 1 - CHILD_SOCKET_RESERVE;

/** Throws, naming the cause and the fix, when `root` leaves a spawned child no room to bind. */
export function assertSocketSafeRoot(root: string, base: string): void {
  const bytes = Buffer.byteLength(root);
  if (bytes <= MAX_MANAGED_ROOT_BYTES) return;
  throw new Error(
    `test temp isolation cannot use ${root}: at ${bytes} bytes it leaves a spawned child too ` +
      `little of the ${SOCKET_PATH_LIMIT}-byte unix-socket path limit to bind ` +
      `$TMPDIR/<tool>/<pid>.sock (this seam allows ${MAX_MANAGED_ROOT_BYTES}). It sits inside ` +
      `${base}; re-run with a shorter temp directory, e.g. \`TMPDIR=/tmp/jinn yarn test\`.`,
  );
}

// Restores write and traverse permission on the tree. Symlinks are skipped — `chmod` follows them,
// which would reach outside the tree, and `rmSync` unlinks them without needing the target's
// permission. `readdirSync(withFileTypes)` is `lstat`-based, so the loop below covers the entries;
// the root gets its own `lstat` because nothing above this has checked it.
function unsealTree(directory: string): void {
  let entries;
  try {
    if (lstatSync(directory).isSymbolicLink()) return;
    chmodSync(directory, 0o700);
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return; // Let the retry in the caller report whatever actually blocks removal.
  }
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) unsealTree(child);
    else {
      try {
        chmodSync(child, 0o600);
      } catch {
        // Same: the retry's error is the useful one.
      }
    }
  }
}

/**
 * Removes `root`, repairing a sealed subtree and retrying once. Never throws: a cleanup failure is
 * an operational problem that has to be visible, yet throwing would fabricate a failure in a test
 * file whose assertions all passed. `label` names the tree in that warning.
 *
 * Under a keep flag it removes nothing and prints the path instead, so the developer who asked to
 * keep an artifact can find it.
 */
export function sweepManagedTree(root: string, label: string): void {
  const keep = keepArtifactFlag();
  if (keep !== undefined) {
    console.warn(`[jinn-test] keeping ${label} ${root} — ${keep} is set`);
    return;
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Almost always a sealed `input/`. Unseal the tree we own, then retry.
    unsealTree(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[jinn-test] could not sweep ${label} ${root}:`, error);
    }
  }
}
