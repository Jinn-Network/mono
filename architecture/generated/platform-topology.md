<!-- GENERATED FILE — DO NOT EDIT. Run: node .github/scripts/generate-architecture.mjs -->

# Generated platform topology

Source authority: [`architecture/platform-packages.v1.json`](../platform-packages.v1.json) and each cataloged package manifest.

## Inventory

The catalog contains **69** entries: **50** `platform-v1` packages, **7** disabled `experimental-environment-supply` packages, **8** other entries below `packages/**`, and **4** adjacent entries.

| Package | Path | Domain | Tier | Classification | Role | Stability | Release group | Publish policy | Runtime dependencies | Optional dependencies | Peer dependencies |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| @jinn-network/broadcast-bot | apps/broadcast-bot | repository-operations | — | repository-tooling | repository and community communications automation | stable-semantics | transitional-or-private | never | smol-toml<br>twitter-api-v2<br>viem<br>zod | — | — |
| @jinn-network/client | client | operator | 4 | product | operator daemon and application | transitional | legacy-product-lines | independent | @ethereumjs/wallet<br>@grpc/grpc-js<br>@hono/node-server<br>@huggingface/transformers<br>@jinn-network/core<br>@jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-local-runtime<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-pipeline<br>@jinn-network/marketplace-projector<br>@jinn-network/marketplace-venue-base<br>@jinn-network/plugin<br>@jinn-network/record-discovery-client<br>@jinn-network/record-discovery-facts-task-execution<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/record-discovery-transport-http<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve<br>@lmoe/gliner-onnx<br>@modelcontextprotocol/sdk<br>@msgpack/msgpack<br>@noble/curves<br>@noble/ed25519<br>@noble/hashes<br>@opentelemetry/api<br>@opentelemetry/core<br>@opentelemetry/exporter-trace-otlp-grpc<br>@opentelemetry/exporter-trace-otlp-http<br>@opentelemetry/resources<br>@opentelemetry/sdk-node<br>@opentelemetry/sdk-trace-base<br>@safe-global/protocol-kit<br>@safe-global/safe-deployments<br>@safe-global/types-kit<br>@scure/bip32<br>@scure/bip39<br>@secretlint/core<br>@secretlint/secretlint-rule-preset-recommend<br>@slicekit/erc8128<br>@types/better-sqlite3<br>@x402/core<br>@x402/evm<br>@x402/fetch<br>@x402/hono<br>ajv<br>ajv-formats<br>better-sqlite3<br>bs58<br>canonicalize<br>chokidar<br>dotenv<br>hono<br>node-pty<br>protobufjs<br>safe-regex<br>semver<br>tokenlens<br>viem<br>ws<br>yaml<br>zod | @coinbase/cdp-sdk | — |
| @jinn-network/operator-spa | client/src/dashboard/spa | operator | 4 | product | operator dashboard product | candidate | transitional-or-private | private | @hookform/resolvers<br>@radix-ui/react-alert-dialog<br>@radix-ui/react-dialog<br>@radix-ui/react-dropdown-menu<br>@radix-ui/react-label<br>@radix-ui/react-popover<br>@radix-ui/react-progress<br>@radix-ui/react-radio-group<br>@radix-ui/react-scroll-area<br>@radix-ui/react-slot<br>@radix-ui/react-switch<br>@radix-ui/react-tabs<br>@radix-ui/react-tooltip<br>@tanstack/react-query<br>@tanstack/react-table<br>class-variance-authority<br>clsx<br>html-to-image<br>lucide-react<br>react<br>react-dom<br>react-hook-form<br>sonner<br>tailwind-merge<br>tailwindcss-animate<br>wouter<br>xterm<br>xterm-addon-fit<br>xterm-addon-web-links<br>zod | — | — |
| @jinn-network/autopilot | packages/autopilot | autopilot | 4 | transitional | vendored tier-4 product residue | transitional | transitional-or-private | private | @jinn-network/sdk<br>zod | — | — |
| @jinn-network/benchmarking-aggregate | packages/benchmarking/aggregate | benchmarking | 3 | platform | aggregation capability | candidate | platform-v1 | canary-only | @jinn-network/benchmarking-records<br>@jinn-network/trust-core | — | — |
| @jinn-network/benchmarking-interop | packages/benchmarking/interop | benchmarking | 3 | platform | task-execution import and export | candidate | platform-v1 | canary-only | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/benchmarking-marketplace | packages/benchmarking/marketplace | benchmarking | 3 | platform | marketplace adapter | candidate | platform-v1 | canary-only | @jinn-network/benchmarking-records<br>@jinn-network/benchmarking-run<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/benchmarking-records | packages/benchmarking/records | benchmarking | 2 | platform | benchmark record family | candidate | platform-v1 | canary-only | @jinn-network/task-execution-protocol<br>@noble/hashes<br>zod | — | — |
| @jinn-network/benchmarking-run | packages/benchmarking/run | benchmarking | 3 | platform | benchmark orchestration | candidate | platform-v1 | canary-only | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/benchmarking-testing | packages/benchmarking/testing | benchmarking | — | platform-support | benchmarking conformance kit | candidate | platform-v1 | canary-only | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | vitest |
| @jinn-network/core | packages/core | legacy-plugin-stack | — | legacy | legacy product-support kernel | transitional | legacy-product-lines | independent | @huggingface/transformers<br>@jinn-network/plugin<br>@lmoe/gliner-onnx<br>@noble/hashes<br>@secretlint/core<br>@secretlint/secretlint-rule-preset-recommend<br>better-sqlite3<br>canonicalize<br>zod | — | vitest |
| @jinn-network/record-discovery-client | packages/discovery/client | discovery | 3 | platform | discovery client and resolution | candidate | platform-v1 | canary-only | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core<br>zod | — | — |
| @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking | discovery | 3 | platform | benchmarking facts projection | candidate | platform-v1 | canary-only | @jinn-network/benchmarking-records<br>@jinn-network/record-discovery-protocol | — | — |
| @jinn-network/record-discovery-facts-environments | packages/discovery/facts/environments | environments | 3 | platform | experimental environment facts projection | experimental | experimental-environment-supply | disabled | @jinn-network/environment-record<br>@jinn-network/record-discovery-protocol | — | — |
| @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence | discovery | 3 | platform | evidence facts projection | candidate | platform-v1 | canary-only | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-protocol<br>zod | — | — |
| @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution | discovery | 3 | platform | task-execution facts projection | candidate | platform-v1 | canary-only | @jinn-network/record-discovery-protocol<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>zod | — | — |
| @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust | discovery | 3 | platform | trust facts projection | candidate | platform-v1 | canary-only | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core<br>zod | — | — |
| @jinn-network/record-discovery-protocol | packages/discovery/protocol | discovery | 1 | platform | record-discovery protocol | candidate | platform-v1 | canary-only | @jinn-network/trust-core<br>@noble/hashes<br>zod | — | — |
| @jinn-network/record-discovery-serve | packages/discovery/serve | discovery | 3 | platform | discovery serving contract | candidate | platform-v1 | canary-only | @jinn-network/record-discovery-protocol<br>zod | — | — |
| @jinn-network/record-discovery-source-evidence-journal | packages/discovery/sources/evidence-journal | discovery | 3 | platform | evidence-journal source adapter | candidate | platform-v1 | canary-only | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>zod | — | — |
| @jinn-network/record-discovery-testing | packages/discovery/testing | discovery | — | platform-support | record-discovery conformance kit | candidate | platform-v1 | canary-only | @jinn-network/record-discovery-protocol<br>zod | — | vitest |
| @jinn-network/record-discovery-transport-http | packages/discovery/transport-http | discovery | 3 | platform | HTTP discovery transport | candidate | platform-v1 | canary-only | @jinn-network/record-discovery-client<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve | — | — |
| @jinn-network/environment-record | packages/environments/record | environments | 2 | platform | environment record family | experimental | experimental-environment-supply | disabled | @noble/hashes<br>zod | — | vitest |
| @jinn-network/environment-verification | packages/environments/verification | environments | 3 | platform | environment verification capability | experimental | experimental-environment-supply | disabled | @jinn-network/environment-record<br>@jinn-network/trust-core<br>zod | — | vitest |
| @jinn-network/attestation-issuer | packages/evidence/attestation-issuer | evidence | 3 | platform | attestation issuance capability | candidate | platform-v1 | canary-only | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository | — | vitest |
| @jinn-network/evidence-catalog-sqlite | packages/evidence/catalog-sqlite | evidence | 3 | platform | SQLite evidence catalog binding | candidate | platform-v1 | canary-only | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>better-sqlite3 | — | — |
| @jinn-network/evidence-contribution | packages/evidence/contribution | evidence | 3 | platform | evidence contribution composition | candidate | platform-v1 | canary-only | @jinn-network/evidence-derivation<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-publication<br>@jinn-network/evidence-repository<br>canonicalize | — | vitest |
| @jinn-network/evidence-derivation | packages/evidence/derivation | evidence | 3 | platform | evidence derivation capability | candidate | platform-v1 | canary-only | @jinn-network/evidence-protocol<br>@noble/hashes<br>@secretlint/core<br>@secretlint/secretlint-rule-preset-recommend<br>canonicalize<br>zod | — | vitest |
| @jinn-network/evidence-discovery | packages/evidence/discovery | evidence | 3 | platform | evidence discovery contract | candidate | platform-v1 | canary-only | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository | — | vitest |
| @jinn-network/execution-recorder | packages/evidence/execution-recorder | evidence | 3 | platform | execution recording capability | candidate | platform-v1 | canary-only | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository | — | vitest |
| @jinn-network/execution-recorder-bridge | packages/evidence/execution-recorder-bridge | evidence | 3 | platform | execution-recorder integration bridge | candidate | platform-v1 | canary-only | @jinn-network/evidence-repository<br>@jinn-network/execution-recorder | — | — |
| @jinn-network/evidence-local-runtime | packages/evidence/local-runtime | evidence | 3 | platform | local evidence composition | candidate | platform-v1 | canary-only | @jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>better-sqlite3 | — | — |
| @jinn-network/evidence-protocol | packages/evidence/protocol | evidence | 1 | platform | execution-evidence protocol | candidate | platform-v1 | canary-only | @noble/hashes<br>zod | — | — |
| @jinn-network/evidence-publication | packages/evidence/publication | evidence | 3 | platform | evidence publication capability | candidate | platform-v1 | canary-only | @jinn-network/evidence-repository | — | vitest |
| @jinn-network/evidence-repository | packages/evidence/repository | evidence | 3 | platform | evidence repository contract | candidate | platform-v1 | canary-only | @jinn-network/evidence-protocol | — | vitest |
| @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs | evidence | 3 | platform | IPFS evidence repository binding | candidate | platform-v1 | canary-only | @jinn-network/evidence-repository<br>kubo-rpc-client | — | — |
| @jinn-network/evidence-repository-oci | packages/evidence/repository-oci | evidence | 3 | platform | OCI evidence repository binding | candidate | platform-v1 | canary-only | @jinn-network/evidence-repository<br>canonicalize | — | — |
| @jinn-network/evidence-retrieval | packages/evidence/retrieval | evidence | 3 | platform | evidence retrieval capability | candidate | platform-v1 | canary-only | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository | — | vitest |
| @jinn-network/evidence-trace-decode | packages/evidence/trace-decode | evidence | 3 | platform | evidence trace decoder | candidate | platform-v1 | canary-only | @jinn-network/evidence-trajectory | — | vitest |
| @jinn-network/evidence-trajectory | packages/evidence/trajectory | evidence | 2 | platform | trajectory record family | candidate | platform-v1 | canary-only | @jinn-network/evidence-protocol<br>@jinn-network/trust-core<br>@noble/hashes<br>ajv<br>zod | — | vitest |
| @jinn-network/indexer | packages/indexer | read-plane | — | transitional | transitional projector and product mixture | transitional | transitional-or-private | never | @hono/node-server<br>@jinn-network/benchmarking-records<br>drizzle-orm<br>hono<br>ponder<br>viem | — | — |
| @jinn-network/indexer-enrichment | packages/indexer-enrichment | read-plane | — | transitional | transitional indexer enrichment worker | transitional | transitional-or-private | never | @jinn-network/indexer<br>drizzle-orm<br>pg | — | — |
| @jinn-network/explorer-spa | packages/indexer/explorer | read-plane | 4 | product | network explorer product | candidate | transitional-or-private | private | @tanstack/react-query<br>clsx<br>react<br>react-dom<br>uplot<br>wouter | — | — |
| @jinn-network/jinn-layer | packages/layer | legacy-plugin-stack | — | legacy | legacy product composition and local runtime | transitional | legacy-product-lines | independent | @jinn-network/core<br>@jinn-network/plugin<br>@modelcontextprotocol/sdk<br>better-sqlite3<br>canonicalize<br>viem<br>yaml<br>zod | — | — |
| @jinn-network/marketplace-binding | packages/marketplace/binding | marketplace | 3 | platform | venue-neutral marketplace binding | candidate | platform-v1 | canary-only | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve<br>@noble/hashes<br>viem<br>zod | — | — |
| @jinn-network/marketplace-pipeline | packages/marketplace/pipeline | marketplace | 3 | platform | marketplace pipeline composition | candidate | platform-v1 | canary-only | @jinn-network/marketplace-binding<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/marketplace-projector | packages/marketplace/projector | marketplace | 3 | platform | marketplace discovery projection | candidate | platform-v1 | canary-only | @jinn-network/marketplace-binding<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-protocol<br>@noble/hashes<br>viem | — | — |
| @jinn-network/marketplace-testing | packages/marketplace/testing | marketplace | — | platform-support | marketplace conformance kit | candidate | platform-v1 | canary-only | @jinn-network/evidence-protocol<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/marketplace-venue-base<br>@jinn-network/record-discovery-testing<br>@jinn-network/task-execution-testing<br>@jinn-network/trust-testing<br>viem | — | vitest |
| @jinn-network/marketplace-venue-base | packages/marketplace/venue-base | marketplace | 3 | platform | Base venue adapter | candidate | platform-v1 | canary-only | @jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-protocol<br>@types/better-sqlite3<br>better-sqlite3<br>viem | — | — |
| @jinn-network/plugin | packages/plugin | legacy-plugin-stack | — | legacy | legacy extension contract | transitional | legacy-product-lines | independent | zod | — | vitest |
| @jinn-network/sdk | packages/sdk | legacy-sdk | — | legacy | deprecated SolverNet SDK | deprecated | legacy-product-lines | independent | zod<br>zod-to-json-schema | — | — |
| @jinn-network/task-execution-backend | packages/task-execution/backend | task-execution | 3 | platform | backend contract | candidate | platform-v1 | canary-only | @jinn-network/task-execution-protocol | — | — |
| @jinn-network/task-execution-backend-local | packages/task-execution/backend-local/assembly | task-execution | 3 | platform | local backend assembly | candidate | platform-v1 | canary-only | @jinn-network/evidence-discovery<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | — |
| @jinn-network/task-execution-launchers | packages/task-execution/backend-local/launchers | task-execution | 3 | platform | launch planning capability | candidate | platform-v1 | canary-only | @jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | — |
| @jinn-network/task-execution-supervisor | packages/task-execution/backend-local/supervisor | task-execution | 3 | platform | execution supervision capability | candidate | platform-v1 | canary-only | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/task-execution-workspace | packages/task-execution/backend-local/workspace | task-execution | 3 | platform | workspace preparation capability | candidate | platform-v1 | canary-only | @jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | — | — |
| @jinn-network/task-execution-evaluation-harness | packages/task-execution/evaluation-harness | task-execution | 3 | platform | evaluation orchestration capability | candidate | platform-v1 | canary-only | @jinn-network/attestation-issuer<br>@jinn-network/evidence-protocol<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | — |
| @jinn-network/task-execution-evaluator-adapters | packages/task-execution/evaluator-adapters | task-execution | 3 | platform | evaluator adapters | candidate | platform-v1 | canary-only | @jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-supervisor | — | — |
| @jinn-network/task-execution-profiles | packages/task-execution/profiles | task-execution | 1 | platform | task profile family | candidate | platform-v1 | canary-only | @jinn-network/task-execution-protocol<br>@noble/hashes<br>ajv<br>safe-regex<br>zod | — | — |
| @jinn-network/task-execution-protocol | packages/task-execution/protocol | task-execution | 1 | platform | task-execution protocol | candidate | platform-v1 | canary-only | @noble/hashes<br>zod | — | — |
| @jinn-network/task-execution-testing | packages/task-execution/testing | task-execution | — | platform-support | task-execution conformance kit | candidate | platform-v1 | canary-only | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace | — | vitest |
| @jinn-network/task-admission | packages/task-supply/admission | task-supply | 3 | platform | task admission capability | experimental | experimental-environment-supply | disabled | @jinn-network/environment-record<br>@jinn-network/trust-core<br>zod | — | vitest |
| @jinn-network/task-curation | packages/task-supply/curation | task-supply | 3 | platform | task curation projection | experimental | experimental-environment-supply | disabled | zod | — | — |
| @jinn-network/task-derivation | packages/task-supply/derivation | task-supply | 3 | platform | task derivation capability | experimental | experimental-environment-supply | disabled | @jinn-network/environment-record<br>@jinn-network/task-admission<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@noble/hashes<br>zod | — | vitest |
| @jinn-network/task-posting | packages/task-supply/posting | task-supply | 3 | platform | task posting capability | experimental | experimental-environment-supply | disabled | @jinn-network/marketplace-binding<br>@jinn-network/task-derivation<br>@jinn-network/task-execution-protocol<br>viem | — | — |
| @jinn-network/trust-core | packages/trust/core | trust | 1 | platform | trust records and policy | candidate | platform-v1 | canary-only | @noble/curves<br>@noble/hashes<br>zod | — | — |
| @jinn-network/trust-resolve | packages/trust/resolve | trust | 3 | platform | trust resolution binding | candidate | platform-v1 | canary-only | @jinn-network/trust-core<br>viem | — | — |
| @jinn-network/trust-testing | packages/trust/testing | trust | — | platform-support | trust conformance kit | candidate | platform-v1 | canary-only | @jinn-network/trust-core<br>@jinn-network/trust-resolve<br>@noble/curves<br>@noble/hashes | — | vitest |
| @jinn-network/plugin-runtime | plugin/runtime | plugin-product | — | product-support | unpublished plugin product support runtime | candidate | transitional-or-private | never | @jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-derivation<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-local-runtime<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/evidence-retrieval<br>@jinn-network/evidence-trace-decode<br>@jinn-network/evidence-trajectory<br>@jinn-network/execution-recorder<br>@jinn-network/record-discovery-client<br>@jinn-network/record-discovery-protocol<br>@jinn-network/trust-core<br>@modelcontextprotocol/sdk<br>better-sqlite3<br>zod | — | — |

