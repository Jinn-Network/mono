# Hermes provider as a first-class catalog + config concept

- **Date:** 2026-06-14
- **Author:** Claude (spike for issue #295)
- **Status:** Design proposal — awaiting review, spawns a separate implementation issue
- **Version:** 0.1
- **Related:**
  - Issue: [#295](https://github.com/Jinn-Network/mono/issues/295) (this spike)
  - Patch being superseded: [#293](https://github.com/Jinn-Network/mono/issues/293) — `inferProviderFromModelId` regex (release-blocker for v0.1.6)
  - Catalog landed in [#292](https://github.com/Jinn-Network/mono/issues/292)
  - `log/decisions/2026-05-19-v0.1.6-stewardship.md` (where the gap was discovered)
  - `client/src/dashboard/spa/src/pages/configuration/claudeModels.ts` (the catalog)
  - `client/src/harnesses/impls/hermes-agent/adapter.ts` (provider resolution + the #293 patch)
  - `client/src/config.ts` (`joinedSolverNets` Zod schema + `migrateLegacySolverNets`)

---

## 1. The question

`HERMES_MODELS` (`claudeModels.ts:49-59`) ships ten entries of shape `{ label, id }`. Every `id` is an OpenRouter-format `<org>/<model>` slug (`anthropic/claude-opus-4.7`, `deepseek/deepseek-v4-flash`, …). The daemon adapter has **no per-net notion of which provider a model routes through**. The v0.1.6 patch #293 (`adapter.ts:49-64`) infers `provider = 'openrouter'` from the slug shape with a regex. That works only because every catalog entry happens to be OpenRouter-routed; it misroutes the moment a non-OpenRouter entry is added (a direct-Anthropic id, a Nous Portal model, a local Ollama endpoint, an NVIDIA NIM slug — all of which use `<org>/<model>`-shaped or arbitrary ids).

This note proposes the catalog + config schema that makes provider a first-class concept, deletes the regex from the hot path, and stays backwards-compatible with operators who joined under v0.1.6.

## 2. What Hermes actually accepts (the constraint)

Provider/model/endpoint/auth reach the Hermes child through **three channels**, written every run (`adapter.ts:133-205`, `bootstrap.ts:179-191`):

| Concept | CLI flag | `config.yaml` field | env |
|---|---|---|---|
| Model | `--model <id>` | `model.default` | — |
| Provider | `--provider <name>` | `model.provider` | — |
| Endpoint | _(none)_ | `model.base_url` | — |
| Auth | _(none)_ | _(none)_ | env var **by name** (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, …) |

Two load-bearing facts:

1. **There is no `--api-key` flag and no api-key config field.** Hermes picks the credential env var implicitly *from the provider name*. So the provider name is not cosmetic — it selects which `*_API_KEY` Hermes reads (`adapter.ts:42-47` allowlists `/_API_KEY$/`, `/_API_TOKEN$/`, `/_TOKEN$/`, `/^HERMES_/` for passthrough). Get the provider wrong and Hermes dies at first model call with an empty-key error.
2. **Endpoint (`base_url`) is independent of provider** and only flows through config.yaml. A "custom" OpenAI-compatible endpoint (local Ollama, NVIDIA NIM, a self-hosted Hermes) needs `provider: custom` **and** a `base_url`. The adapter already special-cases this: `this.hermesBaseUrl ? 'custom' : …` (`adapter.ts:135-137`).

**Implication for the schema:** a single `provider` string is sufficient for hosted aggregators and vendor-direct providers (OpenRouter, Anthropic, Google, Nous Portal) where Hermes already knows the base URL and credential-var convention. It is **not** sufficient for custom OpenAI-compatible endpoints, which additionally need a `base_url` and (sometimes) a non-standard auth-var name. The schema must therefore allow provider to optionally carry `baseUrl` and `authVar` — but must not *require* them, since the common case is a bare provider name.

## 3. How provider resolves today (the gap)

Full path, catalog → child process (verified citations):

1. Catalog entry `{ label, id }` — no provider (`claudeModels.ts:13-18, 49-59`).
2. Join form sends `model: form.model`, **no provider** (`JoinFlow.tsx:313`).
3. Join endpoint validates/persists `name/roles/harness/model/plugins/...`, **no provider** (`setup-endpoints.ts:479-487, 515-517, 622`).
4. `joinedSolverNets` Zod entry — `{ manifestCid, name?, contract?, roles, harness?, model?, plugins, disabledDefaultPlugins }`, **no provider** (`config.ts:486-502`).
5. `registerJoinedNet` copies `model` into `SolverNetConfig.model` (`registry.ts:265-321`).
6. Engine stamps `inputs.model = solverNet?.model ?? operatorConfig.claudeModel` (`engine.ts:1699`). **`inputs` carries `model` but no provider.**
7. Adapter resolves `provider = this.hermesBaseUrl ? 'custom' : (this.hermesProvider ?? inferProviderFromModelId(model))` (`adapter.ts:135-137`).

`this.hermesProvider`/`hermesBaseUrl`/`hermesModel` are **boot-time daemon globals** (`config.ts:135-158`, from `JINN_HERMES_*`), shared across all nets. There is no per-net provider anywhere. So for every catalog model, `this.hermesProvider` is unset and the **#293 inference fallback runs** (`adapter.ts:60-64`).

**The single structural blocker:** the engine→adapter task-inputs interface (`TaskSessionInputs`, consumed at `adapter.ts:133`, stamped at `engine.ts:1699`) carries `model` per-task but no provider. Provider is only a boot-time global. Any first-class provider must add a **per-task provider channel** here.

**The other catalogs do not share the gap.** `CLAUDE_MODELS` and `CODEX_MODELS` (`claudeModels.ts:20-32`) are also `{ label, id }` only, but Claude Code and Codex each bind to one fixed provider (the CLI's own auth). Only Hermes is provider-pluralistic. The fix is Hermes-specific; the shared `LearnerModelOption` type can gain an **optional** `provider`, leaving the other two catalogs untouched.

## 4. Proposed schema

### 4.1 Catalog entry — `LearnerModelOption`

Add an optional `provider` to the shared type; populate it on `HERMES_MODELS` entries only:

```ts
export interface LearnerModelOption {
  label: string;
  id: string;
  /**
   * Provider route for this model. Required on Hermes entries (Hermes is
   * provider-pluralistic); omitted on Claude Code / Codex entries, which bind
   * to a single fixed provider. A bare string names a provider Hermes already
   * knows the base URL + credential-var for (`openrouter`, `anthropic`,
   * `google`, `nous`). The object form carries an explicit endpoint/auth-var
   * for custom OpenAI-compatible providers.
   */
  provider?: ProviderRef;
}

export type ProviderRef =
  | string                                            // e.g. 'openrouter'
  | { name: string; baseUrl?: string; authVar?: string };
```

`HERMES_MODELS` entries become `{ label, id, provider: 'openrouter' }` today; a future direct-Anthropic entry is `{ label, id: 'claude-opus-4.7', provider: 'anthropic' }`; a local endpoint is `{ label, id: 'llama3', provider: { name: 'custom', baseUrl: 'http://localhost:11434/v1', authVar: 'OLLAMA_API_KEY' } }`.

**Why `ProviderRef` and not a bare string:** §2 shows endpoint and auth-var are real, provider-coupled handles for the custom case, but absent for the common case. A union keeps the 90% case a one-word string and only pays structure where Hermes genuinely needs it. This directly answers the issue's Q4 ("does provider remain a single string field, or does it need more structure"): **string by default, `{ name, baseUrl, authVar }` when the provider is a custom endpoint.**

### 4.2 Config entry — `joinedSolverNets[<cid>]`

Add one optional field (Zod, `config.ts:486-502`):

```ts
provider: ProviderRefSchema.optional(),
// where ProviderRefSchema = z.union([
//   z.string().min(1),
//   z.object({ name: z.string().min(1), baseUrl: z.string().url().optional(), authVar: z.string().optional() }),
// ])
```

Optional, non-`.strict()` object → **v0.1.6 `{ model }`-only entries parse unchanged** (Q5 / backwards-compat). The same field threads through the join POST body (`JoinFlow.tsx:313`), the join endpoint (`setup-endpoints.ts:515-517, 622`), `SolverNetConfig` + `registerJoinedNet` (`registry.ts:23, 270, 318`), and `inputs.provider` on `TaskSessionInputs` (`engine.ts:1699`).

### 4.3 Adapter resolution

Replace the inference with the per-task value, keeping inference only as the absent-provider bridge:

```ts
const provider = this.hermesBaseUrl
  ? 'custom'
  : (inputs.provider ?? this.hermesProvider ?? inferProviderFromModelId(model));
```

When `inputs.provider` is a `ProviderRef` object, its `baseUrl`/`authVar` feed `model.base_url` and the env-passthrough selection.

## 5. Backwards compatibility & migration

Two-layer, both non-breaking:

1. **Optional field** (§4.2) — old `{ model }`-only entries validate as-is. The field is never required, so no v0.1.6 config fails to load. *Making `provider` required would break every existing entry at load — explicitly rejected.*
2. **Load-time backfill** following the established `migrateLegacySolverNets` pattern (`config.ts:836-889`, run pre-Zod at `config.ts:1224-1231`): a raw-object pass that stamps `provider: 'openrouter'` onto any `joinedSolverNets` entry whose `model` matches the OpenRouter slug shape and has no `provider`. Idempotent, runs once at load. This lets us **delete #293's `inferProviderFromModelId` from the adapter hot path** (`adapter.ts:60-64`) while preserving v0.1.6 routing — the inference moves from "every task, every run" to "once, at config-migration time, persisted."

The inference logic is not extended (the issue's explicit "Don't") — it is *relocated* to the migration layer and then removed from the runtime path entirely.

## 6. Recommended implementation slice (for the spawned issue)

1. `ProviderRef` type + `ProviderRefSchema` (shared between SPA and daemon).
2. `provider` on `HERMES_MODELS` entries (`'openrouter'` on all ten).
3. Thread `provider` through: JoinFlow body → join endpoint validate/persist → `joinedSolverNets` Zod → `SolverNetConfig`/`registerJoinedNet` → `TaskSessionInputs` (`inputs.provider`) → engine stamp (`engine.ts:1699`).
4. Adapter: `inputs.provider ?? this.hermesProvider ?? inferProviderFromModelId(model)`; honour `ProviderRef.baseUrl`/`authVar`.
5. Load-time backfill migration; then delete `inferProviderFromModelId` from `adapter.ts`.
6. Tests: a non-OpenRouter catalog entry routes correctly; a v0.1.6 `{ model }`-only config backfills to `openrouter`; a `{ name, baseUrl, authVar }` custom provider produces the right `config.yaml` + env passthrough.

## 7. Open questions for review

- **Catalog `provider` required vs optional on Hermes entries?** Recommendation: type-optional (shared with the other catalogs) but lint/test-enforced present on every `HERMES_MODELS` entry, so the catalog can never ship a Hermes model with no route.
- **`authVar` default convention.** For named providers Hermes already maps name→credential-var; `authVar` is only needed for `custom`. Confirm Hermes's exact name→var mapping before populating named entries (likely: leave `authVar` unset for named providers, let Hermes resolve).
- **Should the backfill also run for the global `JINN_HERMES_*` path?** The global daemon provider is operator-set and already explicit; recommendation is no — backfill targets only `joinedSolverNets` entries.
