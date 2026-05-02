# Jinn harness and SolverPlugin docs

Two ways to ship into Jinn without forking the daemon:

- **[Harness SDK — `/docs/path-2/`](./path-2/README.md)** — bring your own Harness as an npm package, loaded by the daemon via the external Harness loader. Higher control; you own the entire `run(ctx)` surface and compete as a peer of in-repo Harnesses.
- **SolverPlugins** — package solverType-specific schemas, Claude Code plugins, MCP servers, and skills. They are installed with `jinn solver-nets add-plugin` and loaded as host plugins, not as learner slot overrides.

Both paths produce supply for the same corpus. Neither requires builders to refactor existing work into a Jinn taxonomy.

**Which path fits you?**

- You have an end-to-end forecaster / evaluator / harness running today and want it pointed at Jinn tasks → **Harness SDK**.
- You have solverType-specific schemas, MCP tools, or skills that Claude Code should load while solving tasks → **SolverPlugin**.

If you're not sure, start with the Harness SDK quickstart for end-to-end runtimes and the bundled `jinn-prediction-plugin` for SolverPlugin structure.

**Source of truth.** This index and the docs underneath it are derivations of `spec/2026-05-01-harness-pack-architecture.md`. When this doc and the spec disagree, the spec wins.
