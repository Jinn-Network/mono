<!-- GENERATED FILE — DO NOT EDIT. Run: node .github/scripts/generate-architecture.mjs -->

# Generated platform topology

Source authority: [`architecture/platform-packages.v1.json`](../platform-packages.v1.json) and each cataloged package manifest.

## Inventory

The catalog contains **97** entries: **13** `sealed-platform-v1` packages, **60** `implementations-v1` packages, **2** disabled `experimental-policy` packages, **16** other entries below `packages/**`, and **6** adjacent entries.

| Package | Path | Domain | Tier | Classification | Role | Stability | Release group | Publish policy | Runtime dependencies | Optional dependencies | Peer dependencies |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| @jinn-network/broadcast-bot | apps/broadcast-bot | repository-operations | — | repository-tooling | repository and community communications automation | stable-semantics | transitional-or-private | never | smol-toml<br>twitter-api-v2<br>viem<br>zod | — | — |
| @jinn-network/operator-console | apps/operator-console | operator | 4 | product | operator console product | candidate | transitional-or-private | private | @jinn-network/lifecycle-notifications<br>class-variance-authority<br>clsx<br>lucide-react<br>next<br>radix-ui<br>react<br>react-dom<br>tailwind-merge | — | — |
| @jinn-network/website | apps/website | devx | 4 | product | developer-experience website product | candidate | transitional-or-private | private | class-variance-authority<br>clsx<br>fumadocs-core<br>fumadocs-mdx<br>fumadocs-ui<br>lucide-react<br>next<br>radix-ui<br>react<br>react-dom<br>tailwind-merge<br>zod | — | — |
| @jinn-network/operator | operator | operator | 4 | product | operator daemon and application | transitional | legacy-product-lines | independent | @ethereumjs/wallet<br>@grpc/grpc-js<br>@hono/node-server<br>@huggingface/transformers<br>@jinn-network/attestation-issuer<br>@jinn-network/core<br>@jinn-network/environment-record<br>@jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-local-runtime<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-evidence-builder<br>@jinn-network/execution-recorder<br>@jinn-network/lifecycle-notifications<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-pipeline<br>@jinn-network/marketplace-projector<br>@jinn-network/marketplace-venue-base<br>@jinn-network/plugin<br>@jinn-network/policy-identity<br>@jinn-network/read-plane<br>@jinn-network/record-discovery-client<br>@jinn-network/record-discovery-facts-task-execution<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/record-discovery-transport-http<br>@jinn-network/sdk<br>@jinn-network/task-admission<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-evaluator-adapters<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace<br>@jinn-network/trust-authoring<br>@jinn-network/trust-core<br>@jinn-network/trust-observation<br>@jinn-network/trust-resolve<br>@lmoe/gliner-onnx<br>@modelcontextprotocol/sdk<br>@msgpack/msgpack<br>@noble/curves<br>@noble/ed25519<br>@noble/hashes<br>@opentelemetry/api<br>@opentelemetry/core<br>@opentelemetry/exporter-trace-otlp-grpc<br>@opentelemetry/exporter-trace-otlp-http<br>@opentelemetry/resources<br>@opentelemetry/sdk-node<br>@opentelemetry/sdk-trace-base<br>@safe-global/protocol-kit<br>@safe-global/safe-deployments<br>@safe-global/types-kit<br>@scure/bip32<br>@scure/bip39<br>@secretlint/core<br>@secretlint/secretlint-rule-preset-recommend<br>@slicekit/erc8128<br>@types/better-sqlite3<br>@x402/core<br>@x402/evm<br>@x402/fetch<br>@x402/hono<br>ajv<br>ajv-formats<br>better-sqlite3<br>bs58<br>canonicalize<br>chokidar<br>dotenv<br>hono<br>node-pty<br>protobufjs<br>safe-regex<br>semver<br>tokenlens<br>viem<br>ws<br>yaml<br>zod<br>zod-to-json-schema | @coinbase/cdp-sdk | — |
| @jinn-network/autopilot | packages/autopilot | autopilot | 4 | transitional | vendored tier-4 product residue | transitional | transitional-or-private | private | @jinn-network/sdk<br>zod | — | — |
| @colophon-claims/cli | packages/benchmark-product/cli | benchmark-product | 4 | product | Colophon self-serve command and packaged local application | experimental | transitional-or-private | never | @colophon-claims/core<br>@colophon-claims/verify<br>next<br>react<br>react-dom | — | — |
| @colophon-claims/core | packages/benchmark-product/core | benchmark-product | 4 | product | benchmark product core | experimental | transitional-or-private | never | @colophon-claims/verify<br>@fontsource-variable/newsreader<br>@fontsource-variable/public-sans<br>@fontsource/ibm-plex-mono<br>@jinn-network/attestation-issuer<br>@jinn-network/benchmarking-aggregate<br>@jinn-network/benchmarking-evaluation<br>@jinn-network/benchmarking-evidence<br>@jinn-network/benchmarking-interop<br>@jinn-network/benchmarking-local<br>@jinn-network/benchmarking-native-capture<br>@jinn-network/benchmarking-protocol<br>@jinn-network/benchmarking-publication<br>@jinn-network/benchmarking-records<br>@jinn-network/benchmarking-run<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/record-discovery-transport-http<br>@jinn-network/record-publication<br>@jinn-network/task-admission<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-evaluator-adapters<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-oci-grader<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace<br>@jinn-network/trust-core<br>zod | — | — |
| @colophon-claims/verify | packages/benchmark-product/verify | benchmark-product | 4 | product | standalone Colophon public-bundle reader verifier | experimental | transitional-or-private | never | @fontsource-variable/newsreader<br>@fontsource-variable/public-sans<br>@fontsource/ibm-plex-mono<br>@jinn-network/benchmarking-aggregate<br>@jinn-network/benchmarking-evidence<br>@jinn-network/benchmarking-interop<br>@jinn-network/benchmarking-local<br>@jinn-network/benchmarking-protocol<br>@jinn-network/benchmarking-records<br>@jinn-network/benchmarking-run<br>@jinn-network/task-admission<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>zod | — | — |
| @colophon-claims/web | packages/benchmark-product/web | benchmark-product | 4 | product | benchmark product web application | experimental | transitional-or-private | never | @colophon-claims/core<br>@fontsource-variable/newsreader<br>@fontsource-variable/public-sans<br>@fontsource/ibm-plex-mono<br>class-variance-authority<br>clsx<br>lucide-react<br>next<br>radix-ui<br>react<br>react-dom<br>server-only<br>tailwind-merge | — | — |
| @jinn-network/benchmarking-aggregate | packages/benchmarking/aggregate | benchmarking | 3 | platform | aggregation capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/trust-core | — | — |
| @jinn-network/benchmarking-evaluation | packages/benchmarking/evaluation | benchmarking | 3 | platform | TEP-free exact subject evaluation issuance | candidate | implementations-v1 | canary-and-stable | @jinn-network/attestation-issuer<br>@jinn-network/benchmarking-protocol<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/trust-core | — | vitest |
| @jinn-network/benchmarking-evidence | packages/benchmarking/evidence | benchmarking | 3 | platform | evidence-native cohort verification and matrix assembly | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-aggregate<br>@jinn-network/benchmarking-protocol<br>@jinn-network/evidence-protocol<br>@jinn-network/trust-core | — | vitest |
| @jinn-network/benchmarking-interop | packages/benchmarking/interop | benchmarking | 3 | platform | task-execution import and export | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/benchmarking-local | packages/benchmarking/local | benchmarking | 3 | platform | local venue adapter | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/benchmarking-run | — | — |
| @jinn-network/benchmarking-marketplace | packages/benchmarking/marketplace | benchmarking | 3 | platform | marketplace adapter | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/benchmarking-run<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/benchmarking-native-capture | packages/benchmarking/native-capture | benchmarking | 3 | platform | resumable native execution capture coordinator | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-protocol<br>@jinn-network/evidence-protocol<br>@jinn-network/execution-evidence-builder | — | vitest |
| @jinn-network/benchmarking-protocol | packages/benchmarking/protocol | benchmarking | 2 | platform | evidence-native benchmarking record protocol | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/evidence-protocol<br>@noble/hashes<br>zod | — | vitest |
| @jinn-network/benchmarking-publication | packages/benchmarking/publication | benchmarking | 3 | platform | benchmark publication planning and accounting verification | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/record-publication<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/benchmarking-records | packages/benchmarking/records | benchmarking | 2 | platform | benchmark record family | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>@noble/hashes<br>zod | — | — |
| @jinn-network/benchmarking-run | packages/benchmarking/run | benchmarking | 3 | platform | benchmark orchestration | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/benchmarking-testing | packages/benchmarking/testing | benchmarking | — | platform-support | benchmarking conformance kit | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | vitest |
| @jinn-network/core | packages/core | legacy-plugin-stack | — | legacy | legacy product-support kernel | transitional | legacy-product-lines | independent | @huggingface/transformers<br>@jinn-network/plugin<br>@lmoe/gliner-onnx<br>@noble/hashes<br>@secretlint/core<br>@secretlint/secretlint-rule-preset-recommend<br>better-sqlite3<br>canonicalize<br>zod | — | vitest |
| @jinn-network/record-discovery-client | packages/discovery/client | discovery | 3 | platform | discovery client and resolution | candidate | implementations-v1 | canary-and-stable | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core<br>zod | — | — |
| @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking | discovery | 3 | platform | benchmarking facts projection | candidate | implementations-v1 | canary-and-stable | @jinn-network/benchmarking-records<br>@jinn-network/record-discovery-protocol<br>@jinn-network/trust-core | — | — |
| @jinn-network/record-discovery-facts-chain-environments | packages/discovery/facts/chain-environments | environments | 3 | platform | chain-environment facts projection | experimental | implementations-v1 | canary-and-stable | @jinn-network/chain-environment-record<br>@jinn-network/information-world<br>@jinn-network/record-discovery-protocol | — | — |
| @jinn-network/record-discovery-facts-environments | packages/discovery/facts/environments | environments | 3 | platform | experimental environment facts projection | experimental | implementations-v1 | canary-and-stable | @jinn-network/environment-record<br>@jinn-network/record-discovery-protocol | — | — |
| @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence | discovery | 3 | platform | evidence facts projection | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-protocol<br>zod | — | — |
| @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution | discovery | 3 | platform | task-execution facts projection | candidate | implementations-v1 | canary-and-stable | @jinn-network/record-discovery-protocol<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>zod | — | — |
| @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust | discovery | 3 | platform | trust facts projection | candidate | implementations-v1 | canary-and-stable | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core<br>zod | — | — |
| @jinn-network/record-discovery-protocol | packages/discovery/protocol | discovery | 1 | platform | record-discovery protocol | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/trust-core<br>@noble/hashes<br>zod | — | — |
| @jinn-network/record-publication | packages/discovery/publication | discovery | 3 | platform | kind-neutral recoverable record publication coordinator | candidate | implementations-v1 | canary-and-stable | @jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve | — | — |
| @jinn-network/record-discovery-serve | packages/discovery/serve | discovery | 3 | platform | discovery serving contract | candidate | implementations-v1 | canary-and-stable | @jinn-network/record-discovery-protocol<br>zod | — | — |
| @jinn-network/record-discovery-source-evidence-journal | packages/discovery/sources/evidence-journal | discovery | 3 | platform | evidence-journal source adapter | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>zod | — | — |
| @jinn-network/record-discovery-testing | packages/discovery/testing | discovery | — | platform-support | record-discovery conformance kit | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/record-discovery-protocol<br>zod | — | vitest |
| @jinn-network/record-discovery-transport-http | packages/discovery/transport-http | discovery | 3 | platform | HTTP discovery transport | candidate | implementations-v1 | canary-and-stable | @jinn-network/record-discovery-client<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve | — | — |
| @jinn-network/chain-state-extraction | packages/environments/chain-extraction | environments | 3 | platform | archive-fork chain-state extraction capability | experimental | implementations-v1 | canary-and-stable | @jinn-network/chain-environment-record<br>@jinn-network/chain-environment-verification<br>@jinn-network/trust-core<br>@noble/hashes<br>zod | — | vitest |
| @jinn-network/chain-environment-record | packages/environments/chain-record | environments | 2 | platform | sealed chain and composite crypto environment record family | experimental | sealed-platform-v1 | canary-and-stable | @noble/hashes<br>zod | — | vitest |
| @jinn-network/chain-environment-verification | packages/environments/chain-verification | environments | 3 | platform | chain environment materialization and verification capability | experimental | implementations-v1 | canary-and-stable | @jinn-network/chain-environment-record<br>@jinn-network/trust-core<br>@noble/hashes<br>zod | — | vitest |
| @jinn-network/information-world | packages/environments/information-world | environments | 3 | platform | sealed information-world record family and loopback replay capability | experimental | implementations-v1 | canary-and-stable | @noble/hashes<br>zod | — | vitest |
| @jinn-network/environment-record | packages/environments/record | environments | 2 | platform | environment record family | experimental | sealed-platform-v1 | canary-and-stable | @noble/hashes<br>zod | — | vitest |
| @jinn-network/environment-verification | packages/environments/verification | environments | 3 | platform | environment verification capability | experimental | implementations-v1 | canary-and-stable | @jinn-network/environment-record<br>@jinn-network/trust-core<br>zod | — | vitest |
| @jinn-network/attestation-issuer | packages/evidence/attestation-issuer | evidence | 3 | platform | attestation issuance capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository | — | vitest |
| @jinn-network/evidence-catalog-sqlite | packages/evidence/catalog-sqlite | evidence | 3 | platform | SQLite evidence catalog binding | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>better-sqlite3 | — | — |
| @jinn-network/evidence-contribution | packages/evidence/contribution | evidence | 3 | platform | evidence contribution composition | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-derivation<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-publication<br>@jinn-network/evidence-repository<br>canonicalize | — | vitest |
| @jinn-network/evidence-derivation | packages/evidence/derivation | evidence | 3 | platform | evidence derivation capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-protocol<br>@noble/hashes<br>@secretlint/core<br>@secretlint/secretlint-rule-preset-recommend<br>canonicalize<br>zod | — | vitest |
| @jinn-network/evidence-discovery | packages/evidence/discovery | evidence | 3 | platform | evidence discovery contract | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository | — | vitest |
| @jinn-network/execution-evidence-builder | packages/evidence/execution-evidence-builder | evidence | 3 | platform | pure execution-evidence construction capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-protocol | — | vitest |
| @jinn-network/execution-recorder | packages/evidence/execution-recorder | evidence | 3 | platform | execution recording capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-evidence-builder | — | vitest |
| @jinn-network/execution-recorder-bridge | packages/evidence/execution-recorder-bridge | evidence | 3 | platform | execution-recorder integration bridge | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-repository<br>@jinn-network/execution-recorder | — | — |
| @jinn-network/evidence-local-runtime | packages/evidence/local-runtime | evidence | 3 | platform | local evidence composition | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>better-sqlite3 | — | — |
| @jinn-network/evidence-protocol | packages/evidence/protocol | evidence | 1 | platform | execution-evidence protocol | candidate | sealed-platform-v1 | canary-and-stable | @noble/hashes<br>zod | — | — |
| @jinn-network/evidence-publication | packages/evidence/publication | evidence | 3 | platform | evidence publication capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-repository<br>@jinn-network/record-publication | — | vitest |
| @jinn-network/evidence-repository | packages/evidence/repository | evidence | 3 | platform | evidence repository contract | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-protocol | — | vitest |
| @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs | evidence | 3 | platform | IPFS evidence repository binding | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-repository<br>kubo-rpc-client | — | — |
| @jinn-network/evidence-repository-oci | packages/evidence/repository-oci | evidence | 3 | platform | OCI evidence repository binding | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-repository<br>canonicalize | — | — |
| @jinn-network/evidence-retrieval | packages/evidence/retrieval | evidence | 3 | platform | evidence retrieval capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository | — | vitest |
| @jinn-network/evidence-trace | packages/evidence/trace | evidence | 2 | platform | trace record family | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/evidence-protocol<br>@jinn-network/trust-core<br>@noble/hashes<br>ajv<br>zod | — | vitest |
| @jinn-network/evidence-trace-decode | packages/evidence/trace-decode | evidence | 3 | platform | evidence trace decoder | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-trace | — | vitest |
| @jinn-network/indexer | packages/indexer | read-plane | — | transitional | transitional projector and product mixture | transitional | transitional-or-private | never | @hono/node-server<br>@jinn-network/benchmarking-records<br>drizzle-orm<br>hono<br>ponder<br>viem | — | — |
| @jinn-network/indexer-enrichment | packages/indexer-enrichment | read-plane | — | transitional | transitional indexer enrichment worker | transitional | transitional-or-private | never | @jinn-network/indexer<br>drizzle-orm<br>pg | — | — |
| @jinn-network/explorer-spa | packages/indexer/explorer | read-plane | 4 | product | network explorer product | candidate | transitional-or-private | private | @tanstack/react-query<br>clsx<br>react<br>react-dom<br>uplot<br>wouter | — | — |
| @jinn-network/jinn-layer | packages/layer | legacy-plugin-stack | — | legacy | legacy product composition and local runtime | transitional | legacy-product-lines | independent | @jinn-network/core<br>@jinn-network/plugin<br>@modelcontextprotocol/sdk<br>better-sqlite3<br>canonicalize<br>viem<br>yaml<br>zod | — | — |
| @jinn-network/lifecycle-notifications | packages/lifecycle-notifications | lifecycle | 3 | platform | pure notification derivation from receipts and live-health | experimental | experimental-lifecycle-notifications | disabled | — | — | — |
| @jinn-network/marketplace-binding | packages/marketplace/binding | marketplace | 3 | platform | venue-neutral marketplace binding | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve<br>@noble/hashes<br>viem<br>zod | — | — |
| @jinn-network/marketplace-pipeline | packages/marketplace/pipeline | marketplace | — | transitional | legacy marketplace operator composition | transitional | legacy-product-lines | independent | @jinn-network/marketplace-binding<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/marketplace-projector | packages/marketplace/projector | marketplace | 3 | platform | marketplace discovery projection | candidate | implementations-v1 | canary-and-stable | @jinn-network/marketplace-binding<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-protocol<br>@noble/hashes<br>viem | — | — |
| @jinn-network/marketplace-testing | packages/marketplace/testing | marketplace | — | platform-support | marketplace conformance kit | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-protocol<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/marketplace-venue-base<br>@jinn-network/record-discovery-testing<br>@jinn-network/task-execution-testing<br>@jinn-network/trust-testing<br>viem | — | vitest |
| @jinn-network/marketplace-venue-base | packages/marketplace/venue-base | marketplace | 3 | platform | Base venue adapter | candidate | implementations-v1 | canary-and-stable | @jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-protocol<br>@types/better-sqlite3<br>better-sqlite3<br>viem | — | — |
| @jinn-network/plugin | packages/plugin | legacy-plugin-stack | — | legacy | legacy extension contract | transitional | legacy-product-lines | independent | zod | — | vitest |
| @jinn-network/policy-optimization | packages/policy-optimization | policy | 4 | product | policy optimization product | experimental | transitional-or-private | never | @jinn-network/attestation-issuer<br>@jinn-network/benchmarking-aggregate<br>@jinn-network/benchmarking-local<br>@jinn-network/benchmarking-records<br>@jinn-network/benchmarking-run<br>@jinn-network/evidence-protocol<br>@jinn-network/policy-identity<br>@jinn-network/policy-outcomes<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-evaluator-adapters<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace<br>@jinn-network/trust-core<br>zod | — | — |
| @jinn-network/policy-identity | packages/policy/identity | policy | 3 | platform | execution-policy identity and candidate manifest sealing | experimental | experimental-policy | disabled | @noble/curves<br>@noble/hashes | — | — |
| @jinn-network/policy-outcomes | packages/policy/outcomes | policy | 3 | platform | policy-keyed outcomes projection | experimental | experimental-policy | disabled | @jinn-network/policy-identity<br>@noble/hashes<br>zod | — | — |
| @jinn-network/read-plane | packages/read-plane | read-plane | 3 | platform | health/ready, freshness, SSE resume, constructor token gate, payload classes, OpenAPI generation | experimental | experimental-read-plane | disabled | zod | — | — |
| @jinn-network/sdk | packages/sdk | legacy-sdk | — | legacy | deprecated SolverNet SDK | deprecated | legacy-product-lines | independent | zod<br>zod-to-json-schema | — | — |
| @jinn-network/task-execution-backend | packages/task-execution/backend | task-execution | 3 | platform | backend contract | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-protocol | — | — |
| @jinn-network/task-execution-backend-local | packages/task-execution/backend-local/assembly | task-execution | 3 | platform | local backend assembly | candidate | implementations-v1 | canary-and-stable | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | — |
| @jinn-network/task-execution-launchers | packages/task-execution/backend-local/launchers | task-execution | 3 | platform | launch planning capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | — |
| @jinn-network/task-execution-supervisor | packages/task-execution/backend-local/supervisor | task-execution | 3 | platform | execution supervision capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/task-execution-workspace | packages/task-execution/backend-local/workspace | task-execution | 3 | platform | workspace preparation capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/task-execution-evaluation-harness | packages/task-execution/evaluation-harness | task-execution | 3 | platform | evaluation orchestration capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/attestation-issuer<br>@jinn-network/evidence-protocol<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | — |
| @jinn-network/task-execution-evaluator-adapters | packages/task-execution/evaluator-adapters | task-execution | 3 | platform | evaluator adapters | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor | — | — |
| @jinn-network/task-execution-oci-grader | packages/task-execution/oci-grader | task-execution | 3 | platform | host-owned OCI grader execution | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-evaluator-adapters<br>@jinn-network/task-execution-profiles | — | — |
| @jinn-network/task-execution-profiles | packages/task-execution/profiles | task-execution | 1 | platform | task profile family | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/task-execution-protocol<br>@noble/hashes<br>ajv<br>safe-regex<br>zod | — | — |
| @jinn-network/task-execution-protocol | packages/task-execution/protocol | task-execution | 1 | platform | task-execution protocol | candidate | sealed-platform-v1 | canary-and-stable | @noble/hashes<br>zod | — | — |
| @jinn-network/task-execution-testing | packages/task-execution/testing | task-execution | — | platform-support | task-execution conformance kit | candidate | implementations-v1 | canary-and-stable | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | vitest |
| @jinn-network/task-admission | packages/task-supply/admission | task-supply | 3 | platform | task admission capability | candidate | implementations-v1 | canary-and-stable | @jinn-network/environment-record<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>zod | — | vitest |
| @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios | task-supply | 3 | platform | verified chain-environment scenario derivation capability | experimental | implementations-v1 | canary-and-stable | @jinn-network/chain-environment-record<br>@jinn-network/task-admission<br>@jinn-network/task-derivation<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@noble/hashes<br>zod | — | vitest |
| @jinn-network/task-curation | packages/task-supply/curation | task-supply | 3 | platform | task curation projection | experimental | implementations-v1 | canary-and-stable | zod | — | — |
| @jinn-network/task-derivation | packages/task-supply/derivation | task-supply | 3 | platform | task derivation capability | experimental | implementations-v1 | canary-and-stable | @jinn-network/environment-record<br>@jinn-network/task-admission<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@noble/hashes<br>zod | — | vitest |
| @jinn-network/task-posting | packages/task-supply/posting | task-supply | 3 | platform | task posting capability | experimental | implementations-v1 | canary-and-stable | @jinn-network/marketplace-binding<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/trust-authoring | packages/trust/authoring | trust | 2 | platform | trust artifact authoring | candidate | sealed-platform-v1 | canary-and-stable | @jinn-network/trust-core<br>bs58 | — | — |
| @jinn-network/trust-core | packages/trust/core | trust | 1 | platform | trust records and policy | candidate | sealed-platform-v1 | canary-and-stable | @noble/curves<br>@noble/hashes<br>zod | — | — |
| @jinn-network/trust-observation | packages/trust/observation | trust | 3 | platform | Class O/A receipt container profile and writeObservation() | candidate | implementations-v1 | canary-and-stable | zod | — | — |
| @jinn-network/trust-resolve | packages/trust/resolve | trust | 3 | platform | trust resolution binding | candidate | implementations-v1 | canary-and-stable | @jinn-network/trust-core<br>viem | — | — |
| @jinn-network/trust-testing | packages/trust/testing | trust | — | platform-support | trust conformance kit | candidate | implementations-v1 | canary-and-stable | @jinn-network/trust-core<br>@jinn-network/trust-resolve<br>@noble/curves<br>@noble/hashes | — | vitest |
| @jinn-network/plugin-runtime | plugin/runtime | plugin-product | — | product-support | unpublished plugin product support runtime | candidate | transitional-or-private | never | @jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-derivation<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-local-runtime<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/evidence-retrieval<br>@jinn-network/evidence-trace<br>@jinn-network/evidence-trace-decode<br>@jinn-network/execution-recorder<br>@jinn-network/record-discovery-client<br>@jinn-network/record-discovery-protocol<br>@jinn-network/trust-core<br>@modelcontextprotocol/sdk<br>better-sqlite3<br>zod | — | — |
| @jinn-network/chain-only-gate-harness | scripts/chain-only-gate | repository-operations | — | repository-tooling | live chain-environment end-to-end gate harness | experimental | transitional-or-private | never | — | — | — |

