# Vitest temp-directory isolation

Three files, one copy, wired by every Vitest config under `packages/`:

| File | Vitest hook | What it does |
|---|---|---|
| `isolate-tmp.ts` | `setupFiles` | Points `$TMPDIR`/`$TMP`/`$TEMP` at a managed root created per test file, and sweeps it in `afterAll` plus an `exit` backstop. |
| `global-tmp-root.ts` | `globalSetup` | Creates the per-run registry in the main process and sweeps every root recorded in it once the workers are gone — including a file whose tests were all skipped, and a run killed by SIGINT/SIGTERM/SIGHUP. |
| `sweep-tree.ts` | — | Shared by both: the managed-root prefix, the containment guard, the socket-path budget, the keep-artifact flags, and the removal itself (which repairs a read-only subtree before giving up). |

Wire a config like this — the depth of the relative path is whatever reaches this
directory from the config's own directory:

```ts
setupFiles: ["../../test-support/tmp-isolation/isolate-tmp.ts"],
globalSetup: ["../../test-support/tmp-isolation/global-tmp-root.ts"],
```

`.github/scripts/vitest-tmp-isolation.test.mjs` runs on every pull request and fails
if any Vitest config under `packages/` (or the operator's five configs, which use the
operator's own home-plus-temp seam at `operator/test/_support/`) names an entry that
does not resolve to its seam, and if either seam file has moved out from under the
configs that point at it. That is the regression coverage for
the wiring; `tmp-isolation.test.ts` next to this README is the behavioural coverage
for the seam itself, and runs under `packages/benchmark-product/core`.

## Why this is a directory and not a package

The repository has no root workspace: each package installs on its own with `portal:`
resolutions, and every manifest has to appear in `architecture/platform-packages.v1.json`.
A workspace package for these three files would cost a manifest, a build, a publish
surface, a catalog entry and a dependency edge in roughly fifty packages — to ship code
that product code never imports and npm never sees. `setupFiles` and `globalSetup` take
plain path strings, so a relative path gets the same single-copy result for none of it.

The one thing given up is type checking: no package's `tsconfig.json` covers this
directory (each sets `rootDir: "src"`, which a path outside the package cannot satisfy),
so these files are transpiled by Vitest and never seen by `tsc`. `tmp-isolation.test.ts`
exercises them instead — including the containment guard, the socket-path budget, the
keep flags, the double-`globalSetup` case and the sealed-`input/` removal.
