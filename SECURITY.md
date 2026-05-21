# Security Policy

## Reporting a vulnerability

**Do not file a public issue or Discussion for a suspected vulnerability.**

Two private channels are accepted:

1. **GitHub private vulnerability reporting** (preferred). On
   `Jinn-Network/mono`, use *Security → Report a vulnerability*. This
   routes directly to repository administrators and creates a private
   advisory thread.
2. **Email**: `security@jinn.network`. Encrypt with the PGP key
   published in the repository at `.well-known/security/pgp-key.asc`
   if your report contains sensitive material (exploit code, on-chain
   addresses involved in active incidents, etc.). If the PGP key is
   not yet published, send a request-for-pubkey first and we will
   respond with one.

Please include:

- A description of the issue and the impact you expect.
- The component affected — daemon (`client/`), contracts
  (`contracts/`), indexer (`packages/indexer/`), docs, or
  infrastructure.
- Steps to reproduce, or a proof-of-concept where possible.
- Whether the issue is already public, partially public, or
  embargoed. If embargoed, include any deadline you are working to.

We will acknowledge receipt within **3 working days**, give an initial
triage assessment within **7 working days**, and aim to issue a fix
or mitigation within **90 days** of the report for confirmed
high-severity issues. Lower-severity issues may track the normal
release cadence.

## Scope

In scope:

- The Jinn daemon under `client/` (CLI, daemon loops, earning
  bootstrap, runners, store, MCP server, x402, discovery, peer sync).
- The Solidity contracts under `contracts/src/` authored by the Jinn
  Network team (claiming, staking, tasks, tokenomics, vendor wrappers
  authored by us). Vendored upstream code under
  `contracts/src/vendor/` is in scope only where Jinn-authored
  contracts depend on it; primary vulnerabilities in upstream code
  should be reported to the upstream project as well.
- The published npm packages under `packages/` and the indexer.
- The published Docker images and binaries for the daemon.

Out of scope:

- Third-party services and contracts we interact with at runtime
  (RPC providers, external smart contracts, IPFS gateways, npm
  registry, and similar). Report vulnerabilities in those to the
  relevant upstream.
- Issues that require already-compromised operator keys, root on the
  operator's machine, or a malicious browser extension. We will read
  these but they will generally not be treated as security issues
  against Jinn.
- Findings against historical contract deployments that have been
  superseded by a documented migration. Check `spec/` and
  `log/decisions/` first.

## Disclosure

We follow coordinated disclosure. After a fix or mitigation is shipped,
we publish a GitHub Security Advisory describing the vulnerability, the
fix, and (where appropriate) credit to the reporter. Reporters who
prefer to remain anonymous will be credited as "an anonymous
researcher" or not at all, at the reporter's choice.

We may delay public disclosure where a fix requires on-chain
governance actions or where premature disclosure would put funds at
risk.

## Safe harbour

Good-faith security research against Jinn's testnets, deployed
mainnet contracts, daemon software, and infrastructure does not
violate our terms. "Good faith" means:

- You stop as soon as you have proof of the issue. Do not exfiltrate
  data beyond what is needed to demonstrate impact.
- You do not move user funds, manipulate user state, or degrade the
  service for others.
- You report through one of the channels above before public
  disclosure.

We will not pursue legal action against researchers who operate
within this safe harbour and report in good faith.

## What this policy is not

This policy does not promise a bug bounty programme, and the
existence of this file is not an offer of payment. Bounty programmes,
if and when they exist, will be announced in
`https://github.com/Jinn-Network/mono/discussions` and linked from
this file.