## Runtime dependency topology

Only `dependencies`, `optionalDependencies`, and `peerDependencies` contribute edges. `devDependencies` never affect closure or publication order.

| From | Kind | To |
| --- | --- | --- |
| @colophon-claims/cli | runtime | @colophon-claims/core |
| @colophon-claims/cli | runtime | @colophon-claims/verify |
| @colophon-claims/core | runtime | @colophon-claims/verify |
| @colophon-claims/core | runtime | @jinn-network/attestation-issuer |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-aggregate |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-evaluation |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-evidence |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-interop |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-local |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-native-capture |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-protocol |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-publication |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-records |
| @colophon-claims/core | runtime | @jinn-network/benchmarking-run |
| @colophon-claims/core | runtime | @jinn-network/record-discovery-protocol |
| @colophon-claims/core | runtime | @jinn-network/record-discovery-serve |
| @colophon-claims/core | runtime | @jinn-network/record-discovery-transport-http |
| @colophon-claims/core | runtime | @jinn-network/record-publication |
| @colophon-claims/core | runtime | @jinn-network/task-admission |
| @colophon-claims/core | runtime | @jinn-network/task-execution-backend |
| @colophon-claims/core | runtime | @jinn-network/task-execution-backend-local |
| @colophon-claims/core | runtime | @jinn-network/task-execution-evaluation-harness |
| @colophon-claims/core | runtime | @jinn-network/task-execution-evaluator-adapters |
| @colophon-claims/core | runtime | @jinn-network/task-execution-launchers |
| @colophon-claims/core | runtime | @jinn-network/task-execution-oci-grader |
| @colophon-claims/core | runtime | @jinn-network/task-execution-profiles |
| @colophon-claims/core | runtime | @jinn-network/task-execution-protocol |
| @colophon-claims/core | runtime | @jinn-network/task-execution-supervisor |
| @colophon-claims/core | runtime | @jinn-network/task-execution-workspace |
| @colophon-claims/core | runtime | @jinn-network/trust-core |
| @colophon-claims/verify | runtime | @jinn-network/benchmarking-aggregate |
| @colophon-claims/verify | runtime | @jinn-network/benchmarking-evidence |
| @colophon-claims/verify | runtime | @jinn-network/benchmarking-interop |
| @colophon-claims/verify | runtime | @jinn-network/benchmarking-local |
| @colophon-claims/verify | runtime | @jinn-network/benchmarking-protocol |
| @colophon-claims/verify | runtime | @jinn-network/benchmarking-records |
| @colophon-claims/verify | runtime | @jinn-network/benchmarking-run |
| @colophon-claims/verify | runtime | @jinn-network/task-admission |
| @colophon-claims/verify | runtime | @jinn-network/task-execution-profiles |
| @colophon-claims/verify | runtime | @jinn-network/task-execution-protocol |
| @colophon-claims/verify | runtime | @jinn-network/trust-core |
| @colophon-claims/web | runtime | @colophon-claims/core |
| @jinn-network/attestation-issuer | runtime | @jinn-network/evidence-protocol |
| @jinn-network/attestation-issuer | runtime | @jinn-network/evidence-repository |
| @jinn-network/autopilot | runtime | @jinn-network/sdk |
| @jinn-network/benchmarking-aggregate | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-aggregate | runtime | @jinn-network/trust-core |
| @jinn-network/benchmarking-evaluation | runtime | @jinn-network/attestation-issuer |
| @jinn-network/benchmarking-evaluation | runtime | @jinn-network/benchmarking-protocol |
| @jinn-network/benchmarking-evaluation | runtime | @jinn-network/evidence-protocol |
| @jinn-network/benchmarking-evaluation | runtime | @jinn-network/evidence-repository |
| @jinn-network/benchmarking-evaluation | runtime | @jinn-network/trust-core |
| @jinn-network/benchmarking-evidence | runtime | @jinn-network/benchmarking-aggregate |
| @jinn-network/benchmarking-evidence | runtime | @jinn-network/benchmarking-protocol |
| @jinn-network/benchmarking-evidence | runtime | @jinn-network/evidence-protocol |
| @jinn-network/benchmarking-evidence | runtime | @jinn-network/trust-core |
| @jinn-network/benchmarking-interop | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-interop | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/benchmarking-interop | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-local | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-local | runtime | @jinn-network/benchmarking-run |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/benchmarking-run |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/marketplace-binding |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/marketplace-projector |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-native-capture | runtime | @jinn-network/benchmarking-protocol |
| @jinn-network/benchmarking-native-capture | runtime | @jinn-network/evidence-protocol |
| @jinn-network/benchmarking-native-capture | runtime | @jinn-network/execution-evidence-builder |
| @jinn-network/benchmarking-protocol | runtime | @jinn-network/evidence-protocol |
| @jinn-network/benchmarking-publication | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-publication | runtime | @jinn-network/record-publication |
| @jinn-network/benchmarking-publication | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-records | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-records | runtime | @jinn-network/trust-core |
| @jinn-network/benchmarking-run | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-run | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/benchmarking-run | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-testing | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-testing | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/benchmarking-testing | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/chain-environment-verification | runtime | @jinn-network/chain-environment-record |
| @jinn-network/chain-environment-verification | runtime | @jinn-network/trust-core |
| @jinn-network/chain-scenarios | runtime | @jinn-network/chain-environment-record |
| @jinn-network/chain-scenarios | runtime | @jinn-network/task-admission |
| @jinn-network/chain-scenarios | runtime | @jinn-network/task-derivation |
| @jinn-network/chain-scenarios | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/chain-scenarios | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/chain-state-extraction | runtime | @jinn-network/chain-environment-record |
| @jinn-network/chain-state-extraction | runtime | @jinn-network/chain-environment-verification |
| @jinn-network/chain-state-extraction | runtime | @jinn-network/trust-core |
| @jinn-network/core | runtime | @jinn-network/plugin |
| @jinn-network/environment-verification | runtime | @jinn-network/environment-record |
| @jinn-network/environment-verification | runtime | @jinn-network/trust-core |
| @jinn-network/evidence-catalog-sqlite | runtime | @jinn-network/evidence-discovery |
| @jinn-network/evidence-catalog-sqlite | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-contribution | runtime | @jinn-network/evidence-derivation |
| @jinn-network/evidence-contribution | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-contribution | runtime | @jinn-network/evidence-publication |
| @jinn-network/evidence-contribution | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-derivation | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-discovery | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-discovery | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-local-runtime | runtime | @jinn-network/evidence-catalog-sqlite |
| @jinn-network/evidence-local-runtime | runtime | @jinn-network/evidence-discovery |
| @jinn-network/evidence-local-runtime | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-local-runtime | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-local-runtime | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/evidence-local-runtime | runtime | @jinn-network/record-discovery-serve |
| @jinn-network/evidence-publication | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-publication | runtime | @jinn-network/record-publication |
| @jinn-network/evidence-repository | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-repository-ipfs | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-repository-oci | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-retrieval | runtime | @jinn-network/evidence-discovery |
| @jinn-network/evidence-retrieval | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-retrieval | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-trace | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-trace | runtime | @jinn-network/trust-core |
| @jinn-network/evidence-trace-decode | runtime | @jinn-network/evidence-trace |
| @jinn-network/execution-evidence-builder | runtime | @jinn-network/evidence-protocol |
| @jinn-network/execution-recorder | runtime | @jinn-network/evidence-protocol |
| @jinn-network/execution-recorder | runtime | @jinn-network/evidence-repository |
| @jinn-network/execution-recorder | runtime | @jinn-network/execution-evidence-builder |
| @jinn-network/execution-recorder-bridge | runtime | @jinn-network/evidence-repository |
| @jinn-network/execution-recorder-bridge | runtime | @jinn-network/execution-recorder |
| @jinn-network/indexer | runtime | @jinn-network/benchmarking-records |
| @jinn-network/indexer-enrichment | runtime | @jinn-network/indexer |
| @jinn-network/jinn-layer | runtime | @jinn-network/core |
| @jinn-network/jinn-layer | runtime | @jinn-network/plugin |
| @jinn-network/marketplace-binding | runtime | @jinn-network/task-execution-backend |
| @jinn-network/marketplace-binding | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/marketplace-binding | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/marketplace-binding | runtime | @jinn-network/trust-core |
| @jinn-network/marketplace-binding | runtime | @jinn-network/trust-resolve |
| @jinn-network/marketplace-pipeline | runtime | @jinn-network/marketplace-binding |
| @jinn-network/marketplace-pipeline | runtime | @jinn-network/task-execution-backend |
| @jinn-network/marketplace-pipeline | runtime | @jinn-network/task-execution-backend-local |
| @jinn-network/marketplace-pipeline | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/marketplace-projector | runtime | @jinn-network/marketplace-binding |
| @jinn-network/marketplace-projector | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/marketplace-projector | runtime | @jinn-network/record-discovery-serve |
| @jinn-network/marketplace-projector | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/marketplace-testing | runtime | @jinn-network/evidence-protocol |
| @jinn-network/marketplace-testing | runtime | @jinn-network/marketplace-binding |
| @jinn-network/marketplace-testing | runtime | @jinn-network/marketplace-projector |
| @jinn-network/marketplace-testing | runtime | @jinn-network/marketplace-venue-base |
| @jinn-network/marketplace-testing | runtime | @jinn-network/record-discovery-testing |
| @jinn-network/marketplace-testing | runtime | @jinn-network/task-execution-testing |
| @jinn-network/marketplace-testing | runtime | @jinn-network/trust-testing |
| @jinn-network/marketplace-venue-base | runtime | @jinn-network/marketplace-binding |
| @jinn-network/marketplace-venue-base | runtime | @jinn-network/marketplace-projector |
| @jinn-network/marketplace-venue-base | runtime | @jinn-network/task-execution-backend |
| @jinn-network/marketplace-venue-base | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/operator | runtime | @jinn-network/attestation-issuer |
| @jinn-network/operator | runtime | @jinn-network/core |
| @jinn-network/operator | runtime | @jinn-network/environment-record |
| @jinn-network/operator | runtime | @jinn-network/evidence-catalog-sqlite |
| @jinn-network/operator | runtime | @jinn-network/evidence-discovery |
| @jinn-network/operator | runtime | @jinn-network/evidence-local-runtime |
| @jinn-network/operator | runtime | @jinn-network/evidence-protocol |
| @jinn-network/operator | runtime | @jinn-network/evidence-repository |
| @jinn-network/operator | runtime | @jinn-network/execution-evidence-builder |
| @jinn-network/operator | runtime | @jinn-network/execution-recorder |
| @jinn-network/operator | runtime | @jinn-network/lifecycle-notifications |
| @jinn-network/operator | runtime | @jinn-network/marketplace-binding |
| @jinn-network/operator | runtime | @jinn-network/marketplace-pipeline |
| @jinn-network/operator | runtime | @jinn-network/marketplace-projector |
| @jinn-network/operator | runtime | @jinn-network/marketplace-venue-base |
| @jinn-network/operator | runtime | @jinn-network/plugin |
| @jinn-network/operator | runtime | @jinn-network/policy-identity |
| @jinn-network/operator | runtime | @jinn-network/read-plane |
| @jinn-network/operator | runtime | @jinn-network/record-discovery-client |
| @jinn-network/operator | runtime | @jinn-network/record-discovery-facts-task-execution |
| @jinn-network/operator | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/operator | runtime | @jinn-network/record-discovery-serve |
| @jinn-network/operator | runtime | @jinn-network/record-discovery-transport-http |
| @jinn-network/operator | runtime | @jinn-network/sdk |
| @jinn-network/operator | runtime | @jinn-network/task-admission |
| @jinn-network/operator | runtime | @jinn-network/task-execution-backend |
| @jinn-network/operator | runtime | @jinn-network/task-execution-backend-local |
| @jinn-network/operator | runtime | @jinn-network/task-execution-evaluation-harness |
| @jinn-network/operator | runtime | @jinn-network/task-execution-evaluator-adapters |
| @jinn-network/operator | runtime | @jinn-network/task-execution-launchers |
| @jinn-network/operator | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/operator | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/operator | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/operator | runtime | @jinn-network/task-execution-workspace |
| @jinn-network/operator | runtime | @jinn-network/trust-authoring |
| @jinn-network/operator | runtime | @jinn-network/trust-core |
| @jinn-network/operator | runtime | @jinn-network/trust-observation |
| @jinn-network/operator | runtime | @jinn-network/trust-resolve |
| @jinn-network/operator-console | runtime | @jinn-network/lifecycle-notifications |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-catalog-sqlite |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-derivation |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-discovery |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-local-runtime |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-protocol |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-repository |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-retrieval |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-trace |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-trace-decode |
| @jinn-network/plugin-runtime | runtime | @jinn-network/execution-recorder |
| @jinn-network/plugin-runtime | runtime | @jinn-network/record-discovery-client |
| @jinn-network/plugin-runtime | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/plugin-runtime | runtime | @jinn-network/trust-core |
| @jinn-network/policy-optimization | runtime | @jinn-network/attestation-issuer |
| @jinn-network/policy-optimization | runtime | @jinn-network/benchmarking-aggregate |
| @jinn-network/policy-optimization | runtime | @jinn-network/benchmarking-local |
| @jinn-network/policy-optimization | runtime | @jinn-network/benchmarking-records |
| @jinn-network/policy-optimization | runtime | @jinn-network/benchmarking-run |
| @jinn-network/policy-optimization | runtime | @jinn-network/evidence-protocol |
| @jinn-network/policy-optimization | runtime | @jinn-network/policy-identity |
| @jinn-network/policy-optimization | runtime | @jinn-network/policy-outcomes |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-backend |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-backend-local |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-evaluation-harness |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-evaluator-adapters |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-launchers |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/policy-optimization | runtime | @jinn-network/task-execution-workspace |
| @jinn-network/policy-optimization | runtime | @jinn-network/trust-core |
| @jinn-network/policy-outcomes | runtime | @jinn-network/policy-identity |
| @jinn-network/record-discovery-client | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-client | runtime | @jinn-network/trust-core |
| @jinn-network/record-discovery-facts-benchmarking | runtime | @jinn-network/benchmarking-records |
| @jinn-network/record-discovery-facts-benchmarking | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-facts-benchmarking | runtime | @jinn-network/trust-core |
| @jinn-network/record-discovery-facts-chain-environments | runtime | @jinn-network/chain-environment-record |
| @jinn-network/record-discovery-facts-chain-environments | runtime | @jinn-network/information-world |
| @jinn-network/record-discovery-facts-chain-environments | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-facts-environments | runtime | @jinn-network/environment-record |
| @jinn-network/record-discovery-facts-environments | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-facts-evidence | runtime | @jinn-network/evidence-discovery |
| @jinn-network/record-discovery-facts-evidence | runtime | @jinn-network/evidence-repository |
| @jinn-network/record-discovery-facts-evidence | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-facts-task-execution | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-facts-task-execution | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/record-discovery-facts-task-execution | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/record-discovery-facts-trust | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-facts-trust | runtime | @jinn-network/trust-core |
| @jinn-network/record-discovery-protocol | runtime | @jinn-network/trust-core |
| @jinn-network/record-discovery-serve | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-source-evidence-journal | runtime | @jinn-network/evidence-discovery |
| @jinn-network/record-discovery-source-evidence-journal | runtime | @jinn-network/evidence-repository |
| @jinn-network/record-discovery-source-evidence-journal | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-source-evidence-journal | runtime | @jinn-network/record-discovery-serve |
| @jinn-network/record-discovery-testing | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-transport-http | runtime | @jinn-network/record-discovery-client |
| @jinn-network/record-discovery-transport-http | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-transport-http | runtime | @jinn-network/record-discovery-serve |
| @jinn-network/record-publication | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-publication | runtime | @jinn-network/record-discovery-serve |
| @jinn-network/task-admission | runtime | @jinn-network/environment-record |
| @jinn-network/task-admission | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-admission | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-admission | runtime | @jinn-network/trust-core |
| @jinn-network/task-derivation | runtime | @jinn-network/environment-record |
| @jinn-network/task-derivation | runtime | @jinn-network/task-admission |
| @jinn-network/task-derivation | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-derivation | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-backend | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/evidence-discovery |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/evidence-repository |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/execution-recorder |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/task-execution-backend |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/task-execution-launchers |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/task-execution-backend-local | runtime | @jinn-network/task-execution-workspace |
| @jinn-network/task-execution-evaluation-harness | runtime | @jinn-network/attestation-issuer |
| @jinn-network/task-execution-evaluation-harness | runtime | @jinn-network/evidence-protocol |
| @jinn-network/task-execution-evaluation-harness | runtime | @jinn-network/task-execution-launchers |
| @jinn-network/task-execution-evaluation-harness | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-execution-evaluation-harness | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/task-execution-evaluation-harness | runtime | @jinn-network/task-execution-workspace |
| @jinn-network/task-execution-evaluator-adapters | runtime | @jinn-network/task-execution-evaluation-harness |
| @jinn-network/task-execution-evaluator-adapters | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-execution-evaluator-adapters | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-evaluator-adapters | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-workspace |
| @jinn-network/task-execution-oci-grader | runtime | @jinn-network/task-execution-evaluation-harness |
| @jinn-network/task-execution-oci-grader | runtime | @jinn-network/task-execution-evaluator-adapters |
| @jinn-network/task-execution-oci-grader | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-execution-profiles | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-supervisor | runtime | @jinn-network/task-execution-backend |
| @jinn-network/task-execution-supervisor | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-testing | runtime | @jinn-network/task-execution-backend |
| @jinn-network/task-execution-testing | runtime | @jinn-network/task-execution-backend-local |
| @jinn-network/task-execution-testing | runtime | @jinn-network/task-execution-launchers |
| @jinn-network/task-execution-testing | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-testing | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/task-execution-testing | runtime | @jinn-network/task-execution-workspace |
| @jinn-network/task-execution-workspace | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-execution-workspace | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-posting | runtime | @jinn-network/marketplace-binding |
| @jinn-network/task-posting | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/trust-authoring | runtime | @jinn-network/trust-core |
| @jinn-network/trust-resolve | runtime | @jinn-network/trust-core |
| @jinn-network/trust-testing | runtime | @jinn-network/trust-core |
| @jinn-network/trust-testing | runtime | @jinn-network/trust-resolve |


