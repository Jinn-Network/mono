# Benchmark report

**Complete comparison. No comparative winner is stated.**

Scope: 1 tasks · 2 arms · 2 replicates · self-run.

Report SHA-256: `a2ad26617832d49b576207f1d0865b822864e5e29a3b4993f1351181c4b2a136`

Matrix SHA-256: `81075baacb6b69f2ddb727de38fba004d6adc622a1ed560729eeec812ee5fc86`

Read the [full report](index.html), [limitations](index.html#limitations), and [portable verification instructions](index.html#verification).

## Prominent adverse facts

- Report limitations: 6; read every limitation below.
- Claim limitations: 6; read every limitation below.

## Configurations

- **control** — pinning: {"harness":{"id":"inspect-ai","version":"0.3.255"},"jinn.network/inspect-arm":"control","model":{"id":"mockllm/model"}}
- **candidate** — pinning: {"harness":{"id":"inspect-ai","version":"0.3.255"},"jinn.network/inspect-arm":"candidate","model":{"id":"mockllm/model"}}

## Sealed Matrix accounting

Source: authenticated [`matrix.json`](matrix.json). These stored values are not reconciled with another source.

    {"attrition":{"asymmetryFlags":[],"perArm":{"candidate":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0},"control":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0}}},"completeness":{"expected":4,"floor":"1","judged":4,"runOutcome":"complete"}}

## Sealed Report facts

Source: authenticated [`report.json`](report.json). These stored values are not reconciled with another source.

### Sealed Report arm results

| Arm | n | Pass rate | Wilson low | Wilson high |
|---|---:|---:|---:|---:|
| candidate | 2 | 1.0000 | 0.3424 | 1.0000 |
| control | 2 | 1.0000 | 0.3424 | 1.0000 |

### Report method and preregistration

- Report method: jinn.benchmarking.method/wilson @ 1
- Report preregistered: yes
- Report parameters: {"verdictRule":"sole"}

### Report conflicts

    {"cellKeys":[],"count":0}

### Report disclosures

    {"perSubject":[{"attrition":{"asymmetryFlags":[],"perArm":{"candidate":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0},"control":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0}}},"completeness":{"expected":4,"floor":"1","judged":4,"runOutcome":"complete"},"independence":0,"integrityTiers":{"attested-only":4,"re-derivable":0},"pinning":{"harness":{"match":4,"mismatch":0,"unverifiable":0},"isolation":{"match":4,"mismatch":0,"unverifiable":0},"loadout":{"match":0,"mismatch":0,"unverifiable":4},"model":{"match":4,"mismatch":0,"unverifiable":0}},"subjectSha256":"81075baacb6b69f2ddb727de38fba004d6adc622a1ed560729eeec812ee5fc86"}]}

### Report limitations

- This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.
- Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.
- Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.
- Cost figures, where present, are self-reported by this venue and were never independently settled.
- Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties.
- 1 disposable preview rehearsal\(s\) of this benchmark ran before lock \(at 2026-08-10T17:34:33.902Z\); preview results are rehearsal only and never entered official results.

## Stored Claim facts

Source: authenticated [`claim-package.json`](claim-package.json). These stored values are not reconciled with another source.

### Stored claim mirror

| Arm | n | Pass rate | Wilson low | Wilson high |
|---|---:|---:|---:|---:|
| candidate | 2 | 1.0000 | 0.3424 | 1.0000 |
| control | 2 | 1.0000 | 0.3424 | 1.0000 |

### Claim method and preregistration

- Claim method: jinn.benchmarking.method/wilson @ 1
- Claim preregistered: yes
- Claim parameters: {"verdictRule":"sole"}

### Claim completeness

    {"expected":4,"floor":"1","judged":4,"runOutcome":"complete"}

### Claim attrition

    {"asymmetryFlags":[],"perArm":{"candidate":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0},"control":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0}}}

### Claim conflicts

    {"cellKeys":[],"count":0}