## Runtime dependency topology

Only `dependencies`, `optionalDependencies`, and `peerDependencies` contribute edges. `devDependencies` never affect closure or publication order.

| From | Kind | To |
| --- | --- | --- |
| @jinn-network/attestation-issuer | runtime | @jinn-network/evidence-protocol |
| @jinn-network/attestation-issuer | runtime | @jinn-network/evidence-repository |
| @jinn-network/autopilot | runtime | @jinn-network/sdk |
| @jinn-network/benchmarking-aggregate | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-aggregate | runtime | @jinn-network/trust-core |
| @jinn-network/benchmarking-interop | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-interop | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/benchmarking-interop | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/benchmarking-run |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/marketplace-binding |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/marketplace-projector |
| @jinn-network/benchmarking-marketplace | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-records | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-run | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-run | runtime | @jinn-network/task-execution-backend |
| @jinn-network/benchmarking-run | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/benchmarking-run | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-testing | runtime | @jinn-network/benchmarking-records |
| @jinn-network/benchmarking-testing | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/benchmarking-testing | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/client | runtime | @jinn-network/core |
| @jinn-network/client | runtime | @jinn-network/evidence-catalog-sqlite |
| @jinn-network/client | runtime | @jinn-network/evidence-discovery |
| @jinn-network/client | runtime | @jinn-network/evidence-local-runtime |
| @jinn-network/client | runtime | @jinn-network/evidence-protocol |
| @jinn-network/client | runtime | @jinn-network/evidence-repository |
| @jinn-network/client | runtime | @jinn-network/execution-recorder |
| @jinn-network/client | runtime | @jinn-network/marketplace-binding |
| @jinn-network/client | runtime | @jinn-network/marketplace-pipeline |
| @jinn-network/client | runtime | @jinn-network/marketplace-projector |
| @jinn-network/client | runtime | @jinn-network/marketplace-venue-base |
| @jinn-network/client | runtime | @jinn-network/plugin |
| @jinn-network/client | runtime | @jinn-network/record-discovery-client |
| @jinn-network/client | runtime | @jinn-network/record-discovery-facts-task-execution |
| @jinn-network/client | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/client | runtime | @jinn-network/record-discovery-serve |
| @jinn-network/client | runtime | @jinn-network/record-discovery-transport-http |
| @jinn-network/client | runtime | @jinn-network/task-execution-backend |
| @jinn-network/client | runtime | @jinn-network/task-execution-backend-local |
| @jinn-network/client | runtime | @jinn-network/task-execution-launchers |
| @jinn-network/client | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/client | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/client | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/client | runtime | @jinn-network/task-execution-workspace |
| @jinn-network/client | runtime | @jinn-network/trust-core |
| @jinn-network/client | runtime | @jinn-network/trust-resolve |
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
| @jinn-network/evidence-publication | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-repository | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-repository-ipfs | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-repository-oci | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-retrieval | runtime | @jinn-network/evidence-discovery |
| @jinn-network/evidence-retrieval | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-retrieval | runtime | @jinn-network/evidence-repository |
| @jinn-network/evidence-trace-decode | runtime | @jinn-network/evidence-trajectory |
| @jinn-network/evidence-trajectory | runtime | @jinn-network/evidence-protocol |
| @jinn-network/evidence-trajectory | runtime | @jinn-network/trust-core |
| @jinn-network/execution-recorder | runtime | @jinn-network/evidence-protocol |
| @jinn-network/execution-recorder | runtime | @jinn-network/evidence-repository |
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
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-catalog-sqlite |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-derivation |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-discovery |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-local-runtime |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-protocol |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-repository |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-retrieval |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-trace-decode |
| @jinn-network/plugin-runtime | runtime | @jinn-network/evidence-trajectory |
| @jinn-network/plugin-runtime | runtime | @jinn-network/execution-recorder |
| @jinn-network/plugin-runtime | runtime | @jinn-network/record-discovery-client |
| @jinn-network/plugin-runtime | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/plugin-runtime | runtime | @jinn-network/trust-core |
| @jinn-network/record-discovery-client | runtime | @jinn-network/record-discovery-protocol |
| @jinn-network/record-discovery-client | runtime | @jinn-network/trust-core |
| @jinn-network/record-discovery-facts-benchmarking | runtime | @jinn-network/benchmarking-records |
| @jinn-network/record-discovery-facts-benchmarking | runtime | @jinn-network/record-discovery-protocol |
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
| @jinn-network/task-admission | runtime | @jinn-network/environment-record |
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
| @jinn-network/task-execution-evaluator-adapters | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-profiles |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-supervisor |
| @jinn-network/task-execution-launchers | runtime | @jinn-network/task-execution-workspace |
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
| @jinn-network/task-posting | runtime | @jinn-network/task-derivation |
| @jinn-network/task-posting | runtime | @jinn-network/task-execution-protocol |
| @jinn-network/trust-resolve | runtime | @jinn-network/trust-core |
| @jinn-network/trust-testing | runtime | @jinn-network/trust-core |
| @jinn-network/trust-testing | runtime | @jinn-network/trust-resolve |

