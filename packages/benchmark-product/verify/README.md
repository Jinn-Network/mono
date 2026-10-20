# @colophon-claims/verify — deprecated alias

**Install [`@colophon-claims/check`](https://www.npmjs.com/package/@colophon-claims/check) instead.**
The checker moved to a name that does not repeat the word its own verdict line uses.

This package is a passthrough alias: it re-exports `@colophon-claims/check` and its
`colophon-verify` executable re-enters `colophon-check`. The verdict, the `--json` document, and
the exit status are the checker's own, unchanged. Diagnostic lines name `colophon-check`, because
they come from the checker rather than from this shim. The published JSON Schemas and the
dependency-free `scripts/external-verify.py` ship in the checker's tarball, not this one:
`node_modules/@colophon-claims/check/` after installing either name.

Installing or running a Colophon package needs npm 11.6 or newer. On Node 22, which ships npm 10,
run `npm install -g npm@11` first, or use Node 24.8 or newer, which ships it.

The name stays published permanently. Bundles sealed before the rename print their reader command
with this name, and a sealed instruction that stops resolving is a broken claim, so:

```sh
npx @colophon-claims/verify@0.1 ./bundle   # keeps working
npx @colophon-claims/verify@0.2 ./bundle   # keeps working
```

New surfaces print the new name:

```sh
npx @colophon-claims/check@0.2 ./bundle
```
