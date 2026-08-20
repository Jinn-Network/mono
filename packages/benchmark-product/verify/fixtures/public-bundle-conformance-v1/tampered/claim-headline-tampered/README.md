# Colophon report

**Complete comparison. No comparative winner is stated.**

Scope: 3 tasks · 2 arms · 1 replicates · self-run.

Report SHA-256: `1a72e2614af474c4728c211f702d7bd7e3615f44c6ac7520f5874549207d2ebb`

Matrix SHA-256: `546ed4c8bc349db998dabe34ffd5f452d85009423aff5a621a24ee6ed08d43b7`

Read the [full report](index.html), [limitations](index.html#limitations), and [portable verification instructions](index.html#verification).

## What happened, task by task

Across 3 paired cells, baseline had lower solverBrier in 3; sample-uniform had lower solverBrier in 0; 0 tied. Lower is better. This is descriptive evidence, not a registered comparative winner.

This bundled sample demonstrates the evidence path, not agent quality. Its outcomes are synthetic and derived from the sample consensus inputs.

- **Will the alpha proposal pass its scheduled vote?** — Sample consensus input: 64% Yes. Synthetic sample resolution: Yes.
  - **baseline**, replicate 1: Forecast 64% Yes; 0.129600 solverBrier \(lower-is-better\); outcome judged. Task evidence `records/f8de1772acabd52dc9cd8c7b0b0032783fd0c4f8a2b5f69b5f6e8717e9816a96.bin`; outputs `records/9a225761d611a6c1ce90bd06610003295a43e655ea289202b3460b47f447fcc7.bin`; verdicts `records/01095a2187cb4d177eff622d8076c5c91b892585dcaa89c6eb87de5648b8bf71.bin`.
  - **sample-uniform**, replicate 1: Forecast 50% Yes; 0.250000 solverBrier \(lower-is-better\); outcome judged. Task evidence `records/f8de1772acabd52dc9cd8c7b0b0032783fd0c4f8a2b5f69b5f6e8717e9816a96.bin`; outputs `records/a4a1614977357adfaf8bf40e4a6e242ca922b5419772184b9f661488030b1b97.bin`; verdicts `records/7bbb7119cae3223ddd29bfaf8bd78447d6da5d659a8fe1d65ad279879c814f90.bin`.
- **Will the bravo shipment arrive before its deadline?** — Sample consensus input: 32% Yes. Synthetic sample resolution: No.
  - **baseline**, replicate 1: Forecast 32% Yes; 0.102400 solverBrier \(lower-is-better\); outcome judged. Task evidence `records/38ce0dafcc5e973ef974ab6ab1d5bfca36a549523f76fbdaa5b0b85246a0fd8f.bin`; outputs `records/0ecf6d739cd1e370bf5672fa9338049de1b4708316405b8a32afd212e6ad8c80.bin`; verdicts `records/d72ba451e951b7b116af4da36b6409a825a20423f3075b5c7caaab1f6b4cc6d0.bin`.
  - **sample-uniform**, replicate 1: Forecast 50% Yes; 0.250000 solverBrier \(lower-is-better\); outcome judged. Task evidence `records/38ce0dafcc5e973ef974ab6ab1d5bfca36a549523f76fbdaa5b0b85246a0fd8f.bin`; outputs `records/b493b5a1d94858d4dacd0d89dc36f16083bdbe653bca7c859ad3f5950eda96b3.bin`; verdicts `records/e73c15a84cde53b1defafac5610d8dd0d40d0645e60deb46ef5eeb2bd6193280.bin`.
- **Will the charlie contract renew for another term?** — Sample consensus input: 100% Yes. Synthetic sample resolution: Yes.
  - **baseline**, replicate 1: Forecast 100% Yes; 0.000000 solverBrier \(lower-is-better\); outcome judged. Task evidence `records/a87ae8bcb68dc32d497b59f7cb795896ce06455f3d9fba9479d2499b7a10acdc.bin`; outputs `records/679106e6fbedff4acf8a24515fb7f5e5d4144aedf0a4ce9eb21237e28cd6be90.bin`; verdicts `records/1dfc54a56d80c18fa7d21c265b28c59a18dd333d620d1f1099a401df6d4971d9.bin`.
  - **sample-uniform**, replicate 1: Forecast 50% Yes; 0.250000 solverBrier \(lower-is-better\); outcome judged. Task evidence `records/a87ae8bcb68dc32d497b59f7cb795896ce06455f3d9fba9479d2499b7a10acdc.bin`; outputs `records/d7e22c8154501aad395e4bd28b1b46aa8e7114b079d6290a4c3b7f70c6a305d6.bin`; verdicts `records/63d10d4bc3d0ce614c725e1130ccae726a91d0b76217957ee5e602fa094b29e0.bin`.

## Prominent adverse facts

- Report limitations: 5; read every limitation below.
- Claim limitations: 5; read every limitation below.

## Configurations

- **baseline** — pinning: {"harness":{"id":"prediction-v1-baseline","version":"1.0.0"}}
- **sample-uniform** — pinning: {"harness":{"id":"sample-uniform","version":"0.1.0"}}

## Sealed Matrix accounting

Source: authenticated [`matrix.json`](matrix.json). These stored values are not reconciled with another source.

    {"attrition":{"asymmetryFlags":[],"perArm":{"baseline":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0},"sample-uniform":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0}}},"completeness":{"expected":6,"floor":"1","judged":6,"runOutcome":"complete"}}

