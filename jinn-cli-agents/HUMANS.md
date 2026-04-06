---
title: Human Developer Guide
purpose: entry-point
last_verified: 2026-02-01
---

# Human Developer Guide

> Quick start and navigation for human developers.

---

## What is Jinn?

Jinn is an autonomous agent platform built on OLAS. It connects an on-chain job marketplace to AI agents that execute work and deliver results back to the blockchain.

For full details: [README.md](README.md)

---

## Quick Start

**Prerequisites:** Node 22+, Yarn 1.22+, Python 3.11

```bash
yarn install
cp .env.template .env  # Edit with your keys
yarn dev:stack         # Start Ponder + Control API + Worker
```

Full setup guide: [Setup Worker](docs/runbooks/setup-worker.md)

---

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `worker/` | Job execution engine |
| `gemini-agent/` | Gemini CLI + MCP tools |
| `ponder/` | Blockchain event indexer |
| `control-api/` | GraphQL API gateway |
| `frontend/explorer/` | Job monitoring UI |
| `codespec/` | Code quality enforcement |

---

## Common Commands

| Task | Command |
|------|---------|
| Start dev stack | `yarn dev:stack` |
| Run tests | `yarn test` |
| Frontend | `yarn frontend:dev` |
| Type check | `yarn build` |
| Single job | `yarn dev:mech --single` |
| Parallel workers | `yarn dev:mech:parallel -w 3` |

---

## Documentation Index

| Need | Location |
|------|----------|
| How-to guides | [docs/runbooks/](docs/runbooks/) |
| Architecture | [docs/context/](docs/context/) |
| API reference | [docs/reference/](docs/reference/) |
| Troubleshooting | docs/runbooks/troubleshoot-*.md |
| Code standards | [docs/guides/code-spec.md](docs/guides/code-spec.md) |
| Blood written rules | [docs/reference/blood-written-rules.md](docs/reference/blood-written-rules.md) |

---

## Key Runbooks

- [Setup Worker](docs/runbooks/setup-worker.md) - Initial development setup
- [Deploy OLAS Service](docs/runbooks/deploy-olas-service.md) - OLAS service deployment
- [Launch Workstream](docs/runbooks/launch-workstream.md) - Creating workstreams
- [Configure Staking](docs/runbooks/configure-staking.md) - Staking configuration
- [Recover OLAS Funds](docs/runbooks/recover-olas-funds.md) - Fund recovery procedures

---

## Key Reference Docs

- [Environment Variables](docs/reference/environment-variables.md) - All env vars
- [Job Lifecycle](docs/reference/job-lifecycle.md) - Job states and transitions
- [Tool Policy](docs/reference/tool-policy.md) - MCP tool access control
- [Constants](docs/reference/constants.md) - Contract addresses and endpoints

---

## Task Tracking

Use beads for task tracking:

```bash
bd ready              # Find available work
bd show <id>          # View task details
bd update <id> --status=in_progress
bd close <id>
bd sync               # Sync with remote
```

---

*For AI agent instructions, see [AGENTS.md](AGENTS.md).*
