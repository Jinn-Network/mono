# @colophon-claims/verify — deprecated alias

**Install [`@colophon-claims/check`](https://www.npmjs.com/package/@colophon-claims/check) instead.**
The checker moved to a name that does not repeat the word its own verdict line uses.

This package is a passthrough alias: it re-exports `@colophon-claims/check` and its
`colophon-verify` executable re-enters `colophon-check`. Behaviour, output, and exit status are
identical.

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
