# Paired (two-operator) console flow — manual runbook

**Type:** human-run check, NOT an automated test. Run as a **soft, human-judgment
gate on the Monday named cut** (DR-2026-06-08) — Captain runs it before publishing
and records a verdict (see [Recording the verdict](#recording-the-verdict-release-gate)
below). Soft means nothing in `npm-publish.yml` blocks; the human is the classifier.

The former SPA launcher/join paired flow is retired with the daemon-served SPA.
Console v1 does not port Launcher, curator, SolverNet draft-launch, captures,
embedded-agent WS, leaderboard, or fleet view. This runbook checks the inherited
surfaces against two real daemons.

**Gating coverage already exists, deterministically:** console Playwright
`e2e:app-flow` (claim-policy + posting-status) and `e2e:funding-sequence` run
in CI / the hermetic gate against a mocked daemon. This runbook is the *manual*
way to eyeball the real *app* layer; nothing depends on it being green.

## Goal

Two distinct operators each run a headless daemon and an operator console.
Captain confirms handshake, overview (bootstrap / funding / rewards as
projections), events, notifications, claim policy + execution wiring, network,
security, and the read-only posting view.

## Two operators

You need two **distinct, funded, bootstrapped** testnet operators — two separate
on-chain identities (EOA / Safe / agentId), each a `.jinn-client` tree.

- The env-suite warm operators live at `~/jinn-dev/operators/op-b` and
  `~/jinn-dev/operators/op-c` (each is a `<dir>/.jinn-client`). These are the
  pair used below. **Do NOT use `~/.jinn-client`** — that's the Railway-hosted
  production operator; running it locally double-spends its nonce.
- To make a fresh pair, bootstrap two operators per the earning flow (CLAUDE.md
  §Earning bootstrap), each in its own HOME, each funded with testnet ETH + OLAS.

Each operator's keystore decrypts with its **own** `keystore-password` file.
`JINN_PASSWORD` env takes precedence over that file (`operator/src/main.ts`), so if
the two operators have **different** passwords (they usually do), do NOT export a
single `JINN_PASSWORD` — let each daemon read its own file.

## Per operator

1. Start the daemon (`jinn run --no-ui` in that HOME). Confirm `GET /` returns
   `{ "error": "no_human_surface" }` and `GET /health` is 200.
2. Mint a UI token: `jinn auth token`.
3. Start the console against that daemon:

   ```bash
   cd apps/operator-console
   NEXT_PUBLIC_JINN_OPERATOR_URL=http://127.0.0.1:<apiPort> \
   NEXT_PUBLIC_JINN_UI_TOKEN=<token> \
   yarn dev --port <consolePort>
   ```

   Use distinct API and console ports for op-b vs op-c.
4. Open the console. Handshake must succeed (`contractVersion` major 1). A minor
   mismatch shows a banner and continues; a major mismatch is a full-page stop.

## Checklist

For each operator:

- [ ] Handshake ok (or warn-only on minor)
- [ ] Overview shows bootstrap / funding / rewards projections
- [ ] Events page tails CloudEvents (`Last-Event-ID` resume after a refresh)
- [ ] Notifications render; an unknown kind still shows envelope title
- [ ] Claim policy save persists and shows restart-required
- [ ] Execution wiring row is visible
- [ ] Network posting view is read-only
- [ ] Security page loads

## Recording the verdict (release gate)

Append one line to [`log/decisions/release-readiness-runs.md`](../../../log/decisions/release-readiness-runs.md):

- **pass** — proceed with the Monday cut
- **infra-blocked** — RPC / indexer / faucet judged not-the-product; record the
  symptom and proceed
- **product-red** — hold the cut, file a `fix`, re-run

Hotfixes are exempt.