### `platform-v1` runtime waves

1. `@jinn-network/evidence-protocol`, `@jinn-network/task-execution-protocol`, `@jinn-network/trust-core`
2. `@jinn-network/benchmarking-records`, `@jinn-network/evidence-derivation`, `@jinn-network/evidence-repository`, `@jinn-network/evidence-trajectory`, `@jinn-network/record-discovery-protocol`, `@jinn-network/task-execution-backend`, `@jinn-network/task-execution-profiles`, `@jinn-network/trust-resolve`
3. `@jinn-network/attestation-issuer`, `@jinn-network/benchmarking-aggregate`, `@jinn-network/benchmarking-interop`, `@jinn-network/benchmarking-run`, `@jinn-network/benchmarking-testing`, `@jinn-network/evidence-discovery`, `@jinn-network/evidence-publication`, `@jinn-network/evidence-repository-ipfs`, `@jinn-network/evidence-repository-oci`, `@jinn-network/evidence-trace-decode`, `@jinn-network/execution-recorder`, `@jinn-network/marketplace-binding`, `@jinn-network/record-discovery-client`, `@jinn-network/record-discovery-facts-benchmarking`, `@jinn-network/record-discovery-facts-task-execution`, `@jinn-network/record-discovery-facts-trust`, `@jinn-network/record-discovery-serve`, `@jinn-network/record-discovery-testing`, `@jinn-network/task-execution-supervisor`, `@jinn-network/task-execution-workspace`, `@jinn-network/trust-testing`
4. `@jinn-network/evidence-catalog-sqlite`, `@jinn-network/evidence-contribution`, `@jinn-network/evidence-retrieval`, `@jinn-network/execution-recorder-bridge`, `@jinn-network/marketplace-projector`, `@jinn-network/record-discovery-facts-evidence`, `@jinn-network/record-discovery-source-evidence-journal`, `@jinn-network/record-discovery-transport-http`, `@jinn-network/task-execution-launchers`
5. `@jinn-network/benchmarking-marketplace`, `@jinn-network/evidence-local-runtime`, `@jinn-network/marketplace-venue-base`, `@jinn-network/task-execution-backend-local`, `@jinn-network/task-execution-evaluation-harness`
6. `@jinn-network/marketplace-pipeline`, `@jinn-network/task-execution-evaluator-adapters`, `@jinn-network/task-execution-testing`
7. `@jinn-network/marketplace-testing`