### Claim disclosures

    {"integrityTierCounts":{"attested-only":4,"re-derivable":0},"perSubject":[{"attrition":{"asymmetryFlags":[],"perArm":{"candidate":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0},"control":{"excluded":0,"expected":2,"expired":0,"invalidated":0,"judged":2,"replacements":0,"unjudged":0,"unscorable":0}}},"completeness":{"expected":4,"floor":"1","judged":4,"runOutcome":"complete"},"independence":0,"integrityTiers":{"attested-only":4,"re-derivable":0},"pinning":{"harness":{"match":4,"mismatch":0,"unverifiable":0},"isolation":{"match":4,"mismatch":0,"unverifiable":0},"loadout":{"match":0,"mismatch":0,"unverifiable":4},"model":{"match":4,"mismatch":0,"unverifiable":0}},"subjectSha256":"81075baacb6b69f2ddb727de38fba004d6adc622a1ed560729eeec812ee5fc86"}],"pinningUnverifiableCounts":{"harness":0,"isolation":0,"loadout":4,"model":0}}

### Claim limitations

- This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.
- Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.
- Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.
- Cost figures, where present, are self-reported by this venue and were never independently settled.
- Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties.
- 1 disposable preview rehearsal\(s\) of this benchmark ran before lock \(at 2026-08-10T17:34:33.902Z\); preview results are rehearsal only and never entered official results.

### Claim assurance, rehearsal, and self-run trust boundary

- Assurance: direct-check — {"distinctEvaluator":false,"independence":"disclosed","minVerdicts":1,"verdictRule":"sole"}
- Boundary: Distinct evaluator identities are workspace-minted keys; they prove agent-distinctness, not party-independence, on this self-run venue.
- Rehearsal: {"previewCount":1,"timestamps":\["2026-08-10T17:34:33.902Z"\]}
- Venue honesty: {"limits":\["This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.","Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.","Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.","Cost figures, where present, are self-reported by this venue and were never independently settled.","Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties."\],"preRegistration":"structural-and-append-order-only","unverifiableAxisCounts":{"harness":0,"isolation":0,"loadout":4,"model":0},"venue":"self-run"}

## Verification assembly dissent

Source: authenticated [verification assembly](verification/assembly.jsonl).

    {"dissentCellKeys":[]}

## Raw records and catalogs

### Top-level records and catalogs

- [Benchmark record (`benchmark.json`)](benchmark.json)
- [Run record (`run.json`)](run.json)
- [Matrix record (`matrix.json`)](matrix.json)
- [Report payload (`report.json`)](report.json)
- [Report signature envelope (`report-envelope.json`)](report-envelope.json)
- [Claim package (`claim-package.json`)](claim-package.json)
- [Static-bundle projection (`static-bundle.json`)](static-bundle.json)
- [Evidence catalog (`evidence.json`)](evidence.json)
- [Verdict catalog (`verdicts.json`)](verdicts.json)
- [Verification assembly (`verification/assembly.jsonl`)](verification/assembly.jsonl)
- [Public trust material (`trust/public-keys.json`)](trust/public-keys.json)

### Every manifest-listed content-addressed record

