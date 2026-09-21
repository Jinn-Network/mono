# Packed-closure third-party lockfile

This `package-lock.json` pins the **third-party** graph used by
`scripts/smoke-test-hermetic-packed-closure.mjs`.

The smoke copies this lockfile into a clean consumer, runs
`npm ci --ignore-scripts --no-audit --no-fund`, then overlays first-party
packed tarballs with `--offline`. It does not resolve npm ranges at gate time.
A registry publish between two runs of the same tree cannot change the
installed bytes.

## Refresh

This is the only packed-closure path allowed to consult the registry for range
resolution.

From `operator/`:

```bash
node scripts/refresh-hermetic-packed-closure-lockfile.mjs
```

The script builds the consumer `package.json` (sorted union of operator
non-`@jinn-network` `dependencies`+`optionalDependencies`, the compiler
devDependencies `typescript` / `@types/node` / `@types/semver` / `@types/ws`,
and every non-`@jinn-network` `dependencies` entry of every first-party package
in the packed closure; operator specifiers win collisions), runs
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` in a
temp directory, and writes `package-lock.json` here.

Refresh when operator or packed-closure first-party third-party specifiers
change. Do not edit the lockfile by hand. Do not run `npm install
--package-lock=false` in the smoke. Do not commit packed archives.

`yarn test:hermetic:packed-closure` is unchanged; it still runs the smoke
script after the SDK/stack/plugin/core builds.