## Sealed Report facts

Source: authenticated [`report.json`](report.json). These stored values are not reconciled with another source.

### Sealed Report arm results

| Arm | n | Pass rate | Wilson low | Wilson high |
|---|---:|---:|---:|---:|
| baseline | 3 | 1.0000 | 0.4385 | 1.0000 |
| sample-uniform | 3 | 1.0000 | 0.4385 | 1.0000 |

### Report method and preregistration

- Report method: jinn.benchmarking.method/wilson @ 1
- Report preregistered: yes
- Report parameters: {"verdictRule":"sole"}

### Report conflicts

    {"cellKeys":[],"count":0}

### Report disclosures

    {"perSubject":[{"attrition":{"asymmetryFlags":[],"perArm":{"baseline":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0},"sample-uniform":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0}}},"completeness":{"expected":6,"floor":"1","judged":6,"runOutcome":"complete"},"independence":0,"integrityTiers":{"attested-only":0,"re-derivable":6},"pinning":{"harness":{"match":6,"mismatch":0,"unverifiable":0},"isolation":{"match":6,"mismatch":0,"unverifiable":0},"loadout":{"match":0,"mismatch":0,"unverifiable":6},"model":{"match":0,"mismatch":0,"unverifiable":6}},"subjectSha256":"546ed4c8bc349db998dabe34ffd5f452d85009423aff5a621a24ee6ed08d43b7"}]}

### Report limitations

- This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.
- Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.
- Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.
- Cost figures, where present, are self-reported by this venue and were never independently settled.
- Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties.

## Stored Claim facts

Source: authenticated [`claim-package.json`](claim-package.json). These stored values are not reconciled with another source.

### Stored claim mirror

| Arm | n | Pass rate | Wilson low | Wilson high |
|---|---:|---:|---:|---:|
| baseline | 3 | 1.0000 | 0.4385 | 1.0000 |
| sample-uniform | 3 | 1.0000 | 0.4385 | 1.0000 |

### Claim method and preregistration

- Claim method: jinn.benchmarking.method/wilson @ 1
- Claim preregistered: yes
- Claim parameters: {"verdictRule":"sole"}

### Claim completeness

    {"expected":6,"floor":"1","judged":6,"runOutcome":"complete"}

### Claim attrition

    {"asymmetryFlags":[],"perArm":{"baseline":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0},"sample-uniform":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0}}}

### Claim conflicts

    {"cellKeys":[],"count":0}

### Claim disclosures

    {"integrityTierCounts":{"attested-only":0,"re-derivable":6},"perSubject":[{"attrition":{"asymmetryFlags":[],"perArm":{"baseline":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0},"sample-uniform":{"excluded":0,"expected":3,"expired":0,"invalidated":0,"judged":3,"replacements":0,"unjudged":0,"unscorable":0}}},"completeness":{"expected":6,"floor":"1","judged":6,"runOutcome":"complete"},"independence":0,"integrityTiers":{"attested-only":0,"re-derivable":6},"pinning":{"harness":{"match":6,"mismatch":0,"unverifiable":0},"isolation":{"match":6,"mismatch":0,"unverifiable":0},"loadout":{"match":0,"mismatch":0,"unverifiable":6},"model":{"match":0,"mismatch":0,"unverifiable":6}},"subjectSha256":"546ed4c8bc349db998dabe34ffd5f452d85009423aff5a621a24ee6ed08d43b7"}],"pinningUnverifiableCounts":{"harness":0,"isolation":0,"loadout":6,"model":6}}

