# Harbor 0.21.0 jobs directories, Terminal-Bench 2.1

Two real jobs directories written by Harbor 0.21.0, each pruned to a few tasks by two arms. Each
is what `run import --from harbor <jobs-dir>` is given after a claimant has run the official
Terminal-Bench 2.1 slate themselves.

| Directory | Tasks | Trials per task | Read by |
| --- | --- | --- | --- |
| `jobs/` | 3 | 1 | `src/intake/harbor-run-records.test.ts`, `src/conformance/claimant-path.terminal-bench-2-1.test.ts` |
| `jobs-two-attempts/` | 2 | 2 | `src/intake/harbor-run-records.test.ts` |

These two records are also the list of Harbor versions the reader accepts. `--from harbor` reads
a job only when its `lock.json` states a version that a record here states, and a test holds the
two lists equal. To accept another Harbor version, add a real jobs directory written by it.

## Where `jobs/` came from

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

## Where `jobs-two-attempts/` came from

A second run on 2026-10-06, made to see how Harbor 0.21.0 writes more than one attempt of a task.
It ran two tasks by the same two arms, two attempts each and retries off:

```
harbor run -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  -a oracle --n-attempts 2 --max-retries 0 --n-concurrent 2 -o jobs --job-name oracle \
  -i terminal-bench/adaptive-rejection-sampler -i terminal-bench/cancel-async-tasks
harbor run -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  -a terminus-2 -m openrouter/deepseek/deepseek-v4.1-flash --n-attempts 2 --max-retries 0 --n-concurrent 2 \
  -o jobs --job-name terminus-2 \
  -i terminal-bench/adaptive-rejection-sampler -i terminal-bench/cancel-async-tasks
```

(`-n` in the first record's commands is `--n-concurrent`, not the attempts flag.)

What the record shows:

- Two attempts of one task are two sibling trial directories in the job directory, each named
  `<task>__<seven random characters>`. Harbor numbers neither. Their `config.json` files differ
  only in `trial_name`, and nothing in the job files says which attempt is which.
- The job `config.json` carries `"n_attempts": 2`. The job `lock.json` lists each planned trial,
  so a task appears twice there, and states `retry.max_retries` as 0. The job `result.json` states
  `stats.n_retries` as 0.
- The `terminus-2` job holds a reward of `1.0` and of `0.0`, each with and without
  `AgentTimeoutError`: both trials of `adaptive-rejection-sampler` ran to the agent timeout, and
  the verifier still wrote a reward for each.

**The scores in this record are not a result either.** Harbor ran in a linux/amd64 container
under emulation on an Apple-silicon host.

## What is kept

- Per job (`oracle`, `terminus-2`): `config.json`, `lock.json` and `result.json`, byte for byte.
  In `jobs/` they still describe all ten trials of the original job. Note that the `oracle` job
  `config.json` has no `agents` key: Harbor omits its default agent.
- Per kept trial: `config.json` and `verifier/reward.txt` byte for byte, and `result.json` with two
  lines removed (below).
- In `jobs/` the three tasks are `adaptive-rejection-sampler`, `cancel-async-tasks` and
  `chess-best-move`. The `terminus-2` trial of `chess-best-move` is the one that ended in
  `AgentTimeoutError` with a verifier reward of `0.0`.
- In `jobs-two-attempts/` the two tasks are `adaptive-rejection-sampler` and
  `cancel-async-tasks`, with both trial directories of each. Nothing was dropped from the
  original job but the files listed below.

## What is removed

- From each trial `result.json`: `trial_uri` (an absolute path on the machine that ran Harbor) and
  `exception_info.exception_traceback` (a stack trace of install paths). Only those lines are
  deleted; every other byte is Harbor's.
- Everything else in a trial directory: `agent/` (trajectory, terminal recording, agent logs),
  `verifier/test-stdout.txt`, `verifier/ctrf.json`, `artifacts/`, the per-trial `lock.json`,
  `trial.log` and `exception.txt`. These hold task instructions, reference solutions and hidden
  test output.
- The job `job.log`, and from `jobs/` the trials of the other seven tasks.

## The prune script

`prune.mjs` produced each record from the directory Harbor wrote and is the only way either
should be regenerated. Its first argument names the record, which is also the directory it
writes:

```
node prune.mjs jobs <source-jobs-dir>
node prune.mjs jobs-two-attempts <source-jobs-dir>
```

It refuses to finish if anything it wrote holds a non-empty `env`, `kwargs`, `mcp_servers` or
`headers`, a credential-shaped key or string, a file URL, a traceback, or an absolute host path.
It also refuses a source job that holds any other number of trial directories for a kept task
than the record states. To change the kept tasks, or to add a record, edit `RECORDS` at the top
of the script.