### `platform-v1` transitive closure

| Package | Runtime closure |
| --- | --- |
| @jinn-network/attestation-issuer | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/benchmarking-aggregate | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core |
| @jinn-network/benchmarking-interop | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-marketplace | @jinn-network/benchmarking-records<br>@jinn-network/benchmarking-run<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve |
| @jinn-network/benchmarking-records | @jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-run | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol |
| @jinn-network/benchmarking-testing | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol |
| @jinn-network/evidence-catalog-sqlite | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-contribution | @jinn-network/evidence-derivation<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-publication<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-derivation | @jinn-network/evidence-protocol |
| @jinn-network/evidence-discovery | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-local-runtime | @jinn-network/evidence-catalog-sqlite<br>@jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-protocol | — |
| @jinn-network/evidence-publication | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-repository | @jinn-network/evidence-protocol |
| @jinn-network/evidence-repository-ipfs | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-repository-oci | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-retrieval | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/evidence-trace-decode | @jinn-network/evidence-protocol<br>@jinn-network/evidence-trajectory<br>@jinn-network/trust-core |
| @jinn-network/evidence-trajectory | @jinn-network/evidence-protocol<br>@jinn-network/trust-core |
| @jinn-network/execution-recorder | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository |
| @jinn-network/execution-recorder-bridge | @jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder |
| @jinn-network/marketplace-binding | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve |
| @jinn-network/marketplace-pipeline | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder<br>@jinn-network/marketplace-binding<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve |
| @jinn-network/marketplace-projector | @jinn-network/marketplace-binding<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve |
| @jinn-network/marketplace-testing | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder<br>@jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/marketplace-venue-base<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/record-discovery-testing<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-testing<br>@jinn-network/task-execution-workspace<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve<br>@jinn-network/trust-testing |
| @jinn-network/marketplace-venue-base | @jinn-network/marketplace-binding<br>@jinn-network/marketplace-projector<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core<br>@jinn-network/trust-resolve |
| @jinn-network/record-discovery-client | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-facts-benchmarking | @jinn-network/benchmarking-records<br>@jinn-network/record-discovery-protocol<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-facts-evidence | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-facts-task-execution | @jinn-network/record-discovery-protocol<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-facts-trust | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-protocol | @jinn-network/trust-core |
| @jinn-network/record-discovery-serve | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-source-evidence-journal | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-testing | @jinn-network/record-discovery-protocol<br>@jinn-network/trust-core |
| @jinn-network/record-discovery-transport-http | @jinn-network/record-discovery-client<br>@jinn-network/record-discovery-protocol<br>@jinn-network/record-discovery-serve<br>@jinn-network/trust-core |
| @jinn-network/task-execution-backend | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-backend-local | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-evaluation-harness | @jinn-network/attestation-issuer<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-evaluator-adapters | @jinn-network/attestation-issuer<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-evaluation-harness<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-launchers | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-profiles | @jinn-network/task-execution-protocol |
| @jinn-network/task-execution-protocol | — |
| @jinn-network/task-execution-supervisor | @jinn-network/task-execution-backend<br>@jinn-network/task-execution-protocol |
| @jinn-network/task-execution-testing | @jinn-network/evidence-discovery<br>@jinn-network/evidence-protocol<br>@jinn-network/evidence-repository<br>@jinn-network/execution-recorder<br>@jinn-network/task-execution-backend<br>@jinn-network/task-execution-backend-local<br>@jinn-network/task-execution-launchers<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol<br>@jinn-network/task-execution-supervisor<br>@jinn-network/task-execution-workspace |
| @jinn-network/task-execution-workspace | @jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol |
| @jinn-network/trust-core | — |
| @jinn-network/trust-resolve | @jinn-network/trust-core |
| @jinn-network/trust-testing | @jinn-network/trust-core<br>@jinn-network/trust-resolve |

