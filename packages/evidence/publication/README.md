# `@jinn-network/evidence-publication`

Recoverable, medium-neutral publication for exact Jinn evidence records and
artifacts.

The root entrypoint defines publication contracts and orchestration. Internally it
adapts its closed evidence record families to `@jinn-network/record-publication`:
evidence records become kind-bearing neutral records, stored evidence artifacts
become role-bearing neutral artifacts, and prepared legacy announcement frames
become neutral mirror actions. The v1 evidence journal and receipts remain the
durable compatibility and recovery authority, including pending-placement
reconciliation; callers therefore retain the exact existing API and partition
semantics.
`@jinn-network/evidence-publication/testing` provides contract kits and
in-memory doubles. The durable filesystem journal is available only from
`@jinn-network/evidence-publication/fs`.

The version 1 filesystem journal profile bounds each immutable revision file
at 8 MiB. Writers reject larger revisions before publishing them, and
readers inspect at most that bound plus one byte before UTF-8, JSON, or base64
decoding. This binding-level ceiling keeps replay allocation bounded without
changing the medium-neutral root contracts.

This package does not validate Evidence Protocol conformance, select a
concrete announcement medium, or acquire credentials.

## Filesystem journal trust boundary

The configured journal root is trusted local application state. The
filesystem binding resolves its existing unmanaged ancestor prefix to a
physical path, so stable platform-managed aliases such as macOS `/var` are
accepted. Unmanaged ancestors must remain trusted and stable. The configured
root and every component below it must not be symlinks and must not be
concurrently replaced by an equally privileged hostile process. Node 22 has
no portable descriptor-relative child operations, so version 1 detects
static, accidental, and observable between-check replacement but does not
claim containment against a same-user process that wins an active pathname
race.

On POSIX platforms, managed directories and files must belong to the current
user and are normalized to exact modes `0700` and `0600`. These modes are
defense in depth, not encryption, secret scrubbing, or protection from an
operator that already controls the files. Backup security, retention, and
deletion remain operator responsibilities.

Prepared frames, pending state, confirmed placement state, journal entries,
and receipts may contain only non-secret publication or recovery data.
Credentials, private keys, bearer tokens, wallet authority, and similar
material must remain closed over by the injected sink capability. Concrete
sinks may persist only non-secret recovery identifiers and must run the
exported contract kit with printable and binary synthetic authority markers.