### `sealed-platform-v1` runtime waves

1. `@jinn-network/chain-environment-record`, `@jinn-network/environment-record`, `@jinn-network/evidence-protocol`, `@jinn-network/task-execution-protocol`, `@jinn-network/trust-core`
2. `@jinn-network/benchmarking-protocol`, `@jinn-network/benchmarking-records`, `@jinn-network/evidence-trace`, `@jinn-network/record-discovery-protocol`, `@jinn-network/task-execution-profiles`, `@jinn-network/trust-authoring`
3. `@jinn-network/benchmarking-testing`, `@jinn-network/record-discovery-testing`

### `sealed-platform-v1` transitive closure

| Package | Runtime closure |
| --- | --- |
| @jinn-network/benchmarking-protocol | @jinn-network/evidence-protocol |
| @jinn-network/benchmarking-records | @jinn-network/task-execution-protocol<br>@jinn-network/trust-core |
| @jinn-network/benchmarking-testing | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core |
| @jinn-network/chain-environment-record | — |
| @jinn-network/environment-record | — |
| @jinn-network/evidence-protocol | — |
| @jinn-network/evidence-trace | @jinn-network/evidence-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-protocol | @jinn-network/trust-core |
| @jinn-network/record-discovery-testing | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core |
| @jinn-network/task-execution-profiles | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-protocol | — |
| @jinn-network/trust-authoring | @jinn-network/trust-core |
| @jinn-network/trust-core | — |

### `implementations-v1` runtime waves