## Release and trusted publishers

| Release group | Packages | Publish policies | Stack published | Canary | Stable |
| --- | ---: | --- | --- | --- | --- |
| experimental-environment-supply | 7 | disabled | false | false | false |
| legacy-product-lines | 5 | independent | false | false | false |
| platform-v1 | 50 | canary-only | true | true | false |
| transitional-or-private | 7 | private<br>never | false | false | false |

The exact 50-package trusted-publisher set is `platform-v1`. Receipt-gated canary publication is enabled. **Stable publication is disabled until live `jinn.network` profile hosting verification passes.** The 7 experimental packages remain disabled. Legacy and product lines publish independently or remain private/never-published according to the catalog.

| Package | Workflow | Environment field |
| --- | --- | --- |
| @jinn-network/attestation-issuer | stack-npm-publish.yml | blank |
| @jinn-network/benchmarking-aggregate | stack-npm-publish.yml | blank |
| @jinn-network/benchmarking-interop | stack-npm-publish.yml | blank |
| @jinn-network/benchmarking-marketplace | stack-npm-publish.yml | blank |
| @jinn-network/benchmarking-records | stack-npm-publish.yml | blank |
| @jinn-network/benchmarking-run | stack-npm-publish.yml | blank |
| @jinn-network/benchmarking-testing | stack-npm-publish.yml | blank |
| @jinn-network/evidence-catalog-sqlite | stack-npm-publish.yml | blank |
| @jinn-network/evidence-contribution | stack-npm-publish.yml | blank |
| @jinn-network/evidence-derivation | stack-npm-publish.yml | blank |
| @jinn-network/evidence-discovery | stack-npm-publish.yml | blank |
| @jinn-network/evidence-local-runtime | stack-npm-publish.yml | blank |
| @jinn-network/evidence-protocol | stack-npm-publish.yml | blank |
| @jinn-network/evidence-publication | stack-npm-publish.yml | blank |
| @jinn-network/evidence-repository | stack-npm-publish.yml | blank |
| @jinn-network/evidence-repository-ipfs | stack-npm-publish.yml | blank |
| @jinn-network/evidence-repository-oci | stack-npm-publish.yml | blank |
| @jinn-network/evidence-retrieval | stack-npm-publish.yml | blank |
| @jinn-network/evidence-trace-decode | stack-npm-publish.yml | blank |
| @jinn-network/evidence-trajectory | stack-npm-publish.yml | blank |
| @jinn-network/execution-recorder | stack-npm-publish.yml | blank |
| @jinn-network/execution-recorder-bridge | stack-npm-publish.yml | blank |
| @jinn-network/marketplace-binding | stack-npm-publish.yml | blank |
| @jinn-network/marketplace-pipeline | stack-npm-publish.yml | blank |
| @jinn-network/marketplace-projector | stack-npm-publish.yml | blank |
| @jinn-network/marketplace-testing | stack-npm-publish.yml | blank |
| @jinn-network/marketplace-venue-base | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-client | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-facts-benchmarking | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-facts-evidence | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-facts-task-execution | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-facts-trust | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-protocol | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-serve | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-source-evidence-journal | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-testing | stack-npm-publish.yml | blank |
| @jinn-network/record-discovery-transport-http | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-backend | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-backend-local | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-evaluation-harness | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-evaluator-adapters | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-launchers | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-profiles | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-protocol | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-supervisor | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-testing | stack-npm-publish.yml | blank |
| @jinn-network/task-execution-workspace | stack-npm-publish.yml | blank |
| @jinn-network/trust-core | stack-npm-publish.yml | blank |
| @jinn-network/trust-resolve | stack-npm-publish.yml | blank |
| @jinn-network/trust-testing | stack-npm-publish.yml | blank |

