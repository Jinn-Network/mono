# SWE-rebench v2 runtime plugin

Provides Solver-side orientation + planning skills for the `swe-rebench-v2.v1` SolverNet.

This plugin bundles two skills:
- `swe-rebench-v2-orient` — read the task, identify FAIL_TO_PASS tests, plan the bug hypothesis.
- `swe-rebench-v2-plan` — sketch the minimal diff that satisfies FAIL_TO_PASS without breaking PASS_TO_PASS.

The plugin is loaded automatically when an operator's daemon has the `swe-rebench-v2.v1` SolverNet enabled, per the SDK's `defaultRuntimePlugins: ['bundled:swe-rebench-v2-runtime']`.

License: MIT.

## See also

- `client/plugins/swe-rebench-v2-diffmin/` — complementary minimal-diff +
  test-mapping skills. Stacks with this plug-in: a daemon can load both for
  the same SolverNet. The two plug-ins cover different angles:
  `swe-rebench-v2-runtime` orients + plans; `swe-rebench-v2-diffmin` enforces
  minimal-diff discipline and pre-loads the PASS_TO_PASS call-graph.

Already shipping a Hermes skill? Drop it under `skills/<name>/SKILL.md`, add
a `jinn.plugin.json` targeting `swe-rebench-v2.v1`, `yarn pack`, then
`jinn solver-plugins publish`. See `swe-rebench-v2-diffmin/README.md` for
the Hermes-migrator quickstart.