1. `@jinn-network/benchmarking-aggregate`, `@jinn-network/benchmarking-interop`, `@jinn-network/benchmarking-run`, `@jinn-network/chain-environment-verification`, `@jinn-network/environment-verification`, `@jinn-network/evidence-derivation`, `@jinn-network/evidence-repository`, `@jinn-network/evidence-trace-decode`, `@jinn-network/execution-evidence-builder`, `@jinn-network/information-world`, `@jinn-network/record-discovery-client`, `@jinn-network/record-discovery-facts-benchmarking`, `@jinn-network/record-discovery-facts-environments`, `@jinn-network/record-discovery-facts-task-execution`, `@jinn-network/record-discovery-facts-trust`, `@jinn-network/record-discovery-serve`, `@jinn-network/task-admission`, `@jinn-network/task-curation`, `@jinn-network/task-execution-backend`, `@jinn-network/task-execution-workspace`, `@jinn-network/trust-observation`, `@jinn-network/trust-resolve`
2. `@jinn-network/attestation-issuer`, `@jinn-network/benchmarking-evidence`, `@jinn-network/benchmarking-local`, `@jinn-network/benchmarking-native-capture`, `@jinn-network/chain-state-extraction`, `@jinn-network/evidence-discovery`, `@jinn-network/evidence-repository-ipfs`, `@jinn-network/evidence-repository-oci`, `@jinn-network/execution-recorder`, `@jinn-network/marketplace-binding`, `@jinn-network/record-discovery-facts-chain-environments`, `@jinn-network/record-discovery-transport-http`, `@jinn-network/record-publication`, `@jinn-network/task-derivation`, `@jinn-network/task-execution-supervisor`, `@jinn-network/trust-testing`
3. `@jinn-network/benchmarking-evaluation`, `@jinn-network/benchmarking-publication`, `@jinn-network/chain-scenarios`, `@jinn-network/evidence-catalog-sqlite`, `@jinn-network/evidence-publication`, `@jinn-network/evidence-retrieval`, `@jinn-network/execution-recorder-bridge`, `@jinn-network/marketplace-projector`, `@jinn-network/record-discovery-facts-evidence`, `@jinn-network/record-discovery-source-evidence-journal`, `@jinn-network/task-execution-launchers`, `@jinn-network/task-posting`
4. `@jinn-network/benchmarking-marketplace`, `@jinn-network/evidence-contribution`, `@jinn-network/evidence-local-runtime`, `@jinn-network/marketplace-venue-base`, `@jinn-network/task-execution-backend-local`, `@jinn-network/task-execution-evaluation-harness`
5. `@jinn-network/task-execution-evaluator-adapters`, `@jinn-network/task-execution-testing`
6. `@jinn-network/marketplace-testing`, `@jinn-network/task-execution-oci-grader`

### `implementations-v1` transitive closure

| Package | Runtime closure |
| --- | --- |
| @jinn-network/attestation-issuer | @jinn-network/evidence-repository |
| @jinn-network/benchmarking-aggregate | — |
| @jinn-network/benchmarking-evaluation | @jinn-network/attestation-issuer<br>@jinn-network/evidence-repository |
| @jinn-network/benchmarking-evidence | @jinn-network/benchmarking-aggregate |
| @jinn-network/benchmarking-interop | — |
| @jinn-network/benchmarking-local | @jinn-network/benchmarking-run |
| @jinn-network/benchmarking-marketplace | @jinn-network/benchmarking-run<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-backend<br>@jinn-network/trust-resolve |
| @jinn-network/benchmarking-native-capture | @jinn-network/execution-evidence-builder |
| @jinn-network/benchmarking-publication | @jinn-network/record-discovery-serve<br>@jinn-network/record-publication |
| @jinn-network/benchmarking-run | — |
| @jinn-network/chain-environment-verification | — |
| @jinn-network/chain-scenarios | @jinn-network/task-admission<br>@jinn-network/task-derivation |
| @jinn-network/chain-state-extraction | @jinn-network/chain-environment-verification |
| @jinn-network/environment-verification | — |
| @jinn-network/evidence-catalog-sqlite | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-contribution | @jinn-network/evidence-derivation<br>@jinn-network/evidence-publication<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-serve<br>@jinn-network/record-publication |
| @jinn-network/evidence-derivation | — |
| @jinn-network/evidence-discovery | @jinn-network/evidence-repository |
| @jinn-network/evidence-local-runtime | @jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-serve |
| @jinn-network/evidence-publication | @jinn-network/evidence-repository<br>@jinn-network/record-discovery-serve<br>@jinn-network/record-publication |
| @jinn-network/evidence-repository | — |
| @jinn-network/evidence-repository-ipfs | @jinn-network/evidence-repository |
| @jinn-network/evidence-repository-oci | @jinn-network/evidence-repository |
| @jinn-network/evidence-retrieval | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-trace-decode | — |
| @jinn-network/execution-evidence-builder | — |
| @jinn-network/execution-recorder | @jinn-network/evidence-repository<br>@jinn-network/execution-evidence-builder |
| @jinn-network/execution-recorder-bridge | @jinn-network/evidence-repository<br>@jinn-network/execution-evidence-builder<br>@jinn-network/execution-recorder |
| @jinn-network/information-world | — |
| @jinn-network/marketplace-binding | @jinn-network/task-execution-backend<br>@jinn-network/trust-resolve |
| @jinn-network/marketplace-projector | @jinn-network/marketplace-binding<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-backend<br>@jinn-network/trust-resolve |
| @jinn-network/marketplace-testing | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/execution-evidence-builder<br>@jinn-network/execution-recorder<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/marketplace-venue-base<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-testing<br>@jinn-network/task-execution-workspace<br>@jinn-network/trust-resolve<br>@jinn-network/trust-testing |
| @jinn-network/marketplace-venue-base | @jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-backend<br>@jinn-network/trust-resolve |
| @jinn-network/record-discovery-client | — |
| @jinn-network/record-discovery-facts-benchmarking | — |
| @jinn-network/record-discovery-facts-chain-environments | @jinn-network/information-world |
| @jinn-network/record-discovery-facts-environments | — |
| @jinn-network/record-discovery-facts-evidence | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository |
| @jinn-network/record-discovery-facts-task-execution | — |
| @jinn-network/record-discovery-facts-trust | — |
| @jinn-network/record-discovery-serve | — |
| @jinn-network/record-discovery-source-evidence-journal | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-serve |
| @jinn-network/record-discovery-transport-http | @jinn-network/record-discovery-client<br>@jinn-network/record-discovery-serve |
| @jinn-network/record-publication | @jinn-network/record-discovery-serve |
| @jinn-network/task-admission | — |
| @jinn-network/task-curation | — |
| @jinn-network/task-derivation | @jinn-network/task-admission |
| @jinn-network/task-execution-backend | — |
| @jinn-network/task-execution-backend-local | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/execution-evidence-builder<br>@jinn-network/execution-recorder<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-evaluation-harness | @jinn-network/attestation-issuer<br>@jinn-network/evidence-repository<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-evaluator-adapters | @jinn-network/attestation-issuer<br>@jinn-network/evidence-repository<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-launchers | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-oci-grader | @jinn-network/attestation-issuer<br>@jinn-network/evidence-repository<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-evaluator-adapters<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-supervisor | @jinn-network/task-execution-backend |
| @jinn-network/task-execution-testing | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/execution-evidence-builder<br>@jinn-network/execution-recorder<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-workspace | — |
| @jinn-network/task-posting | @jinn-network/marketplace-binding<br>@jinn-network/task-execution-backend<br>@jinn-network/trust-resolve |
| @jinn-network/trust-observation | — |
| @jinn-network/trust-resolve | — |
| @jinn-network/trust-testing | @jinn-network/trust-resolve |

## Release and trusted publishers

| Release group | Packages | Required gates | Publish policies | Stack published | Canary | Stable |
| --- | ---: | --- | --- | --- | --- | --- |
| experimental-lifecycle-notifications | 1 | lifecycle-notifications-ci | disabled | false | false | false |
| experimental-policy | 2 | policy-ci | disabled | false | false | false |
| experimental-read-plane | 1 | read-plane-ci | disabled | false | false | false |
| implementations-v1 | 60 | benchmarking-ci<br>environments-ci<br>evidence-ci<br>marketplace-ci<br>record-discovery-ci<br>task-execution-ci<br>task-supply-ci<br>trust-ci | canary-and-stable | true | true | true |
| legacy-product-lines | 6 | client-ci<br>core-ci<br>layer-ci<br>marketplace-ci<br>plugin-ci<br>sdk-ci | independent | false | false | false |
| sealed-platform-v1 | 13 | benchmarking-ci<br>environments-ci<br>evidence-ci<br>record-discovery-ci<br>task-execution-ci<br>trust-ci | canary-and-stable | true | true | true |
| transitional-or-private | 14 | autopilot-ci<br>benchmark-product-ci<br>broadcast-bot-ci<br>environments-ci<br>indexer-ci<br>indexer-enrichment-ci<br>operator-console-ci<br>plugin-tree-ci<br>policy-optimization-ci<br>task-supply-ci<br>website-ci | private<br>never | false | false | false |

The exact 73-package trusted-publisher set is the union of stack-published groups. Receipt-gated canary publication is enabled for every stack-published group. **Stable publication is disabled until live `spec.jinn.network` profile hosting verification passes.** The 2 `experimental-policy` packages remain disabled. Legacy and product lines publish independently or remain private/never-published according to the catalog.

| Package | Workflow | Environment field |
| --- | --- | --- |
| @jinn-network/attestation-issuer | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-aggregate | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-evaluation | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-evidence | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-interop | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-local | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-marketplace | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-native-capture | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-protocol | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-publication | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-records | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-run | stack-npm-publish.yml | npm-publish |
| @jinn-network/benchmarking-testing | stack-npm-publish.yml | npm-publish |
| @jinn-network/chain-environment-record | stack-npm-publish.yml | npm-publish |
| @jinn-network/chain-environment-verification | stack-npm-publish.yml | npm-publish |
| @jinn-network/chain-scenarios | stack-npm-publish.yml | npm-publish |
| @jinn-network/chain-state-extraction | stack-npm-publish.yml | npm-publish |
| @jinn-network/environment-record | stack-npm-publish.yml | npm-publish |
| @jinn-network/environment-verification | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-catalog-sqlite | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-contribution | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-derivation | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-discovery | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-local-runtime | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-protocol | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-publication | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-repository | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-repository-ipfs | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-repository-oci | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-retrieval | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-trace | stack-npm-publish.yml | npm-publish |
| @jinn-network/evidence-trace-decode | stack-npm-publish.yml | npm-publish |
| @jinn-network/execution-evidence-builder | stack-npm-publish.yml | npm-publish |
| @jinn-network/execution-recorder | stack-npm-publish.yml | npm-publish |
| @jinn-network/execution-recorder-bridge | stack-npm-publish.yml | npm-publish |
| @jinn-network/information-world | stack-npm-publish.yml | npm-publish |
| @jinn-network/marketplace-binding | stack-npm-publish.yml | npm-publish |
| @jinn-network/marketplace-projector | stack-npm-publish.yml | npm-publish |
| @jinn-network/marketplace-testing | stack-npm-publish.yml | npm-publish |
| @jinn-network/marketplace-venue-base | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-client | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-facts-benchmarking | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-facts-chain-environments | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-facts-environments | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-facts-evidence | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-facts-task-execution | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-facts-trust | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-protocol | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-serve | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-source-evidence-journal | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-testing | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-discovery-transport-http | stack-npm-publish.yml | npm-publish |
| @jinn-network/record-publication | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-admission | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-curation | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-derivation | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-backend | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-backend-local | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-evaluation-harness | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-evaluator-adapters | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-launchers | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-oci-grader | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-profiles | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-protocol | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-supervisor | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-testing | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-execution-workspace | stack-npm-publish.yml | npm-publish |
| @jinn-network/task-posting | stack-npm-publish.yml | npm-publish |
| @jinn-network/trust-authoring | stack-npm-publish.yml | npm-publish |
| @jinn-network/trust-core | stack-npm-publish.yml | npm-publish |
| @jinn-network/trust-observation | stack-npm-publish.yml | npm-publish |
| @jinn-network/trust-resolve | stack-npm-publish.yml | npm-publish |
| @jinn-network/trust-testing | stack-npm-publish.yml | npm-publish |

## Public surfaces and identity claims