## Public surfaces and identity claims

| Package | Release group | Schemas | Profiles | Fixtures | Conformance exports |
| --- | --- | --- | --- | --- | --- |
| @jinn-network/broadcast-bot | transitional-or-private | — | — | — | — |
| @jinn-network/client | legacy-product-lines | schemas | — | fixtures | — |
| @jinn-network/operator-spa | transitional-or-private | — | — | — | — |
| @jinn-network/autopilot | transitional-or-private | — | — | — | — |
| @jinn-network/benchmarking-aggregate | platform-v1 | — | — | — | — |
| @jinn-network/benchmarking-interop | platform-v1 | — | — | fixtures | — |
| @jinn-network/benchmarking-marketplace | platform-v1 | — | — | fixtures | — |
| @jinn-network/benchmarking-records | platform-v1 | schemas | — | fixtures | — |
| @jinn-network/benchmarking-run | platform-v1 | — | — | — | — |
| @jinn-network/benchmarking-testing | platform-v1 | — | — | fixtures | . |
| @jinn-network/core | legacy-product-lines | — | — | — | — |
| @jinn-network/record-discovery-client | platform-v1 | — | — | — | — |
| @jinn-network/record-discovery-facts-benchmarking | platform-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-environments | experimental-environment-supply | — | profiles | — | — |
| @jinn-network/record-discovery-facts-evidence | platform-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-task-execution | platform-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-facts-trust | platform-v1 | — | profiles | — | — |
| @jinn-network/record-discovery-protocol | platform-v1 | — | — | fixtures | — |
| @jinn-network/record-discovery-serve | platform-v1 | — | — | — | — |
| @jinn-network/record-discovery-source-evidence-journal | platform-v1 | — | — | fixtures | — |
| @jinn-network/record-discovery-testing | platform-v1 | — | — | fixtures | . |
| @jinn-network/record-discovery-transport-http | platform-v1 | — | — | — | — |
| @jinn-network/environment-record | experimental-environment-supply | schemas | — | fixtures | ./testing |
| @jinn-network/environment-verification | experimental-environment-supply | — | — | fixtures | ./testing |
| @jinn-network/attestation-issuer | platform-v1 | — | — | fixtures | ./testing |
| @jinn-network/evidence-catalog-sqlite | platform-v1 | — | — | — | — |
| @jinn-network/evidence-contribution | platform-v1 | — | — | — | ./testing |
| @jinn-network/evidence-derivation | platform-v1 | — | — | — | ./testing |
| @jinn-network/evidence-discovery | platform-v1 | — | — | — | ./testing |
| @jinn-network/execution-recorder | platform-v1 | — | — | fixtures | ./testing |
| @jinn-network/execution-recorder-bridge | platform-v1 | — | — | — | — |
| @jinn-network/evidence-local-runtime | platform-v1 | — | — | — | — |
| @jinn-network/evidence-protocol | platform-v1 | profiles/execution-evidence/1.0/schemas | profiles | fixtures | — |
| @jinn-network/evidence-publication | platform-v1 | — | — | — | ./testing |
| @jinn-network/evidence-repository | platform-v1 | — | — | — | ./testing |
| @jinn-network/evidence-repository-ipfs | platform-v1 | — | profile | profile/v1/fixtures | — |
| @jinn-network/evidence-repository-oci | platform-v1 | profiles/evidence-repository-oci/1.0/schemas | profiles | fixtures | — |
| @jinn-network/evidence-retrieval | platform-v1 | — | — | — | ./testing |
| @jinn-network/evidence-trace-decode | platform-v1 | — | — | fixtures | ./testing |
| @jinn-network/evidence-trajectory | platform-v1 | schemas | — | fixtures | ./testing |
| @jinn-network/indexer | transitional-or-private | — | — | — | — |
| @jinn-network/indexer-enrichment | transitional-or-private | — | — | — | — |
| @jinn-network/explorer-spa | transitional-or-private | — | — | — | — |
| @jinn-network/jinn-layer | legacy-product-lines | — | — | — | — |
| @jinn-network/marketplace-binding | platform-v1 | — | — | fixtures | — |
| @jinn-network/marketplace-pipeline | platform-v1 | — | — | — | — |
| @jinn-network/marketplace-projector | platform-v1 | — | — | — | — |
| @jinn-network/marketplace-testing | platform-v1 | — | — | fixtures | ./backend-conformance<br>./projector-conformance<br>./revised-contract-conformance<br>./venue-conformance |
| @jinn-network/marketplace-venue-base | platform-v1 | — | — | — | — |
| @jinn-network/plugin | legacy-product-lines | — | — | — | — |
| @jinn-network/sdk | legacy-product-lines | — | — | fixtures | — |
| @jinn-network/task-execution-backend | platform-v1 | — | — | — | — |
| @jinn-network/task-execution-backend-local | platform-v1 | — | — | — | — |
| @jinn-network/task-execution-launchers | platform-v1 | — | — | — | — |
| @jinn-network/task-execution-supervisor | platform-v1 | — | — | — | — |
| @jinn-network/task-execution-workspace | platform-v1 | — | — | — | — |
| @jinn-network/task-execution-evaluation-harness | platform-v1 | — | — | — | — |
| @jinn-network/task-execution-evaluator-adapters | platform-v1 | — | — | fixtures | — |
| @jinn-network/task-execution-profiles | platform-v1 | — | profiles | fixtures | ./testing |
| @jinn-network/task-execution-protocol | platform-v1 | schemas | — | fixtures | — |
| @jinn-network/task-execution-testing | platform-v1 | — | — | fixtures | . |
| @jinn-network/task-admission | experimental-environment-supply | — | — | — | ./testing |
| @jinn-network/task-curation | experimental-environment-supply | — | — | fixtures | — |
| @jinn-network/task-derivation | experimental-environment-supply | — | — | fixtures | ./testing |
| @jinn-network/task-posting | experimental-environment-supply | — | — | — | — |
| @jinn-network/trust-core | platform-v1 | — | — | fixtures | — |
| @jinn-network/trust-resolve | platform-v1 | — | — | — | — |
| @jinn-network/trust-testing | platform-v1 | — | — | fixtures | . |
| @jinn-network/plugin-runtime | transitional-or-private | — | — | — | — |

