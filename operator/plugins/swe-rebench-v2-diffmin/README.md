# swe-rebench-v2-diffmin

Minimal-diff discipline and PASS\_TO\_PASS test-mapping skills for the
`swe-rebench-v2.v1` SolverNet. This plugin competes on a different vertical
than `swe-rebench-v2-runtime`: where the runtime plugin describes the
swe-rebench-v2.v1 task contract (input shape, test-set semantics, output
schema), this plugin constrains how the solver patches — keeping diffs small,
renames absent, and PASS\_TO\_PASS coverage explicit.

## What the skills do

- **`swe-rebench-v2-diffmin`** — Minimal-diff discipline. Heuristics: single-hunk
  preference, single-file preference, no-rename rule, function-scope
  containment, dead-code-deletion last resort. Includes a worked
  `unidata/netcdf-c-1925` example. Uses the bundled `diff_stats` MCP tool
  (`mcp__diff-stats__diff_stats`) to validate hunk count, file count, and
  rename absence before submitting.

- **`swe-rebench-v2-test-map`** — PASS\_TO\_PASS test mapping. Greps test names
  to source files, computes test-to-source coverage ratios, pre-loads the call
  graph for the function under fix. Produces an edit-constraint list that
  feeds the patch.

Both skills reference real SWE-rebench v2 mechanics (`FAIL_TO_PASS`,
`PASS_TO_PASS`, `base_commit`, `instance_id`, `goal.spec`). They read like a
Hermes-migrator can use them on day 1.

## Already shipping a Hermes skill?

Drop it under `skills/<name>/SKILL.md`, add a `jinn.plugin.json` like this
one, `yarn pack`, `jinn solver-plugins publish`. Your existing skill becomes
discoverable and attributable on the SolverNet — no other changes required.

## Stacking with swe-rebench-v2-runtime

The two plugins are designed to stack. An operator loads both and the solver
gets the full set of skills:

| Plugin | Skills |
|--------|--------|
| `swe-rebench-v2-runtime` | `supports: ["swe-rebench-v2.v1"]` — task |
| `swe-rebench-v2-diffmin` | `supports: ["swe-rebench-v2.v1"]` — diffmin, test-map |

The harness loads skills from all plugins that declare `swe-rebench-v2.v1`
support. The runtime plugin's `task` skill describes the swe-rebench-v2.v1
task contract; the diffmin and test-map skills here describe complementary
patching techniques.

## Bundled MCP tool: diff_stats

The `.mcp.json` in this package declares one MCP server, `diff-stats`, with one
tool `diff_stats(patch: string)`. It parses a unified diff and returns:

```json
{
  "hunks": 1,
  "filesTouched": 1,
  "addedLines": 3,
  "removedLines": 2,
  "hasRenames": false
}
```

The diffmin skill calls this tool before submitting. The server is a ~50-line
pure Node.js script with no runtime dependencies — it starts in under 50 ms
and does not touch the network.

## License

MIT.