| Package | Release group | Schemas | Profiles | Fixtures | Conformance exports |
| --- | --- | --- | --- | --- | --- |
| @jinn-network/broadcast-bot | transitional-or-private | — | — | — | — |
| @jinn-network/operator-console | transitional-or-private | — | — | — | — |
| @jinn-network/website | transitional-or-private | — | — | — | — |
| @jinn-network/operator | legacy-product-lines | schemas | — | fixtures | — |
| @jinn-network/autopilot | transitional-or-private | — | — | — | — |
| @colophon-claims/cli | transitional-or-private | — | — | — | — |
| @colophon-claims/core | transitional-or-private | — | — | — | — |
| @colophon-claims/verify | transitional-or-private | — | — | — | — |
| @colophon-claims/web | transitional-or-private | — | — | — | — |
| @jinn-network/benchmarking-aggregate | implementations-v1 | — | — | — | — |
| @jinn-network/benchmarking-evaluation | implementations-v1 | — | — | — | — |
| @jinn-network/benchmarking-evidence | implementations-v1 | — | — | — | — |
| @jinn-network/benchmarking-interop | implementations-v1 | — | — | fixtures | — |
| @jinn-network/benchmarking-local | implementations-v1 | — | — | — | — |
| @jinn-network/benchmarking-marketplace | implementations-v1 | — | — | fixtures | — |
| @jinn-network/benchmarking-native-capture | implementations-v1 | — | — | — | — |
| @jinn-network/benchmarking-protocol | sealed-platform-v1 | — | — | — | — |
| @jinn-network/benchmarking-publication | implementations-v1 | — | — | — | — |
| @jinn-network/benchmarking-records | sealed-platform-v1 | schemas | — | fixtures | — |
| @jinn-network/benchmarking-run | implementations-v1 | — | — | — | — |
| @jinn-network/benchmarking-testing | sealed-platform-v1 | — | — | fixtures | . |
| @jinn-network/core | legacy-product-lines | — | — | — | — |
| @jinn-network/record-discovery-client | implementations-v1 | — | — | — | — |
| @jinn-network/record-discovery-facts-benchmarking | implementations-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-chain-environments | implementations-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-environments | implementations-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-evidence | implementations-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-task-execution | implementations-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-trust | implementations-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-protocol | sealed-platform-v1 | — | — | fixtures | — |
| @jinn-network/record-publication | implementations-v1 | — | — | — | — |
| @jinn-network/record-discovery-serve | implementations-v1 | — | — | — | — |
| @jinn-network/record-discovery-source-evidence-journal | implementations-v1 | — | — | fixtures | — |
| @jinn-network/record-discovery-testing | sealed-platform-v1 | — | — | fixtures | . |
| @jinn-network/record-discovery-transport-http | implementations-v1 | — | — | — | — |
| @jinn-network/chain-state-extraction | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/chain-environment-record | sealed-platform-v1 | schemas | — | fixtures | ./testing |
| @jinn-network/chain-environment-verification | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/information-world | implementations-v1 | schemas | — | fixtures | ./testing |
| @jinn-network/environment-record | sealed-platform-v1 | schemas | — | fixtures | ./testing |
| @jinn-network/environment-verification | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/attestation-issuer | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/evidence-catalog-sqlite | implementations-v1 | — | — | — | — |
| @jinn-network/evidence-contribution | implementations-v1 | — | — | — | ./testing |
| @jinn-network/evidence-derivation | implementations-v1 | — | — | — | ./testing |
| @jinn-network/evidence-discovery | implementations-v1 | — | — | — | ./testing |
| @jinn-network/execution-evidence-builder | implementations-v1 | — | — | — | — |
| @jinn-network/execution-recorder | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/execution-recorder-bridge | implementations-v1 | — | — | — | — |
| @jinn-network/evidence-local-runtime | implementations-v1 | — | — | — | — |
| @jinn-network/evidence-protocol | sealed-platform-v1 | profiles/execution-evidence/v1/schemas | profiles | fixtures | — |
| @jinn-network/evidence-publication | implementations-v1 | — | — | — | ./testing |
| @jinn-network/evidence-repository | implementations-v1 | — | — | — | ./testing |
| @jinn-network/evidence-repository-ipfs | implementations-v1 | — | profile | profile/v1/fixtures | — |
| @jinn-network/evidence-repository-oci | implementations-v1 | profiles/evidence-repository-oci/v1/schemas | profiles | fixtures | — |
| @jinn-network/evidence-retrieval | implementations-v1 | — | — | — | ./testing |
| @jinn-network/evidence-trace | sealed-platform-v1 | schemas | profiles | fixtures | ./testing |
| @jinn-network/evidence-trace-decode | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/indexer | transitional-or-private | — | — | — | — |
| @jinn-network/indexer-enrichment | transitional-or-private | — | — | — | — |
| @jinn-network/explorer-spa | transitional-or-private | — | — | — | — |
| @jinn-network/jinn-layer | legacy-product-lines | — | — | — | — |
| @jinn-network/lifecycle-notifications | experimental-lifecycle-notifications | — | — | — | ./testing |
| @jinn-network/marketplace-binding | implementations-v1 | — | — | fixtures | — |
| @jinn-network/marketplace-pipeline | legacy-product-lines | — | — | — | — |
| @jinn-network/marketplace-projector | implementations-v1 | — | — | — | — |
| @jinn-network/marketplace-testing | implementations-v1 | — | — | fixtures | ./backend-conformance<br>./projector-conformance<br>./revised-contract-conformance<br>./venue-conformance |
| @jinn-network/marketplace-venue-base | implementations-v1 | — | — | — | — |
| @jinn-network/plugin | legacy-product-lines | — | — | — | — |
| @jinn-network/policy-optimization | transitional-or-private | — | — | — | — |
| @jinn-network/policy-identity | experimental-policy | — | — | fixtures | — |
| @jinn-network/policy-outcomes | experimental-policy | — | — | fixtures | — |
| @jinn-network/read-plane | experimental-read-plane | — | — | — | ./testing |
| @jinn-network/sdk | legacy-product-lines | — | — | fixtures | — |
| @jinn-network/task-execution-backend | implementations-v1 | — | — | — | — |
| @jinn-network/task-execution-backend-local | implementations-v1 | — | — | — | — |
| @jinn-network/task-execution-launchers | implementations-v1 | — | — | — | — |
| @jinn-network/task-execution-supervisor | implementations-v1 | — | — | — | — |
| @jinn-network/task-execution-workspace | implementations-v1 | — | — | — | — |
| @jinn-network/task-execution-evaluation-harness | implementations-v1 | — | — | — | — |
| @jinn-network/task-execution-evaluator-adapters | implementations-v1 | — | — | fixtures | — |
| @jinn-network/task-execution-oci-grader | implementations-v1 | — | — | — | — |
| @jinn-network/task-execution-profiles | sealed-platform-v1 | — | profiles | fixtures | ./testing |
| @jinn-network/task-execution-protocol | sealed-platform-v1 | schemas | profiles | fixtures | — |
| @jinn-network/task-execution-testing | implementations-v1 | — | — | fixtures | . |
| @jinn-network/task-admission | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/chain-scenarios | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/task-curation | implementations-v1 | — | — | fixtures | — |
| @jinn-network/task-derivation | implementations-v1 | — | — | fixtures | ./testing |
| @jinn-network/task-posting | implementations-v1 | — | — | — | — |
| @jinn-network/trust-authoring | sealed-platform-v1 | — | — | — | — |
| @jinn-network/trust-core | sealed-platform-v1 | — | — | fixtures | — |
| @jinn-network/trust-observation | implementations-v1 | — | — | — | ./testing |
| @jinn-network/trust-resolve | implementations-v1 | — | — | — | — |
| @jinn-network/trust-testing | implementations-v1 | — | — | fixtures | . |
| @jinn-network/plugin-runtime | transitional-or-private | — | — | — | — |
| @jinn-network/chain-only-gate-harness | transitional-or-private | — | — | — | — |

### Exact public assets

