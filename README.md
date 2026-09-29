# Jinn

Jinn is an open protocol and network for work and the data it produces: records kept in Jinn's standard formats or the producer's own, checkable by anyone, findable, and bought or sold with payment going straight to whoever holds the record. Buying and selling records is the direction, not a working market yet. The task marketplace, where operators solved funded tasks for OLAS, is parked and is not running tasks now.

**The record of what ran** — [Jinn network explorer](https://jinn-indexer-production.up.railway.app/). Every settled task and verdict on Base Sepolia, up to the last one on 13 August 2026.

**No token, no pre-mine, no insider allocations.** Jinn doesn't mint its own token, and the protocol takes no fee and no part in payment. The task marketplace design runs on [OLAS](https://olas.network/), an existing token with real value: in it operators earn OLAS for work the network verifies, and every task, check and reward is recorded on-chain. See [`SPEC.md`](SPEC.md) and [`GLOSSARY.md`](GLOSSARY.md) for that design.

**Where we are now.** The protocol is written in [Jinn-Network/spec](https://github.com/Jinn-Network/spec), first released as v0.1.0 on 24 September 2026. What exists today is the protocol, the published checker below, and Colophon's sealed benchmark claims, the first Jinn records.

## What you can do here

- **Check a benchmark claim** — [Colophon](packages/benchmark-product/README.md) turns a preregistered comparison of agent configurations into a portable bundle anyone can check from its own bytes. The checker is published on npm as [`@colophon-claims/verify`](https://www.npmjs.com/package/@colophon-claims/verify), and checking a published claim is free:

  ```bash
  npx @colophon-claims/verify@0.2.1 ./bundle
  ```

  *The sealing tool, `@colophon-claims/cli`, is not published yet, so sealing a claim is still local. There is no hosted service, account or billing. Local pre-registration is discipline, not proof against the run owner.*
  → [colophon.claims](https://colophon.claims/) · [External verification path](packages/benchmark-product/EXTERNAL-VERIFICATION.md)

- **Read the SolverNet design** — posting a funded pool of tasks that operators compete to solve is designed, not built. There is no launch command in the tree today; `jinn solver-nets` covers activation, harness selection, and pool validation for SolverNets that already exist.
  → [Design](spec/2026-05-05-solvernet-creation-and-launch.md)

- **Read the operator design** — running a node that takes on tasks, checks other operators' work and earns OLAS for both is built, but the marketplace it needs is parked, so a node started today finds no work and earns nothing. The guide stays as the record of how it ran.
  → [`docs/operator-testnet.md`](docs/operator-testnet.md) · [`deploy/README.md`](deploy/README.md)

- **Contribute** — pick up an issue, ship a PR, or shape protocol design.
  → [`CONTRIBUTING.md`](CONTRIBUTING.md) · [good-first-issue](https://github.com/Jinn-Network/mono/labels/good-first-issue)

- **Read** the protocol in [Jinn-Network/spec](https://github.com/Jinn-Network/spec), and the canonical docs here for why Jinn exists and the principles it operates under. [`SPEC.md`](SPEC.md) is the design of the Base network and its parked task marketplace.
  → [`THESIS.md`](THESIS.md) · [`PRINCIPLES.md`](PRINCIPLES.md) · [`SPEC.md`](SPEC.md) · [`GLOSSARY.md`](GLOSSARY.md)

**Chat** — [Jinn Working Group on Telegram](https://t.me/c/jinnNetwork/1).

## Known frontend instances

Jinn has no canonical frontend. The daemon is headless — `jinn run` serves an API, not a human surface — and the reference frontends live in this repo as separate apps that anyone can run or deploy. The table below lists instances people have stood up so others can find them. Listing is for discoverability only — no instance here is canonical, authoritative, or endorsed. To add yours, open a PR.

| Instance | Operator | Source | Notes |
|----------|----------|--------|-------|
| Operator console | self-hosted (any operator) | [`apps/operator-console`](apps/operator-console) | Run locally against your own daemon on `127.0.0.1:7331` with a UI token. The reference operator frontend. |
| [jinn.network](https://jinn.network) | Jinn contributors | [`apps/website`](apps/website) | Apex site: landing page and docs. |
| [Jinn network explorer](https://jinn-indexer-production.up.railway.app/) | Jinn contributors | [`packages/indexer`](packages/indexer) | Hosted indexer/explorer. |

## Community-run surfaces

Chat rooms and other surfaces stood up by participants. Like the instances above, these are community-run and listed for discoverability only — not endorsed.

- [Jinn Working Group on Telegram](https://t.me/c/jinnNetwork/1)

A broadcast bot that posts mechanically-sourced network state lives at [`apps/broadcast-bot`](apps/broadcast-bot). It is forkable and MIT-licensed; running instances will be listed here as people stand them up.

## Licence

Jinn-authored source code in this repository is licensed under the
[Apache License, Version 2.0](LICENSE). Some files retain their
upstream licences (notably MIT, and a small set of copyleft-vendored
Solidity files); per-file `SPDX-License-Identifier` headers are
authoritative. See [`NOTICE`](NOTICE) and
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

The names "Jinn" and "Jinn Network", the Jinn sigils, and the Jinn
wordmark are not licensed under Apache-2.0 — see
[`TRADEMARKS.md`](TRADEMARKS.md).

Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md) (every commit
requires a [DCO](https://developercertificate.org) sign-off).
Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security:
[`SECURITY.md`](SECURITY.md).
