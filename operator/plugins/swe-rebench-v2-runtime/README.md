# SWE-rebench v2 runtime plugin

Provides a Solver-side domain reference skill for the `swe-rebench-v2.v1` SolverNet.

This plugin bundles one skill:
- `swe-rebench-v2-task` — task input shape, repo handling, FAIL_TO_PASS / PASS_TO_PASS semantics, and the `swe-rebench-v2-solution.v1` output schema with `submit_typed_payload` usage.

The plugin is loaded automatically when an operator's daemon has the `swe-rebench-v2.v1` SolverNet enabled, per the SDK's `defaultRuntimePlugins: ['bundled:swe-rebench-v2-runtime']`.

License: MIT.

## See also

- `operator/plugins/swe-rebench-v2-diffmin/` — complementary minimal-diff +
  test-mapping skills. Stacks with this plug-in: a daemon can load both for
  the same SolverNet. The two plug-ins cover different angles:
  `swe-rebench-v2-runtime` describes the task contract;
  `swe-rebench-v2-diffmin` enforces minimal-diff discipline and pre-loads
  the PASS_TO_PASS call-graph.

Already shipping a Hermes skill? Drop it under `skills/<name>/SKILL.md`, add
a `jinn.plugin.json` targeting `swe-rebench-v2.v1`, `yarn pack`, then
`jinn solver-plugins publish`. See `swe-rebench-v2-diffmin/README.md` for
the Hermes-migrator quickstart.
