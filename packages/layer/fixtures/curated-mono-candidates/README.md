# Curated mono candidate template

This directory is a preparation aid for Stage 2 issue #1826. It contains no
approved episode and is not a publishable batch.

1. Copy `episode.template.json` to a private working directory as
   `<stable-id>.episode.json`.
2. Replace every placeholder from evidence captured in a real
   `Jinn-Network/mono` working session or a faithful re-performance of a merged
   fix.
3. Keep `mono` plus the task's real subsystem vocabulary in `tags`, and add the
   canonical `retrieval:visible.v1` mark only after the operator decides the
   episode meets the curation bar.
4. Run the offline validator documented in
   `docs/runbooks/stage2-mono-curated-seeds.md`.

The automated validator checks mechanical evidence, provenance, the shared
doctor-probe vocabulary, distinctness, and the deterministic seed scrub. It
cannot decide that the prose is useful, approve publication, run a live probe,
or establish that a real session retrieved the episode. Those remain explicit
operator gates.

Do not rename this template itself to `*.episode.json` in this directory. A file
with that suffix is loadable by the seed lane.
