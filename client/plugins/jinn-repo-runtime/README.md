# jinn-repo runtime plugin

Provides a Solver-side domain reference skill for the `jinn-repo.v1` SolverNet.

This plugin bundles one skill:
- `jinn-repo-task` — task input shape, repo handling (checkout of
  `Jinn-Network/mono` at `base_commit`), and the `jinn-repo-solution.v1`
  output schema.

It also ships a `SessionStart` hook (`hooks/session-start`) that
deterministically materialises the task repository at `$WORKING_DIR/repo` at
`base_commit` before the solver agent runs, so a direct-solving model never has
to improvise the checkout.

The plugin is loaded automatically when an operator's daemon has the
`jinn-repo.v1` SolverNet enabled, per the registry's
`defaultRuntimePluginsForSolverType('jinn-repo.v1') === ['bundled:jinn-repo-runtime']`.

License: MIT.

## See also

- `client/plugins/swe-rebench-v2-runtime/` — the sibling runtime plugin for the
  `swe-rebench-v2.v1` SolverNet. jinn-repo mirrors its task contract and repo
  handling exactly; the difference is that jinn-repo instances are real merged
  `Jinn-Network/mono` PRs (repo is always `Jinn-Network/mono`) and the solverView
  is leak-controlled (no test files / no gold tests).