| Kind | Package | Source | Export | Packed targets | Self-identifying claim |
| --- | --- | --- | --- | --- | --- |
| fixtures | @jinn-network/operator | operator/fixtures/config.example.json | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/jinn-repo-live-issue-task.example.json | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/local-config.json | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/mint-candidate-example.json | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/prediction-apy-v0-intent.example.json | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/prediction-v1-task.example.json | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/aider/example-analytics.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/aider/example-chat-history.md | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/claude-code/example-session.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/claude-code/stream-json-example.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/claude-code/stream-json-with-model.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/codex/example-session.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/codex/exec-json-with-usage.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/codex/wrapped-0-129-mcp-tools.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/continue/dev_data/chat/0.2.0.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/continue/dev_data/edit/0.2.0.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/gemini/example-session.jsonl | — | — | — |
| fixtures | @jinn-network/operator | operator/fixtures/transcripts/hermes-agent/session-example.json | — | — | — |
| schemas | @jinn-network/operator | operator/schemas/jinn-manifest-v1.json | — | — | — |
| fixtures | @jinn-network/benchmarking-interop | packages/benchmarking/interop/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/benchmarking-interop | packages/benchmarking/interop/fixtures/swebench/expected.json | — | — | — |
| fixtures | @jinn-network/benchmarking-interop | packages/benchmarking/interop/fixtures/swebench/expected.v2.json | — | — | — |
| fixtures | @jinn-network/benchmarking-interop | packages/benchmarking/interop/fixtures/swebench/row.json | — | — | — |
| fixtures | @jinn-network/benchmarking-interop | packages/benchmarking/interop/fixtures/swebench/rows.multi-repo.json | — | — | — |
| fixtures | @jinn-network/benchmarking-marketplace | packages/benchmarking/marketplace/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/benchmarking-marketplace | packages/benchmarking/marketplace/fixtures/projector/golden-events/revised-task-created.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark-accounting/invalid-authorization-after-close.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark-accounting/invalid-missing-protocol.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark-accounting/invalid-missing-publisher-authority.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark-accounting/invalid-unsorted-cells.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark-accounting/valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark-accounting/valid.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark/invalid-bad-version.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark/invalid-duplicate-item.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark/invalid-item-uri-only.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark/minimal.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark/valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/benchmark/valid.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/equivalence/expected-digest.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/equivalence/input-a.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/equivalence/input-b.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/equivalence/unicode-invalid-key.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/equivalence/unicode-invalid-value.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/equivalence/unicode-valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/matrix/invalid-aggregate-field.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/matrix/invalid-bad-outcome.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/matrix/invalid-missing-cells.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/matrix/invalid-run-uri-only.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/matrix/minimal.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/matrix/valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/matrix/valid.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/observation-archive/invalid-missing-profile.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/observation-archive/invalid-unsorted-streams.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/observation-archive/valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/observation-archive/valid.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/report/invalid-missing-disclosures.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/report/invalid-subject-uri-only.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/report/minimal.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/report/plural-valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/report/valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/report/valid.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/committed.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/expected-coverage.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/revealed-full/10b04c8d2f473c1bdb0db65d14a08c6cf9fd31bd9dc685cb00ac80783c7dedb6.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/revealed-full/23ea40a429f1d2ed0bfc81d41ab34ee48f0a1384f71046d4062c06c445643a30.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/revealed-full/50a6a9787f196bf3654d99f8ae1c9adb5891269259f4158860530300a252f462.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/revealed-full/7d8f64441861789ce4d4076f693f6b8924cfbf88a2a7606f7ec0b4958d2f412e.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/revealed-full/b88662f1bd9b1839da3f5830f7e3e4c21c8d00de6f0ec00e766fd1fe4b023a9f.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/revealed-partial/50a6a9787f196bf3654d99f8ae1c9adb5891269259f4158860530300a252f462.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/revealed-partial/b88662f1bd9b1839da3f5830f7e3e4c21c8d00de6f0ec00e766fd1fe4b023a9f.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/reveal/tampered-item/50a6a9787f196bf3654d99f8ae1c9adb5891269259f4158860530300a252f462.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/run/invalid-benchmark-uri-only.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/run/invalid-dup-arm.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/run/invalid-missing-closeAt.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/run/minimal.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/run/valid.json | — | — | — |
| fixtures | @jinn-network/benchmarking-records | packages/benchmarking/records/fixtures/run/valid.sha256 | — | — | — |
| schemas | @jinn-network/benchmarking-records | packages/benchmarking/records/schemas/benchmark-accounting.schema.json | — | — | — |
| schemas | @jinn-network/benchmarking-records | packages/benchmarking/records/schemas/benchmark.schema.json | — | — | — |
| schemas | @jinn-network/benchmarking-records | packages/benchmarking/records/schemas/matrix.schema.json | — | — | — |
| schemas | @jinn-network/benchmarking-records | packages/benchmarking/records/schemas/observation-archive.schema.json | — | — | — |
| schemas | @jinn-network/benchmarking-records | packages/benchmarking/records/schemas/report.schema.json | — | — | — |
| schemas | @jinn-network/benchmarking-records | packages/benchmarking/records/schemas/run.schema.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/exports/croissant.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/exports/eval-log.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/exports/matrix-projection.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/exports/static-bundle.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/avg-at-k.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/bradley-terry.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/clean-subset.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/conflict-cases.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/conformance-cases.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/fully-attrited-avg-at-k.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/fully-attrited-pass-at-k.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/fully-attrited-wilson.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/method-specs.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/noninferiority-cluster-bca.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/noninferiority-fail.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/noninferiority-inconclusive.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/noninferiority-pass.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/paired-contract.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/paired-delta-shared-ensemble.v2.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/paired-delta-withheld.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/paired-delta.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/paired-exclusion-r1.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/paired-mcnemar.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/pass-at-k-incompatible.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/pass-at-k.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/provenance-cluster-sign-conformance.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/provenance-cluster-sign-method-spec.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/provenance-cluster-sign.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/subject-isolation.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/methods/wilson.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/benchmark.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/benchmark.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/deliveries.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/evaluation-spec.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/evaluation-spec.sealed.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/evidence.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/expected-matrix.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/expected-matrix.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/injected-scope.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/run.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/run.sha256 | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/submissions.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/tasks.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/miniature-run/verdicts.json | — | — | — |
| fixtures | @jinn-network/benchmarking-testing | packages/benchmarking/testing/fixtures/ordering/transcripts.json | — | — | — |
| conformance | @jinn-network/benchmarking-testing | packages/benchmarking/testing/src/index.ts | . | ./dist/index.d.ts<br>./dist/index.js | — |
| profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/benchmark-accounting.v1.json | — | — | https://spec.jinn.network/facts/benchmark-accounting/v1 |
| profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/benchmark.v1.json | — | — | https://spec.jinn.network/facts/benchmark/v1 |
| profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/matrix.v1.json | — | — | https://spec.jinn.network/facts/benchmark-matrix/v1 |
| profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/report.v1.json | — | — | https://spec.jinn.network/facts/benchmark-report/v1 |
| profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/report.v2.json | — | — | https://spec.jinn.network/facts/benchmark-report/v2 |
| profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/run.v1.json | — | — | https://spec.jinn.network/facts/benchmark-run/v1 |
| profiles | @jinn-network/record-discovery-facts-chain-environments | packages/discovery/facts/chain-environments/profiles/chain-environment.v1.json | — | — | https://spec.jinn.network/facts/chain-environment/v1 |
| profiles | @jinn-network/record-discovery-facts-chain-environments | packages/discovery/facts/chain-environments/profiles/crypto-environment.v1.json | — | — | https://spec.jinn.network/facts/crypto-environment/v1 |
| profiles | @jinn-network/record-discovery-facts-chain-environments | packages/discovery/facts/chain-environments/profiles/information-world.v1.json | — | — | https://spec.jinn.network/facts/information-world/v1 |
| profiles | @jinn-network/record-discovery-facts-environments | packages/discovery/facts/environments/profiles/environment.v1.json | — | — | https://spec.jinn.network/facts/environment/v1 |
| profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-evidence.v1.json | — | — | https://spec.jinn.network/facts/execution-evidence/v1 |
| profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-evidence.v2.json | — | — | https://spec.jinn.network/facts/execution-evidence/v2 |
| profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-verification.v1.json | — | — | https://spec.jinn.network/facts/execution-verification/v1 |
| profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/result-evaluation.v1.json | — | — | https://spec.jinn.network/facts/result-evaluation/v1 |
| profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/result-evaluation.v2.json | — | — | https://spec.jinn.network/facts/result-evaluation/v2 |
| profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/checkpoint.v1.json | — | — | https://spec.jinn.network/facts/checkpoint/v1 |
| profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/delivery.v1.json | — | — | https://spec.jinn.network/facts/delivery/v1 |
| profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/evaluation-spec.v1.json | — | — | https://spec.jinn.network/facts/evaluation-spec/v1 |
| profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/plugin.v1.json | — | — | https://spec.jinn.network/facts/plugin/v1 |
| profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/profile-document.v1.json | — | — | https://spec.jinn.network/facts/profile-document/v1 |
| profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/submission.v1.json | — | — | https://spec.jinn.network/facts/submission/v1 |
| profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/task.v1.json | — | — | https://spec.jinn.network/facts/task/v1 |
| profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/authorization.v1.json | — | — | https://spec.jinn.network/facts/authorization/v1 |
| profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/key-binding.v1.json | — | — | https://spec.jinn.network/facts/key-binding/v1 |
| profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/trust-policy.v1.json | — | — | https://spec.jinn.network/facts/trust-policy/v1 |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/derivation-annotation-tolerance/annotation-with-registered-additions.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/equivalence/key-shuffled.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/equivalence/nested.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/equivalence/simple.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/expected-digests.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/golden-entries/available-withdrawn.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/golden-entries/genesis-shuffled-keys.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/golden-entries/genesis.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/golden-heads/head.json | — | — | — |
| fixtures | @jinn-network/record-discovery-protocol | packages/discovery/protocol/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/record-discovery-source-evidence-journal | packages/discovery/sources/evidence-journal/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/record-discovery-source-evidence-journal | packages/discovery/sources/evidence-journal/fixtures/pinned-projection/expected-digests.json | — | — | — |
| fixtures | @jinn-network/record-discovery-source-evidence-journal | packages/discovery/sources/evidence-journal/fixtures/pinned-projection/journal.json | — | — | — |
| fixtures | @jinn-network/record-discovery-source-evidence-journal | packages/discovery/sources/evidence-journal/fixtures/pinned-projection/source.json | — | — | — |
| fixtures | @jinn-network/record-discovery-source-evidence-journal | packages/discovery/sources/evidence-journal/fixtures/pinned-projection/withdrawals.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/broken-linkage-previous-mismatch/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/competing-head-rotated-out-key/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-cold-start-mirror-disagreement/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-head-vs-delivered-divergence/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-hostile-locator-oversize/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-hostile-locator-private-address/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-hostile-locator-wrong-content-type/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-ping-flood-debounce/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-reorged-withdrawal-recompute/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/consumer-withdrawal-retrospective-no-prune/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/derivation-consistency-fabricated/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/derivation-consistency-present/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/derivation-consistency-reorged-away/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/duplicate-announcement-id-across-entries/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/duplicate-genesis-entries/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/facts-consistency-consistent/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/facts-consistency-inconsistent/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/facts-consistency-indeterminate-unavailable-referenced-bytes/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/forked-chain-second-signed-child/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/forked-chain-shared-previous/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/genesis-pinned-sequence/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/issued-at-regression/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/item-content-corruption/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/item-lying-entry-provenance/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/item-unauthorized-provenance/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/item-verified-consistent/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/missing-withdrawal-reason/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/non-genesis-previous-null/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/oversized-archive-page/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/oversized-entry/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/query-complete-honesty/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/query-cursor-determinism-digest-tiebreak/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/query-fabricated-provenance/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/query-provenance-present-on-every-item/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/query-service-originates-rejected/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/re-announce-after-withdrawal/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/rolled-back-head/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/sequence-duplicate/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/sequence-gap/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/source-conformance-correction-by-append-reorged/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/source-conformance-freshness-maintenance/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/source-conformance-published-profile/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/source-conformance-refreshby-bound/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/source-conformance-unpublished-profile/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/stale-head/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-announcement-dedupe-key/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-cursor-no-cursor/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-cursor-older-than-window/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-cursor-oldest/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-cursor-unknown-or-future/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-cursor-within-window/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-declared-replay-window/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-observation-passthrough-unaltered/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-per-item-drop-censoring-relay/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/subscribe-relay-local-cursor-declaration/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/substrate-fact-in-author-source/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/unknown-facts-field-skip/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/unknown-record-kind-skip/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/valid-chain/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/withdrawal-of-foreign-announcement/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/withdrawal-of-withdrawal/vector.json | — | — | — |
| fixtures | @jinn-network/record-discovery-testing | packages/discovery/testing/fixtures/vectors/wrong-signing-scope/vector.json | — | — | — |
| conformance | @jinn-network/record-discovery-testing | packages/discovery/testing/src/index.ts | . | ./dist/index.d.ts<br>./dist/index.js | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/.gitkeep | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/adversarial-v1/uncovered-entry.json | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/adversarial-v1/unsorted-slots.json | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/adversarial-v1/uppercase-hex.json | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/artifacts-v1/converged.json | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/artifacts-v1/converged.sha256 | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/artifacts-v1/minimal.json | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/artifacts-v1/minimal.sha256 | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/coverage-v1/fixture-coverage.json | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/coverage-v1/fixture-coverage.sha256 | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/coverage-v1/proof-bundle.json | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/coverage-v1/proof-bundle.sha256 | — | — | — |
| fixtures | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/fixtures/manifest.sha256.json | — | — | — |
| conformance | @jinn-network/chain-state-extraction | packages/environments/chain-extraction/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/anchor-root-as-initial-commitment/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/artifact-entry-uncovered/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/bare-extension-key/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/digest-confusion-bare-hex/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/index-digest-as-manifest/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/manifest.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/namespaced-extension-preserved/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/origin-precedence-undeclared/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/recanonicalized-bytes/document.bytes | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/adversarial-v1/well-known-fixture-address/document.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/chain/archive-dependent.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/chain/archive-dependent.sha256 | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/chain/closed-anchored-subset.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/chain/closed-anchored-subset.sha256 | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/chain/closed-local.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/chain/closed-local.sha256 | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/composite/chain-only.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/composite/chain-only.sha256 | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/composite/composed.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/composite/composed.sha256 | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/composite/extension.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/composite/extension.sha256 | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/equivalence/expected-digest.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/equivalence/input-a.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/equivalence/input-b.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/anchor-root-as-initial-commitment.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/artifact-entry-uncovered.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/bare-extension-key.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/checksummed-address.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/digest-confusion-bare-hex.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/digest-confusion-prefixed-descriptor.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/index-digest-as-manifest.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/origin-precedence-undeclared.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/snapshot-reset-closed-state.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/invalid/well-known-fixture-address.json | — | — | — |
| fixtures | @jinn-network/chain-environment-record | packages/environments/chain-record/fixtures/manifest.sha256.json | — | — | — |
| schemas | @jinn-network/chain-environment-record | packages/environments/chain-record/schemas/chain-environment.schema.json | — | — | https://spec.jinn.network/schemas/chain-environment/v1 |
| schemas | @jinn-network/chain-environment-record | packages/environments/chain-record/schemas/crypto-environment.schema.json | — | — | https://spec.jinn.network/schemas/crypto-environment/v1 |
| conformance | @jinn-network/chain-environment-record | packages/environments/chain-record/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/abi-vectors-v1/vectors.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/artifact-unavailable.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/composite-chain-only.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/composite-colliding-origins.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/coverage-incomplete.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/divergent-on-run-3.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/fork-backend-refusal.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/README.md | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/sealed-stable.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/attestations-v1/upstream-fetch-succeeds.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/archive-observed.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/closed-reproducible.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/invalid-closed-with-divergent-per-run.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/invalid-coverage-uncovered-but-reproducible.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/invalid-k-below-minimum.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/invalid-prefixed-digest-set.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/invalid-reason-outcome-mismatch.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/invalid-runs-on-non-run-bearing.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/predicate-v1/invalid-sealed-without-boundary-probe.json | — | — | — |
| fixtures | @jinn-network/chain-environment-verification | packages/environments/chain-verification/fixtures/state-read-keys-v1/keys.json | — | — | — |
| conformance | @jinn-network/chain-environment-verification | packages/environments/chain-verification/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/captured-provenance-unprovable/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/corpus-body-digest-mismatch/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/corpus-injected-instruction/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/entry-origin-undeclared/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/manifest.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/miss-policy-absent/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/miss-policy-redirect/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/policy-header-subset-credential/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/policy-header-subset-unsorted/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/request-key-collision/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/request-key-declared-mismatch/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/adversarial-v1/synthetic-claims-capture/document.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/equivalence/expected-digest.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/equivalence/input-a.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/equivalence/input-b.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/request-key-v1/vectors.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/bodies/158a551933b311c1d20918258e79300fa2a4820d119e07dedca7cb8bc9a3f1eb.bin | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/bodies/1ae291ff0bd911a370ae58284360b786856994754be99dd46143dafb11223dd7.bin | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/bodies/4775bfcd3d930813f077dce01d00f830f083da3a5b6c3951f8a0b68c22b943ff.bin | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/bodies/d564d6d91ff2aa7ec2553069ce20d23da332de5a3bf01699049306e9d23f4693.bin | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/captured.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/captured.sha256 | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/extension.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/extension.sha256 | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/synthetic.json | — | — | — |
| fixtures | @jinn-network/information-world | packages/environments/information-world/fixtures/world/synthetic.sha256 | — | — | — |
| schemas | @jinn-network/information-world | packages/environments/information-world/schemas/information-world.schema.json | — | — | https://spec.jinn.network/schemas/information-world/v1 |
| conformance | @jinn-network/information-world | packages/environments/information-world/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/bare-extension-key/document.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/bare-hex-manifest-digest/document.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/index-digest-as-manifest/document.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/manifest.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/namespaced-extension-preserved/document.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/recanonicalized-bytes/document.bytes | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/reference-not-ending-in-digest/document.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/shell-command-exe-spelling/document.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/adversarial-v1/shell-command/document.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/extension.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/extension.sha256 | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/imported.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/imported.sha256 | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/invalid-bare-extension-key.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/invalid-bare-hex-manifest-digest.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/invalid-index-digest-as-manifest.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/invalid-reference-not-ending-in-digest.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/invalid-shell-command-exe-spelling.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/invalid-shell-command.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/tier-1.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/environment/tier-1.sha256 | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/equivalence/expected-digest.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/equivalence/input-a.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/equivalence/input-b.json | — | — | — |
| fixtures | @jinn-network/environment-record | packages/environments/record/fixtures/manifest.sha256.json | — | — | — |
| schemas | @jinn-network/environment-record | packages/environments/record/schemas/environment.schema.json | — | — | https://spec.jinn.network/schemas/environment/v1 |
| conformance | @jinn-network/environment-record | packages/environments/record/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/attestations-v1/error-acquire.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/attestations-v1/README.md | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/attestations-v1/stable.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/attestations-v1/unstable-divergence.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/predicate-v1/invalid-controls-omitted.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/predicate-v1/invalid-k-below-minimum.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/predicate-v1/invalid-prefixed-digest-set.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/predicate-v1/invalid-stable-divergent-per-run.json | — | — | — |
| fixtures | @jinn-network/environment-verification | packages/environments/verification/fixtures/predicate-v1/stable.json | — | — | — |
| conformance | @jinn-network/environment-verification | packages/environments/verification/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/attestation-issuer | packages/evidence/attestation-issuer/fixtures/issuer-contract-v1/execution-verification.json | — | — | — |
| fixtures | @jinn-network/attestation-issuer | packages/evidence/attestation-issuer/fixtures/issuer-contract-v1/expected-digests.json | — | — | — |
| fixtures | @jinn-network/attestation-issuer | packages/evidence/attestation-issuer/fixtures/issuer-contract-v1/README.md | — | — | — |
| fixtures | @jinn-network/attestation-issuer | packages/evidence/attestation-issuer/fixtures/issuer-contract-v1/result-evaluation.json | — | — | — |
| fixtures | @jinn-network/attestation-issuer | packages/evidence/attestation-issuer/fixtures/manifest.sha256.json | — | — | — |
| conformance | @jinn-network/attestation-issuer | packages/evidence/attestation-issuer/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| conformance | @jinn-network/evidence-contribution | packages/evidence/contribution/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| conformance | @jinn-network/evidence-derivation | packages/evidence/derivation/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| conformance | @jinn-network/evidence-discovery | packages/evidence/discovery/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/abandoned.json | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/completed.json | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/failed.json | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/README.md | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/result.txt | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/runner.mjs | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/runtime.json | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/task.md | — | — | — |
| fixtures | @jinn-network/execution-recorder | packages/evidence/execution-recorder/fixtures/producer-contract-v1/trace.jsonl | — | — | — |
| conformance | @jinn-network/execution-recorder | packages/evidence/execution-recorder/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/artifacts/executor.observed.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/artifacts/repository-input.observed.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/artifacts/result.patch | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/artifacts/scrub-receipt.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/artifacts/task.public.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/artifacts/trace.public.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/candidate-execution-graph.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/conformance-report.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/README.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/autopilot-issue-1697/source-observations.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/public-key.pem | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/statement.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/verification-policy.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/verifier-implementation.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/verifier.mjs | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/evaluation-report.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/evaluation-specification.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/evaluator-implementation.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/evaluator.mjs | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/public-key.pem | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/statement.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/conformance-report.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/evidence/in-run-tests.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/external/marketplace-reference.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/inputs/knowledge.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/inputs/repository-tree.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/inputs/repository/src/slug.ts | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/inputs/repository/test/slug.test.ts | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/results/slug-normalization.patch | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/runtime/hosted-model.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/runtime/runner.mjs | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/runtime/runtime-lock.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/runtime/runtime-specification.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/runtime/system-prompt.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/runtime/tool-policy.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/runtime/workflow.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/task/task.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/execution/trace/trace.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/public/results/slug-normalization.patch | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/public/ro-crate-metadata.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/public/scrub/public-execution-policy.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/public/scrub/scrub-receipt.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/public/task/task.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/public/trace/trace.public.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/README.md | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/golden-execution-evidence-v1/ro-crate-metadata.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/evidence-protocol | packages/evidence/protocol/fixtures/task-execution-identifiers-v1/task-execution-identifiers.json | — | — | — |
| profiles | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/ro-crate-metadata.json | — | — | — |
| schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/dsse-envelope.schema.json | — | — | https://spec.jinn.network/profiles/execution-evidence/v1/schemas/dsse-envelope.schema.json |
| schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/execution-evidence-document.schema.json | — | — | https://spec.jinn.network/profiles/execution-evidence/v1/schemas/execution-evidence-document.schema.json |
| schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/execution-verification-statement.schema.json | — | — | https://spec.jinn.network/profiles/execution-evidence/v1/schemas/execution-verification-statement.schema.json |
| schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/resource-descriptor.schema.json | — | — | https://spec.jinn.network/profiles/execution-evidence/v1/schemas/resource-descriptor.schema.json |
| schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/result-evaluation-statement.schema.json | — | — | https://spec.jinn.network/profiles/execution-evidence/v1/schemas/result-evaluation-statement.schema.json |
| profiles | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/specification.md | — | — | — |
| profiles | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/vocabulary.jsonld | — | — | — |
| conformance | @jinn-network/evidence-publication | packages/evidence/publication/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/fixtures/artifact-registration.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/fixtures/execution-evidence-registration.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/fixtures/execution-verification-registration.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/fixtures/result-evaluation-registration.json | — | — | — |
| profiles | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/registration.schema.json | — | — | https://spec.jinn.network/profiles/evidence-repository-ipfs-registration/v1/registration.schema.json |
| profiles | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/specification.md | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/artifact.content | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/artifact.manifest.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/execution-evidence.content | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/execution-evidence.manifest.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/execution-verification.content | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/execution-verification.manifest.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/expected-digests.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/result-evaluation.content | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/golden-oci-mapping/result-evaluation.manifest.json | — | — | — |
| fixtures | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/fixtures/manifest.sha256.json | — | — | — |
| schemas | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/profiles/evidence-repository-oci/v1/schemas/evidence-oci-manifest.schema.json | — | — | https://spec.jinn.network/profiles/evidence-repository-oci/v1/schemas/evidence-oci-manifest.schema.json |
| profiles | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/profiles/evidence-repository-oci/v1/specification.md | — | — | — |
| conformance | @jinn-network/evidence-repository | packages/evidence/repository/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| conformance | @jinn-network/evidence-retrieval | packages/evidence/retrieval/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/duplicate-call-id/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/duplicate-call-id/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/empty-stream/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/empty-stream/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/error-result/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/error-result/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/injected-instruction/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/injected-instruction/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/minimal-chat/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/minimal-chat/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/not-this-format/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/not-this-format/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/parallel-tools/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/parallel-tools/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/skipped-lines/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/skipped-lines/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/tool-loop/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/tool-loop/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/unclosed-tool/expected.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/cases/unclosed-tool/input.jsonl | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/claude-code-stream-json/manifest.json | — | — | — |
| fixtures | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/fixtures/manifest.sha256.json | — | — | — |
| conformance | @jinn-network/evidence-trace-decode | packages/evidence/trace-decode/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/empty-with-spans/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/full-with-skipped/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/grafted-parent/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/manifest.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/message-content-attribute/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/namespaced-extension-preserved/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/nested-native-trace-key/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/partial-without-skipped/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/adversarial-v1/substituted-source-digest/document.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/derivation/execution-golden-base.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/equivalence/expected-digest.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/equivalence/input-a.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/equivalence/input-b.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/invalid-forged-span-id.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/invalid-forged-trace-id.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/invalid-unknown-extension-key.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/invalid-unsorted-attributes.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/minimal.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/minimal.sha256 | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/valid.json | — | — | — |
| fixtures | @jinn-network/evidence-trace | packages/evidence/trace/fixtures/trace/valid.sha256 | — | — | — |
| profiles | @jinn-network/evidence-trace | packages/evidence/trace/profiles/trace-vocabulary/v1/profile.json | — | — | https://spec.jinn.network/profiles/trace-vocabulary/v1 |
| schemas | @jinn-network/evidence-trace | packages/evidence/trace/schemas/trace-derivation-statement.schema.json | — | — | https://spec.jinn.network/schemas/trace-derivation-statement/v1 |
| schemas | @jinn-network/evidence-trace | packages/evidence/trace/schemas/trace.schema.json | — | — | https://spec.jinn.network/schemas/trace/v1 |
| conformance | @jinn-network/evidence-trace | packages/evidence/trace/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| conformance | @jinn-network/lifecycle-notifications | packages/lifecycle-notifications/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/marketplace-binding | packages/marketplace/binding/fixtures/attempt-uri-agreement.json | — | — | — |
| fixtures | @jinn-network/marketplace-binding | packages/marketplace/binding/fixtures/canonical-equivalence.json | — | — | — |
| fixtures | @jinn-network/marketplace-binding | packages/marketplace/binding/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/escrow/today-generation.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/projector/golden-events/revised-cross-batch-flow-2026-08-03.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/projector/golden-events/revised-cross-batch-flow.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/projector/golden-events/revised-task-created-2026-08-03.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/projector/golden-events/revised-task-created.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/projector/reorg-scenarios/revised-task-created-reorg-2026-08-03.json | — | — | — |
| fixtures | @jinn-network/marketplace-testing | packages/marketplace/testing/fixtures/projector/reorg-scenarios/revised-task-created-reorg.json | — | — | — |
| conformance | @jinn-network/marketplace-testing | packages/marketplace/testing/src/backend-conformance.ts | ./backend-conformance | ./dist/backend-conformance.d.ts<br>./dist/backend-conformance.js | — |
| conformance | @jinn-network/marketplace-testing | packages/marketplace/testing/src/projector-conformance.ts | ./projector-conformance | ./dist/projector-conformance.d.ts<br>./dist/projector-conformance.js | — |
| conformance | @jinn-network/marketplace-testing | packages/marketplace/testing/src/revised-contract-conformance.ts | ./revised-contract-conformance | ./dist/revised-contract-conformance.d.ts<br>./dist/revised-contract-conformance.js | — |
| conformance | @jinn-network/marketplace-testing | packages/marketplace/testing/src/venue-conformance.ts | ./venue-conformance | ./dist/venue-conformance.d.ts<br>./dist/venue-conformance.js | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/canonical/adversarial/non-plain-object.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/canonical/adversarial/sparse-array.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/canonical/golden/mixed-scalars-and-nesting.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/adversarial/effort-floor-violated.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/adversarial/fractional-declared-key.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/adversarial/harness-conflict.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/adversarial/model-constraint-violated.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/adversarial/profile-declares-format-token.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/adversarial/profile-digest-mismatch.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/adversarial/provider-inference-miss.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/golden/equivalence-primary.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/golden/provider-inferred-from-model-id.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/derivation/golden/unpinned-all-core-null.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/dsse/adversarial/wrong-predicate-type.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/dsse/adversarial/wrong-subject.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/dsse/golden/valid-statement.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/fork-healing/fail-closed.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/fork-healing/smuggled-git-hooks.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/fork-healing/tree-golden.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/fork-healing/tree-without-excluded-roots.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/adversarial/duplicate-parents.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/adversarial/malformed-parent-digest.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/adversarial/malformed-parent-kind.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/adversarial/missing-provenance.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/adversarial/policy-omits-core-axis.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/adversarial/provenance-names-two-queries.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/adversarial/unrecognized-top-level-field.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/golden/extension-bearing.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/golden/minimal.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/manifest/golden/multi-parent.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/README.md | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/canonical.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/conformance.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/derive.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/dsse.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/errors.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/hash-profile.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/hashing.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/index.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/manifest.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/merge.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/reference/tuple.ts | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/adversarial/negative-zero.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/adversarial/non-integer-number.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/adversarial/omitted-core-axis-harness.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/adversarial/omitted-core-axis-isolation.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/adversarial/tuple-is-array.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/adversarial/unpaired-surrogate.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/adversarial/wrong-format-token.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/demonstrations/digest-substitution.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/demonstrations/extension-key-sensitivity.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/demonstrations/null-vs-absent-non-collision.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/golden/all-axes.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/golden/constraint-shaped-value.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/golden/extension-axis.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/golden/key-order-variance.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/golden/null-axes.json | — | — | — |
| fixtures | @jinn-network/policy-identity | packages/policy/identity/fixtures/tuple/golden/utf16-code-unit-ordering.json | — | — | — |
| fixtures | @jinn-network/policy-outcomes | packages/policy/outcomes/fixtures/observations-golden.json | — | — | — |
| fixtures | @jinn-network/policy-outcomes | packages/policy/outcomes/fixtures/observations-manipulation.json | — | — | — |
| fixtures | @jinn-network/policy-outcomes | packages/policy/outcomes/fixtures/projection-golden.json | — | — | — |
| conformance | @jinn-network/read-plane | packages/read-plane/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/correlation-failure.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/correlation-mismatch.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/delivery-contradiction.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/delivery-pending.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/malformed-submit-request.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/manifest.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/mutation-complete.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/mutation-human.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/receipt-solution-accepted-comment.txt | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/receipt-solution-accepted.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/receipt-solution-rejected.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/receipt-verdict-accepted.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/receipt-verdict-findings-accepted.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/receipt-verdict-rejected.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/review-approve.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/review-human.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/review-request-changes.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/session-ci-failure.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/session-fix-child.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/session-implement.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/session-reconcile.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/solution-expectation.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/submit-request.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/submit-result.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/verdict-expectation.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/verified-solution.json | — | — | — |
| fixtures | @jinn-network/sdk | packages/sdk/fixtures/autopilot/verified-verdict.json | — | — | — |
| fixtures | @jinn-network/task-execution-evaluator-adapters | packages/task-execution/evaluator-adapters/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/task-execution-evaluator-adapters | packages/task-execution/evaluator-adapters/fixtures/parsers/prediction-market.parser.json | — | — | — |
| fixtures | @jinn-network/task-execution-evaluator-adapters | packages/task-execution/evaluator-adapters/fixtures/parsers/swe-rebench-v2.parser.json | — | — | — |
| fixtures | @jinn-network/task-execution-evaluator-adapters | packages/task-execution/evaluator-adapters/fixtures/prediction/README.md | — | — | — |
| fixtures | @jinn-network/task-execution-evaluator-adapters | packages/task-execution/evaluator-adapters/fixtures/swe-rebench/README.md | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/admission-receipt/adversarial/reused.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/admission-receipt/adversarial/unsigned.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/admission-receipt/adversarial/wrong-subject.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/admission-receipt/golden/valid-signed.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/binary-judgment-request/golden/unicode-line-endings.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/composite/adversarial/composite-depth-3.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/composite/adversarial/composite-fanout-33.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/composite/golden/within-bounds.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/equivalence/expected-digests.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/equivalence/key-order-sensitive.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-spec/adversarial/wrong-protocol.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-spec/golden/deterministic-minimal.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-spec/golden/deterministic-minimal.sha256 | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-spec/golden/fractional-threshold.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-spec/golden/fractional-threshold.sha256 | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-spec/golden/state-predicate-minimal.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-spec/golden/state-predicate-minimal.sha256 | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-task-derivation/adversarial/competitor-delivery.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-task-derivation/adversarial/evaluator-modified-template.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-task-derivation/adversarial/superseded-delivery.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-task-derivation/adversarial/wrong-spec-digest.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/evaluation-task-derivation/golden/derive-TD.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/composite-bare-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/composite-fanout-33.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/composite-numeric-weight.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/deterministic-process-bare-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/human-review-bare-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/judge-invented-digest.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/model-graded-bare-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/adversarial/parser-with-code.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/composite-namespaced-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/composite.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/deterministic-process-namespaced-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/deterministic-process.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/human-review-namespaced-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/human-review.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/model-graded-namespaced-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/family-blocks/golden/model-graded.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/measurements-coverage/adversarial/missing-required.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/measurements-coverage/golden/full-coverage.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/migration/jinn-repo-to-repository-work/golden/live-issue.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/migration/jinn-repo-to-repository-work/golden/merged-pr.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/README.md | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/adversarial/addable-conflict.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/adversarial/ceiling-conflict.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/adversarial/constraint-rejected.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/adversarial/exact-conflict.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/adversarial/floor-conflict.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/adversarial/pinning-inventory-reject.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/golden/addable-new-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/golden/ceiling-tighter.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/golden/constraint-admitted.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/golden/exact-match.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/requirement-merge/golden/floor-tighter.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/resolution/adversarial/drift.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/resolution/adversarial/unknown-digest.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/resolution/golden/resolves.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/result-evaluation/golden/evidence-statement.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/result-evaluation/golden/evidence-statement.PROVENANCE.md | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/schema-hardening/adversarial/depth-bomb.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/schema-hardening/adversarial/overlong-pattern.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/schema-hardening/adversarial/oversized.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/schema-hardening/adversarial/redos-pattern.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/schema-hardening/adversarial/remote-ref.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/schema-hardening/golden/valid-conforms.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/schema-hardening/golden/valid-rejects-nonconforming-payload.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/bare-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/environment-record-inlined-content.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/environment-record-prefixed-digest.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/predicate-bare-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/reserved-measurement-name.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/safety-constraint-state-predicate.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/source-consulted-as-success-predicate.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/tolerance-without-within-comparator.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/adversarial/unknown-predicate-kind.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/golden/measurements-and-tightenings.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/golden/minimal.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-block/golden/namespaced-extra-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/adversarial/duplicate-state-read.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/adversarial/environment-record-mismatch.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/adversarial/replay-refused.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/adversarial/reported-value-post-replay-only.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/adversarial/source-read-unavailable.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/declarative-call-ground-truth.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/do-nothing-satisfies-conjunction.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/reported-value-baseline-ground-truth.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/reported-value-post-replay-declared.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/safety-violated-unlimited-approval.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/source-value-and-consulted.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/success-conjunction-satisfied.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/state-predicate-evaluation/golden/time-bound-across-timewarp.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/sub-profile/adversarial/chain-depth-9.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/sub-profile/adversarial/closed-parent.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/sub-profile/adversarial/widening-subprofile.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/sub-profile/golden/family-chain.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/sub-profile/golden/valid-subprofile.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/swe-rebench-golden/golden/evaluation-spec.sealed.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/swe-rebench-golden/golden/expected.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/swe-rebench-golden/golden/row.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/swe-rebench-golden/golden/task.sealed.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/task-profile/adversarial/requirement-key-no-class.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/task-profile/adversarial/wrong-format-uri.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/task-profile/golden/minimal-profile.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/task-profile/golden/minimal-profile.sha256 | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/unscorable/adversarial/unknown-disposition.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/unscorable/golden/recorded-inconclusive.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/unscorable/golden/retryable-infra.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-consistency/adversarial/laundered-inconclusive.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-consistency/adversarial/undeclared-limitation.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-consistency/golden/consistent-pass.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/adversarial/malformed-decimal-string.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/adversarial/missing-measurement.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/adversarial/unknown-op.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/golden/all-combinator.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/golden/decimal-string-equality-canonical-scale.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/golden/fractional-decimal-string-threshold-fail.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/golden/fractional-decimal-string-threshold.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/golden/inconclusive-predicate.json | — | — | — |
| fixtures | @jinn-network/task-execution-profiles | packages/task-execution/profiles/fixtures/verdict-rule/golden/threshold-pass.json | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/binary-judgment/parsers/binary-accept-reject/1.0.0/semantics.json | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/binary-judgment/parsers/binary-accept-reject/1.0.0/semantics.sha256 | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/binary-judgment/parsers/binary-judgment-evaluation/1.0.0/semantics.json | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/binary-judgment/parsers/binary-judgment-evaluation/1.0.0/semantics.sha256 | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profile/v1/profile.json | — | — | https://spec.jinn.network/profiles/task-profile/v1 |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/binary-judgment/1.0/profile.json | — | — | https://spec.jinn.network/task-profiles/binary-judgment/1.0 |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/binary-judgment/1.0/profile.sha256 | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/evaluation-task/1.0/profile.json | — | — | https://spec.jinn.network/task-profiles/evaluation-task/1.0 |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/evaluation-task/1.0/profile.sha256 | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/prediction-forecast/1.0/profile.json | — | — | https://spec.jinn.network/task-profiles/prediction-forecast/1.0 |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/prediction-forecast/1.0/profile.sha256 | — | — | — |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/repository-work/1.0/profile.json | — | — | https://spec.jinn.network/task-profiles/repository-work/1.0 |
| profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/repository-work/1.0/profile.sha256 | — | — | — |
| conformance | @jinn-network/task-execution-profiles | packages/task-execution/profiles/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/contradictory-terminals/observations.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/digest-mismatch/claimed-digest.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/digest-mismatch/document.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/dispatch-context-grafting/grafted-dispatch-context.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/dispatch-context-grafting/NOTE.md | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/expired-then-late-terminal/fold-options.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/expired-then-late-terminal/log-with-terminal.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/expired-then-late-terminal/log-without-terminal.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/extension-override/task.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/forged-cross-attempt-supersedes/delivery-a.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/forged-cross-attempt-supersedes/delivery-b-forged-supersedes.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/idempotency-scopes/submission-a.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/idempotency-scopes/submission-b-same-key-different-bytes.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/idempotency-scopes/submission-c-different-requester-same-key.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/illegal-terminal-transition/observations.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/leaked-task-resubmission/confidential-task.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/leaked-task-resubmission/unauthorized-submission.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/lost-then-corrected/observations.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/malformed-document/task.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/manifest.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/oversized-content/oversized-observation.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/oversized-content/resource-descriptor.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/replayed-and-out-of-order/observations.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/adversarial-v1/sequence-boundary/observations.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/artifacts/patch.diff | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/conformance-report.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/equivalence/expected-digest.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/equivalence/task-a.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/equivalence/task-b.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/local/delivery.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/local/observations.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/local/submission.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/marketplace/delivery.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/marketplace/observations.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/marketplace/submission.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/golden-task-execution-v1/task.json | — | — | — |
| fixtures | @jinn-network/task-execution-protocol | packages/task-execution/protocol/fixtures/manifest.sha256.json | — | — | — |
| profiles | @jinn-network/task-execution-protocol | packages/task-execution/protocol/profiles/task-execution/v1/profile.json | — | — | https://spec.jinn.network/profiles/task-execution/v1 |
| schemas | @jinn-network/task-execution-protocol | packages/task-execution/protocol/schemas/delivery.schema.json | — | — | — |
| schemas | @jinn-network/task-execution-protocol | packages/task-execution/protocol/schemas/dispatch-context.schema.json | — | — | — |
| schemas | @jinn-network/task-execution-protocol | packages/task-execution/protocol/schemas/observation.schema.json | — | — | — |
| schemas | @jinn-network/task-execution-protocol | packages/task-execution/protocol/schemas/submission.schema.json | — | — | — |
| schemas | @jinn-network/task-execution-protocol | packages/task-execution/protocol/schemas/task.schema.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/cancellation-races.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/evidence-join.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/expected-digests.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/contradictory-terminals.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/dangling-intents.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/duplicate-nonces.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/rebuild-identity.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/seq-resumption.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/submission-segment-survival.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/torn-tail.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/journals/valid.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/reconciliation-table.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/result-interpretation.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/shim-contract.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/backend-local/workspace.json | — | — | — |
| fixtures | @jinn-network/task-execution-testing | packages/task-execution/testing/fixtures/manifest.sha256.json | — | — | — |
| conformance | @jinn-network/task-execution-testing | packages/task-execution/testing/src/index.ts | . | ./dist/index.d.ts<br>./dist/index.js | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/admission-receipt.dsse.json | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/evaluation-spec.json | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/manifest.json | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/README.md | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/requester.dsse.json | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/submission.json | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/task.json | — | — | — |
| fixtures | @jinn-network/task-admission | packages/task-supply/admission/fixtures/prediction-snapshot-v1/verification-key.json | — | — | — |
| conformance | @jinn-network/task-admission | packages/task-supply/admission/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/environment/approval-chain.sealed.json | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/environment/approval-record.sealed.json | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/environment/chain.sealed.json | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/environment/record.sealed.json | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/environment/record.source.json | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/approval-hygiene/evaluation-spec.bytes | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/approval-hygiene/pool-manifest.bytes | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/approval-hygiene/reference-script.digest | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/approval-hygiene/task.bytes | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/lending-lifecycle/evaluation-spec.bytes | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/lending-lifecycle/pool-manifest.bytes | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/lending-lifecycle/reference-script.digest | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/golden/lending-lifecycle/task.bytes | — | — | — |
| fixtures | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/fixtures/manifest.sha256.json | — | — | — |
| conformance | @jinn-network/chain-scenarios | packages/task-supply/chain-scenarios/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/task-curation | packages/task-supply/curation/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/task-curation | packages/task-supply/curation/fixtures/observations-bucket.json | — | — | — |
| fixtures | @jinn-network/task-curation | packages/task-supply/curation/fixtures/observations-golden.json | — | — | — |
| fixtures | @jinn-network/task-curation | packages/task-supply/curation/fixtures/observations-manipulation.json | — | — | — |
| fixtures | @jinn-network/task-curation | packages/task-supply/curation/fixtures/projection-golden.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/environment/record.sealed.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/golden/entries/09a3691084a1c71d3ab685cef843a2d2b9c8e8326740b1bfb9462da54376eca4/entry.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/golden/entries/09a3691084a1c71d3ab685cef843a2d2b9c8e8326740b1bfb9462da54376eca4/evaluation-spec.sealed.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/golden/entries/09a3691084a1c71d3ab685cef843a2d2b9c8e8326740b1bfb9462da54376eca4/task.sealed.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/golden/entries/e449237b49127daba416afa0626239530296eb551182f79f6aab06f0f5fbc2f2/entry.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/golden/entries/e449237b49127daba416afa0626239530296eb551182f79f6aab06f0f5fbc2f2/evaluation-spec.sealed.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/golden/entries/e449237b49127daba416afa0626239530296eb551182f79f6aab06f0f5fbc2f2/task.sealed.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/golden/summary.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/task-derivation | packages/task-supply/derivation/fixtures/rows/rows.json | — | — | — |
| conformance | @jinn-network/task-derivation | packages/task-supply/derivation/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/anchor-evidence-v1/expected-digests.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/anchor-evidence-v1/golden.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/ceremony-v1/eoa-siwe.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/ceremony-v1/recap.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/policy-chain-v1/genesis.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/policy-chain-v1/v2.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/policy-chain-v1/v3.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/sealing-v1/authorization.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/sealing-v1/expected-digests.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/sealing-v1/key-binding.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/sealing-v1/policy.json | — | — | — |
| fixtures | @jinn-network/trust-core | packages/trust/core/fixtures/sealing-v1/revocation.json | — | — | — |
| conformance | @jinn-network/trust-observation | packages/trust/observation/src/testing.ts | ./testing | ./dist/testing.d.ts<br>./dist/testing.js | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/adversarial-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/capture-provenance.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/cross-validation.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/kit-token-canonical.der | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/ots-stamp-provenance.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/real-stamp-v1-complete.ots | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/real-stamp-v1-pending.ots | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/token-digicert.der | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/anchor-kit-v1/token-sslcom.der | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/authorization-v1/example.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/authorization-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/binding-v1/example.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/binding-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/ceremony-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/consent-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/equivalence-v1/key-order-sensitive.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/equivalence-v1/shared-payload-bytes.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/equivalence-v1/task-execution-canonical-cases.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/equivalence-v1/task-execution-oracle-digests.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/equivalence-v1/trust-core-digests.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/join-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/manifest.sha256.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/policy-v1/example.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/policy-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/requester-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/resolution-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/revocation-v1/example.json | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/revocation-v1/README.md | — | — | — |
| fixtures | @jinn-network/trust-testing | packages/trust/testing/fixtures/walkthrough-v1/README.md | — | — | — |
| conformance | @jinn-network/trust-testing | packages/trust/testing/src/index.ts | . | ./dist/index.d.ts<br>./dist/index.js | — |

