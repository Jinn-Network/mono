# Machine-local evidence store threat model

The machine-local evidence store preserves private episode records and a
rebuildable SQLite view. It is not a sandbox or a security boundary between
processes running as the same OS account.

## Guarantees

- Jinn's JavaScript and Python writers and the reindexer serialize through one
  crash-recoverable SQLite mutex.
- The evidence directory is owner-only. Accepted files must be regular,
  owner-matched, terminally non-symlinked, and normally single-linked.
- Writers publish only complete, fsynced content without overwriting an
  existing canonical episode. A crash after hardlink publication is recovered
  only when the canonical name and a writer-owned temp name provably identify
  the same two-link inode.
- Repair uses a durable journal. Normalization writes only through a pinned
  descriptor; rescue moves a source through a random quarantine name and
  preserves a pathname replacement detected during finalization.
- Detected identity, ownership, type, schema, or link-count changes fail
  closed. Incomplete repair state is retained and reported instead of being
  silently discarded.

## Trust boundary

All Jinn processes that write the store must use the shared mutex. Deliberate
out-of-band mutation by another process already running as the same uid is out
of scope: that process can chmod the owner-only directory, replace path-based
SQLite files, and read or rewrite the operator's other private runtime state.
Portable Node.js does not expose the `openat`/conditional-rename primitives
needed to turn a user-owned directory into a same-uid isolation boundary.

The implementation still pins descriptors, revalidates identities before
mutation, avoids destructive replacement, and retains recovery journals so
ordinary editor activity or a non-cooperating local tool is detected with the
smallest practical data-loss surface. Isolation from untrusted code must come
from a distinct OS account, container, or equivalent sandbox.
