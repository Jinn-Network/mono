# #1823 Onboarding Documentation Implementation Plan

> Issue: [#1823](https://github.com/Jinn-Network/mono/issues/1823)
> Base: `next` at `3dabe0eb9d2521afc861b136e82cc1068a499c18`

## Goal

Make the stock-Hermes Jinn path say one install command, one update verb, and
one doctor invocation everywhere a Jinn user is likely to encounter it. Add an
explicit, reversible local-state purge and point the historical Stage 1 product
design at the Stage 2 amendments that supersede its install and rollback text.

## Constraints

- No npm command appears in the plugin user path.
- The install remains `hermes plugins install Jinn-Network/jinn-plugin`; the
  native enable prompt is part of that one command.
- Purging is destructive and must require disabling the plugin, identify both
  state roots, offer a backup first, and explain that plugin removal alone does
  not delete retained local state.
- The Stage 1 product design remains a historical record. Add local amendment
  notices rather than silently rewriting its original decisions.
- The promoted slim channel cannot be exercised from `next`; keep that
  clean-machine proof in the existing #1816 human residual.

## Changes

1. Tighten `apps/jinn-agent/plugins/jinn/README.md` with the install, update,
   doctor, disable/remove, backup, and purge commands.
2. Remove the stale second enable command from `apps/jinn-agent/README.md` and
   `apps/jinn-agent/JINN.md`; link both to the canonical plugin README.
3. Add explicit Stage 2 amendment notices under product-design §4.1 and §4.8,
   linking the onboarding design and charter.
4. Run exact-copy assertions, Markdown-link resolution checks, trailing
   whitespace checks, and the repository canonical-docs check.

## Human residual

After the Stage 2 release is promoted, run the documented command sequence on a
fresh stock-Hermes environment and attach the transcript to #1816/#1823. No
publication, promotion, or live state mutation is part of this implementation.
