# Packed-closure lockfile

This `package-lock.json` pins the graph used by
`scripts/smoke-test-hermetic-packed-closure.mjs`: every third-party package at
the position npm places it, and each packed first-party package as a
`file:../archives/<name>-<version>.tgz` entry.

The smoke packs the first-party closure, copies this lockfile into a clean
consumer, and runs `npm ci --ignore-scripts --no-audit --no-fund`. It then
removes the lockfile and overlays the packed client with `--offline`, against
an npm cache that starts empty for the run. It does not resolve npm ranges at
gate time. A registry publish between two runs of the same tree cannot change
the installed bytes.

First-party entries are what let a member pin a third-party version apart from
the operator's own range: `better-sqlite3@13.0.1` beside the operator's
`^12.10.0` is nested under the members that pin it. They carry no `integrity`,
because their archives are packed from the working tree on every run. Registry
entries keep theirs.

## Refresh

This is the only packed-closure path allowed to consult the registry for range
resolution.

From `operator/`:

```bash
node scripts/refresh-hermetic-packed-closure-lockfile.mjs
```

Run it with npm 11.19.0 (`npm --version`), the version that wrote the
committed lockfile. CI's npm 10.9.8 installs that lockfile unchanged, but a
refresh under 10.9.8 rewrites 33 entries that have nothing to do with the
change (it drops 32 `libc` fields and changes the flags on
`@coinbase/cdp-sdk/node_modules/typescript`).

The script builds the consumer `package.json` (sorted union of operator
non-`@jinn-network` `dependencies`+`optionalDependencies`, the compiler
devDependencies `typescript` / `@types/node` / `@types/semver` / `@types/ws`,
and every non-`@jinn-network` `dependencies` entry of every first-party package
in the packed closure; operator specifiers win collisions; plus one `file:`
entry per packed first-party manifest), runs
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` in a
temp directory, drops `integrity` from the `file:` entries, and writes
`package-lock.json` here.

Refresh when the closure's membership, a member's version, or a dependency
specifier of the operator or a member changes. A stale lockfile fails the
smoke's `npm ci` and the unit test with `packed-closure lockfile is out of
sync`. Do not edit the lockfile by hand. Do not run `npm install
--package-lock=false` in the smoke. Do not commit packed archives.

`yarn test:hermetic:packed-closure` is unchanged; it still runs the smoke
script after the SDK/stack/plugin/core builds.
