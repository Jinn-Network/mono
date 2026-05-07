# SWE-rebench v2 runtime plugin

Provides Solver-side orientation + planning skills for the `swe-rebench-v2.v1` SolverNet.

This plugin bundles two skills:
- `swe-rebench-v2-orient` — read the task, identify FAIL_TO_PASS tests, plan the bug hypothesis.
- `swe-rebench-v2-plan` — sketch the minimal diff that satisfies FAIL_TO_PASS without breaking PASS_TO_PASS.

The plugin is loaded automatically when an operator's daemon has the `swe-rebench-v2.v1` SolverNet enabled, per the SDK's `defaultRuntimePlugins: ['bundled:swe-rebench-v2-runtime']`.

License: MIT.
