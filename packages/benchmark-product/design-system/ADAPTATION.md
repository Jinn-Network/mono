# Colophon design-system adaptation

This directory preserves the supplied Colophon design system as a **reference-only**
source for the standalone product. Production code does not import its JSX, global
prototype bundle, CDN stylesheet, or demo data.

## Authority order

1. The standalone product charter and benchmark-product design specification define
   product behavior, operations, lifecycle, records, verification, and publication.
2. `reference/` defines Colophon's visual identity, content posture, tokens, and supplied
   assets.
3. The web portal and public-bundle renderer adapt those visuals to their existing
   runtime and security contracts.

Where the reference kit differs from the product, the implementation keeps the product
truth. In particular, the canonical 27 operation ids replace the kit's illustrative
snake-case verbs, and `wilson@1` never gains a winner, ranking, certification, or causal
claim from the sample report copy. A `paired-delta@1` full report explicitly labels its
candidate-minus-baseline estimate, interval state, exact alpha, and paired Task count;
the badge, social card, and share text remain number-free and link relatively to the full
report instead of becoming detachable result claims.

## Imported source

The authored brand package, token files, component contracts and prompts, real SVG marks,
reference UI kits, manifest, and supplied badge example are retained unchanged beneath
`reference/`. Matching reference captures live in `reference-captures/` for blocking
design QA.

## Omitted source

The archive's generated `_ds_bundle.js`, `.thumbnail`, `_adherence.oxlintrc.json`,
`thumbnail.html`, and root `SKILL.md` are omitted. They are prototype or generator
artifacts, not production dependencies. The reference `tokens/fonts.css` is retained for
provenance only; production uses pinned Fontsource packages and makes no remote request.

## Runtime adapters

- `web/src/app/globals.css` and product-owned React components translate the visual tokens
  into the existing Next.js/Tailwind application.
- `core/src/bundle/assets.ts` applies the same identity to the deterministic five-file
  public bundle and embeds its own font bytes. Its generated `README.md` carries the
  complete upstream license notice for each redistributed font.
- `web/public/brand/` copies the supplied SVG assets byte-for-byte for same-origin use.

The adapters may fix responsive containment, accessibility, security, and factual copy.
They must not invent replacement marks, operation semantics, or public evidence.