### Self-identifying `jinn.network` claims

| Identifier | Field | Kind | Package | Source |
| --- | --- | --- | --- | --- |
| https://spec.jinn.network/facts/authorization/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/authorization.v1.json |
| https://spec.jinn.network/facts/benchmark-accounting/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/benchmark-accounting.v1.json |
| https://spec.jinn.network/facts/benchmark-matrix/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/matrix.v1.json |
| https://spec.jinn.network/facts/benchmark-report/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/report.v1.json |
| https://spec.jinn.network/facts/benchmark-report/v2 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/report.v2.json |
| https://spec.jinn.network/facts/benchmark-run/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/run.v1.json |
| https://spec.jinn.network/facts/benchmark/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/benchmark.v1.json |
| https://spec.jinn.network/facts/chain-environment/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-chain-environments | packages/discovery/facts/chain-environments/profiles/chain-environment.v1.json |
| https://spec.jinn.network/facts/checkpoint/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/checkpoint.v1.json |
| https://spec.jinn.network/facts/crypto-environment/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-chain-environments | packages/discovery/facts/chain-environments/profiles/crypto-environment.v1.json |
| https://spec.jinn.network/facts/delivery/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/delivery.v1.json |
| https://spec.jinn.network/facts/environment/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-environments | packages/discovery/facts/environments/profiles/environment.v1.json |
| https://spec.jinn.network/facts/evaluation-spec/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/evaluation-spec.v1.json |
| https://spec.jinn.network/facts/execution-evidence/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-evidence.v1.json |
| https://spec.jinn.network/facts/execution-evidence/v2 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-evidence.v2.json |
| https://spec.jinn.network/facts/execution-verification/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-verification.v1.json |
| https://spec.jinn.network/facts/information-world/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-chain-environments | packages/discovery/facts/chain-environments/profiles/information-world.v1.json |
| https://spec.jinn.network/facts/key-binding/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/key-binding.v1.json |
| https://spec.jinn.network/facts/plugin/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/plugin.v1.json |
| https://spec.jinn.network/facts/profile-document/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/profile-document.v1.json |
| https://spec.jinn.network/facts/result-evaluation/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/result-evaluation.v1.json |
| https://spec.jinn.network/facts/result-evaluation/v2 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/result-evaluation.v2.json |
| https://spec.jinn.network/facts/submission/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/submission.v1.json |
| https://spec.jinn.network/facts/task/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/task.v1.json |
| https://spec.jinn.network/facts/trust-policy/v1 | `profile` | profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/trust-policy.v1.json |
| https://spec.jinn.network/profiles/evidence-repository-ipfs-registration/v1/registration.schema.json | `$id` | profiles | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/registration.schema.json |
| https://spec.jinn.network/profiles/evidence-repository-oci/v1/schemas/evidence-oci-manifest.schema.json | `$id` | schemas | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/profiles/evidence-repository-oci/v1/schemas/evidence-oci-manifest.schema.json |
| https://spec.jinn.network/profiles/execution-evidence/v1/schemas/dsse-envelope.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/dsse-envelope.schema.json |
| https://spec.jinn.network/profiles/execution-evidence/v1/schemas/execution-evidence-document.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/execution-evidence-document.schema.json |
| https://spec.jinn.network/profiles/execution-evidence/v1/schemas/execution-verification-statement.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/execution-verification-statement.schema.json |
| https://spec.jinn.network/profiles/execution-evidence/v1/schemas/resource-descriptor.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/resource-descriptor.schema.json |
| https://spec.jinn.network/profiles/execution-evidence/v1/schemas/result-evaluation-statement.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/v1/schemas/result-evaluation-statement.schema.json |
| https://spec.jinn.network/profiles/task-execution/v1 | `profile` | profiles | @jinn-network/task-execution-protocol | packages/task-execution/protocol/profiles/task-execution/v1/profile.json |
| https://spec.jinn.network/profiles/task-profile/v1 | `profile` | profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profile/v1/profile.json |
| https://spec.jinn.network/profiles/trace-vocabulary/v1 | `profile` | profiles | @jinn-network/evidence-trace | packages/evidence/trace/profiles/trace-vocabulary/v1/profile.json |
| https://spec.jinn.network/schemas/chain-environment/v1 | `$id` | schemas | @jinn-network/chain-environment-record | packages/environments/chain-record/schemas/chain-environment.schema.json |
| https://spec.jinn.network/schemas/crypto-environment/v1 | `$id` | schemas | @jinn-network/chain-environment-record | packages/environments/chain-record/schemas/crypto-environment.schema.json |
| https://spec.jinn.network/schemas/environment/v1 | `$id` | schemas | @jinn-network/environment-record | packages/environments/record/schemas/environment.schema.json |
| https://spec.jinn.network/schemas/information-world/v1 | `$id` | schemas | @jinn-network/information-world | packages/environments/information-world/schemas/information-world.schema.json |
| https://spec.jinn.network/schemas/trace-derivation-statement/v1 | `$id` | schemas | @jinn-network/evidence-trace | packages/evidence/trace/schemas/trace-derivation-statement.schema.json |
| https://spec.jinn.network/schemas/trace/v1 | `$id` | schemas | @jinn-network/evidence-trace | packages/evidence/trace/schemas/trace.schema.json |
| https://spec.jinn.network/task-profiles/binary-judgment/1.0 | `profile` | profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/binary-judgment/1.0/profile.json |
| https://spec.jinn.network/task-profiles/evaluation-task/1.0 | `profile` | profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/evaluation-task/1.0/profile.json |
| https://spec.jinn.network/task-profiles/prediction-forecast/1.0 | `profile` | profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/prediction-forecast/1.0/profile.json |
| https://spec.jinn.network/task-profiles/repository-work/1.0 | `profile` | profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/repository-work/1.0/profile.json |

