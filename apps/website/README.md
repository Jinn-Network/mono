# apps/website — jinn.network

The apex site: the landing page, the docs tree, and the machine-readable surfaces compiled
from it. Next.js App Router, Tailwind v4, shadcn/ui primitives, Fumadocs over MDX, exported
as static files.

This replaces the one-page static brochure. Its own README carried the trigger — "revisit
if it grows beyond one page" — and the DevX surface design pulled it.

The domain model, the four-axis surface spec, and the design decisions live in
[`WEBSITE-APP-SPEC.md`](WEBSITE-APP-SPEC.md). Read it before changing a route, a component,
or the CSS layering. This file covers only how to run and ship the thing.

## Layout

| Path | What is there |
| --- | --- |
| `app/` | Routes. `(home)` is the landing page; `docs/` is the Fumadocs layout; `llms.txt`, `llms-full.txt`, and `api/search` are build-time route handlers. |
| `content/docs/` | The docs tree. MDX plus `meta.json` ordering files. New authored content — never a mirror of the repository's internal `docs/`. |
| `components/` | `ui/` holds vendored shadcn primitives. Everything else is composition. |
| `styles/` | `colors_and_type.css` and `foundations.css` are byte-identical copies of the design system and are never edited. `theme.css` is the one editable bridge. |
| `lib/` | Content source, shared links, `cn`. Deliberately not CODEOWNER-gated. |
| `scripts/`, `test/` | The link checker and the content guards CI runs. |

## Develop

Node 22, Yarn 4.13.0 via corepack. This directory is its own yarn island — it has its own
`yarn.lock` and there is no root workspace.

```bash
cd apps/website
corepack enable
yarn install
yarn dev            # http://localhost:3000
```

## Verify

Everything below runs in CI (`.github/workflows/website-ci.yml`). Run it before opening a
PR.

```bash
yarn typecheck      # next typegen + tsc --noEmit
yarn test           # content guards; also asserts the built output once out/ exists
yarn check:links    # internal links resolve; retired document-root paths absent
yarn build          # static export into out/
yarn test           # again, so the build-output assertions run
```

The design-token copies are guarded from the repository root:

```bash
node --test .github/scripts/website-design-tokens.test.mjs
```

If that fails, the fix is to re-copy from `docs/design/jinn-design-system/project/`, never
to edit the copy. Colour and type changes belong in the design system.

## Deploy

Manual, from this directory:

```bash
yarn build
vercel deploy --prod
```

Vercel team `jinn-a6b5fa9d`, project `jinn-website`. `jinn.network` and `www.jinn.network`
are attached to that project. There is no git integration and no deploy workflow; the
build output is `out/`.

**Follow-up:** moving the deploy into CI, so a green pipeline is the gate on the apex
domain, is deliberately not part of this change. It is named as an open question in
[`WEBSITE-APP-SPEC.md`](WEBSITE-APP-SPEC.md) §4.

## What this site does not serve

The protocol document root — profile, schema, record, and task-profile documents and their
digest manifest — is **not** here. DR-2026-08-04 moved the identifier origin to
`spec.jinn.network`. There is no `/profiles`, `/records`, `/schemas`, `/prompts`,
`/task-profiles`, or `/manifest.json` route on this site, and `yarn check:links` fails the
build if one reappears.

The live network counts the brochure fetched from the indexer are gone with it. This site
is a static export with no data source; the numbers are the explorer's job.

## Copy provenance

Every claim on the landing page and in the docs tree traces to a canonical document: what
Jinn is, what exists today and what is direction to [`THESIS.md`](../../THESIS.md) §3 and
§4; record, holder, offer and price to [`GLOSSARY.md`](../../GLOSSARY.md); Colophon to the
root [`README.md`](../../README.md); voice to [`BRAND.md`](../../BRAND.md).

The call to action is [`GROWTH.md`](../../GROWTH.md) §3: "Bring a claim" is the single ask
on every outward surface, so the three doors are navigation and there is exactly one button
on the page. `yarn test` asserts it.

The site offers only what exists. A docs page exists only for something a visitor can read
or run today, and every command on one was run as written before it was committed.
