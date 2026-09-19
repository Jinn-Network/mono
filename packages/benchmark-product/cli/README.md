# Colophon CLI — `@colophon-claims/cli`

The published `colophon` command. A stranger uses it to make a claim, not only to
check one.

```sh
npx @colophon-claims/cli@0.1 --help
```

## Claimant verbs this package exposes

These verbs are the published claimant path:

| Verb | Role |
|---|---|
| `method` | Bind a named suite or method document onto a draft |
| `arm add` | Add a pinned solver arm |
| `lock` | Seal the method before the run |
| `anchor` | Publicly anchor the sealed lock or matrix |
| `run import` | Bring a finished harness run back onto the sealed slate |
| `collect` | Collect sealed evidence after the run |
| `report` | Produce the report |
| `publish` | Emit the local public bundle |
| `results` | Read the sealed results document |
| `status` | Read draft or run status |

```sh
npx @colophon-claims/cli@0.1 method --help
npx @colophon-claims/cli@0.1 arm add --help
npx @colophon-claims/cli@0.1 lock --help
npx @colophon-claims/cli@0.1 anchor --help
npx @colophon-claims/cli@0.1 run import --help
npx @colophon-claims/cli@0.1 collect --help
npx @colophon-claims/cli@0.1 report --help
npx @colophon-claims/cli@0.1 publish --help
npx @colophon-claims/cli@0.1 results --help
npx @colophon-claims/cli@0.1 status --help
```

`help --advanced` prints the full lifecycle library.

## Service venue verbs

`launch`, `resume`, `preview`, `quote`, and the other venue-orchestration verbs
are the service's machinery on a venue Colophon controls. They are not the
claimant path. A claimant runs the benchmark on Harbor, Inspect, or their own
harness and brings the finished output with `run import`.

## Bundled sample

```sh
npx @colophon-claims/cli@0.1
```

The sample needs Node 22 or newer and is qualified on Ubuntu x64 and Apple-silicon macOS arm64. It needs no account, API key, funds, or Docker. It publishes only to a new local directory, verifies the copied bundle after deleting the source workspace, serves the report from a loopback-only viewer, and uploads nothing. Windows and Intel macOS are not yet qualified.

To move from the sample to your own tasks, run `colophon open`. The local app uses
`./colophon-workspace` unless you select another workspace on the command line. It binds only to
loopback and does not send telemetry. SWE-bench is the supported import path for homemade
instance rows.

Claude Code and Codex arms use strict machine-local profiles. Add a profile by naming the adapter,
exact model, effort, and optional executable; Colophon observes and hashes the executable itself.
Use `colophon agent login --agent <id>` for an exactly qualified subscription build, or explicitly
grant an API-key file with `colophon agent credentials`. Add the profile to a draft with
`colophon arm add --agent`, then run `colophon doctor` before locking. Real arms
contact their provider and may create provider charges. Colophon does not create the provider
account, hold funds, or put credential values or host paths into the published bundle.
The sample's operating-system qualification does not qualify these real-agent paths;
`colophon doctor` still checks each selected adapter, credential grant, and runtime before lock.

`colophon agent login` refuses unless the exact harness version and executable digest are in
Colophon's isolated login-artifact allowlist. The prepublication Mac candidates are Claude Code
2.1.222 through fresh `setup-token` capture and Codex 0.147.0 through device auth in a fresh
`CODEX_HOME`; every other build fails closed. The isolation, validation, and cleanup contract is
covered by automated tests, but a real interactive capture and provider acceptance are still
publication gates. Colophon never copies an ordinary Claude or Codex home as a shortcut. A local
doctor proves configuration, not provider acceptance.

For this release, `@jinn-network/*` is pinned to the exact
`0.1.0-canary.sha.0533a224cf99f06d7facf0c23455f2781a5b9e62` receipt.
It is not a floating `@canary` dependency and is not a stable stack release.

For a received bundle, the smaller reader surface is:

```sh
npx @colophon-claims/check@0.2 ./bundle
```

That line reads the bundle formats through public-bundle/6, and only the claims that pin it.
Reader lines are not forward compatible, and a reader that is too old refuses with the same code
an invalid bundle earns, so before concluding anything from a refusal, read the line the bundle's
own claim package pins in `verification.command` — the producer named it for that exact bundle.
The per-format table in [`PUBLIC-BUNDLE.md`](../PUBLIC-BUNDLE.md) covers the case where you have
only `bundle.json`; the format string alone is not sufficient, because prompted-screening bundles
pin a later line without changing their format.

## What this does not yet prove

Protocol identifiers in the installed platform packages are names, not addresses.
This CLI fetches nothing from them. Checks run against the exact `@jinn-network/*`
platform bytes installed from npm, and those bytes are the whole basis of every
check it reports.
