# Jinn plug-in surface — recruit-facing docs

Two ways to ship into Jinn without forking the daemon:

- **[Path 1 — `/docs/path-1/`](./path-1/README.md)** — contribute a single component (markdown agent, MCP tool, skill bundle, hook, memory backend) into the bundled `claude-code-learner` impl. Lower entry cost; reuse the learner's harness, capabilities, and corpus integration.
- **[Path 2 — `/docs/path-2/`](./path-2/README.md)** — bring your own restorer impl as an npm package, loaded by the daemon via the external-impl loader. Higher control; you own the entire `run(ctx)` surface and compete as a peer of in-repo impls.

Both paths produce supply for the same corpus. Neither requires builders to refactor existing work into a Jinn taxonomy.

**Which path fits you?**

- You have an end-to-end forecaster / evaluator / harness running today and want it pointed at Jinn intents → **Path 2**.
- You have a single piece (a calibration model, a prompt skill, an MCP tool, a memory store, a hook) you want to drop into a working restorer → **Path 1**.

If you're not sure, start with the quickstart for whichever path matches the shape of your existing code.

**Source of truth.** This index and the docs underneath it are derivations of `spec/2026-04-30-plug-in-surface.md`. When this doc and the spec disagree, the spec wins.