## Architecture-control ownership

Task 6's validator reports 3825 controlled paths. Required effective owners: `@oaksprout` `@ritsukai`.
The exhaustive path-level input and coverage report is the `ownership` object in [`platform-topology.v1.json`](./platform-topology.v1.json); this human view keeps its deterministic category summary.

| Category | Controlled paths |
| --- | ---: |
| authorityDocuments | 32 |
| boundaryPolicies | 26 |
| catalogManifests | 97 |
| catalogPublicSurfaces | 1329 |
| catalogSchema | 2 |
| conformancePackedTargets | 62 |
| conformanceSources | 31 |
| decisionRecords | 5 |
| discoveredFirstPartySurfaces | 2995 |
| generatedOutputSources | 1391 |
| generatorSources | 659 |
| marketplaceControl | 2 |
| requiredGates | 25 |
| staticControl | 6 |

## Transitional and deprecated entries

| Package | Path | Stability | Release | Supersedes | Replaced by | Status | Reason | Sunset condition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| @jinn-network/operator | operator | transitional | legacy-product-lines / independent | — | — | independently published during recomposition | The operator is being recomposed onto cataloged platform applications. | The operator-daemon cutover is complete and the legacy release coupling is retired. |
| @jinn-network/autopilot | packages/autopilot | transitional | transitional-or-private / private | — | — | removal tracked | Autopilot has been extracted to Jinn-Network/autopilot; this package is vendored residue. | The monorepo no longer needs the vendored copy. |
| @jinn-network/core | packages/core | transitional | legacy-product-lines / independent | — | — | independently published during cutover | The legacy kernel overlaps evidence applications and the plugin product stack. | Operator and plugin cutovers no longer import @jinn-network/core. |
| @jinn-network/indexer | packages/indexer | transitional | transitional-or-private / never | — | — | logical split required | The package mixes platform projector and product explorer responsibilities. | The projector is re-derived onto the platform and the explorer remains a tier-4 product. |
| @jinn-network/indexer-enrichment | packages/indexer-enrichment | transitional | transitional-or-private / never | — | — | re-derive with the read plane | The worker remains coupled to the legacy indexer service boundary. | The indexer projector is re-derived onto the platform and the read-plane boundary is settled. |
| @jinn-network/jinn-layer | packages/layer | transitional | legacy-product-lines / independent | — | — | independently published during cutover | The legacy local runtime overlaps platform evidence and task-execution applications. | Plugin and operator cutovers no longer resolve @jinn-network/jinn-layer. |
| @jinn-network/marketplace-pipeline | packages/marketplace/pipeline | transitional | legacy-product-lines / independent | — | @jinn-network/marketplace-binding<br>@jinn-network/task-execution-backend | deprecated legacy compatibility surface with a frozen consumer allowlist | The package combines legacy claim, spend, wiring and orchestration policy that native tier-4 composition now owns. | The operator defaults to the exact-head proven native vertical, legacy pipeline usage is zero for the approved observation window, and deletion tests find no remaining importer or invocation. |
| @jinn-network/plugin | packages/plugin | transitional | legacy-product-lines / independent | — | — | independently published during cutover | The legacy extension contract is being reconciled with the product plugin boundary. | The plugin product cutover no longer imports this legacy line. |
| @jinn-network/sdk | packages/sdk | deprecated | legacy-product-lines / independent | — | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | independent compatibility line | Platform record families supersede the legacy SolverNet SDK surfaces. | Daemon and marketplace-surface migrations have removed every live importer. |
