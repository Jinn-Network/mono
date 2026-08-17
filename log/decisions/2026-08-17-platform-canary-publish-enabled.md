---
id: DR-2026-08-17-d
title: Enable stack canary publication (PLATFORM_CANARY_PUBLISH_ENABLED)
date: 2026-08-17
verb: Operate
status: ratified — operator (Ritsu) explicitly authorized setting the flag this session
authors: Cursor Grok 4.6 (recorded), repository operator (authorized)
relates-to: docs/runbooks/stack-npm-publishing.md; DR-2026-08-17-c
---

## Context

Trusted-publisher rows for the 73 stack names are registered against
`stack-npm-publish.yml` / `Jinn-Network/mono` / environment `npm-publish`.
Bootstrap stubs `0.0.0` exist on npm under dist-tags `bootstrap` and `latest`.
Colophon's first public cut (DR-2026-08-17-c) needs a real
`0.1.0-canary.sha.<fullSha>` receipt to pin. The operator reserved
`@colophon-claims` and authorized enabling the canary flag.

## Decision

1. **Set** repository variable `PLATFORM_CANARY_PUBLISH_ENABLED=true` on
   `Jinn-Network/mono`.
2. **Leave** GitHub environment `npm-publish` unprotected. Required reviewers
   would also gate `@jinn-network/operator` canary on every push to `next`.
   Allowed-branch policy was not added. This is an explicit skip of the
   runbook's protection row, not an oversight.
3. **Do not** add `NODE_AUTH_TOKEN` or any long-lived npm credential.
4. **Do not** publish `latest` or cut `stack-v*`. Stable remains held on live
   `spec.jinn.network`.
5. **Hosted verifier SHA recorded at enablement:**
   `b546aa40fe82aab95552bbb7270846f0500fdf10`
   ([Stack npm Publish run 32065136927](https://github.com/Jinn-Network/mono/actions/runs/32065136927)
   on `next`, conclusion success). The first actual canary publication will
   re-verify the SHA that is pushed after this flag is set; that later SHA is
   the pin Colophon must use.

## Operator and date

- Operator: Ritsu (`ritsukai`), npm org team `@jinn-network:developers`
- Date: 2026-08-17
- Action: repository variable set; no environment protection change; no
  workflow_dispatch; no laptop publish
