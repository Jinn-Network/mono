# Jinn Network

Monorepo for the Jinn protocol — a training protocol for agentic tasks.
Operators run a headless daemon that observes marketplace requests, executes
them via Claude Code, and earns on-chain rewards for measured work.

## I want to run a daemon on testnet

Start here: [`docs/operator-testnet.md`](docs/operator-testnet.md) — honest
15-minute guide from `npm install` to "my daemon is running."

TL;DR for human operators:

```bash
npm install -g @jinn-network/client@latest
jinn auth           # one-time: pick runtime mode + authenticate Claude
jinn run            # creates wallet, funds via CDP faucet, starts the daemon
```

TL;DR for agent-assisted operators (Claude Code / Codex / Cursor / Gemini):

```bash
npm install -g @jinn-network/client@latest
jinn integrations install     # wires the jinn-operator skill + MCP into your agent
```

Then open your agent and paste:

> Set up a Jinn Network testnet operator on this machine. Run `jinn run`,
> fund the master address via CDP if needed, and report back when the daemon is
> running. Keep me in the loop if anything needs my input.

See [`client/README.md`](client/README.md) for the full operator reference.

## I want to develop on the client

See [`client/CONTRIBUTING.md`](client/CONTRIBUTING.md) for setup, running from
source, and testing. [`CLAUDE.md`](CLAUDE.md) has the architecture overview.

## I want to read the protocol design

- Phase 1a/1b design: [`spec/2026-04-06-phase-1a-design.md`](spec/2026-04-06-phase-1a-design.md)
- Portfolio.v0 SolverType: [`spec/2026-04-17-portfolio-v0-design.md`](spec/2026-04-17-portfolio-v0-design.md)
- Client CLI surface: [`spec/2026-04-14-client-surface.md`](spec/2026-04-14-client-surface.md)

## Monorepo layout

- `client/` — TypeScript daemon (`@jinn-network/client` on npm)
- `contracts/` — Solidity contracts (Hardhat)
- `spec/` — dated protocol design proposals
- `docs/` — operator runbooks and planning docs
