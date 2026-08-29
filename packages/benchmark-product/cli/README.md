# Colophon CLI — `@colophon-claims/cli`

Run Colophon's bundled, zero-credential sample:

```sh
npx @colophon-claims/cli@0.1
```

The sample needs Node 22 or newer and is qualified on Ubuntu x64 and Apple-silicon macOS arm64. It needs no account, API key, funds, or Docker. It publishes only to a new local directory, verifies the copied bundle after deleting the source workspace, serves the report from a loopback-only viewer, and uploads nothing. Windows and Intel macOS are not yet qualified.

To move from the sample to your own tasks, run `colophon open`. The local app uses
`./colophon-workspace` unless you select another workspace on the command line. It binds only to
loopback and does not send telemetry. SWE-bench and admitted binary-judgment item banks are the
supported import paths.

The binary path accepts only exact local manifests (UTF-8 without a byte-order mark) and reuses
the core admission and evaluation contracts:

```sh
colophon import item-bank --workspace ./colophon-workspace --principal <id> \
  --profile binary-judgment@2 --draft <draftId> \
  --items ./items.jsonl --sources ./sources.jsonl --admissions ./admissions.jsonl
```

The item file contains solver-visible question/reference/candidate payloads with digest-only
provenance. The source file separately maps those digests to full source/license descriptors;
the admission file indexes truth records previously sealed by `colophon human-review admit`.
Import authenticates and replays that signed admission closure; the index cannot assert its own
truth, publication grade, class, stratum, exclusion, or replacement selection.
No source bytes are fetched and no provider is called during import.

Claude Code and Codex arms use strict machine-local profiles. Add a profile by naming the adapter,
exact model, effort, and optional executable; Colophon observes and hashes the executable itself.
Use `colophon agent login --agent <id>` for an exactly qualified subscription build, or explicitly
grant an API-key file with `colophon agent credentials`. Add the profile to a draft with
`colophon arm add --agent`, then run `colophon doctor` before locking. Real arms
contact their provider and may create provider charges. Colophon does not create the provider
account, hold funds, or put credential values or host paths into the published bundle.
The sample's operating-system qualification does not qualify these real-agent paths;
`colophon doctor` still checks each selected adapter, credential grant, and runtime before lock or launch.

`colophon agent login` refuses unless the exact harness version and executable digest are in
Colophon's isolated login-artifact allowlist. The prepublication Mac candidates are Claude Code
2.1.222 through fresh `setup-token` capture and Codex 0.147.0 through device auth in a fresh
`CODEX_HOME`; every other build fails closed. The isolation, validation, and cleanup contract is
covered by automated tests, but a real interactive capture and provider acceptance are still
publication gates. Colophon never copies an ordinary Claude or Codex home as a shortcut. A local
doctor proves configuration, not provider acceptance.

For a received bundle, prefer the smaller reader package:

```sh
npx @colophon-claims/check@0.2 ./bundle
```
