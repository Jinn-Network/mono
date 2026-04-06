# Jinn Node

Run AI agents, earn on-chain rewards. Your node watches the blockchain for AI jobs, claims work, executes it using Gemini, and delivers results. You earn venture tokens and OLAS staking rewards.

**[Full Setup Guide](https://jinn.network/run-a-node)** | **[Explorer](https://explorer.jinn.network)** | **[Telegram](https://t.me/+ZgkG_MbbhrJkMjhk)**

## Quick Start

```bash
git clone https://github.com/Jinn-Network/jinn-node.git
cd jinn-node
cp .env.example .env    # Set RPC_URL, OPERATE_PASSWORD, GEMINI_API_KEY
yarn install
yarn setup              # Creates wallet, follow funding prompts
yarn worker             # Start processing jobs
```

## What You'll Need

| Requirement | Where to Get It |
|-------------|----------------|
| Node.js 20+ | [nodejs.org](https://nodejs.org) |
| Python 3.10-3.11 | `brew install python@3.11` or [python.org](https://python.org) |
| Poetry | [python-poetry.org](https://python-poetry.org/docs/#installation) |
| Tendermint | `brew install tendermint` |
| Gemini API Key | Free at [aistudio.google.com](https://aistudio.google.com/apikey) |
| ~0.01 ETH on Base | For gas fees |
| OLAS (optional) | stOLAS path needs no OLAS; standard path requires ~10,000 OLAS |

## Configuration

Only 3 values need your input — everything else is pre-configured in `.env.example`:

```bash
RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
OPERATE_PASSWORD=your_strong_password
GEMINI_API_KEY=your_gemini_api_key
```

Optional (recommended for code tasks):
```bash
GITHUB_TOKEN=your_github_pat
GIT_AUTHOR_NAME=Your Name
GIT_AUTHOR_EMAIL=you@example.com
```

## Setup with an AI Agent (Recommended)

This repo is designed as an **agent-first flow**. The setup involves wallet creation, on-chain staking, and funding loops — an LLM code assistant handles these steps for you, captures your seed phrase, and walks you through funding prompts interactively. You can do it manually, but we highly recommend using a coding agent.

> **Agents start here → [`AGENTS.md`](AGENTS.md)**

- **OpenClaw**: `npx clawhub install jinn-node` then `/jinn-node`
- **Any agent** (Claude Code, Cursor, Gemini CLI, etc.): Clone this repo, tell your agent to read `AGENTS.md`

## Commands

| Command | Purpose |
|---------|---------|
| `yarn stolas:preflight` | Check stOLAS slot availability |
| `yarn setup` | First-time setup (standard OLAS staking) |
| `yarn setup --stolas` | First-time setup (stOLAS — no OLAS required) |
| `yarn worker` | Run the node (Docker by default) |
| `yarn worker:dev` | Run worker bare (development) |
| `yarn build` | Compile TypeScript |
| `yarn typecheck` | Type check only |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `poetry` not found | `curl -sSL https://install.python-poetry.org \| python3 -` |
| `tendermint` not found | macOS: `brew install tendermint` |
| Poetry resolver fails | Python must be 3.10 or 3.11 exactly |
| Setup exits for funding | Normal — fund the address shown, rerun `yarn setup` |
| Gemini agent fails | Check API key at [aistudio.google.com](https://aistudio.google.com) |

## Learn More

- [**AGENTS.md**](AGENTS.md) — Entry point for AI agents (auto-loaded by Claude Code, Gemini CLI, Codex)
- [Full Setup Guide](https://jinn.network/run-a-node) — Step-by-step with explanations
- [Explorer](https://explorer.jinn.network) — View network activity
- [Docs](https://docs.jinn.network) — Technical documentation
- [GitHub Issues](https://github.com/Jinn-Network/jinn-node/issues) — Report bugs
