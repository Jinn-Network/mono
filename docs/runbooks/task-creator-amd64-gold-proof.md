# Task Creator — amd64 gold-grade proof (AC #1)

Before any rung-1 mint posts to the network, prove one minted instance grades through the **unmodified** evaluator path on a proper amd64 host.

## CI (preferred)

On every `client/**` PR, GitHub Actions runs the proof on `ubuntu-latest` (native linux/amd64):

```bash
cd client
yarn task-creator:amd64-gold-proof
```

Workflow: `.github/workflows/ci.yml` → `task-creator-amd64-gold-proof` job.

## Manual operator run

### Prerequisites

- Native **linux/amd64** (not Apple Silicon / QEMU emulation)
- Docker (linux/amd64)
- Python 3
- `yarn build` in `client/`
- `jinn harnesses enable swe-rebench-v2-evaluator` (the script auto-enables if missing)

### Steps

```bash
cd client
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