### Claim limitations

- This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.
- Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.
- Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.
- Cost figures, where present, are self-reported by this venue and were never independently settled.
- Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties.

### Claim assurance, rehearsal, and self-run trust boundary

- Assurance: direct-check — {"distinctEvaluator":false,"independence":"disclosed","minVerdicts":1,"verdictRule":"sole"}
- Boundary: Distinct evaluator identities are workspace-minted keys; they prove agent-distinctness, not party-independence, on this self-run venue.
- Rehearsal: null
- Venue honesty: {"limits":\["This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.","Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.","Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.","Cost figures, where present, are self-reported by this venue and were never independently settled.","Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties."\],"preRegistration":"structural-and-append-order-only","unverifiableAxisCounts":{"harness":0,"isolation":0,"loadout":6,"model":6},"venue":"self-run"}

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

- [CAS record `records/01095a2187cb4d177eff622d8076c5c91b892585dcaa89c6eb87de5648b8bf71.bin`](records/01095a2187cb4d177eff622d8076c5c91b892585dcaa89c6eb87de5648b8bf71.bin)
- [CAS record `records/01f641980d3a729b744da46030ca3a562813dfcfe8cadd7e7968d3ce58915924.bin`](records/01f641980d3a729b744da46030ca3a562813dfcfe8cadd7e7968d3ce58915924.bin)
- [CAS record `records/028f6e88f4d8ae37d1286254dfab87fac994a2d8f1e60f10c1b647a3411bb1ab.bin`](records/028f6e88f4d8ae37d1286254dfab87fac994a2d8f1e60f10c1b647a3411bb1ab.bin)
- [CAS record `records/0adc9877ad94946ed7bbcc1ebd0406b74d12348afb9f60ad5b5c18a83a79acc9.bin`](records/0adc9877ad94946ed7bbcc1ebd0406b74d12348afb9f60ad5b5c18a83a79acc9.bin)
- [CAS record `records/0aea45cded8d736dfa2e22bf86021d593246454f1276622beab2411a3bf76f58.bin`](records/0aea45cded8d736dfa2e22bf86021d593246454f1276622beab2411a3bf76f58.bin)
- [CAS record `records/0c4e03bef25879c34c67e09587ad5607163ff2e9620aa9aa51905b77d9927a0d.bin`](records/0c4e03bef25879c34c67e09587ad5607163ff2e9620aa9aa51905b77d9927a0d.bin)
- [CAS record `records/0ecf6d739cd1e370bf5672fa9338049de1b4708316405b8a32afd212e6ad8c80.bin`](records/0ecf6d739cd1e370bf5672fa9338049de1b4708316405b8a32afd212e6ad8c80.bin)
- [CAS record `records/16a2d063b30dac74abdd5785a34dce8323f4dc2520103f4e23f334f26274e826.bin`](records/16a2d063b30dac74abdd5785a34dce8323f4dc2520103f4e23f334f26274e826.bin)
- [CAS record `records/193fda468b317dcfb35d3c8247a73ea3de56e3e47591fb570b4c0c7298c720a9.bin`](records/193fda468b317dcfb35d3c8247a73ea3de56e3e47591fb570b4c0c7298c720a9.bin)
- [CAS record `records/1dfc54a56d80c18fa7d21c265b28c59a18dd333d620d1f1099a401df6d4971d9.bin`](records/1dfc54a56d80c18fa7d21c265b28c59a18dd333d620d1f1099a401df6d4971d9.bin)
- [CAS record `records/3877d488fb4ea99ca7be0fd9a8f2a2c6be5ee7d7f62ed4df11c8c3afadb9727a.bin`](records/3877d488fb4ea99ca7be0fd9a8f2a2c6be5ee7d7f62ed4df11c8c3afadb9727a.bin)
- [CAS record `records/38ce0dafcc5e973ef974ab6ab1d5bfca36a549523f76fbdaa5b0b85246a0fd8f.bin`](records/38ce0dafcc5e973ef974ab6ab1d5bfca36a549523f76fbdaa5b0b85246a0fd8f.bin)
- [CAS record `records/44311cc4f5b26778fc3814d6c5d01bdcf96cf5185cfd5e61a23ea4d640d3785c.bin`](records/44311cc4f5b26778fc3814d6c5d01bdcf96cf5185cfd5e61a23ea4d640d3785c.bin)
- [CAS record `records/47e81bb22f4a8a3730735dc272ef0eff62b6f065ba89b6bb19cf0bf11fd733ad.bin`](records/47e81bb22f4a8a3730735dc272ef0eff62b6f065ba89b6bb19cf0bf11fd733ad.bin)
- [CAS record `records/4e37ad5c282f05ed1e7d2a4710c5e4ad3a972e36a22fe20c59ad3ed35a711459.bin`](records/4e37ad5c282f05ed1e7d2a4710c5e4ad3a972e36a22fe20c59ad3ed35a711459.bin)
- [CAS record `records/4f7b8d6fdf84e5cc652d0454740eb55110a20897b03eb091a48c10076c6de959.bin`](records/4f7b8d6fdf84e5cc652d0454740eb55110a20897b03eb091a48c10076c6de959.bin)
- [CAS record `records/5102192d8e33580bf6babe9d1bcb419fdf13e32cc994302a02aabb836cd25a03.bin`](records/5102192d8e33580bf6babe9d1bcb419fdf13e32cc994302a02aabb836cd25a03.bin)
- [CAS record `records/567bf2f42789b7a67bebe7fd2894aedec695d847cae6985e57c9d136a194ed55.bin`](records/567bf2f42789b7a67bebe7fd2894aedec695d847cae6985e57c9d136a194ed55.bin)
- [CAS record `records/5ebf02a23f1a581a0e222f01b5ee6f65f5809a41ef322508b36f1c5cb1c5ff6c.bin`](records/5ebf02a23f1a581a0e222f01b5ee6f65f5809a41ef322508b36f1c5cb1c5ff6c.bin)
- [CAS record `records/63d10d4bc3d0ce614c725e1130ccae726a91d0b76217957ee5e602fa094b29e0.bin`](records/63d10d4bc3d0ce614c725e1130ccae726a91d0b76217957ee5e602fa094b29e0.bin)
- [CAS record `records/672aca68a10fd6fadffb07a528bb8ea2b1713779ef35c79532dad2ada14f19b6.bin`](records/672aca68a10fd6fadffb07a528bb8ea2b1713779ef35c79532dad2ada14f19b6.bin)
- [CAS record `records/679106e6fbedff4acf8a24515fb7f5e5d4144aedf0a4ce9eb21237e28cd6be90.bin`](records/679106e6fbedff4acf8a24515fb7f5e5d4144aedf0a4ce9eb21237e28cd6be90.bin)
- [CAS record `records/695cd33128ed2865794e997a9a04ef169763d01d60d5f2ecc9c791c3ae35daae.bin`](records/695cd33128ed2865794e997a9a04ef169763d01d60d5f2ecc9c791c3ae35daae.bin)
- [CAS record `records/7a124b9d5af3ef07b5d21b92519a5c30f01ca159bedf057c000397b7dc1a145f.bin`](records/7a124b9d5af3ef07b5d21b92519a5c30f01ca159bedf057c000397b7dc1a145f.bin)
- [CAS record `records/7bbb7119cae3223ddd29bfaf8bd78447d6da5d659a8fe1d65ad279879c814f90.bin`](records/7bbb7119cae3223ddd29bfaf8bd78447d6da5d659a8fe1d65ad279879c814f90.bin)
- [CAS record `records/7e057614a12fc00fac155af7f48544a2c22512fa36b1000bd8142c2a042004d4.bin`](records/7e057614a12fc00fac155af7f48544a2c22512fa36b1000bd8142c2a042004d4.bin)
- [CAS record `records/81f6e3ff1c8f9c1981d90385edc19e7c5ca427092add6ad127840fa9fa8bf9dc.bin`](records/81f6e3ff1c8f9c1981d90385edc19e7c5ca427092add6ad127840fa9fa8bf9dc.bin)
- [CAS record `records/96ab0c377a4c4bc20494291ac715d4f7c415d154a1091b01c9d7408e2dc6551b.bin`](records/96ab0c377a4c4bc20494291ac715d4f7c415d154a1091b01c9d7408e2dc6551b.bin)
- [CAS record `records/99dc41582df9c3a0100a380662fff1ce72afdea4f505f7c4b5fa39d65e83e2bd.bin`](records/99dc41582df9c3a0100a380662fff1ce72afdea4f505f7c4b5fa39d65e83e2bd.bin)
- [CAS record `records/9a225761d611a6c1ce90bd06610003295a43e655ea289202b3460b47f447fcc7.bin`](records/9a225761d611a6c1ce90bd06610003295a43e655ea289202b3460b47f447fcc7.bin)
- [CAS record `records/9bc94ca84a912de65c1b8ac3822ef3be3651798bc760aa7151b6340bf6a77883.bin`](records/9bc94ca84a912de65c1b8ac3822ef3be3651798bc760aa7151b6340bf6a77883.bin)
- [CAS record `records/9bf777f8dce68a51a861f1fc58381f96b70d618a1caa8180313e1736b428abf2.bin`](records/9bf777f8dce68a51a861f1fc58381f96b70d618a1caa8180313e1736b428abf2.bin)
- [CAS record `records/9c21d91f99bf48578e7052148b5d481dcc25dc88311318184e982fa026494fe0.bin`](records/9c21d91f99bf48578e7052148b5d481dcc25dc88311318184e982fa026494fe0.bin)
- [CAS record `records/a4a1614977357adfaf8bf40e4a6e242ca922b5419772184b9f661488030b1b97.bin`](records/a4a1614977357adfaf8bf40e4a6e242ca922b5419772184b9f661488030b1b97.bin)
- [CAS record `records/a6821a066168cb199adf550ec515ad14dc7f9a27587963cbb5cc549732a31e0c.bin`](records/a6821a066168cb199adf550ec515ad14dc7f9a27587963cbb5cc549732a31e0c.bin)
- [CAS record `records/a6f44c6247faff5e668a7115a46786d0a9d94d5a57b37f990c54282284b92225.bin`](records/a6f44c6247faff5e668a7115a46786d0a9d94d5a57b37f990c54282284b92225.bin)
- [CAS record `records/a87ae8bcb68dc32d497b59f7cb795896ce06455f3d9fba9479d2499b7a10acdc.bin`](records/a87ae8bcb68dc32d497b59f7cb795896ce06455f3d9fba9479d2499b7a10acdc.bin)
- [CAS record `records/ac1f4f6e82e6d064791838fdc21c00709b2c7d8e9346a2fb6c78909b630c9916.bin`](records/ac1f4f6e82e6d064791838fdc21c00709b2c7d8e9346a2fb6c78909b630c9916.bin)
- [CAS record `records/b22bf7890f603e166af8c49b367d38a2ded2e2507b77824bd424945fa164f2ff.bin`](records/b22bf7890f603e166af8c49b367d38a2ded2e2507b77824bd424945fa164f2ff.bin)
- [CAS record `records/b493b5a1d94858d4dacd0d89dc36f16083bdbe653bca7c859ad3f5950eda96b3.bin`](records/b493b5a1d94858d4dacd0d89dc36f16083bdbe653bca7c859ad3f5950eda96b3.bin)
- [CAS record `records/c32fad4e253a9e66dd5c4aab9151c922e268ee0d2c3d14a477982a34ea3e9392.bin`](records/c32fad4e253a9e66dd5c4aab9151c922e268ee0d2c3d14a477982a34ea3e9392.bin)
- [CAS record `records/ca5360973a234809dee38dcad006b9010e978df9e06adb85398b48ee5090b5f9.bin`](records/ca5360973a234809dee38dcad006b9010e978df9e06adb85398b48ee5090b5f9.bin)
- [CAS record `records/d34df81f730f2c486e80055a991584dcb5a974e7bf1b69ce158ec6f578863c44.bin`](records/d34df81f730f2c486e80055a991584dcb5a974e7bf1b69ce158ec6f578863c44.bin)
- [CAS record `records/d72ba451e951b7b116af4da36b6409a825a20423f3075b5c7caaab1f6b4cc6d0.bin`](records/d72ba451e951b7b116af4da36b6409a825a20423f3075b5c7caaab1f6b4cc6d0.bin)
- [CAS record `records/d7e22c8154501aad395e4bd28b1b46aa8e7114b079d6290a4c3b7f70c6a305d6.bin`](records/d7e22c8154501aad395e4bd28b1b46aa8e7114b079d6290a4c3b7f70c6a305d6.bin)
- [CAS record `records/d8fe2e9eddfd7de00b75ac66ea598aa57df93fc2cd82351edc5f9e1be13caf1a.bin`](records/d8fe2e9eddfd7de00b75ac66ea598aa57df93fc2cd82351edc5f9e1be13caf1a.bin)
- [CAS record `records/dabdf24a8ed3e3ed0e928dea15a8ac3ea4efc046987622eb486068ef3087a38f.bin`](records/dabdf24a8ed3e3ed0e928dea15a8ac3ea4efc046987622eb486068ef3087a38f.bin)
- [CAS record `records/de7a995513ad7f5de33d01804cad7ed22d11a513949e0f25c93cf7c8058feb26.bin`](records/de7a995513ad7f5de33d01804cad7ed22d11a513949e0f25c93cf7c8058feb26.bin)
- [CAS record `records/df6cbec82c2fc728ca99dcac82f790232af6dc74026e0f840463c789a23ada06.bin`](records/df6cbec82c2fc728ca99dcac82f790232af6dc74026e0f840463c789a23ada06.bin)
- [CAS record `records/e73c15a84cde53b1defafac5610d8dd0d40d0645e60deb46ef5eeb2bd6193280.bin`](records/e73c15a84cde53b1defafac5610d8dd0d40d0645e60deb46ef5eeb2bd6193280.bin)
- [CAS record `records/ec15d9cb17175dd7167b27bb9a36350aed9f7f2d131d4586e3a9db002fee553c.bin`](records/ec15d9cb17175dd7167b27bb9a36350aed9f7f2d131d4586e3a9db002fee553c.bin)
- [CAS record `records/f1b6b24dec7e518fa58c8330846be859c8bf5ba441d975d5fd49ba4e926c93cf.bin`](records/f1b6b24dec7e518fa58c8330846be859c8bf5ba441d975d5fd49ba4e926c93cf.bin)
- [CAS record `records/f633e5f6692fe4ce62f27abb7110d76b8227c28857cf64afa7536388703777ec.bin`](records/f633e5f6692fe4ce62f27abb7110d76b8227c28857cf64afa7536388703777ec.bin)
- [CAS record `records/f8de1772acabd52dc9cd8c7b0b0032783fd0c4f8a2b5f69b5f6e8717e9816a96.bin`](records/f8de1772acabd52dc9cd8c7b0b0032783fd0c4f8a2b5f69b5f6e8717e9816a96.bin)
- [CAS record `records/f9bc55d6fa07978fd3bcc1b6c6ea2c9deb9ab38e9bae3055be93b3911467e9cf.bin`](records/f9bc55d6fa07978fd3bcc1b6c6ea2c9deb9ab38e9bae3055be93b3911467e9cf.bin)

