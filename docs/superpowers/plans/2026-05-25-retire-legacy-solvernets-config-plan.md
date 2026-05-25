# Retire legacy short-name-keyed `solverNets` config block — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-remove the legacy short-name-keyed `solverNets` block from `JinnConfigSchema` and every reader, replacing it with the manifest-CID-keyed `joinedSolverNets` shape across the daemon, CLI, scripts, and SPA. Auto-migrate legacy on-disk configs into synthetic-keyed `joinedSolverNets` entries at load time so operators upgrade without an explicit action. Close the wave-2 Overview "SOLVING ON …" stale-label bug by removing the SPA's legacy fallback and showing an empty-state when no SolverNets are joined.

**Architecture:** One PR (per coordinator decision overriding the design's 3-PR stack), structured as a top-down strangler-fig inside a single branch: (1) introduce the load-time migration helper behind a unit-tested API and exercise it through `loadConfig`; (2) drain every `config.solverNets` reader file-by-file, swapping each to `config.joinedSolverNets`; (3) remove the schema field, the `DEFAULT_SOLVER_NETS` constant, the `solverNets` echo in the `/v1/bootstrap` payload, and the SPA's legacy fallback in `Overview.tsx`; (4) verify the four acceptance criteria with focused integration tests.

**Tech Stack:** TypeScript (strict), Vitest (Node + jsdom), Zod for schema, Hono for HTTP API, React + Vitest + Testing Library for the SPA.

**Spec:** `docs/superpowers/specs/2026-05-25-retire-legacy-solvernets-config.md`
**Issue:** `Jinn-Network/mono#421`
**Run-mode:** `refactor` (per `CLAUDE.md` §The shapes of work — integration tests over mocks for migration / contract surfaces; design upfront; TDD for new code, regression coverage for migrations)

---

## File map (touched in this PR)

**Schema + loader (Task 1, 2):**
- `client/src/config.ts` — drop `solverNets` from `JinnConfigSchema`, drop `DEFAULT_SOLVER_NETS`, add `migrateLegacySolverNets()` helper, call it before `JinnConfigSchema.safeParse`.

**Test files (Task 1, 5–13):**
- `client/test/config.test.ts` — add migration unit tests; update existing `loadConfig solverNets roles migration` describe to assert against the migrated joined shape (the legacy describe block at line 707 stops being meaningful once `solverNets` is gone).
- `client/test/solver-nets/prediction-operator-ux.test.ts` — joined-only tests.
- `client/test/api/gather-status.test.ts` — drop legacy paths, assert joined-only derivation.
- `client/test/api/launcher-status.test.ts` — joined-only fixtures.
- `client/test/api/bootstrap-endpoint.test.ts` — assert no `solverNets` field in the payload, only `joinedSolverNets`.
- `client/test/api/launcher-tasks.test.ts` (new) — build solver-type → joined-net index from `joinedSolverNets`.
- `client/test/cli/commands/tasks.test.ts` (or wherever existing tests live; new if not) — `--solver-net` lookup via joined names.
- `client/test/cli/task-native-readiness.test.ts` (new or existing) — evaluator-role detection via `joinedSolverNets`.
- `client/test/scripts/donation-consumption-acceptance.test.ts` — drop legacy SWE branch.

**Production readers (Task 6–12):**
- `client/src/solver-nets/prediction-operator-ux.ts` — drop the `config.solverNets[name]` branch; require `predictionJoined`; drop `name` parameter from signature; update all `configField` strings.
- `client/src/solver-nets/registry.ts` — delete the `Object.entries(config.solverNets)` loop; narrow `loadSolverNets`' input type to drop `solverNets`.
- `client/src/api/gather-status.ts` — `derivePredictionSolverNetName` joined-only; drop the `config.solverNets[name]` read on the unavailable path.
- `client/src/api/launcher-status.ts` — iterate `config.joinedSolverNets`; update `GatherLauncherStatusDeps.config` to `Pick<JinnConfig, 'joinedSolverNets'>`.
- `client/src/api/launcher-tasks.ts` — `buildSolverTypeToNetIndex` reads `joinedSolverNets` and synthesises solverType from `contract.id + '.' + contract.version`.
- `client/src/api/bootstrap-endpoint.ts` — drop `solverNets` from `configReader` return type and from the response envelope.
- `client/src/api/setup-endpoints.ts` — the legacy `POST /v1/setup/solvernets/:name` route is fully retired (write target gone). Returns 410 Gone with a structured `route_retired` envelope pointing operators at `POST /v1/operator/join/:cid`. Tests cover the new shape. (Earlier drafts of this plan called the verb `PATCH`; the live verb on `origin/next` was `POST` — see `git show origin/next:client/src/api/setup-endpoints.ts`.)
- `client/src/main.ts` — drop `solverNets:` from the `/v1/bootstrap` configReader projection (line 1077), drop `onSolverNetsUpdated` callbacks that wrote into `config.solverNets`, retire the launcher-mode `getGeneratorState`/`getOpenTaskCount` reads of `config.solverNets`.
- `client/src/cli/task-native-readiness.ts` — drop `legacySolverNets` branch in `hasConfiguredEvaluatorRole`; rely on `joinedSolverNets` evaluator role only.
- `client/src/cli/commands/tasks.ts` — `--solver-net` lookup by `joinedSolverNets` keyed by manifestCid OR by `joined.name`; deduce `solverType` from `joined.contract`.
- `client/src/cli/commands/solver-nets.ts` — narrow the `list` subverb so it iterates `loaded.joinedSolverNets` only. The mutation subverbs (`enable`/`disable`/`set-harness`/`add-plugin`/`remove-plugin`/`sample`/`doctor`) read raw JSON via the file-level `readConfig` and continue to operate on legacy on-disk configs through one migration cycle; they emit a deprecation warning (single `console.warn` line) directing operators at the SPA join flow. The CLI is operator-debug surface only — full retirement is a separate follow-up.
- `client/src/scripts/donation-consumption-acceptance.ts` — drop `cloneSolverNetsForConsumer`, drop legacy SWE branch in `assertConsumerConfiguredForSwe`.
- `client/src/dashboard/spa/src/pages/Overview.tsx` — drop the `bootstrap?.solverNets` fallback in `joinedNets`; remove `solverNets?:` from `BootstrapWithSolverNets`.
- `client/src/dashboard/spa/src/api/types.ts` — remove `solverNets?:` from the bootstrap response type.

**SPA tests (Task 14, 15):**
- `client/src/dashboard/spa/src/pages/Overview.test.tsx` — add a test that asserts `joinedNets` is empty (no "SOLVING ON" stale label) when `joinedSolverNets` is absent or empty and a stale legacy block is ignored.
- `client/src/dashboard/spa/src/pages/overview/ActivityCard.test.tsx` — already covers the empty-state copy; add a regression assertion that `joined: []` keeps the empty-state visible and does not render any selectable rows.

---

## Pre-flight: ensure tests run

- [ ] **Step 0.1: Confirm the worktree is on the refactor branch**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `refactor/421-refactor-retire-the-legacy-short-name-keyed-solvernets-confi`

- [ ] **Step 0.2: Confirm baseline tests pass before changes**

Run: `cd client && yarn typecheck && yarn test --run` (full vitest in non-watch mode)
Expected: zero TS errors, all tests pass. If anything fails here, stop and report — the plan assumes a green baseline.

---

## Task 1: Add `migrateLegacySolverNets` helper with unit tests

**Files:**
- Modify: `client/src/config.ts` (add helper, do not yet wire into the loader)
- Modify: `client/test/config.test.ts` (new describe block at the end of the file)

The helper takes a raw `Record<string, unknown>` parsed from JSON and mutates it in place: walks `rawConfig.solverNets`, projects each entry into `rawConfig.joinedSolverNets[`legacy:<short-name>`]`, then `delete`s `rawConfig.solverNets`. Returns a count of migrated entries so the loader can log a one-time warning. Idempotent — running it on an already-migrated raw config is a no-op.

- [ ] **Step 1.1: Write the failing test (legacy entry → synthetic-keyed joined entry)**

Append to `client/test/config.test.ts` at the end of the file:

```ts
import { migrateLegacySolverNets } from '../src/config.js';

describe('migrateLegacySolverNets', () => {
  it('migrates a single legacy solverNets entry into joinedSolverNets keyed by `legacy:<name>`', () => {
    const raw: Record<string, unknown> = {
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving'],
          harness: 'claude-code',
          plugins: [],
          taskGenerator: { enabled: true },
        },
      },
    };
    const migrated = migrateLegacySolverNets(raw);
    expect(migrated).toBe(1);
    expect(raw.solverNets).toBeUndefined();
    expect(raw.joinedSolverNets).toEqual({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
  });

  it('returns 0 and does not mutate when no legacy block exists', () => {
    const raw: Record<string, unknown> = { joinedSolverNets: { existing: { manifestCid: 'cid1', roles: ['solver'] } } };
    const before = JSON.stringify(raw);
    expect(migrateLegacySolverNets(raw)).toBe(0);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('maps the legacy "evaluating" role to "evaluator"', () => {
    const raw: Record<string, unknown> = {
      solverNets: {
        'swe-rebench-v2': {
          enabled: true,
          solverType: 'swe-rebench-v2.v1',
          roles: ['solving', 'evaluating'],
          harness: 'hermes-agent',
          model: 'minimax-m2.7',
          plugins: ['bundled:swe-rebench-v2-runtime'],
        },
      },
    };
    expect(migrateLegacySolverNets(raw)).toBe(1);
    expect(raw.joinedSolverNets).toEqual({
      'legacy:swe-rebench-v2': {
        manifestCid: 'legacy:swe-rebench-v2',
        name: 'swe-rebench-v2',
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'hermes-agent',
        model: 'minimax-m2.7',
        plugins: ['bundled:swe-rebench-v2-runtime'],
        disabledDefaultPlugins: [],
      },
    });
  });

  it('preserves a pre-existing joinedSolverNets entry under the same synthetic key (does not overwrite)', () => {
    const raw: Record<string, unknown> = {
      solverNets: {
        prediction: { solverType: 'prediction.v1', roles: ['solving'], harness: 'claude-code' },
      },
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'preserved',
          roles: ['solver'],
        },
      },
    };
    migrateLegacySolverNets(raw);
    // The pre-existing entry wins; the legacy block does not clobber it.
    expect((raw.joinedSolverNets as Record<string, { name: string }>)['legacy:prediction'].name).toBe('preserved');
  });

  it('handles an empty solverNets object as a no-op migration (no entries to convert)', () => {
    const raw: Record<string, unknown> = { solverNets: {} };
    expect(migrateLegacySolverNets(raw)).toBe(0);
    expect(raw.solverNets).toBeUndefined();
    expect(raw.joinedSolverNets).toBeUndefined();
  });

  it('defaults roles to ["solver"] when the legacy entry has no roles field', () => {
    const raw: Record<string, unknown> = {
      solverNets: { prediction: { solverType: 'prediction.v1', harness: 'claude-code' } },
    };
    migrateLegacySolverNets(raw);
    expect((raw.joinedSolverNets as Record<string, { roles: string[] }>)['legacy:prediction'].roles).toEqual(['solver']);
  });

  it('drops legacy "launching" roles during migration (operator config no longer carries them)', () => {
    const raw: Record<string, unknown> = {
      solverNets: { prediction: { solverType: 'prediction.v1', roles: ['solving', 'launching'] } },
    };
    migrateLegacySolverNets(raw);
    expect((raw.joinedSolverNets as Record<string, { roles: string[] }>)['legacy:prediction'].roles).toEqual(['solver']);
  });

  it('falls back to id=<name>, version="v1" when solverType is malformed', () => {
    const raw: Record<string, unknown> = {
      solverNets: { 'broken-net': { solverType: 'no-dot-version', roles: ['solving'] } },
    };
    migrateLegacySolverNets(raw);
    expect((raw.joinedSolverNets as Record<string, { contract: unknown }>)['legacy:broken-net'].contract)
      .toEqual({ id: 'broken-net', version: 'v1' });
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `cd client && yarn test --run config.test`
Expected: FAIL — `migrateLegacySolverNets is not exported by ../src/config.js`.

- [ ] **Step 1.3: Implement `migrateLegacySolverNets` in `client/src/config.ts`**

Insert above the `export function loadConfig(...)` declaration (i.e. immediately after `// ── Loader ───`):

```ts
interface LegacySolverNetEntry {
  enabled?: boolean;
  solverType?: string;
  roles?: Array<'solving' | 'evaluating' | 'launching' | string>;
  harness?: string;
  model?: string;
  plugins?: unknown[];
  taskGenerator?: unknown;
}

/**
 * Parse a legacy `<id>.<version>` solverType string into `{id, version}`.
 * Falls back to `{ id: fallbackId, version: 'v1' }` when the string lacks a
 * dot or terminates in one — this happens only on hand-edited operator
 * configs and keeps the migration loud-but-non-fatal.
 */
function parseSolverTypeRef(
  solverType: string | undefined,
  fallbackId: string,
): { id: string; version: string } {
  if (typeof solverType !== 'string') {
    return { id: fallbackId, version: 'v1' };
  }
  const dot = solverType.lastIndexOf('.');
  if (dot <= 0 || dot === solverType.length - 1) {
    return { id: fallbackId, version: 'v1' };
  }
  return { id: solverType.slice(0, dot), version: solverType.slice(dot + 1) };
}

/**
 * Translate any legacy short-name-keyed `solverNets` block on the raw parsed
 * config into manifest-keyed `joinedSolverNets` entries with synthetic
 * `legacy:<short-name>` keys.
 *
 * This is the auto-migration path for operators upgrading past issue #421.
 * The runtime claim filter remains manifest-digest gated, so synthetic-keyed
 * entries don't change task eligibility — they exist purely so the diagnostic
 * surfaces (Overview SOLVING-ON eyebrow, prediction-operator-status) keep
 * showing the operator's previous SolverNets until they re-join via the SPA.
 *
 * Returns the number of legacy entries migrated. Idempotent — calling on an
 * already-migrated raw config is a no-op.
 *
 * @param raw — the JSON-parsed config file contents (mutated in place).
 */
export function migrateLegacySolverNets(raw: Record<string, unknown>): number {
  const legacy = raw['solverNets'];
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return 0;
  }
  const entries = Object.entries(legacy as Record<string, unknown>);
  if (entries.length === 0) {
    delete raw['solverNets'];
    return 0;
  }

  const joined = (typeof raw['joinedSolverNets'] === 'object' && raw['joinedSolverNets'] !== null && !Array.isArray(raw['joinedSolverNets']))
    ? (raw['joinedSolverNets'] as Record<string, unknown>)
    : {};

  let migrated = 0;
  for (const [name, entryRaw] of entries) {
    if (!entryRaw || typeof entryRaw !== 'object') continue;
    const entry = entryRaw as LegacySolverNetEntry;
    const syntheticKey = `legacy:${name}`;
    // Do not overwrite a pre-existing joinedSolverNets entry under the same key.
    if (joined[syntheticKey] !== undefined) continue;

    const contract = parseSolverTypeRef(entry.solverType, name);
    const rolesIn = Array.isArray(entry.roles) && entry.roles.length > 0
      ? entry.roles
      : ['solving'];
    const roles: Array<'solver' | 'evaluator'> = [];
    for (const r of rolesIn) {
      if (r === 'solving') roles.push('solver');
      else if (r === 'evaluating') roles.push('evaluator');
      // 'launching' (and any other unknown role) is dropped — operator config
      // no longer carries the launcher role per spec §11.
    }
    if (roles.length === 0) roles.push('solver');

    joined[syntheticKey] = {
      manifestCid: syntheticKey,
      name,
      contract,
      roles: Array.from(new Set(roles)),
      ...(typeof entry.harness === 'string' ? { harness: entry.harness } : {}),
      ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
      plugins: Array.isArray(entry.plugins) ? entry.plugins : [],
      disabledDefaultPlugins: [],
    };
    migrated += 1;
  }

  if (Object.keys(joined).length > 0) {
    raw['joinedSolverNets'] = joined;
  }
  delete raw['solverNets'];
  return migrated;
}
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `cd client && yarn test --run config.test`
Expected: PASS — all eight `migrateLegacySolverNets` tests green; the existing `loadConfig` tests still pass (the helper isn't wired in yet).

- [ ] **Step 1.5: Commit**

```bash
git add client/src/config.ts client/test/config.test.ts
git commit -m "$(cat <<'EOF'
refactor(config): add migrateLegacySolverNets helper for issue #421

Walks a raw parsed config's `solverNets` block and projects each entry into
`joinedSolverNets[legacy:<name>]` with synthetic CID keys. Idempotent;
preserves pre-existing joined entries; drops the retired `launching` role.

Wired into `loadConfig` in the next commit so the migration is exercised
end-to-end before the schema field is removed.

Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire the migration into `loadConfig` and remove the `solverNets` schema field

This is the schema-removal step. The migration runs before `JinnConfigSchema.safeParse`, so by the time validation sees the merged object, `solverNets` is gone and only `joinedSolverNets` carries the operator's intent.

**Files:**
- Modify: `client/src/config.ts` — drop `DefaultSolverNetConfig` interface; drop `DEFAULT_SOLVER_NETS`; drop the `solverNets:` zod block from `JinnConfigSchema`; call `migrateLegacySolverNets(merged)` immediately before `JinnConfigSchema.safeParse(merged)`; emit one `console.warn` line when migration count > 0.
- Modify: `client/test/config.test.ts` — rewrite the existing `describe('loadConfig solverNets roles migration', ...)` block so each test asserts against `cfg.joinedSolverNets['legacy:prediction']` instead of `cfg.solverNets['prediction']`; rewrite the `describe('config: legacy launching role removal', ...)` block similarly.

- [ ] **Step 2.1: Write the failing test (loader migrates legacy → joined and the legacy field is gone from the typed config)**

In `client/test/config.test.ts`, **replace** the entire body of `describe('loadConfig solverNets roles migration', ...)` (starting line 707) with:

```ts
describe('loadConfig legacy solverNets migration via loader', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('migrates a legacy solverNets entry into joinedSolverNets at load time', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving'],
          harness: 'claude-code',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    // The validated config has no `solverNets` field at all.
    expect((cfg as unknown as Record<string, unknown>).solverNets).toBeUndefined();
    expect(cfg.joinedSolverNets).toEqual({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
  });

  it('preserves an explicit joinedSolverNets entry when legacy and joined are both present', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      solverNets: { prediction: { solverType: 'prediction.v1', roles: ['solving'] } },
      joinedSolverNets: {
        bafkreireal: {
          manifestCid: 'bafkreireal',
          name: 'real-net',
          roles: ['solver'],
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(Object.keys(cfg.joinedSolverNets ?? {})).toEqual(
      expect.arrayContaining(['bafkreireal', 'legacy:prediction']),
    );
  });

  it('produces an empty joinedSolverNets when no legacy block is on disk', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const cfg = loadConfig(configPath);
    expect(cfg.joinedSolverNets ?? {}).toEqual({});
  });

  it('migrates the dual-role legacy shape to roles: [solver, evaluator]', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      solverNets: {
        'swe-rebench-v2': {
          solverType: 'swe-rebench-v2.v1',
          roles: ['solving', 'evaluating'],
          harness: 'hermes-agent',
          model: 'minimax-m2.7',
          plugins: ['bundled:swe-rebench-v2-runtime'],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.joinedSolverNets?.['legacy:swe-rebench-v2']).toEqual({
      manifestCid: 'legacy:swe-rebench-v2',
      name: 'swe-rebench-v2',
      contract: { id: 'swe-rebench-v2', version: 'v1' },
      roles: ['solver', 'evaluator'],
      harness: 'hermes-agent',
      model: 'minimax-m2.7',
      plugins: ['bundled:swe-rebench-v2-runtime'],
      disabledDefaultPlugins: [],
    });
  });

  it('strips legacy "launching" role on migration', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      solverNets: {
        prediction: {
          solverType: 'prediction.v1',
          roles: ['solving', 'launching'],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.joinedSolverNets?.['legacy:prediction']?.roles).toEqual(['solver']);
  });
});
```

**Also delete** the `describe('config: legacy launching role removal', ...)` block at line 875 (its only assertions are against the now-removed `cfg.solverNets[...]`; the equivalent coverage is in the new "strips legacy launching role on migration" test above).

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `cd client && yarn test --run config.test`
Expected: FAIL — multiple tests fail because the loader still exposes `cfg.solverNets`, and `migrateLegacySolverNets` is not yet invoked from `loadConfig`.

- [ ] **Step 2.3: Remove the `solverNets` schema field and wire the migration call**

In `client/src/config.ts`:

1. Delete lines 27–60 (the `DefaultSolverNetConfig` interface and `DEFAULT_SOLVER_NETS` export).
2. Delete the entire `solverNets: z.record(z.preprocess(...))` block (lines 465–509) from `JinnConfigSchema`.
3. Update the JSDoc on the `joinedSolverNets` field (lines 511–525) to drop the "Kept structurally separate from legacy `solverNets`" sentence — the legacy block no longer exists.
4. Inside `loadConfig`, immediately before `const result = JinnConfigSchema.safeParse(merged);` (around line 1056), insert:

```ts
  // Auto-migrate any legacy short-name-keyed `solverNets` block into
  // `joinedSolverNets` with synthetic `legacy:<name>` keys. Operators upgrade
  // without an explicit action; the warning surfaces the migration so they
  // know to re-join via the SPA when they want a real manifest CID. See
  // spec/2026-05-25-retire-legacy-solvernets-config.md and issue #421.
  const migratedCount = migrateLegacySolverNets(merged);
  if (migratedCount > 0) {
    console.warn(
      `[config] Migrated ${migratedCount} legacy solverNets ${migratedCount === 1 ? 'entry' : 'entries'} to joinedSolverNets. ` +
      'Open Operator > SolverNets in the dashboard to re-join via the registry ' +
      '(replaces the synthetic legacy:* keys with real manifest CIDs).'
    );
  }
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `cd client && yarn test --run config.test`
Expected: PASS — both `migrateLegacySolverNets` (Task 1) and the loader-level migration tests pass.

- [ ] **Step 2.5: Typecheck the rest of the codebase to surface every reader**

Run: `cd client && yarn typecheck`
Expected: FAIL — many TS errors of the form `Property 'solverNets' does not exist on type 'JinnConfig'`. Capture the list; it should mirror the readers enumerated in the file map above (`main.ts`, `gather-status.ts`, `prediction-operator-ux.ts`, `launcher-status.ts`, `launcher-tasks.ts`, `bootstrap-endpoint.ts`, `setup-endpoints.ts`, `task-native-readiness.ts`, `cli/commands/tasks.ts`, `cli/commands/solver-nets.ts`, `registry.ts`, `scripts/donation-consumption-acceptance.ts`, `dashboard/spa/src/pages/Overview.tsx`, `dashboard/spa/src/api/types.ts`). The next tasks drain these one by one.

- [ ] **Step 2.6: Commit (mid-state — yarn test passes for config but yarn typecheck reveals reader gaps)**

```bash
git add client/src/config.ts client/test/config.test.ts
git commit -m "$(cat <<'EOF'
refactor(config): wire solverNets→joinedSolverNets migration into loadConfig

Drops the legacy `solverNets` field from JinnConfigSchema and DEFAULT_SOLVER_NETS.
Calls migrateLegacySolverNets() before zod validation so legacy on-disk configs
load without operator-visible breakage. Emits a one-time console.warn line
pointing operators at the SPA join flow.

Typecheck of the rest of the codebase now reveals every reader that still
expects `config.solverNets`; subsequent commits drain them.

Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drain reader — `client/src/solver-nets/registry.ts`

**Files:**
- Modify: `client/src/solver-nets/registry.ts`
- Test: relies on existing `client/test/solver-nets/contracts.test.ts` and the broader integration coverage (no new tests required — `loadSolverNets` is exercised by `e2e:daemon-harness` and existing daemon tests; the typecheck failure caused by Task 2 forces the change).

- [ ] **Step 3.1: Confirm baseline typecheck failure on `registry.ts`**

Run: `cd client && yarn typecheck 2>&1 | grep registry.ts`
Expected: error referring to `config.solverNets` on line 280 (`for (const [name, net] of Object.entries(config.solverNets))`) and line 197 (`solverNets: Record<string, SolverNetConfig>`).

- [ ] **Step 3.2: Narrow `loadSolverNets`' input and drop the legacy loop**

Edit `client/src/solver-nets/registry.ts`:

- Change the parameter signature (line 195):
  ```ts
  export async function loadSolverNets(
    config: {
      joinedSolverNets?: Record<string, JoinedSolverNetConfig>;
    },
  ): Promise<SolverNetRegistry> {
  ```
- Delete lines 280–282 (`for (const [name, net] of Object.entries(config.solverNets)) { await registerFromConfig(name, net); }`).
- The function now solely iterates `config.joinedSolverNets`. The `registerFromConfig` inner helper is still needed by the joined-loop path.

- [ ] **Step 3.3: Run typecheck and `solver-nets` tests**

Run: `cd client && yarn typecheck 2>&1 | grep -c registry.ts`
Expected: 0 errors in `registry.ts`.

Run: `cd client && yarn test --run solver-nets`
Expected: all existing tests pass (the registry's joined-only path was already covered).

- [ ] **Step 3.4: Commit**

```bash
git add client/src/solver-nets/registry.ts
git commit -m "$(cat <<'EOF'
refactor(solver-nets): registry stops reading config.solverNets

loadSolverNets now iterates joinedSolverNets only. Drops the legacy
short-name-keyed branch and narrows the input type accordingly. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Drain reader — `client/src/solver-nets/prediction-operator-ux.ts`

**Files:**
- Modify: `client/src/solver-nets/prediction-operator-ux.ts`
- Modify: `client/test/solver-nets/prediction-operator-ux.test.ts`

The function `buildPredictionOperatorStatus` keeps its diagnostic responsibilities, but the only valid source of a prediction-contract net is now `joinedSolverNets[*]` with `contract.id === 'prediction'`. The `name` parameter and the `const legacy = config.solverNets[name]` branch are removed. Diagnostic `configField` strings change from `solverNets.${name}.X` to `joinedSolverNets.${manifestCid}.X`.

- [ ] **Step 4.1: Write the failing test (joined-only buildPredictionOperatorStatus)**

In `client/test/solver-nets/prediction-operator-ux.test.ts`, locate the test file structure. Replace any existing legacy-config-based test with the following joined-only fixture (add new tests rather than overwriting wholesale — search the file for `config.solverNets` references first and update each call site to use a `joinedSolverNets`-only config). At a minimum, ensure a new test exists:

```ts
it('builds a status from a joined prediction-contract entry with no legacy solverNets block', async () => {
  const cfg = {
    rpcUrl: 'http://127.0.0.1:0',
    network: 'testnet' as const,
    engine: { workingDirRoot: '/tmp/w', implStateDirRoot: '/tmp/i' },
    claudePath: 'claude',
    claudeModel: 'claude-haiku-4-5',
    joinedSolverNets: {
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'] as const,
        harness: 'claude-code',
        plugins: [] as string[],
        disabledDefaultPlugins: [] as string[],
      },
    },
    // (other JinnConfig fields elided for brevity — fill in per existing test fixtures)
  } as unknown as JinnConfig;
  const status = await buildPredictionOperatorStatus({
    config: cfg,
    configPath: '/tmp/config.json',
    buildHarnesses: stubBuildHarnesses,
    loadExternalImpl: stubLoadExternalImpl,
    loadSolverNets: stubLoadSolverNets,
  });
  expect(status.ok).toBe(true);
  expect(status.solverNet.name).toBe('prediction');
});

it('returns missingSolverNetStatus when no joined entry has contract.id === "prediction"', async () => {
  const cfg = { /* same shape with joinedSolverNets: {} */ } as unknown as JinnConfig;
  const status = await buildPredictionOperatorStatus({
    config: cfg,
    configPath: '/tmp/config.json',
  });
  expect(status.ok).toBe(false);
  expect(status.diagnostics[0]?.code).toBe('prediction_solvernet_missing');
});
```

(Adapt the helper-stub imports/types to match the existing fixtures in the file.)

- [ ] **Step 4.2: Run the test to verify it fails**

Run: `cd client && yarn test --run prediction-operator-ux`
Expected: FAIL — `config.solverNets` references and the `name = 'prediction'` parameter default expose the legacy code path.

- [ ] **Step 4.3: Refactor `buildPredictionOperatorStatus`**

In `client/src/solver-nets/prediction-operator-ux.ts`:

1. Remove `name = 'prediction'` from `BuildPredictionOperatorStatusOptions` and the function signature; the function no longer takes a `name`.
2. Replace the body's opening (`const legacy = config.solverNets[name]; ... const net: SolverNetConfig = legacy ?? synthesizeFromJoined(...)`) with:
   ```ts
   const predictionJoined = findPredictionJoined(config.joinedSolverNets);
   if (!predictionJoined) {
     return missingSolverNetStatus(configPath, daemonRunning);
   }
   const net: SolverNetConfig = synthesizeFromJoined(predictionJoined, 'prediction.v1');
   const displayName = predictionJoined.name ?? predictionJoined.manifestCid ?? 'prediction';
   const manifestCid = predictionJoined.manifestCid ?? 'prediction';
   ```
3. Replace every `solverNets.${name}.X` configField with `joinedSolverNets.${manifestCid}.X`.
4. Update `missingSolverNetStatus` to drop its `name` parameter and emit `configField: 'joinedSolverNets'` plus `nextAction.url: '/operator/registry'`. Update the returned `solverNet.name` to `'prediction'` (a literal placeholder for the missing-net case).
5. Update `PredictionOperatorStatus.solverNet.name` to render `displayName` (from the joined entry) when present.
6. Update every caller (gather-status.ts, MCP operator-server, etc.) that passes a `name:` argument; remove the argument.

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `cd client && yarn test --run prediction-operator-ux`
Expected: PASS — joined-only fixtures resolve and the diagnostic shape is updated.

Run: `cd client && yarn typecheck 2>&1 | grep prediction-operator-ux`
Expected: 0 errors in this file.

- [ ] **Step 4.5: Commit**

```bash
git add client/src/solver-nets/prediction-operator-ux.ts client/test/solver-nets/prediction-operator-ux.test.ts
git commit -m "$(cat <<'EOF'
refactor(prediction-operator-ux): joined-only resolution for #421

Drops the `name` parameter and the config.solverNets[name] branch.
buildPredictionOperatorStatus now reads exclusively from joinedSolverNets,
matching entries by contract.id === 'prediction'. configField strings update
from solverNets.<name>.X to joinedSolverNets.<manifestCid>.X.

Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Drain reader — `client/src/api/gather-status.ts`

**Files:**
- Modify: `client/src/api/gather-status.ts`
- Modify: `client/test/api/gather-status.test.ts`

`derivePredictionSolverNetName` and `predictionOperatorUnavailable` both read `config.solverNets`. Drain to joined-only and update the cache key accordingly.

- [ ] **Step 5.1: Write the failing test (gather-status reads only joined)**

In `client/test/api/gather-status.test.ts`, find the existing tests that build a `config` fixture with `solverNets: { ... }` and add a regression test:

```ts
it('does not read config.solverNets in derivePredictionSolverNetName (joined-only)', async () => {
  mockStatusRpc();
  const buildPredictionOperatorStatus = vi.fn(async (): Promise<PredictionOperatorStatus> => (
    /* ... usual fixture ... */
  ));
  vi.doMock('../../src/solver-nets/prediction-operator-ux.js', () => ({
    buildPredictionOperatorStatus,
  }));
  const { gatherStatusForApi } = await import('../../src/api/gather-status.js');
  const config = {
    joinedSolverNets: {
      'bafkrei': {
        manifestCid: 'bafkrei',
        name: 'SWE-rebench v2',
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['solver'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
    },
    // NOTE: no `solverNets` key at all
  } as unknown as JinnConfig;
  // ... gather, assert that the predictionOperator surface called with the joined name
});
```

Also **update or delete** each existing test in this file that uses `solverNets: { ... }` so the input fixtures match the new typed shape. Search the file for `solverNets:` and migrate each fixture into `joinedSolverNets` (synthetic key + correct roles mapping).

- [ ] **Step 5.2: Run test to verify it fails**

Run: `cd client && yarn test --run gather-status`
Expected: FAIL — type errors and assertions against `config.solverNets`.

- [ ] **Step 5.3: Refactor `gather-status.ts`**

1. Replace `derivePredictionSolverNetName` (line 254) with a joined-only implementation:
   ```ts
   function derivePredictionSolverNetName(config: JinnConfig): string {
     const joinedEntries = Object.entries(config.joinedSolverNets ?? {});
     if (joinedEntries.length > 0) {
       const [cid, entry] = joinedEntries[0]!;
       return entry.name ?? cid;
     }
     return 'prediction';
   }
   ```
2. In `predictionOperatorUnavailable` (line 293) replace `const net = config.solverNets[name];` with a joined lookup keyed by the same `name`:
   ```ts
   const joined = Object.values(config.joinedSolverNets ?? {}).find(
     (entry) => (entry.name ?? entry.manifestCid) === name,
   );
   ```
   Use the joined entry's `roles` array (translated from `'solver'/'evaluator'` to `'solving'/'evaluating'` via `rolesFromJoinedConfig`) for the unavailable-status `solverNet.roles` field; default to `[]` when no joined entry matches.
3. The cache key (`configPath, name`) stays the same. Cache invalidation already runs on `onSolverNetsUpdated`; rename that callback to `onJoinedSolverNetsUpdated` where it lives in `main.ts` (Task 11). Leave the cache key in this file untouched.

- [ ] **Step 5.4: Run tests to verify they pass**

Run: `cd client && yarn test --run gather-status`
Expected: PASS.

Run: `cd client && yarn typecheck 2>&1 | grep gather-status`
Expected: 0 errors.

- [ ] **Step 5.5: Commit**

```bash
git add client/src/api/gather-status.ts client/test/api/gather-status.test.ts
git commit -m "$(cat <<'EOF'
refactor(gather-status): derive prediction net name from joinedSolverNets only

derivePredictionSolverNetName and predictionOperatorUnavailable no longer
read config.solverNets. SOLVING-ON detection on Overview now matches the
joined-only path, fixing the wave-2 stale-label symptom for operators who
left every joined SolverNet. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Drain reader — `client/src/api/launcher-status.ts`

**Files:**
- Modify: `client/src/api/launcher-status.ts`
- Modify: `client/test/api/launcher-status.test.ts`

Iterate `config.joinedSolverNets` instead of `config.solverNets`. Each launcher-status net entry's `name` is the joined entry's display name (`joined.name ?? cid`); `solverType` is derived from `contract.id + '.' + contract.version`.

- [ ] **Step 6.1: Write the failing test**

Replace the two test fixtures in `client/test/api/launcher-status.test.ts` (lines 12-21 and 44-54) so the config carries `joinedSolverNets` with one prediction-contract entry. Add a new test:

```ts
it('emits one entry per joinedSolverNets membership, keyed by display name', async () => {
  const status = await gatherLauncherStatus({
    config: {
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'prediction',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    },
    getGeneratorState: () => ({ cadenceMs: 60_000 }),
    getOpenTaskCount: () => 0,
    getReservedBudgetWei: () => '',
    getSafeBalanceWei: () => '0',
    safeAddress: '0x0000000000000000000000000000000000000000',
    now: () => Date.parse('2026-05-08T12:00:00.000Z'),
  });
  expect(status.nets).toHaveLength(1);
  expect(status.nets[0]?.name).toBe('prediction');
  expect(status.nets[0]?.solverType).toBe('prediction.v1');
});
```

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `cd client && yarn test --run launcher-status`
Expected: FAIL.

- [ ] **Step 6.3: Refactor `launcher-status.ts`**

1. Change `GatherLauncherStatusDeps['config']` (line 83) to `Pick<JinnConfig, 'joinedSolverNets'>`.
2. Replace the `Object.entries(deps.config.solverNets ?? {})` loop (line 146) with:
   ```ts
   for (const [cid, joined] of Object.entries(deps.config.joinedSolverNets ?? {})) {
     const displayName = joined.name ?? cid;
     const solverType = joined.contract
       ? `${joined.contract.id}.${joined.contract.version}`
       : undefined;
     // ... rest of the loop body (snapshot, openTasks, reservedBudgetWei, safeBalanceWei)
     // pass `displayName` to deps.getGeneratorState / deps.getOpenTaskCount / deps.getReservedBudgetWei
   }
   ```
3. Push the `name` field as `displayName` and `solverType` from the derivation above.

- [ ] **Step 6.4: Run tests to verify they pass**

Run: `cd client && yarn test --run launcher-status`
Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add client/src/api/launcher-status.ts client/test/api/launcher-status.test.ts
git commit -m "$(cat <<'EOF'
refactor(launcher-status): iterate joinedSolverNets instead of solverNets

gatherLauncherStatus now emits one entry per joinedSolverNets membership.
solverType is derived from contract.id + '.' + contract.version; the
display name is joined.name ?? cid. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Drain reader — `client/src/api/launcher-tasks.ts`

**Files:**
- Modify: `client/src/api/launcher-tasks.ts`
- Test: ensure existing coverage of `gatherLauncherTasks` exercises the joined path; if no test file exists, add `client/test/api/launcher-tasks.test.ts` with one fixture covering the `buildSolverTypeToNetIndex` joined-only path.

`buildSolverTypeToNetIndex` (line 121) builds a `solverType → net-display-name` map. Switch it to read `joinedSolverNets` and synthesise `solverType` from `contract`.

- [ ] **Step 7.1: Write the failing test (or extend an existing one)**

If `client/test/api/launcher-tasks.test.ts` does not exist, create it with:

```ts
import { describe, expect, it } from 'vitest';
import { gatherLauncherTasks } from '../../src/api/launcher-tasks.js';
import type { JinnConfig } from '../../src/config.js';

describe('gatherLauncherTasks', () => {
  it('labels posted tasks by joinedSolverNets display name when no solverNet is recorded', async () => {
    const config = {
      joinedSolverNets: {
        'legacy:swe-rebench-v2': {
          manifestCid: 'legacy:swe-rebench-v2',
          name: 'swe-rebench-v2',
          contract: { id: 'swe-rebench-v2', version: 'v1' },
          roles: ['solver'],
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;
    const response = await gatherLauncherTasks({
      config,
      creatorAddress: '0xabc',
      fetchPostedTasks: () => [{
        taskId: 't1',
        taskCid: 'cid1',
        solverType: 'swe-rebench-v2.v1',
        postedAt: '2026-05-25T00:00:00Z',
        budget: { totalWei: '0' },
      }],
    });
    expect(response.tasks[0]?.solverNet).toBe('swe-rebench-v2');
  });
});
```

- [ ] **Step 7.2: Run the test to verify it fails**

Run: `cd client && yarn test --run launcher-tasks`
Expected: FAIL — `Property 'solverNets' does not exist` or wrong solverNet label.

- [ ] **Step 7.3: Refactor `launcher-tasks.ts`**

1. Change `GatherLauncherTasksDeps['config']` (line 83) to `Pick<JinnConfig, 'joinedSolverNets'>`.
2. Rewrite `buildSolverTypeToNetIndex` (lines 121–133):
   ```ts
   function buildSolverTypeToNetIndex(
     joinedSolverNets: JinnConfig['joinedSolverNets'] | undefined,
   ): Map<string, string> {
     const index = new Map<string, string>();
     if (!joinedSolverNets) return index;
     for (const [cid, joined] of Object.entries(joinedSolverNets)) {
       if (!joined.contract) continue;
       const solverType = `${joined.contract.id}.${joined.contract.version}`;
       const displayName = joined.name ?? cid;
       if (!index.has(solverType)) index.set(solverType, displayName);
     }
     return index;
   }
   ```
3. Update the call site at line 193 to pass `deps.config.joinedSolverNets`.

- [ ] **Step 7.4: Run the test to verify it passes**

Run: `cd client && yarn test --run launcher-tasks`
Expected: PASS.

- [ ] **Step 7.5: Commit**

```bash
git add client/src/api/launcher-tasks.ts client/test/api/launcher-tasks.test.ts
git commit -m "$(cat <<'EOF'
refactor(launcher-tasks): build solverType→net index from joinedSolverNets

buildSolverTypeToNetIndex now reads joinedSolverNets and synthesises solverType
from contract.id + '.' + contract.version. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Drain reader — `client/src/api/bootstrap-endpoint.ts`

**Files:**
- Modify: `client/src/api/bootstrap-endpoint.ts`
- Modify: `client/test/api/bootstrap-endpoint.test.ts`

Drop the `solverNets` field from `BootstrapEndpointConfig.configReader`'s return type and from the `/v1/bootstrap` response envelope.

- [ ] **Step 8.1: Write the failing test**

In `client/test/api/bootstrap-endpoint.test.ts`, add (or update) a test that asserts the response payload has no `solverNets` field, only `joinedSolverNets`:

```ts
it('does not echo a `solverNets` field even when configReader returns a legacy block', async () => {
  // Even if the daemon's configReader accidentally returned a `solverNets`
  // value (it should not — Task 11 retires that callback), the endpoint must
  // not leak it onto the wire. Acceptance criterion: the response has only
  // joinedSolverNets per spec §12.
  /* ... build a Hono test app, hit GET /v1/bootstrap, assert response.body */
  expect(body).not.toHaveProperty('solverNets');
  expect(body).toHaveProperty('joinedSolverNets');
});
```

- [ ] **Step 8.2: Run the test to verify it fails**

Run: `cd client && yarn test --run bootstrap-endpoint`
Expected: FAIL.

- [ ] **Step 8.3: Update the endpoint**

In `client/src/api/bootstrap-endpoint.ts`:

1. Drop `solverNets?:` from the `BootstrapEndpointConfig.configReader` return type (lines 22–28).
2. Drop the `solverNets?:` member from the `interface { ... }` declaration if any other place declares it.
3. Delete line 213: `...(cfg.solverNets !== undefined ? { solverNets: cfg.solverNets } : {}),`.

- [ ] **Step 8.4: Run tests to verify they pass**

Run: `cd client && yarn test --run bootstrap-endpoint`
Expected: PASS.

- [ ] **Step 8.5: Commit**

```bash
git add client/src/api/bootstrap-endpoint.ts client/test/api/bootstrap-endpoint.test.ts
git commit -m "$(cat <<'EOF'
refactor(bootstrap-endpoint): drop legacy solverNets echo from /v1/bootstrap

The endpoint response now carries joinedSolverNets only. Configs that still
have a legacy block on disk are auto-migrated by loadConfig; the wire shape
is uniform. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Retire the POST route — `client/src/api/setup-endpoints.ts`

**Files:**
- Modify: `client/src/api/setup-endpoints.ts`
- Modify: `client/test/api/setup-endpoints.test.ts` (or create if absent)

The POST `/v1/setup/solvernets/:name` route persists into the now-removed `solverNets` field. (Earlier plan drafts mislabelled the verb as PATCH; the live verb on `origin/next` is POST — confirm via `git show origin/next:client/src/api/setup-endpoints.ts | grep solvernets`.) Replace its body with a 410 Gone response pointing operators at `POST /v1/operator/join/:cid`.

- [ ] **Step 9.1: Write the failing test**

In `client/test/api/setup-endpoints.test.ts` (find or create), add:

```ts
it('POST /v1/setup/solvernets/:name returns 410 Gone with route_retired envelope', async () => {
  const res = await app.request('/v1/setup/solvernets/prediction', {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(410);
  const body = await res.json();
  expect(body).toMatchObject({
    error: 'route_retired',
    detail: expect.stringMatching(/operator\/join/),
  });
});
```

- [ ] **Step 9.2: Run the test to verify it fails**

Run: `cd client && yarn test --run setup-endpoints`
Expected: FAIL.

- [ ] **Step 9.3: Replace the POST route body**

In `client/src/api/setup-endpoints.ts`, replace the entire POST route handler (`app.post('/v1/setup/solvernets/:name', ...)` start through the closing `});`) with:

```ts
  app.post('/v1/setup/solvernets/:name', (c) =>
    c.json({
      error: 'route_retired',
      detail:
        'POST /v1/setup/solvernets/:name was retired in issue #421. ' +
        'Use POST /v1/operator/join/:cid to join a SolverNet via the registry, ' +
        'or open Operator > SolverNets in the dashboard.',
    }, 410),
  );
```

Also delete the import / reference to `DEFAULT_SOLVER_NETS` if it appears in this file — the whole handler body is gone, so any `Object.keys(DEFAULT_SOLVER_NETS)` inside the old handler is now dead code.

- [ ] **Step 9.4: Run tests to verify they pass**

Run: `cd client && yarn test --run setup-endpoints`
Expected: PASS.

- [ ] **Step 9.5: Commit**

```bash
git add client/src/api/setup-endpoints.ts client/test/api/setup-endpoints.test.ts
git commit -m "$(cat <<'EOF'
refactor(setup-endpoints): retire POST /v1/setup/solvernets/:name (410 Gone)

The route persisted into the now-removed legacy solverNets block. Operators
join SolverNets via POST /v1/operator/join/:cid (and the SPA Operator >
SolverNets surface). Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Drain reader — `client/src/cli/task-native-readiness.ts`

**Files:**
- Modify: `client/src/cli/task-native-readiness.ts`
- Test: extend or add `client/test/cli/task-native-readiness.test.ts` (create if absent).

`hasConfiguredEvaluatorRole` checks legacy `solverNets` then `joinedSolverNets`. Drop the legacy branch.

- [ ] **Step 10.1: Write the failing test**

In `client/test/cli/task-native-readiness.test.ts`:

```ts
it('detects evaluator role from joinedSolverNets only', () => {
  const config = {
    network: 'testnet',
    earningDir: '/tmp',
    joinedSolverNets: {
      cid1: {
        manifestCid: 'cid1',
        roles: ['evaluator'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
    },
  } as unknown as JinnConfig;
  expect(resolveTaskNativeReadiness(config).evaluatorRoleReady).toBe(true);
});
```

- [ ] **Step 10.2: Run the test to verify it fails**

Run: `cd client && yarn test --run task-native-readiness`
Expected: FAIL.

- [ ] **Step 10.3: Drop the legacy branch**

In `client/src/cli/task-native-readiness.ts`, replace `hasConfiguredEvaluatorRole` (lines 58–67) with:

```ts
function hasConfiguredEvaluatorRole(config: JinnConfig): boolean {
  const joinedSolverNets = Object.values(config.joinedSolverNets ?? {});
  return joinedSolverNets.some((entry) => entry.roles.includes('evaluator'));
}
```

- [ ] **Step 10.4: Run tests to verify they pass**

Run: `cd client && yarn test --run task-native-readiness`
Expected: PASS.

- [ ] **Step 10.5: Commit**

```bash
git add client/src/cli/task-native-readiness.ts client/test/cli/task-native-readiness.test.ts
git commit -m "$(cat <<'EOF'
refactor(cli/task-native-readiness): joined-only evaluator-role detection

hasConfiguredEvaluatorRole no longer reads config.solverNets. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Drain reader — `client/src/cli/commands/tasks.ts`

**Files:**
- Modify: `client/src/cli/commands/tasks.ts`
- Test: `client/test/cli/commands/tasks.test.ts` (find or create)

`--solver-net` resolution: look the requested name up by joined display name OR by manifestCid; derive `solverType` from `joined.contract`.

- [ ] **Step 11.1: Write the failing test**

In `client/test/cli/commands/tasks.test.ts`:

```ts
it('resolves --solver-net by joined name and derives solverType from contract', async () => {
  // arrange: loadConfig returns a joinedSolverNets-only fixture
  // act: run `jinn tasks submit --solver-net prediction --description X --dry-run`
  // assert: the spec carries solverType 'prediction.v1' (joined.contract.id + '.' + version)
});

it('rejects --solver-net <unknown> with the joined names listed in `expected`', async () => {
  // assert: details.expected is the pipe-joined list of joined display names
});
```

- [ ] **Step 11.2: Run the test to verify it fails**

Run: `cd client && yarn test --run cli/commands/tasks`
Expected: FAIL.

- [ ] **Step 11.3: Refactor `tasks.ts`**

Replace lines 147–160 (the `solverTypeFromNet` derivation block) with:

```ts
function lookupJoined(
  joined: JinnConfig['joinedSolverNets'] | undefined,
  needle: string,
): { name: string; solverType: string } | undefined {
  if (!joined) return undefined;
  for (const [cid, entry] of Object.entries(joined)) {
    const displayName = entry.name ?? cid;
    if (displayName === needle || cid === needle || entry.manifestCid === needle) {
      if (!entry.contract) continue;
      return { name: displayName, solverType: `${entry.contract.id}.${entry.contract.version}` };
    }
  }
  return undefined;
}

const joinedLookup = requestedSolverNet
  ? lookupJoined(config.joinedSolverNets, requestedSolverNet)
  : undefined;
const solverTypeFromNet = joinedLookup?.solverType;
if (requestedSolverNet && !solverTypeFromNet) {
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown SolverNet: ${requestedSolverNet}`,
      exampleCli: 'jinn solver-nets list',
      details: {
        field: '--solver-net',
        expected: Object.values(config.joinedSolverNets ?? {})
          .map((entry, cid) => entry.name ?? entry.manifestCid ?? cid)
          .join('|'),
      },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
  return;
}
```

- [ ] **Step 11.4: Run tests to verify they pass**

Run: `cd client && yarn test --run cli/commands/tasks`
Expected: PASS.

- [ ] **Step 11.5: Commit**

```bash
git add client/src/cli/commands/tasks.ts client/test/cli/commands/tasks.test.ts
git commit -m "$(cat <<'EOF'
refactor(cli/tasks): resolve --solver-net via joinedSolverNets

Looks up the SolverNet by joined display name or manifestCid; derives
solverType from contract.id + '.' + contract.version. The error envelope's
`expected` field lists joined display names. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Drain reader — `client/src/cli/commands/solver-nets.ts` (list subverb + dep-warning)

**Files:**
- Modify: `client/src/cli/commands/solver-nets.ts`

The CLI is a debugging surface for operators. The `list` subverb currently reads `loaded.solverNets` (validated config) and `loaded.joinedSolverNets`. After Task 2, `loaded.solverNets` is undefined. Drop the `legacy` array entirely; emit only the joined entries. Mutation subverbs (`enable`/`disable`/`set-harness`/`add-plugin`/`remove-plugin`/`sample`) operate on raw JSON via `readConfig`/`writeConfig`; print a single deprecation `console.warn` line when invoked and let them write to legacy-shaped files for one upgrade cycle.

- [ ] **Step 12.1: Update the `list` subverb**

In `client/src/cli/commands/solver-nets.ts` (lines 375–411):

Replace the body with a joined-only list:

```ts
if (!subverb || subverb === 'list') {
  const loaded = loadConfig(configPath);
  const joined = Object.entries(loaded.joinedSolverNets ?? {}).map(([cid, net]) => ({
    name: net.name ?? cid,
    source: 'joined' as const,
    manifestCid: cid,
    enabled: true,
    solverType: net.contract ? `${net.contract.id}.${net.contract.version}` : '(unknown)',
    harness: net.harness,
    pluginCount: (net.plugins ?? []).length,
    taskGeneratorEnabled: false,
  }));
  const value = {
    verb: 'solver-nets list',
    configPath,
    solverNets: joined,
  };
  emit(ctx, value, human, json, (v) => {
    const list = v as typeof value;
    if (list.solverNets.length === 0) return 'No SolverNets configured.';
    return list.solverNets
      .map((n) =>
        `${n.name}  ${n.enabled ? 'enabled' : 'disabled'}  ${n.solverType}  ` +
        `harness=${n.harness ?? '(default)'}  plugins=${n.pluginCount}  ` +
        `generator=${n.taskGeneratorEnabled ? 'on' : 'off'}  source=${n.source}  cid=${n.manifestCid}`,
      )
      .join('\n');
  });
  return;
}
```

- [ ] **Step 12.2: Print a deprecation warning for mutation subverbs**

In the section that handles `enable`/`disable`/`set-harness`/`add-plugin`/`remove-plugin`/`sample`/`doctor` (after the `if (!name) { fail(...) }` block, around line 491), insert immediately above `const solverNets = ensureSolverNets(cfg);`:

```ts
if (subverb !== 'show' && subverb !== 'doctor') {
  process.stderr.write(
    `[solver-nets] WARNING: subverb '${subverb}' edits the legacy solverNets ` +
    `file shape (issue #421). The daemon auto-migrates this on next load; ` +
    `re-join via the SPA (Operator > SolverNets) to replace synthetic legacy:* ` +
    `keys with real manifest CIDs.\n`,
  );
}
```

These mutation subverbs continue to work on raw JSON via `readConfig`/`writeConfig`; they do not call `loadConfig`. The deprecation message surfaces in the operator's terminal so they know the surface is on the way out.

- [ ] **Step 12.3: Run existing CLI tests**

Run: `cd client && yarn test --run cli/commands/solver-nets`
Expected: tests that exercise `list` may need updates (the test fixtures used to construct a legacy file and inspect the output); fix any assertions that expect a `legacy` source label.

Update those tests in `client/test/cli/commands/solver-nets.test.ts` so they:
1. Write a joined-style config file (or a legacy-shaped file that the loader will migrate).
2. Assert the `list` output contains the joined-source label only.

- [ ] **Step 12.4: Run typecheck and tests**

Run: `cd client && yarn typecheck 2>&1 | grep "solver-nets.ts"`
Expected: 0 errors in `cli/commands/solver-nets.ts`.

Run: `cd client && yarn test --run cli/commands/solver-nets`
Expected: PASS.

- [ ] **Step 12.5: Commit**

```bash
git add client/src/cli/commands/solver-nets.ts client/test/cli/commands/solver-nets.test.ts
git commit -m "$(cat <<'EOF'
refactor(cli/solver-nets): joined-only list; deprecation warning on mutation subverbs

The `list` subverb iterates joinedSolverNets exclusively. Mutation subverbs
(enable/disable/set-harness/add-plugin/remove-plugin/sample) keep working on
raw JSON for one upgrade cycle, with a deprecation warning pointing operators
at the SPA Operator > SolverNets surface. Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Drain reader — `client/src/scripts/donation-consumption-acceptance.ts`

**Files:**
- Modify: `client/src/scripts/donation-consumption-acceptance.ts`
- Modify: `client/test/scripts/donation-consumption-acceptance.test.ts`

Two reads to drop:
1. `cloneSolverNetsForConsumer(opts.producerConfig.solverNets)` (line 652) — delete entirely. The consumer config inherits the producer's `joinedSolverNets` only.
2. `assertConsumerConfiguredForSwe`'s legacy SWE branch (lines 796–809) — delete the `solverNets` read and the `legacySweEntries` accumulator; rely solely on `solverEntries` / `evaluatorEntries` from `joinedSolverNets`.

- [ ] **Step 13.1: Write the failing test**

In `client/test/scripts/donation-consumption-acceptance.test.ts`, add:

```ts
it('builds a consumer config without a legacy solverNets block', () => {
  const consumerCfg = buildConsumerConfig({
    producerConfig: {
      joinedSolverNets: {
        cid1: { manifestCid: 'cid1', name: 'swe', contract: { id: 'swe-rebench-v2', version: 'v1' }, roles: ['solver'], plugins: [] },
      },
      // No legacy solverNets block.
    } as unknown as Record<string, unknown>,
    consumerHome: '/tmp/consumer',
    consumerPort: 8080,
    indexerUrl: 'http://localhost:42424',
    ipfsGatewayUrl: 'http://localhost:8080',
  });
  expect((consumerCfg as unknown as Record<string, unknown>).solverNets).toBeUndefined();
  expect(consumerCfg.joinedSolverNets).toBeDefined();
});

it('asserts SWE-rebench v2 configuration via joinedSolverNets only', () => {
  // Build a fixture with joined solver+evaluator entries; call
  // assertConsumerConfiguredForSwe; expect no throw.
});
```

- [ ] **Step 13.2: Run the test to verify it fails**

Run: `cd client && yarn test --run donation-consumption-acceptance`
Expected: FAIL.

- [ ] **Step 13.3: Drop the legacy paths**

In `client/src/scripts/donation-consumption-acceptance.ts`:

1. Delete the `cloneSolverNetsForConsumer` function (lines 741–754).
2. In `buildConsumerConfig` (line 644), remove `const solverNets = cloneSolverNetsForConsumer(...)` and the `...(solverNets ? { solverNets } : {})` spread.
3. In `assertConsumerConfiguredForSwe`, delete lines 796–809 (the `solverNets` accumulator + `legacySweEntries` filter). Combine the post-conditions so the function relies only on `solverEntries`, `evaluatorEntries`, and `joinedRuntimeEnabled`.
4. Delete any `LocalConfig.solverNets` declaration if `LocalConfig` is defined in this file.

- [ ] **Step 13.4: Run tests to verify they pass**

Run: `cd client && yarn test --run donation-consumption-acceptance`
Expected: PASS.

- [ ] **Step 13.5: Commit**

```bash
git add client/src/scripts/donation-consumption-acceptance.ts client/test/scripts/donation-consumption-acceptance.test.ts
git commit -m "$(cat <<'EOF'
refactor(scripts): drop legacy solverNets paths in donation acceptance

buildConsumerConfig no longer clones a solverNets block; assertConsumerConfiguredForSwe
asserts the swe-rebench-v2 configuration via joinedSolverNets exclusively.
Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Drain reader — `client/src/main.ts` (bootstrap configReader, onSolverNetsUpdated, launcher generator wiring)

**Files:**
- Modify: `client/src/main.ts`

Three changes:

1. **Line 1077** — drop `solverNets: config.solverNets as Record<string, unknown> | undefined,` from the `configReader` projection passed to bootstrap-endpoint deps. Bootstrap responses no longer echo legacy solverNets.

2. **Lines 1199–1207 and 1282–1285** — the `onSolverNetsUpdated` callbacks wrote `solverNets` back into `config`. These are dead with the schema removal. Replace with `onJoinedSolverNetsUpdated` callbacks that write `config.joinedSolverNets`, OR (preferred) remove them entirely if no caller (`/v1/operator/join/:cid` already mutates `config.joinedSolverNets` directly via its own write path). Confirm by `grep -n 'onSolverNetsUpdated\|onJoinedSolverNetsUpdated' client/src/api/`.

3. **Lines 1276, 1290, 1295** — the `launcher.getConfig`, `launcher.getGeneratorState`, `launcher.getOpenTaskCount` all read `config.solverNets`. The launched-record subsystem owns generator ownership now; the only legitimate lookup is "what `solverType` corresponds to this `netName` for accounting?" — derive it from `joinedSolverNets` instead. Rewrite:

```ts
launcher: {
  getConfig: () => ({ joinedSolverNets: config.joinedSolverNets }),
  // … (configPath, onSolverNetsUpdated drop)
  getGeneratorState: (netName) => {
    if (netName === 'prediction') {
      return predictionGeneratorRef?.getState();
    }
    const joined = Object.values(config.joinedSolverNets ?? {})
      .find((entry) => (entry.name ?? entry.manifestCid) === netName);
    if (!joined?.contract) return undefined;
    const solverType = `${joined.contract.id}.${joined.contract.version}`;
    return launchedGeneratorStateBySolverType.get(solverType)?.();
  },
  getOpenTaskCount: (netName) => {
    const joined = Object.values(config.joinedSolverNets ?? {})
      .find((entry) => (entry.name ?? entry.manifestCid) === netName);
    if (!joined?.contract || !safeAddressForLauncher) return 0;
    return sharedStore.countPostedTasksByCreatorAndSolverType({
      creatorSafeAddress: safeAddressForLauncher,
      solverType: `${joined.contract.id}.${joined.contract.version}`,
    });
  },
  // … (rest)
},
```

- [ ] **Step 14.1: Confirm baseline typecheck failures point at the three sites**

Run: `cd client && yarn typecheck 2>&1 | grep main.ts`
Expected: errors at lines 1077, 1200, 1276, 1283, 1290, 1295 (or thereabouts).

- [ ] **Step 14.2: Apply the three changes above**

Use `Edit` to make each replacement; preserve the surrounding comments (they document the launcher-mode wiring evolution).

- [ ] **Step 14.3: Run typecheck and full daemon test suite**

Run: `cd client && yarn typecheck 2>&1 | grep main.ts`
Expected: 0 errors.

Run: `cd client && yarn test --run main`
Expected: PASS (and the `daemon` test suite stays green).

- [ ] **Step 14.4: Commit**

```bash
git add client/src/main.ts
git commit -m "$(cat <<'EOF'
refactor(main): drain config.solverNets readers from daemon wiring

- /v1/bootstrap configReader stops echoing solverNets
- onSolverNetsUpdated callbacks removed (write target is gone)
- launcher.getGeneratorState/getOpenTaskCount resolve solverType from
  joinedSolverNets[*].contract instead of solverNets[netName].solverType

Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: SPA — drop the legacy fallback in `Overview.tsx` and the type member in `types.ts`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/Overview.tsx`
- Modify: `client/src/dashboard/spa/src/api/types.ts`
- Modify: `client/src/dashboard/spa/src/pages/Overview.test.tsx`

The wave-2 symptom: when an operator leaves every joined SolverNet, `joinedNets` falls through to `bootstrap?.solverNets` (Overview.tsx lines 340–361) and the Overview keeps rendering "SOLVING ON prediction". After the daemon stops echoing `solverNets` (Task 14), the SPA still has a dead fallback branch; remove it.

- [ ] **Step 15.1: Write the failing test (Overview shows empty-state when joined is empty)**

In `client/src/dashboard/spa/src/pages/Overview.test.tsx`, add a test that confirms an empty `joinedSolverNets` produces no joined rows and the "no SolverNets joined" message renders (closes the wave-2 symptom):

```ts
it('shows the no-active-SolverNet state when joinedSolverNets is empty (issue #421 wave-2 fix)', async () => {
  getStatusMock.mockResolvedValue({ fleet: { services: [] } });
  getBootstrapMock.mockResolvedValue({ joinedSolverNets: {} });
  render(withProviders(<OverviewPage />));
  await waitFor(() => {
    const joined = screen.getByTestId('activity-joined');
    expect(joined.textContent).toMatch(/no solvernets joined/i);
  });
  // No legacy fallback row appears.
  expect(screen.queryByTestId('activity-joined-row-prediction')).toBeNull();
});

it('ignores a stale legacy bootstrap.solverNets when joinedSolverNets is empty', async () => {
  getStatusMock.mockResolvedValue({ fleet: { services: [] } });
  // Even if the daemon echoes a legacy block (which it should not after Task 14),
  // the SPA must not fall through to it.
  getBootstrapMock.mockResolvedValue({
    solverNets: { prediction: { enabled: true, roles: ['solving'] } },
    joinedSolverNets: {},
  });
  render(withProviders(<OverviewPage />));
  await waitFor(() => {
    expect(screen.getByTestId('activity-joined').textContent).toMatch(/no solvernets joined/i);
  });
});
```

- [ ] **Step 15.2: Run the test to verify it fails**

Run: `cd client && yarn test --run Overview`
Expected: FAIL — the second test fails because the legacy fallback still renders the `prediction` row.

- [ ] **Step 15.3: Drop the legacy fallback and type member**

In `client/src/dashboard/spa/src/pages/Overview.tsx`:

1. Delete the `solverNets?: Record<...>` member from `interface BootstrapWithSolverNets` (lines 24–33).
2. Delete the fallback branch in `joinedNets` (lines 339–361): remove `if (out.length > 0) return out;` plus the `const legacy = bootstrap?.solverNets; if (legacy) { ... }` block. The function now returns the joined-only result directly:
   ```ts
   const joinedNets: ActivityJoinedNet[] = useMemo(() => {
     const out: ActivityJoinedNet[] = [];
     const j = bootstrap?.joinedSolverNets;
     if (!j) return out;
     for (const [key, entry] of Object.entries(j)) {
       /* ...existing projection... */
     }
     return out;
   }, [bootstrap, catalog]);
   ```
3. Remove the JSDoc reference to "legacy short-name `solverNets` shape (a relic of pre-spec-§12 configs)" (lines 300–304) and replace with one line: "Joined: project `bootstrap.joinedSolverNets` into the ActivityCard shape."

In `client/src/dashboard/spa/src/api/types.ts`:

1. Delete the `solverNets?: Record<string, { ... }>;` block (lines 132–137).

- [ ] **Step 15.4: Run tests to verify they pass**

Run: `cd client && yarn test --run Overview`
Expected: PASS — both the wave-2 fix test and the stale-legacy ignore test pass.

Run: `cd client && yarn test --run ActivityCard`
Expected: PASS (no new test needed — the empty-state already shows "no solvernets joined").

- [ ] **Step 15.5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/Overview.tsx client/src/dashboard/spa/src/api/types.ts client/src/dashboard/spa/src/pages/Overview.test.tsx
git commit -m "$(cat <<'EOF'
fix(spa/Overview): drop legacy solverNets fallback (closes #421 wave-2 symptom)

joinedNets now reads exclusively from bootstrap.joinedSolverNets. The
`solverNets?:` member is removed from BootstrapWithSolverNets / types.ts.
Operators who leave every joined SolverNet now see the no-active-SolverNet
empty-state instead of a stale "SOLVING ON prediction" label.

Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Final typecheck + full-suite regression run

- [ ] **Step 16.1: Full typecheck**

Run: `cd client && yarn typecheck`
Expected: 0 errors. Any remaining `Property 'solverNets' does not exist on type 'JinnConfig'` indicates a missed reader; locate and drain it before continuing.

- [ ] **Step 16.2: Full test suite**

Run: `cd client && yarn test --run`
Expected: all tests pass. If a test fixture in a file not touched above still constructs a `config.solverNets` object, update it to use `joinedSolverNets` (no production code reads the field, but a typed test fixture that declares `JinnConfig` will fail to compile).

- [ ] **Step 16.3: Lint (if the project uses ESLint)**

Run: `cd client && yarn lint 2>/dev/null || true`
Expected: clean. Skip if no lint script.

- [ ] **Step 16.4: Acceptance-criteria sweep**

Mentally walk the four issue-421 acceptance criteria and verify each is closed:

1. *"Legacy short-name-keyed `solverNets` block is removed from the config schema and all readers."*
   → Closed by Task 2 (schema field gone) + Tasks 3–14 (readers drained).
2. *"Prediction operator-UX, the `/v1/bootstrap` payload, and Overview SOLVING ON detection are driven solely by `joinedSolverNets`."*
   → Closed by Task 4 (prediction-operator-ux) + Task 8 (bootstrap-endpoint) + Task 15 (Overview).
3. *"Existing `~/.jinn-client/config.json` files containing a `solverNets` block still load without an operator-facing break."*
   → Closed by Tasks 1 + 2 (auto-migration into synthetic-keyed `joinedSolverNets`).
4. *"Leaving all SolverNets shows the no-active-SolverNet state on the Overview."*
   → Closed by Task 15 (legacy fallback removed; existing `ActivityCard` empty-state suffices).

- [ ] **Step 16.5: Final integration regression — daemon-harness e2e (optional but recommended)**

Run: `cd client && yarn e2e:daemon-harness` (skips when no API key in env; otherwise exercises the full daemon → harness → Anvil settlement loop)
Expected: pass with `JINN_E2E_HARNESS=prediction-v1-baseline` (default). The e2e is the safety-net for any code path the typed unit tests can't reach.

- [ ] **Step 16.6: Commit any e2e-revealed fixups (if needed)**

If e2e surfaces a regression (e.g. a runtime read of `config.solverNets` via dynamic property access that TypeScript missed), fix it and commit:

```bash
git add <files>
git commit -m "$(cat <<'EOF'
fix(daemon): cover dynamic config.solverNets read missed by static analysis

Refs #421.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (after writing this plan)

**Spec coverage:**
- §"Chosen approach" hard-remove → Task 2 ✓
- §"Migration strategy" auto-migrate with synthetic keys → Tasks 1, 2 ✓
- §"Sub-question answers" 1 (deprecation path) → Task 1, 2 ✓
- §"Sub-question answers" 2 (prediction-operator-ux drops `name`) → Task 4 ✓
- §"Sub-question answers" 3 (`/v1/bootstrap` joinedSolverNets only) → Tasks 8, 14 ✓
- §"Sub-question answers" 4 (Overview empty-state) → Task 15 (uses existing ActivityCard empty-state) ✓
- §"Sub-question answers" 5 (PR shape) — coordinator overrode to one PR; plan structured accordingly ✓
- §"Out of scope" (solverType to manifest-CID) — not implemented; honored.

**Coordinator constraints:**
- Single PR ✓
- Load-time auto-migration with `legacy:<short-name>` synthetic keys ✓
- All listed readers drained: prediction-operator-ux ✓ (Task 4), gather-status ✓ (Task 5), launcher-status ✓ (Task 6), main.ts launcher routes + bootstrap echo ✓ (Task 14), cli/commands/tasks.ts ✓ (Task 11), cli/task-native-readiness.ts ✓ (Task 10), scripts/donation-consumption-acceptance.ts ✓ (Task 13), registry.ts ✓ (Task 3). Adds launcher-tasks.ts ✓ (Task 7), bootstrap-endpoint.ts ✓ (Task 8), setup-endpoints.ts ✓ (Task 9), cli/commands/solver-nets.ts ✓ (Task 12) — all of which had legacy reads the design note's checklist also flagged.
- `solverNets` removed from schema + `DEFAULT_SOLVER_NETS` removed ✓ (Task 2)
- SPA Overview legacy-shape fallback removed + empty-state confirmed ✓ (Task 15)

**Acceptance-criteria coverage (issue #421):**
1. Removed from schema + readers — Tasks 2 + 3–14
2. Prediction-UX / bootstrap / Overview joined-only — Tasks 4 + 8 + 15
3. Existing on-disk configs still load — Tasks 1 + 2 (auto-migration tested in unit + integration suites)
4. No-active-SolverNet empty-state on Overview — Task 15

**Placeholder scan:** No "TBD" or "implement later" markers. Each code step gives complete code; each test step gives runnable test code. The SPA test step references `getStatusMock` and `getBootstrapMock` which are existing fixtures in `Overview.test.tsx`; the executor should preserve the test-file's existing imports.

**Type consistency:** `migrateLegacySolverNets` exported from `client/src/config.ts`, imported by test at the same path. `JoinedSolverNetConfig` (`client/src/solver-nets/registry.ts`) is the canonical type for joined entries. `BootstrapWithSolverNets` loses `solverNets?:` in lockstep with `OverviewBootstrap` (`api/types.ts`). `derivePredictionSolverNetName` keeps its signature `(config: JinnConfig) => string` — the cache key (`configPath, name`) is unchanged.

**Risk notes for the executor:**
- The `cli/commands/solver-nets.ts` mutation subverbs (Task 12) deliberately keep working on raw JSON via `readConfig`/`writeConfig`. They write to legacy-shaped files. The next `loadConfig` call migrates them. This is the "one upgrade cycle" path. If the executor finds this fragile, the safer fallback is to retire those subverbs entirely (return 410-shaped errors); that is a strictly larger change and should be deferred to a follow-up issue rather than expanding this PR's scope.
- The `POST /v1/setup/solvernets/:name` 410 (Task 9) is a behavior change. Any SPA caller of that route must be updated; do a project-wide search (`grep -rn '/v1/setup/solvernets'` under `client/src/dashboard/spa/src/`) before Task 9 to confirm no live caller depends on it. If a caller exists, retire it as part of Task 15 or open a follow-up issue.
- Tests that mock `JinnConfig` with `as unknown as JinnConfig` casts may silently keep working with a `solverNets` field even after the schema strips it. Run `yarn typecheck` after every task so the executor isn't relying on tests alone to catch missed readers.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-retire-legacy-solvernets-config-plan.md`.

This is being executed by Stage 3 (`implement-issue` / `superpowers:executing-plans`) — proceed task-by-task with checkpoints at each `git commit` step. The plan is structured so each task ends with a green-CI commit (`yarn typecheck` + relevant `yarn test --run <suite>`); the executor can safely pause between tasks.
