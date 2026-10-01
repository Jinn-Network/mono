# Harbor 0.21.0 jobs directory, Terminal-Bench 2.1

A real jobs directory written by Harbor 0.21.0, pruned to three tasks by two arms. It is what
`run import --from harbor <jobs-dir>` is given after a claimant has run the official
Terminal-Bench 2.1 slate themselves. `src/intake/harbor-run-records.test.ts` and
`src/conformance/claimant-path.terminal-bench-2-1.test.ts` read it.

## Where it came from

The pre-publish dry run of the stranger rehearsal (issue #4742) ran Harbor twice over the first
ten tasks of the official slate, pinned to the dataset revision the slate seals:

```
harbor run -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  -a terminus-2 -m openrouter/deepseek/deepseek-v4.1-flash -n 2 -o jobs --job-name terminus-2 -i terminal-bench/<task> ...
harbor run -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  -a oracle -n 2 -o jobs --job-name oracle -i terminal-bench/<task> ...
```

**The scores in this record are not a result.** Harbor ran in a linux/arm64 container on an
Apple-silicon host, and the task images ran under emulation. The reference solution failed two of
the ten tasks there and one agent trial timed out. The record is kept for its shape. It is to be
replaced by a linux/x64 record from the real rehearsal.

## What is kept

- Per job (`jobs/oracle`, `jobs/terminus-2`): `config.json`, `lock.json` and `result.json`, byte
  for byte. They still describe all ten trials of the original job. Note that the `oracle` job
  `config.json` has no `agents` key: Harbor omits its default agent.
- Per kept trial: `config.json` and `verifier/reward.txt` byte for byte, and `result.json` with two
  lines removed (below).
- The three tasks are `adaptive-rejection-sampler`, `cancel-async-tasks` and `chess-best-move`.
  The `terminus-2` trial of `chess-best-move` is the one that ended in `AgentTimeoutError` with a
  verifier reward of `0.0`.

## What is removed

- From each trial `result.json`: `trial_uri` (an absolute path on the machine that ran Harbor) and
  `exception_info.exception_traceback` (a stack trace of install paths). Only those lines are
  deleted; every other byte is Harbor's.
- Everything else in a trial directory: `agent/` (trajectory, terminal recording, agent logs),
  `verifier/test-stdout.txt`, `verifier/ctrf.json`, `artifacts/`, the per-trial `lock.json`,
  `trial.log` and `exception.txt`. These hold task instructions, reference solutions and hidden
  test output.
- The job `job.log`, and the trials of the other seven tasks.

## The prune script

`prune.mjs` produced `jobs/` from the original directory and is the only way this fixture should
be regenerated:

```
node prune.mjs <source-jobs-dir>
```

It refuses to finish if anything it wrote holds a non-empty `env`, `kwargs`, `mcp_servers` or
`headers`, a credential-shaped key or string, a file URL, a traceback, or an absolute host path.
To change the kept tasks, edit `TASKS` at the top of the script.
