# @jinn-network/broadcast-bot

An open-source broadcast bot that posts mechanically-sourced Jinn network state to X.

- **Inputs are verifiable.** Sources are public: GitHub releases, merged PRs, Discussions, and on-chain events from the IdentityRegistry contract.
- **Prose is LLM-authored.** Tweet copy is composed by Claude Sonnet 4.6 via the local `claude` CLI subprocess. Output is constrained by a tight system prompt + deterministic AI-tell linter, so the prose stays factual.
- **No editorial layer.** No commentary, no superlatives, no price talk, no calls to action. The bot states what happened.
- **Forkable.** MIT-licensed. Run your own instance — we run one, not the one.

This bot exists to replace the implicit editorial authority of a human-operated "voice of Jinn" X account. Tracks [issue #258](https://github.com/Jinn-Network/mono/issues/258); motivated by the **Neutrality** and **Prestige** principles in [PRINCIPLES.md](../../PRINCIPLES.md).

## What it posts

| Source | Trigger | Default filter |
|---|---|---|
| GitHub releases | New non-draft, non-prerelease release on `Jinn-Network/mono` | none |
| Merged PRs | A PR is merged into `next` or `main` | excludes `dependabot[bot]`, `github-actions[bot]`, `chore(deps)` |
| GitHub Discussions | A discussion is opened in a watched category | categories: `Announcements`, `RFCs` |
| On-chain | `IdentityRegistry.MetadataSet` with key prefix `solvernet-manifest:` or `plugin:` | first observation per metadata key |

High-noise on-chain events (every `TaskCreated`, every verdict) are **off by default**. Enable them in your fork by editing the `[onchain]` block of your config.

## Run it (canonical instance)

The Jinn-Network/mono repo runs this bot via [`.github/workflows/broadcast-bot.yml`](../../.github/workflows/broadcast-bot.yml) on a 15-minute cron. State persists to a `bot-state` branch. The workflow needs four GitHub repository secrets:

- `CLAUDE_CODE_OAUTH_TOKEN` — from `claude setup-token`. (Or `ANTHROPIC_API_KEY` as a fallback.)
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` — an X developer app + user access token from <https://developer.x.com>.

## Run your own fork

1. Fork `Jinn-Network/mono`.
2. Set the four secrets above in your fork's repository settings.
3. Edit `apps/broadcast-bot/broadcast-bot.example.toml` — point `github.repo` at the repo you want to track, adjust filters, enable on-chain if you want it.
4. Enable Actions on your fork and trigger `broadcast-bot.yml` manually once to validate. After a green run, uncomment the `schedule:` block to enable the cron.

Or run it as a standalone npm install:

```bash
npm install -g @jinn-network/broadcast-bot
export CLAUDE_CODE_OAUTH_TOKEN=...
export X_API_KEY=... X_API_SECRET=... X_ACCESS_TOKEN=... X_ACCESS_TOKEN_SECRET=...
jinn-broadcast run-once --config ./broadcast-bot.toml --state ./state.json
```

The bot expects a local `claude` CLI on PATH, authenticated via `claude login` or one of the env-var auth paths above. **If `claude` is missing, the bot exits with a clear message before doing any network I/O — there is no fallback composer.**

## Dry-run

Set `poster.backend = "stdout"` in your config (or pass `--dry-run`) to print composed tweets to stdout instead of posting. Useful for validating prompt + filter changes:

```bash
jinn-broadcast run-once --config ./broadcast-bot.toml --state ./state.json --dry-run
```

## How the prose stays factual

1. The system prompt forbids superlatives, AI tells, hashtags, emoji, CTAs, first-person plural, price language, and any fact not in the input payload.
2. Each event's payload is restricted to a small flat object — the editorial surface is whatever the source decides to include there.
3. Every composed output runs through a deterministic regex linter ([`src/composer/lint.ts`](src/composer/lint.ts)) before posting. On lint fail, the composer retries once with the failure reason; if it fails a second time, the event is skipped and surfaced in the run summary.

The full prompt + few-shot exemplars live in [`src/composer/prompt.ts`](src/composer/prompt.ts). Tune them in your fork.

## Disclosure

The canonical instance's X bio reads:

> All posts LLM-authored from mechanically-sourced GitHub + on-chain events.
> Source: github.com/Jinn-Network/mono
> Fork your own.

Forkers are asked to keep an equivalent disclosure in their bot's bio.

## Known instances

| Account | Operator | Scope |
|---|---|---|
| `@JinnNetworkAI` *(pending rename)* | Jinn-Network/mono | Canonical, posts events from `Jinn-Network/mono` only |

Open a PR to add yours.

## Out of scope

- Reply-to-mentions (broadcast-only).
- Threaded posts (single tweet per event in v0.1).
- Other platforms (Mastodon / Bluesky / Farcaster) — interface allows drivers, implementations are post-v0.1.
- AI-authored commentary, opinion, or "we believe X" framing.

## License

MIT. See [LICENSE](LICENSE).
