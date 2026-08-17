---
name: testing-jinn-app
description: Use when smoke-testing or writing regression coverage for the operator console — handshake, overview, events, notifications, claim policy, execution wiring, network, security, posting view — or reproducing a paper cut a user reported. Covers manual walks against a live daemon plus Playwright E2E with a mocked daemon API.
---

# Testing the operator console

The operator human surface is the Next.js console at `apps/operator-console/`.
The daemon is headless (`GET /` returns `{ "error": "no_human_surface" }`).
The console talks to `http://127.0.0.1:7331` with `x-jinn-ui-token` and never
`withCredentials`.

Two complementary recipes:

1. **Manual smoke** against a live daemon + `yarn dev` in `apps/operator-console`.
2. **Automated E2E** via Playwright with a mocked daemon API
   (`apps/operator-console/e2e/`).

**Canonical domain model:** [`apps/operator-console/OPERATOR-APP-SPEC.md`](../../../apps/operator-console/OPERATOR-APP-SPEC.md).

Launcher / curator / SolverNet draft-launch, captures UI, embedded-agent WS,
leaderboard, and fleet view are **not** console v1 surfaces.

## When to use

- After console changes that touch routing, handshake, or inherited surfaces
- Before opening a PR that changes operator-visible surfaces
- Reproducing a reported paper cut
- Adding regression coverage for a new console workflow

## Daemon + console spawn

1. `cd operator && yarn build && node dist/bin/jinn.js run --no-ui`
2. `jinn auth token` (or read the token file beside daemon state)
3. `cd apps/operator-console && NEXT_PUBLIC_JINN_OPERATOR_URL=http://127.0.0.1:7331 NEXT_PUBLIC_JINN_UI_TOKEN=<token> yarn dev`
4. Wait for daemon `GET /health` 200 and console handshake (`GET /v1/status`
   with `contractVersion`) before walking the UI.

Restart-respawn tests must **not** use `--no-ui` (`JINN_NO_UI=1` skips
in-process respawn).

## Automated E2E (Playwright)

Specs live under `apps/operator-console/e2e/`. Mock helper:
`apps/operator-console/e2e/helpers/mock-operator-api.ts`. Status fixtures
**must** include `contractVersion: { major: 1, minor: 0 }` or handshake fails.

```bash
cd apps/operator-console
yarn e2e:app-flow          # claim-policy + posting-status
yarn e2e:funding-sequence
yarn e2e                   # all console Playwright
```

From the operator package the same scripts are aliases:
`yarn e2e:app-flow` / `yarn e2e:funding-sequence`.

T1.4 (`yarn release:tier-1:T1.4`) is the console app-flow smoke. The
release-readiness marker key remains `tier-1-spa-route-smoke` (dated schema;
not retro-edited).

## Multi-operator

Spawn helpers: `operator/test/helpers/multi-op-daemon.ts`.

- [`references/multi-op-spawn.md`](references/multi-op-spawn.md)
- [`references/multi-op-chrome-devtools.md`](references/multi-op-chrome-devtools.md)
- [`references/multi-op-playwright.md`](references/multi-op-playwright.md)
- [`references/scenario-cross-op-donation.md`](references/scenario-cross-op-donation.md) — T2.1
- [`references/scenario-producer-evaluator.md`](references/scenario-producer-evaluator.md) — T2.2
- [`references/scenario-multi-op-console-flow.md`](references/scenario-multi-op-console-flow.md) — Monday paired-flow runbook

## Common mistakes

- Forgetting `contractVersion` on mocked `/v1/status` (handshake full-page stop)
- Using `withCredentials` or cookie auth (forbidden under §9)
- Pointing Playwright at the daemon origin (`GET /` is not a UI)
- Mocking too little — handshake fetches `/v1/status` before any page

## References

- Canonical spec: `apps/operator-console/OPERATOR-APP-SPEC.md`
- Headless remote access: `docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md` §9
- Playwright config: `apps/operator-console/playwright.config.ts`