## Portable verification

Copy the complete bundle directory. Reproduce publication with the exact verifier:

    npx @colophon-claims/verify@0.1.0 <bundle-dir>

Use the compatible major line to receive fixes that preserve this bundle-format contract:

    npx @colophon-claims/verify@0.1 <bundle-dir>

The verifier authenticates the manifest, records, evidence graph, Matrix, Report, claim consistency, and every presentation byte using only bundle-carried public trust material. See [index.html#verification](index.html#verification). Built on Jinn.

Typography is embedded for offline use from the SIL Open Font License distributions of Newsreader, Public Sans, and IBM Plex Mono. The complete notices follow so the redistributed font software travels with its license.

## Newsreader font license

```text
Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader) Newsreader-Italic[opsz,wght].ttf: Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Public Sans font license

```text
Copyright 2015 The Public Sans Project Authors (https://github.com/uswds/public-sans) PublicSans-Italic[wght].ttf: Copyright 2015 The Public Sans Project Authors (https://github.com/uswds/public-sans)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## IBM Plex Mono font license

```text
Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-ThinItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-ExtraLight.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-ExtraLightItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Light.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-LightItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Regular.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Italic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Medium.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-MediumItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-SemiBold.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-SemiBoldItalic.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-Bold.ttf: Copyright 2017 IBM Corp. All rights reserved. IBMPlexMono-BoldItalic.ttf: Copyright 2017 IBM Corp. All rights reserved.

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
