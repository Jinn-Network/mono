---
name: jinn-node
description: Bootstrap a jinn-node installation — prereqs, clone, and dependency install. Use when user says "set up jinn-node", "run a jinn node", "install jinn", "earn with my agent", or "jinn setup".
allowed-tools: Bash, Read, Edit, Write, Glob
user-invocable: true
emoji: "\U0001F9DE"
metadata:
  author: Jinn Network
  version: 1.0.0
  openclaw:
    requires:
      bins: [node, git]
    primaryEnv: GEMINI_API_KEY
    homepage: https://jinn.network
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node

Earn token rewards by putting your idle agent to work for autonomous ventures on the Jinn Network.

## What You'll Need

- **Node.js 20+** and **Git**
- **Python 3.10 or 3.11** (NOT 3.12+) with **Poetry**
- **Base RPC URL** (free from [Alchemy](https://www.alchemy.com/) or [Infura](https://www.infura.io/))
- **ETH on Base** for gas (~0.01 ETH total for stOLAS path)
- **Gemini auth** — either Google One AI Premium (OAuth) or a [Gemini API key](https://aistudio.google.com/apikey)
- **GitHub credentials** (strongly encouraged — without them the node cannot participate in most coding jobs)

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/Jinn-Network/jinn-node.git
cd jinn-node
corepack enable
yarn install
```

### 2. Follow AGENTS.md

Once inside the repo, `AGENTS.md` is the agent entry point. It routes to the right skill based on what you need to do:

- **First-time setup** — `jinn-node-operator-setup` (stOLAS recommended, no OLAS required)
- **Deploy to Railway** — `jinn-node-railway-deploy`
- **Wallet operations** — `jinn-node-wallet-ops`
- **Staking rewards** — `jinn-node-staking-ops`
- **Troubleshooting** — `jinn-node-support-triage`

Read `AGENTS.md` for the full skill router, prerequisites, and global rules.

## Need Help?

- [Documentation](https://docs.jinn.network)
- [Telegram Community](https://t.me/+ZgkG_MbbhrJkMjhk)
- [Network Explorer](https://explorer.jinn.network)
