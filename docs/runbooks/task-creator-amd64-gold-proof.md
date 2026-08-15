# Task Creator — amd64 gold-grade proof (AC #1)

Before any rung-1 mint posts to the network, prove one minted instance grades through the **unmodified** evaluator path on a proper amd64 host.

## CI (preferred)

On every `operator/**` PR, GitHub Actions runs the proof on `ubuntu-latest` (native linux/amd64):

```bash
cd operator
yarn task-creator:amd64-gold-proof
```

Workflow: `.github/workflows/ci.yml` → `task-creator-amd64-gold-proof` job.

## HF row source: committed fixture by default (#1683)

The gate proves grading semantics, not HuggingFace uptime. By default the
script makes **zero HF network calls**: the known instance's pool task + full
datasets-server row load from the committed fixture at
`operator/test/release/tier-2/fixtures/known-instance-hf.json`. A missing or
malformed fixture fails loud (naming the record command below) — it never
silently falls back to a live fetch.

- `AC1_LIVE_HF=1 yarn task-creator:amd64-gold-proof` — run against a live HF
  fetch (the pre-fixture behaviour).
- `yarn task-creator:amd64-gold-proof --record-fixture` — fetch live from HF
  and (re)write the committed fixture. Needs HF network only (no amd64 /
  Docker); run it when HF is healthy, e.g. after the known instance rotates,
  and commit the updated JSON.

## Manual operator run

### Prerequisites

- Native **linux/amd64** (not Apple Silicon / QEMU emulation)
- Docker (linux/amd64)
- Python 3
- `yarn build` in `operator/`
- `jinn harnesses enable swe-rebench-v2-evaluator` (the script auto-enables if missing)

### Steps

```bash
cd operator
yarn build
yarn task-creator:amd64-gold-proof
```

For a full mint-tasks → IPFS → validate loop (optional):

```bash
jinn solver-nets mint-tasks swe-rebench-v2 --candidates ./fixtures/mint-candidate-example.json --no-post
```

## Pass criteria

- Host is `linux/x64`
- `RoutingTaskRowFetcher` resolves the minted row
- `rowHash` + image digest pin unchanged
- Gold patch scores resolving; known-bad patch scores 0 (discrimination pass)

Spec: `spec/2026-07-08-task-creator-v0.md` §13 AC #1.