### Self-identifying `jinn.network` claims

| Identifier | Field | Kind | Package | Source |
| --- | --- | --- | --- | --- |
| https://jinn.network/profiles/evidence-repository-ipfs-registration/1/registration.schema.json | `$id` | profiles | @jinn-network/evidence-repository-ipfs | packages/evidence/repository-ipfs/profile/v1/registration.schema.json |
| https://jinn.network/profiles/evidence-repository-oci/1.0/schemas/evidence-oci-manifest.schema.json | `$id` | schemas | @jinn-network/evidence-repository-oci | packages/evidence/repository-oci/profiles/evidence-repository-oci/1.0/schemas/evidence-oci-manifest.schema.json |
| https://jinn.network/profiles/execution-evidence/1.0/schemas/dsse-envelope.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/1.0/schemas/dsse-envelope.schema.json |
| https://jinn.network/profiles/execution-evidence/1.0/schemas/execution-evidence-document.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/1.0/schemas/execution-evidence-document.schema.json |
| https://jinn.network/profiles/execution-evidence/1.0/schemas/execution-verification-statement.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/1.0/schemas/execution-verification-statement.schema.json |
| https://jinn.network/profiles/execution-evidence/1.0/schemas/resource-descriptor.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/1.0/schemas/resource-descriptor.schema.json |
| https://jinn.network/profiles/execution-evidence/1.0/schemas/result-evaluation-statement.schema.json | `$id` | schemas | @jinn-network/evidence-protocol | packages/evidence/protocol/profiles/execution-evidence/1.0/schemas/result-evaluation-statement.schema.json |
| https://jinn.network/records/authorization/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/authorization.1.0.json |
| https://jinn.network/records/benchmark-matrix/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/matrix.1.0.json |
| https://jinn.network/records/benchmark-report/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/report.1.0.json |
| https://jinn.network/records/benchmark-run/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/run.1.0.json |
| https://jinn.network/records/benchmark/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-benchmarking | packages/discovery/facts/benchmarking/profiles/benchmark.1.0.json |
| https://jinn.network/records/checkpoint/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/checkpoint.1.0.json |
| https://jinn.network/records/delivery/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/delivery.1.0.json |
| https://jinn.network/records/environment/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-environments | packages/discovery/facts/environments/profiles/environment.1.0.json |
| https://jinn.network/records/environment/1.0/schema | `$id` | schemas | @jinn-network/environment-record | packages/environments/record/schemas/environment.schema.json |
| https://jinn.network/records/evaluation-spec/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/evaluation-spec.1.0.json |
| https://jinn.network/records/execution-evidence/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-evidence.1.0.json |
| https://jinn.network/records/execution-verification/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/execution-verification.1.0.json |
| https://jinn.network/records/key-binding/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/key-binding.1.0.json |
| https://jinn.network/records/plugin/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/plugin.1.0.json |
| https://jinn.network/records/profile-document/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/profile-document.1.0.json |
| https://jinn.network/records/result-evaluation/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-evidence | packages/discovery/facts/evidence/profiles/result-evaluation.1.0.json |
| https://jinn.network/records/submission/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/submission.1.0.json |
| https://jinn.network/records/task/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-task-execution | packages/discovery/facts/task-execution/profiles/task.1.0.json |
| https://jinn.network/records/trajectory-derivation-statement/1.0/schema | `$id` | schemas | @jinn-network/evidence-trajectory | packages/evidence/trajectory/schemas/trajectory-derivation-statement.schema.json |
| https://jinn.network/records/trajectory/1.0/schema | `$id` | schemas | @jinn-network/evidence-trajectory | packages/evidence/trajectory/schemas/trajectory.schema.json |
| https://jinn.network/records/trust-policy/1.0/facts/1.0 | `profile` | profiles | @jinn-network/record-discovery-facts-trust | packages/discovery/facts/trust/profiles/trust-policy.1.0.json |
| https://jinn.network/task-profiles/evaluation-task/1.0 | `profile` | profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/evaluation-task/1.0/profile.json |
| https://jinn.network/task-profiles/repository-work/1.0 | `profile` | profiles | @jinn-network/task-execution-profiles | packages/task-execution/profiles/profiles/task-profiles/repository-work/1.0/profile.json |