- [CAS record `records/088e64ec3bfb61b4a77fe2deda3bb536d517e96299a144d53fb6843a4cffa4bc.bin`](records/088e64ec3bfb61b4a77fe2deda3bb536d517e96299a144d53fb6843a4cffa4bc.bin)
- [CAS record `records/0d4fc5c0d158c144284b2d33778d2836f24040c25d30a18450107fc59183b005.bin`](records/0d4fc5c0d158c144284b2d33778d2836f24040c25d30a18450107fc59183b005.bin)
- [CAS record `records/15418715efee4ff6754965afcc165ec0d5ea9a9e2802b760ffadf7964b7a2716.bin`](records/15418715efee4ff6754965afcc165ec0d5ea9a9e2802b760ffadf7964b7a2716.bin)
- [CAS record `records/1d3da7aafc05f2b7541262d2d6d04ba1f37216b9b755f6d7e0a1f421a644be84.bin`](records/1d3da7aafc05f2b7541262d2d6d04ba1f37216b9b755f6d7e0a1f421a644be84.bin)
- [CAS record `records/2bb614f5d3d4affdfd34d08b90f79e1b85b9adc19d653716aa12d69d30332f02.bin`](records/2bb614f5d3d4affdfd34d08b90f79e1b85b9adc19d653716aa12d69d30332f02.bin)
- [CAS record `records/304feff63c6f13957297c81a61fa1960651405cccbf8af4384ea2f192dd8eeb6.bin`](records/304feff63c6f13957297c81a61fa1960651405cccbf8af4384ea2f192dd8eeb6.bin)
- [CAS record `records/3a5dd8320580396354b7c6fdd72d4a2f86ca3d312993caa4f304318f314fc91a.bin`](records/3a5dd8320580396354b7c6fdd72d4a2f86ca3d312993caa4f304318f314fc91a.bin)
- [CAS record `records/3c3e76159b3b4959c86e73b7ceabb8034d0a8a244088e089646173cb52eb9d25.bin`](records/3c3e76159b3b4959c86e73b7ceabb8034d0a8a244088e089646173cb52eb9d25.bin)
- [CAS record `records/3d433258716de2b0e963fbb6b8c25351839266a3300a296bee2fa2d031600109.bin`](records/3d433258716de2b0e963fbb6b8c25351839266a3300a296bee2fa2d031600109.bin)
- [CAS record `records/41c22d2112b4e7b8862faa34683516a9c82730e717c694ee338ac5e2ac3abefa.bin`](records/41c22d2112b4e7b8862faa34683516a9c82730e717c694ee338ac5e2ac3abefa.bin)
- [CAS record `records/451302a8c204b884d6ac195ea1df56a5bf24528427125d3a3403ff43b860601a.bin`](records/451302a8c204b884d6ac195ea1df56a5bf24528427125d3a3403ff43b860601a.bin)
- [CAS record `records/4976dbf9e5d59486e87aac2c1d73d854d0e167c70368c33f2afd6ef4615dc2af.bin`](records/4976dbf9e5d59486e87aac2c1d73d854d0e167c70368c33f2afd6ef4615dc2af.bin)
- [CAS record `records/6adcbff8652016d97ba57bc60650caa82c34b3efef5ac1de6a716f40970959d9.bin`](records/6adcbff8652016d97ba57bc60650caa82c34b3efef5ac1de6a716f40970959d9.bin)
- [CAS record `records/6f6b3dba458ce50a1d48559f875055a5a6284e92ae1379b50da09b475b873941.bin`](records/6f6b3dba458ce50a1d48559f875055a5a6284e92ae1379b50da09b475b873941.bin)
- [CAS record `records/8d29d732a499f7f747634f68afbb35db028ad47cfbc26dc56593544ddd85e2d1.bin`](records/8d29d732a499f7f747634f68afbb35db028ad47cfbc26dc56593544ddd85e2d1.bin)
- [CAS record `records/a10d1b5942e0094810ab1cfb0fa66bfc9a37ba1477aea569490a4b6766b61045.bin`](records/a10d1b5942e0094810ab1cfb0fa66bfc9a37ba1477aea569490a4b6766b61045.bin)
- [CAS record `records/a450ebd07c62ea6781a8f8c56806a4e524ff1534ba084e848259779a1c2135cd.bin`](records/a450ebd07c62ea6781a8f8c56806a4e524ff1534ba084e848259779a1c2135cd.bin)
- [CAS record `records/b0f93be47851889d72589f344f733e0daaf54b31b8db24f14e4b012cc75f067c.bin`](records/b0f93be47851889d72589f344f733e0daaf54b31b8db24f14e4b012cc75f067c.bin)
- [CAS record `records/bb11320baef2fd24c4225e4e7b88b2bbf7bf51684f3f7d2e21d9fb534b97a69a.bin`](records/bb11320baef2fd24c4225e4e7b88b2bbf7bf51684f3f7d2e21d9fb534b97a69a.bin)
- [CAS record `records/dac91de0a98f10bd568effe08bd27d11f60f62439efed5e87b387a2ba6a383c8.bin`](records/dac91de0a98f10bd568effe08bd27d11f60f62439efed5e87b387a2ba6a383c8.bin)
- [CAS record `records/dfa917e6f83319d6c08afa4cb4cd440bef02dd02a424e05773f57843b690453d.bin`](records/dfa917e6f83319d6c08afa4cb4cd440bef02dd02a424e05773f57843b690453d.bin)
- [CAS record `records/edafd27d52a1d99ac2f3e92be6235134a8ff745830d7ceb3f354ce1fd81c30dc.bin`](records/edafd27d52a1d99ac2f3e92be6235134a8ff745830d7ceb3f354ce1fd81c30dc.bin)

## Portable verification

Copy the complete bundle directory and run:

    benchmark-product bundle verify --bundle <bundle-dir> --json

The verifier authenticates the manifest, records, evidence graph, Matrix, Report, claim consistency, and every presentation byte using only bundle-carried public trust material. See [index.html#verification](index.html#verification). Runs on Jinn benchmarking records — independently verifiable