## Architecture-control ownership

Task 6's validator reports 3021 controlled paths. Required effective owners: `@oaksprout` `@ritsukai`.
The exhaustive path-level input and coverage report is the `ownership` object in [`platform-topology.v1.json`](./platform-topology.v1.json); this human view keeps its deterministic category summary.

| Category | Controlled paths |
| --- | ---: |
| authorityDocuments | 19 |
| boundaryPolicies | 18 |
| catalogManifests | 69 |
| catalogPublicSurfaces | 951 |
| catalogSchema | 2 |
| conformancePackedTargets | 46 |
| conformanceSources | 23 |
| decisionRecords | 2 |
| discoveredFirstPartySurfaces | 2403 |
| generatedOutputSources | 997 |
| generatorSources | 500 |
| marketplaceControl | 2 |
| requiredGates | 18 |
| staticControl | 6 |

## Transitional and deprecated entries

| Package | Path | Stability | Release | Supersedes | Replaced by | Status | Reason | Sunset condition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| @jinn-network/client | client | transitional | legacy-product-lines / independent | — | — | independently published during recomposition | The operator is being recomposed onto cataloged platform applications. | The operator-daemon cutover is complete and the legacy release coupling is retired. |
| @jinn-network/autopilot | packages/autopilot | transitional | transitional-or-private / private | — | — | removal tracked | Autopilot has been extracted to Jinn-Network/autopilot; this package is vendored residue. | The monorepo no longer needs the vendored copy. |
| @jinn-network/core | packages/core | transitional | legacy-product-lines / independent | — | — | independently published during cutover | The legacy kernel overlaps evidence applications and the plugin product stack. | Operator and plugin cutovers no longer import @jinn-network/core. |
| @jinn-network/indexer | packages/indexer | transitional | transitional-or-private / never | — | — | logical split required | The package mixes platform projector and product explorer responsibilities. | The projector is re-derived onto the platform and the explorer remains a tier-4 product. |
| @jinn-network/indexer-enrichment | packages/indexer-enrichment | transitional | transitional-or-private / never | — | — | re-derive with the read plane | The worker remains coupled to the legacy indexer service boundary. | The indexer projector is re-derived onto the platform and the read-plane boundary is settled. |
| @jinn-network/jinn-layer | packages/layer | transitional | legacy-product-lines / independent | — | — | independently published during cutover | The legacy local runtime overlaps platform evidence and task-execution applications. | Plugin and operator cutovers no longer resolve @jinn-network/jinn-layer. |
| @jinn-network/plugin | packages/plugin | transitional | legacy-product-lines / independent | — | — | independently published during cutover | The legacy extension contract is being reconciled with the product plugin boundary. | The plugin product cutover no longer imports this legacy line. |
| @jinn-network/sdk | packages/sdk | deprecated | legacy-product-lines / independent | — | @jinn-network/benchmarking-records<br>@jinn-network/task-execution-profiles<br>@jinn-network/task-execution-protocol | independent compatibility line | Platform record families supersede the legacy SolverNet SDK surfaces. | Daemon and marketplace-surface migrations have removed every live importer. |
