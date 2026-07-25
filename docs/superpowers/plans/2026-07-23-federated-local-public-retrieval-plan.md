# Federated Local and Public Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Jinn pickup retrieve from the operator's retained local episodes and the public corpus, rank both sources together, and avoid redelivering the same canonical episode when Hermes detects a new task or repository.

**Architecture:** Adapt the existing `EvidencePort` into a local `CorpusPort`, compose it with the existing public adapter behind a failure-tolerant federated `CorpusPort`, and keep all relevance, visibility, deduplication, and packet-budget policy in `packages/plugin`. Extend the additive v1 process contract so Hermes can carry canonical episode exclusions across its one-process-per-pickup boundary.

**Tech Stack:** TypeScript 5, Zod 4, Vitest 4, Node 22, Python 3.11–3.13, pytest through Hermes's `scripts/run_tests.sh`.

## Global Constraints

- Implement the approved design in
  `docs/superpowers/specs/2026-07-23-federated-local-public-retrieval-design.md`.
- Keep `CorpusPort` generic. It exposes content facts and canonical identity;
  it does not decide usefulness or retrievability.
- Preserve the current `retrievalVisible` shortcut for this PR:
  local projections are always `true`; public projections preserve their
  stored/legacy value; the existing Jinn pre- and post-fetch guards remain.
- Do not change publication, consent, scrubbing, retention, indexer schemas,
  seed data, OpenViking, usefulness selection, or public service behavior.
- Keep the process contract at version 1. New request and response fields are
  additive and default to empty arrays.
- Preserve the global packet cap of two. Do not introduce a per-source quota or
  source score bonus.
- `overrides.corpus` replaces the complete default federation.
  `overrides.evidence` must back both persistence and default local retrieval.
- The timeout circuit lives for the federated adapter instance. The production
  process bridge creates a fresh adapter for each `jinn-layer session pickup`,
  so that instance is the invocation boundary; do not add lifecycle methods to
  `CorpusPort`.
- For Hermes tests, obey `apps/jinn-agent/AGENTS.md`: use
  `scripts/run_tests.sh`, not direct `pytest`, and isolate `HERMES_HOME`.

---

## Task 1: Add canonical episode identity and a shared Episode projection

**Files:**

- Create: `packages/layer/src/adapters/episode-record.ts`
- Modify: `packages/plugin/src/ports/corpus-port.ts`
- Modify: `packages/plugin/src/schemas/knowledge-hit.ts`
- Modify: `packages/plugin/src/testing/in-memory-corpus.ts`
- Modify: `packages/layer/src/adapters/corpus-adapter.ts`
- Modify: `packages/layer/src/adapters/index.ts`
- Test: `packages/layer/test/adapters/corpus-adapter.test.ts`
- Test: `packages/plugin/test/ports/corpus-port.test.ts`

- [ ] **Step 1: Write failing canonical-identity tests**

Add assertions to the public adapter tests:

```ts
it('projects a canonical EpisodeV1 identity for cross-source dedup', async () => {
  const layer = makeFakeLayer();
  layer.corpus.get = async () => wireRecordWithEpisode(
    { episodeId: 'episode:shared' },
    'bafyPublicShared',
  );

  const result = await createCorpusAdapter({ layer }).get('bafyPublicShared');

  expect(result).toMatchObject({
    status: 'ok',
    value: {
      ref: 'bafyPublicShared',
      canonicalEpisodeId: 'episode:shared',
    },
  });
});

it('uses the legacy trace session id as its canonical identity', async () => {
  const layer = makeFakeLayer();
  layer.corpus.get = async () => wireRecordWithTrace({
    session: {
      sessionId: 'legacy-session:shared',
      capturedAt: '2026-07-04T00:00:00.000Z',
    },
  });

  const result = await createCorpusAdapter({ layer }).get('bafySourceEpisode');

  expect(result).toMatchObject({
    status: 'ok',
    value: { canonicalEpisodeId: 'legacy-session:shared' },
  });
});
```

Extend the port contract test with a seed carrying
`canonicalEpisodeId: 'episode-contract'` and assert that `get()` preserves it
and `search()` may expose the same optional fact.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cd packages/plugin && yarn test test/ports/corpus-port.test.ts
cd packages/layer && yarn test test/adapters/corpus-adapter.test.ts
```

Expected: TypeScript/test failures because neither `CorpusRecord` nor
`KnowledgeHit` has `canonicalEpisodeId`.

- [ ] **Step 3: Add the additive application-level fields**

In `packages/plugin/src/ports/corpus-port.ts`, add:

```ts
export interface CorpusRecord {
  // existing fields...

  /**
   * Canonical EpisodeV1 episodeId, or the legacy trace sessionId used as its
   * read-compatible identity. Application metadata for deduplication only.
   */
  canonicalEpisodeId?: string;
}
```

In `packages/plugin/src/schemas/knowledge-hit.ts`, add:

```ts
canonicalEpisodeId: z.string().min(1).optional(),
```

The local adapter will be the only production search adapter that emits this
hit-level hint in this PR. It lets Jinn locate the preferred local form before
a public record's canonical identity is known.

Update `InMemoryCorpusPort.toKnowledgeHit`:

```ts
...(seed.canonicalEpisodeId !== undefined
  ? { canonicalEpisodeId: seed.canonicalEpisodeId }
  : {}),
```

No stored episode schema changes are required.

- [ ] **Step 4: Extract the pure Episode-to-record projection**

Create `packages/layer/src/adapters/episode-record.ts`:

```ts
import type {
  CorpusRecord,
  EpisodeV1,
} from '@jinn-network/plugin';

export interface EpisodeRecordProjection {
  ref: string;
  origin: string;
  retrievalVisible: boolean;
  isSkillPayload?: boolean;
}

function seedStepSynthesis(
  steps: EpisodeV1['trajectory'],
): string | undefined {
  for (const step of steps) {
    const value = step.attributes['seed.synthesis'];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function hasSkillMdAttribute(steps: EpisodeV1['trajectory']): boolean {
  return steps.some((step) => {
    const value = step.attributes['skill.md'];
    return typeof value === 'string' && value.length > 0;
  });
}

export function episodeToCorpusRecord(
  episode: EpisodeV1,
  projection: EpisodeRecordProjection,
): CorpusRecord {
  const synthesis =
    episode.outcome.summary ?? seedStepSynthesis(episode.trajectory);
  const isSkillPayload =
    projection.isSkillPayload === true
    || hasSkillMdAttribute(episode.trajectory);

  return {
    ref: projection.ref,
    canonicalEpisodeId: episode.episodeId,
    task: {
      summary: episode.task.summary,
      ...(episode.task.repositorySlug
        ? { repositorySlug: episode.task.repositorySlug }
        : {}),
    },
    outcome: {
      status: episode.outcome.status,
      verifiabilityTier: episode.outcome.verificationStrength,
    },
    ...(synthesis ? { synthesis } : {}),
    steps: episode.trajectory.map((step) => ({
      name: step.name,
      attributes: step.attributes,
    })),
    tags: episode.task.distributionTags,
    provenance: episode.provenance,
    origin: projection.origin,
    capturedAt: episode.session.capturedAt,
    retrievalVisible: projection.retrievalVisible,
    ...(isSkillPayload ? { isSkillPayload: true } : {}),
  };
}
```

Export `episodeToCorpusRecord` and `EpisodeRecordProjection` from
`packages/layer/src/adapters/index.ts`.

- [ ] **Step 5: Use the helper for public EpisodeV1 and preserve legacy identity**

Refactor `decodeRecord` in `corpus-adapter.ts` after sha256 verification:

```ts
const raw: unknown = JSON.parse(artifact.content.toString('utf-8'));
const origin =
  record.provenance.operator.agentId
  || record.provenance.operator.safeAddress
  || record.ref;

if (artifact.artifactType === EPISODE_ARTIFACT_TYPE) {
  const declaresRetrievalVisible =
    raw !== null
    && typeof raw === 'object'
    && Object.prototype.hasOwnProperty.call(raw, 'retrievalVisible');
  const episode = EpisodeV1Schema.parse(raw);
  let isSkillPayload = false;
  try {
    isSkillPayload = detectSkillPayload(record, episode.trajectory);
  } catch {
    isSkillPayload = false;
  }
  return episodeToCorpusRecord(episode, {
    ref: record.ref,
    origin,
    retrievalVisible: declaresRetrievalVisible
      ? episode.retrievalVisible
      : hasRetrievalMark(episode.task.distributionTags),
    isSkillPayload,
  });
}
```

Keep the legacy trace projection in `corpus-adapter.ts`, but add:

```ts
canonicalEpisodeId: trace.session.sessionId,
```

Preserve the current sha verification, first-class skill artifact detection,
legacy `skill.md` detection, synthesis fallback, origin fallback, and
visibility fallback.

- [ ] **Step 6: Run focused tests and typechecks**

Run:

```bash
cd packages/plugin && yarn test test/ports/corpus-port.test.ts && yarn typecheck
cd packages/layer && yarn test test/adapters/corpus-adapter.test.ts && yarn typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin/src/ports/corpus-port.ts \
  packages/plugin/src/schemas/knowledge-hit.ts \
  packages/plugin/src/testing/in-memory-corpus.ts \
  packages/plugin/test/ports/corpus-port.test.ts \
  packages/layer/src/adapters/episode-record.ts \
  packages/layer/src/adapters/corpus-adapter.ts \
  packages/layer/src/adapters/index.ts \
  packages/layer/test/adapters/corpus-adapter.test.ts
git commit -m "feat: expose canonical episode identity"
```

---

## Task 2: Preserve public verification strength in search hits

**Files:**

- Modify: `packages/layer/src/consume.ts`
- Modify: `packages/layer/src/adapters/corpus-adapter.ts`
- Test: `packages/layer/test/consume.test.ts`
- Test: `packages/layer/test/adapters/corpus-adapter.test.ts`

- [ ] **Step 1: Write failing public-tier tests**

In `consume.test.ts`, extend the content-aware search test:

```ts
expect(hits[0]!.verifiabilityTier).toBe('user-accepted');
```

In `corpus-adapter.test.ts`, add:

```ts
it('maps a recognized public verification tier without inventing one', async () => {
  const layer = makeFakeLayer();
  layer.corpus.search = async () => [
    makeHit({ verifiabilityTier: 'tests-passed' }),
    makeHit({ ref: 'legacy-no-tier', verifiabilityTier: undefined }),
    makeHit({ ref: 'future-tier', verifiabilityTier: 'future-tier' }),
  ];

  const result = await createCorpusAdapter({ layer }).search('anything');

  expect(result.status).toBe('ok');
  if (result.status !== 'ok') return;
  expect(result.value[0]?.tier).toBe('tests-passed');
  expect(result.value[1]?.tier).toBeUndefined();
  expect(result.value[2]?.tier).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run:

```bash
cd packages/layer && yarn test test/consume.test.ts test/adapters/corpus-adapter.test.ts
```

Expected: the public search type and mapping do not carry
`verifiabilityTier`.

- [ ] **Step 3: Carry the already-indexed fact through `consume.ts`**

Add to `CorpusSearchHit`:

```ts
/** Canonical capture verification strength from capture-meta, when present. */
verifiabilityTier?: string;
```

Add to the capture-meta hit projection:

```ts
...(typeof metaHit.verifiabilityTier === 'string'
  ? { verifiabilityTier: metaHit.verifiabilityTier }
  : {}),
```

Do not modify the indexer, capture-meta protocol, or manifest fallback.

- [ ] **Step 4: Map only recognized tiers in the public adapter**

In `corpus-adapter.ts`:

```ts
import {
  // existing imports...
  TIER_ORDER,
  type Tier,
} from '@jinn-network/plugin';

function pickupTier(value: string | undefined): Tier | undefined {
  return TIER_ORDER.includes(value as Tier) ? value as Tier : undefined;
}
```

Then add to `toKnowledgeHit`:

```ts
const tier = pickupTier(hit.verifiabilityTier);

return {
  // existing fields...
  ...(tier ? { tier } : {}),
};
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
cd packages/layer && yarn test test/consume.test.ts test/adapters/corpus-adapter.test.ts && yarn typecheck
```

Expected: PASS, including the legacy/future-tier cases.

- [ ] **Step 6: Commit**

```bash
git add packages/layer/src/consume.ts \
  packages/layer/src/adapters/corpus-adapter.ts \
  packages/layer/test/consume.test.ts \
  packages/layer/test/adapters/corpus-adapter.test.ts
git commit -m "feat: preserve public verification tier"
```

---

## Task 3: Implement the local Episode corpus adapter

**Files:**

- Create: `packages/layer/src/adapters/local-episode-corpus-adapter.ts`
- Modify: `packages/layer/src/adapters/index.ts`
- Test: `packages/layer/test/adapters/local-episode-corpus-adapter.test.ts`

- [ ] **Step 1: Write the failing local adapter tests**

Create a focused suite using `InMemoryEvidencePort` plus one counting wrapper.
Cover these behavioral invariants:

```ts
it('searches summary and tags case-insensitively and projects every local hit visible');
it('shares one evidence.list call across concurrent term searches');
it('routes an encoded local ref through evidence.get');
it('keeps valid list values when EvidencePort is degraded');
it('propagates unavailable and degraded get outcomes with local-source reasons');
it('does not mutate the stored EpisodeV1 retrievalVisible field');
```

The core fixture:

```ts
const episode = makeEpisode({
  episodeId: 'episode/local:1',
  retrievalVisible: false,
  task: {
    summary: 'Fix Dashboard Version Status',
    distributionTags: ['Vitest', 'Async'],
  },
  outcome: {
    status: 'completed',
    verificationStrength: 'tests-passed',
  },
});
```

Expected hit:

```ts
expect(hit).toMatchObject({
  ref: `local-episode:${encodeURIComponent('episode/local:1')}`,
  canonicalEpisodeId: 'episode/local:1',
  kind: 'trace',
  snippet: 'Fix Dashboard Version Status',
  tags: ['Vitest', 'Async'],
  tier: 'tests-passed',
  origin: 'local:episode/local:1',
  retrievalVisible: true,
});
expect(hit.publishedAt).toBe(Date.parse(episode.session.capturedAt));
```

- [ ] **Step 2: Run the new suite and confirm RED**

Run:

```bash
cd packages/layer && yarn test test/adapters/local-episode-corpus-adapter.test.ts
```

Expected: import/module failure because the adapter does not exist.

- [ ] **Step 3: Implement namespaced references and the lazy snapshot**

Create `local-episode-corpus-adapter.ts`:

```ts
import type {
  CorpusPort,
  EvidencePort,
  EpisodeV1,
  KnowledgeHit,
  PortResult,
} from '@jinn-network/plugin';
import {
  degraded,
  ok,
  unavailable,
} from '@jinn-network/plugin';
import { episodeToCorpusRecord } from './episode-record.js';

export const LOCAL_EPISODE_REF_PREFIX = 'local-episode:';

export function localEpisodeRef(episodeId: string): string {
  return `${LOCAL_EPISODE_REF_PREFIX}${encodeURIComponent(episodeId)}`;
}

function localEpisodeId(ref: string): string | null {
  if (!ref.startsWith(LOCAL_EPISODE_REF_PREFIX)) return null;
  try {
    const value = decodeURIComponent(ref.slice(LOCAL_EPISODE_REF_PREFIX.length));
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface LocalEpisodeCorpusAdapterDeps {
  evidence: EvidencePort;
}

export function createLocalEpisodeCorpusAdapter(
  deps: LocalEpisodeCorpusAdapterDeps,
): CorpusPort {
  let snapshot: Promise<PortResult<EpisodeV1[]>> | undefined;
  const episodes = (): Promise<PortResult<EpisodeV1[]>> => {
    snapshot ??= deps.evidence.list();
    return snapshot;
  };

  // search/get implementation follows in the next step
}
```

- [ ] **Step 4: Implement source-neutral search metadata**

Inside the adapter:

```ts
function toHit(episode: EpisodeV1): KnowledgeHit {
  const publishedAt = Date.parse(episode.session.capturedAt);
  return {
    ref: localEpisodeRef(episode.episodeId),
    canonicalEpisodeId: episode.episodeId,
    kind: 'trace',
    snippet: episode.task.summary,
    tags: episode.task.distributionTags,
    tier: episode.outcome.verificationStrength,
    origin: `local:${episode.episodeId}`,
    ...(Number.isFinite(publishedAt) ? { publishedAt } : {}),
    retrievalVisible: true,
  };
}

async function search(query: string): Promise<PortResult<KnowledgeHit[]>> {
  const result = await episodes();
  if (result.status === 'unavailable') {
    return unavailable(`local corpus: ${result.reason}`);
  }
  const needle = query.toLocaleLowerCase();
  const hits = (result.status === 'ok' ? result.value : result.value ?? [])
    .filter((episode) => [
      episode.task.summary,
      ...episode.task.distributionTags,
    ].some((value) => value.toLocaleLowerCase().includes(needle)))
    .map(toHit);
  return result.status === 'degraded'
    ? degraded(`local corpus: ${result.reason}`, hits)
    : ok(hits);
}
```

Do not inspect trajectories for search and do not add a source score.

- [ ] **Step 5: Implement routed `get()` using the shared helper**

```ts
async function get(ref: string): Promise<PortResult<CorpusRecord | null>> {
  const episodeId = localEpisodeId(ref);
  if (episodeId === null) return ok(null);

  const result = await deps.evidence.get(episodeId);
  if (result.status === 'unavailable') {
    return unavailable(`local corpus: ${result.reason}`);
  }
  const episode = result.status === 'ok' ? result.value : result.value ?? null;
  const value = episode === null
    ? null
    : episodeToCorpusRecord(episode, {
        ref,
        origin: `local:${episode.episodeId}`,
        retrievalVisible: true,
      });
  return result.status === 'degraded'
    ? degraded(`local corpus: ${result.reason}`, value)
    : ok(value);
}

return { search, get };
```

Import `CorpusRecord` in the final file. Export the adapter, ref helper,
prefix, and deps type from `adapters/index.ts`.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
cd packages/layer && yarn test test/adapters/local-episode-corpus-adapter.test.ts && yarn typecheck
```

Expected: PASS. The counting test must assert exactly one `list()` call after
`Promise.all` over several searches.

- [ ] **Step 7: Commit**

```bash
git add packages/layer/src/adapters/local-episode-corpus-adapter.ts \
  packages/layer/src/adapters/index.ts \
  packages/layer/test/adapters/local-episode-corpus-adapter.test.ts
git commit -m "feat: adapt local episodes for retrieval"
```

---

## Task 4: Implement the failure-tolerant federated CorpusPort

**Files:**

- Create: `packages/layer/src/adapters/federated-corpus-adapter.ts`
- Modify: `packages/layer/src/adapters/index.ts`
- Test: `packages/layer/test/adapters/federated-corpus-adapter.test.ts`

- [ ] **Step 1: Write the failing status-table and routing tests**

Use small fake ports whose calls are `vi.fn`. Cover:

```ts
it.each([
  ['ok + ok', ok([localHit]), ok([publicHit]), 'ok', [localHit, publicHit]],
  ['degraded + ok', degraded('stale', [localHit]), ok([publicHit]), 'degraded', [localHit, publicHit]],
  ['unavailable + ok', unavailable('missing'), ok([publicHit]), 'degraded', [publicHit]],
  ['degraded + unavailable', degraded('partial', [localHit]), unavailable('offline'), 'degraded', [localHit]],
  ['unavailable + unavailable', unavailable('missing'), unavailable('offline'), 'unavailable', []],
])('%s');

it('searches both children concurrently and preserves local-then-public order');
it('deduplicates exact refs without ranking or visibility filtering');
it('routes local-episode refs only to local and all other refs only to public');
it('times out one child while retaining the healthy child value');
it('opens the timed-out child circuit for later search/get calls');
```

Use an injected `timeoutMs: 10` and fake timers for timeout tests.

- [ ] **Step 2: Run the new suite and confirm RED**

Run:

```bash
cd packages/layer && yarn test test/adapters/federated-corpus-adapter.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement named children and timeout/circuit calls**

Create `federated-corpus-adapter.ts`:

```ts
import type {
  CorpusPort,
  CorpusRecord,
  KnowledgeHit,
  PortResult,
} from '@jinn-network/plugin';
import {
  degraded,
  ok,
  unavailable,
  valueOr,
} from '@jinn-network/plugin';
import { LOCAL_EPISODE_REF_PREFIX } from './local-episode-corpus-adapter.js';

type ChildName = 'local' | 'public';

export interface FederatedCorpusAdapterDeps {
  local: CorpusPort;
  public: CorpusPort;
  timeoutMs?: number;
}

export const DEFAULT_FEDERATED_CHILD_TIMEOUT_MS = 5_000;

export function createFederatedCorpusAdapter(
  deps: FederatedCorpusAdapterDeps,
): CorpusPort {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FEDERATED_CHILD_TIMEOUT_MS;
  const openCircuit = new Set<ChildName>();

  async function call<T>(
    child: ChildName,
    operation: () => Promise<PortResult<T>>,
  ): Promise<PortResult<T>> {
    if (openCircuit.has(child)) {
      return unavailable(`${child} corpus circuit open after timeout`);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<PortResult<T>>((resolve) => {
          timer = setTimeout(() => {
            openCircuit.add(child);
            resolve(unavailable(`${child} corpus timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      return unavailable(`${child} corpus rejected: ${String(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // search/get implementation follows in the next step
}
```

The timeout branch resolves a typed outcome. Attach rejection handling to the
original operation through the `await`/`catch` path so a late rejection never
becomes unhandled.

- [ ] **Step 4: Implement the complete status matrix**

Use one helper for search status:

```ts
function reasonFor(
  child: ChildName,
  result: PortResult<unknown>,
): string | undefined {
  return result.status === 'ok' ? undefined : `${child} corpus: ${result.reason}`;
}

async function search(query: string): Promise<PortResult<KnowledgeHit[]>> {
  const [localResult, publicResult] = await Promise.all([
    call('local', () => deps.local.search(query)),
    call('public', () => deps.public.search(query)),
  ]);
  const seen = new Set<string>();
  const hits = [
    ...valueOr(localResult, []),
    ...valueOr(publicResult, []),
  ].filter((hit) => {
    if (seen.has(hit.ref)) return false;
    seen.add(hit.ref);
    return true;
  });

  if (
    localResult.status === 'unavailable'
    && publicResult.status === 'unavailable'
  ) {
    return unavailable([
      reasonFor('local', localResult),
      reasonFor('public', publicResult),
    ].filter(Boolean).join('; '));
  }

  const reason = [
    reasonFor('local', localResult),
    reasonFor('public', publicResult),
  ].find((value) => value !== undefined);
  return reason === undefined ? ok(hits) : degraded(reason, hits);
}
```

This intentionally returns `degraded([])` when one child is unavailable and
the healthy child honestly returns no values.

- [ ] **Step 5: Implement single-child `get()` routing**

```ts
async function get(
  ref: string,
): Promise<PortResult<CorpusRecord | null>> {
  const child: ChildName = ref.startsWith(LOCAL_EPISODE_REF_PREFIX)
    ? 'local'
    : 'public';
  return call(child, () => deps[child].get(ref));
}

return { search, get };
```

Do not fan out, rank, inspect visibility, or prefer a source here.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
cd packages/layer && yarn test test/adapters/federated-corpus-adapter.test.ts && yarn typecheck
```

Expected: PASS, including timer/circuit coverage.

- [ ] **Step 7: Commit**

```bash
git add packages/layer/src/adapters/federated-corpus-adapter.ts \
  packages/layer/src/adapters/index.ts \
  packages/layer/test/adapters/federated-corpus-adapter.test.ts
git commit -m "feat: federate local and public corpus reads"
```

---

## Task 5: Compose the default local and public corpus

**Files:**

- Modify: `packages/layer/src/plugin-wiring.ts`
- Test: `packages/layer/test/plugin-wiring.test.ts`
- Test: `packages/layer/test/process-contract.test.ts`

- [ ] **Step 1: Write failing composition and override tests**

Create `plugin-wiring.test.ts` with behavioral tests:

```ts
it('composes the supplied evidence and public corpus into one default corpus');
it('uses an explicit corpus override unchanged');
it('uses an explicit evidence override for plugin persistence');
```

For the first test, seed `InMemoryEvidencePort` with a local episode, use a
public `InMemoryCorpusPort`, call the exported composition helper, and assert
one search returns both refs.

Add a process-contract integration test using:

- an actual `createEvidenceAdapter` pointed at a temp episodes directory;
- one stored local episode whose stored `retrievalVisible` is `false`;
- a fake public `CorpusPort`;
- the real local and federated adapters;
- `runJinnLayerCli(['session', 'pickup'], ...)`.

Assert that local context is delivered while public is unavailable, and that
the local file still contains `retrievalVisible: false`.

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
cd packages/layer && yarn test test/plugin-wiring.test.ts test/process-contract.test.ts
```

Expected: default wiring still binds `corpus` only to the public adapter.

- [ ] **Step 3: Add a pure default-composition seam**

In `plugin-wiring.ts`:

```ts
import type {
  CorpusPort,
  EvidencePort,
} from '@jinn-network/plugin';
import {
  createFederatedCorpusAdapter,
  createLocalEpisodeCorpusAdapter,
} from './adapters/index.js';

export function composeDefaultCorpus(
  evidence: EvidencePort,
  publicCorpus: CorpusPort,
): CorpusPort {
  return createFederatedCorpusAdapter({
    local: createLocalEpisodeCorpusAdapter({ evidence }),
    public: publicCorpus,
  });
}
```

This is a test seam and the production composition point, not a new protocol.

- [ ] **Step 4: Reorder default wiring around one evidence instance**

Change `buildPluginDepsFromEnv` to construct:

```ts
const evidenceDir = episodesDir();
const evidence = overrides.evidence ?? createEvidenceAdapter(/* existing deps */);

const corpus = overrides.corpus ?? composeDefaultCorpus(
  evidence,
  createCorpusAdapter({ layer: buildDefaultLayer() }),
);
```

Keep contribution bound to that same `evidence` object. Do not construct the
public layer at all when `overrides.corpus` is supplied:

```ts
const corpus = overrides.corpus ?? (() => {
  const publicCorpus = createCorpusAdapter({ layer: buildDefaultLayer() });
  return composeDefaultCorpus(evidence, publicCorpus);
})();
```

This preserves tests/embedders that deliberately replace the complete corpus.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
cd packages/layer && yarn test test/plugin-wiring.test.ts test/process-contract.test.ts && yarn typecheck
```

Expected: PASS. The integration test must exercise real local file persistence
and real adapter imports against a temp directory.

- [ ] **Step 6: Commit**

```bash
git add packages/layer/src/plugin-wiring.ts \
  packages/layer/test/plugin-wiring.test.ts \
  packages/layer/test/process-contract.test.ts
git commit -m "feat: compose local and public retrieval by default"
```

---

## Task 6: Deduplicate canonical episodes in the Jinn pickup policy

**Files:**

- Modify: `packages/plugin/src/plugin.ts`
- Modify: `packages/plugin/src/testing/in-memory-corpus.ts`
- Test: `packages/plugin/test/plugin/first-turn-pickup.test.ts`
- Test: `packages/plugin/test/plugin/first-turn-pickup-content-rescore.test.ts`

- [ ] **Step 1: Write failing mixed-source policy tests**

Add tests using a custom `CorpusPort` that returns ordered local/public hits:

```ts
it('ranks local and public hits globally with the existing two-packet cap');
it('lets public win when it is more relevant and local win when it is more relevant');
it('deduplicates one local/public episode and prefers the local record');
it('continues to the next ranked unique episode after a duplicate');
it('excludes canonical ids delivered by an earlier pickup');
it('returns the canonical ids of records that produced packets');
```

The duplicate test should return:

```ts
const localHit: KnowledgeHit = {
  ref: 'local-episode:episode-shared',
  canonicalEpisodeId: 'episode-shared',
  kind: 'trace',
  snippet: 'dashboard retry failure',
  tags: [],
  origin: 'local:episode-shared',
  retrievalVisible: true,
};
const publicHit: KnowledgeHit = {
  ref: 'bafyPublicShared',
  kind: 'trace',
  snippet: 'dashboard retry failure',
  tags: [],
  origin: 'agent-1',
  retrievalVisible: true,
};
```

Both fetched records carry `canonicalEpisodeId: 'episode-shared'`, but only
the local record has synthesis `"full private solution"`. Assert the delivered
packet uses the local ref/content and that a third unique candidate fills the
second slot.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
cd packages/plugin && yarn test \
  test/plugin/first-turn-pickup.test.ts \
  test/plugin/first-turn-pickup-content-rescore.test.ts
```

Expected: `firstTurnPickup` has no exclusions/result identities and duplicate
records consume separate slots.

- [ ] **Step 3: Add additive pickup options and result state**

In `plugin.ts`:

```ts
export interface FirstTurnPickupOptions {
  excludeCanonicalEpisodeIds?: readonly string[];
}

export interface FirstTurnPickupResult {
  // existing fields...
  deliveredCanonicalEpisodeIds: string[];
}
```

Change the session method:

```ts
async firstTurnPickup(
  firstMessage: string,
  options: FirstTurnPickupOptions = {},
): Promise<FirstTurnPickupResult> {
  const excludedCanonicalEpisodeIds = new Set(
    options.excludeCanonicalEpisodeIds ?? [],
  );
  // existing flow...
}
```

Add `deliveredCanonicalEpisodeIds: []` to every disabled, empty-term,
nothing-found, and degraded-nothing return. Keep a session field only if it is
needed by embedded-session end bookkeeping; canonical IDs do not belong in
the persisted `SessionActivityFacts` schema.

- [ ] **Step 4: Index local canonical hints before ranking**

After merging per-term search results:

```ts
const preferredHitByCanonicalEpisodeId = new Map<string, KnowledgeHit>();
for (const hit of byRef.values()) {
  if (
    hit.canonicalEpisodeId !== undefined
    && !preferredHitByCanonicalEpisodeId.has(hit.canonicalEpisodeId)
  ) {
    preferredHitByCanonicalEpisodeId.set(hit.canonicalEpisodeId, hit);
  }
}
```

In this release only the local search adapter emits the hit-level identity, so
this map identifies the local form without teaching the generic port about
relevance. Filter known local hits in the exclusion set before ranking to
avoid unnecessary fetches.

- [ ] **Step 5: Resolve the preferred local form after public identity is known**

Extract one internal fetch helper that reuses `prefetchedByRef`, records each
actually fetched ref, and preserves the current rejected-promise degradation.
Then, in both the near-miss and final projection paths:

```ts
let selectedHit = hit;
let record = fetchedRecord;
const canonicalEpisodeId = record?.canonicalEpisodeId;
const preferredHit = canonicalEpisodeId === undefined
  ? undefined
  : preferredHitByCanonicalEpisodeId.get(canonicalEpisodeId);

if (preferredHit !== undefined && preferredHit.ref !== hit.ref) {
  const preferredResult = await fetchRecord(preferredHit);
  if (preferredResult.status !== 'ok') {
    degradedReason ??= preferredResult.reason;
  } else if (preferredResult.value !== null) {
    selectedHit = preferredHit;
    record = preferredResult.value;
  }
}
```

Because federated search is stable local-then-public and only local hits expose
canonical identity in this PR, the replacement is deterministic. Do not add a
source score. If the preferred local fetch fails or returns no record, keep the
already-fetched public record and mark the result degraded when there is a
failure; one unavailable source must not suppress usable evidence from the
other.

- [ ] **Step 6: Apply canonical exclusion/dedup before packet projection**

Before projecting:

```ts
const deliveredCanonicalEpisodeIds: string[] = [];
const deliveredCanonicalSet = new Set<string>();

const canonicalEpisodeId = record.canonicalEpisodeId;
if (
  canonicalEpisodeId !== undefined
  && (
    excludedCanonicalEpisodeIds.has(canonicalEpisodeId)
    || deliveredCanonicalSet.has(canonicalEpisodeId)
  )
) {
  continue;
}
```

After a non-empty packet is accepted:

```ts
packets.push(packet);
if (canonicalEpisodeId !== undefined) {
  deliveredCanonicalSet.add(canonicalEpisodeId);
  deliveredCanonicalEpisodeIds.push(canonicalEpisodeId);
}
```

Use `selectedHit` only for fetch/cache bookkeeping; `projectKnowledgePacket`
must receive the preferred `record`, which determines the packet ref.

Return `deliveredCanonicalEpisodeIds` with every final result. Records without
canonical identity retain the existing ref/content dedup behavior.

- [ ] **Step 7: Run plugin tests and typecheck**

Run:

```bash
cd packages/plugin && yarn test \
  test/plugin/first-turn-pickup.test.ts \
  test/plugin/first-turn-pickup-content-rescore.test.ts \
  test/plugin/first-turn-pickup-concurrency.test.ts \
  test/plugin/session-smoke.test.ts && yarn typecheck
```

Expected: PASS. Confirm existing concurrency, visibility, skill-payload,
empty-packet, and two-packet tests stay green.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin/src/plugin.ts \
  packages/plugin/src/testing/in-memory-corpus.ts \
  packages/plugin/test/plugin/first-turn-pickup.test.ts \
  packages/plugin/test/plugin/first-turn-pickup-content-rescore.test.ts
git commit -m "feat: deduplicate canonical pickup episodes"
```

---

## Task 7: Carry canonical exclusions through the v1 process contract

**Files:**

- Modify: `packages/layer/src/process-contract.ts`
- Modify: `packages/layer/src/cli.ts`
- Test: `packages/layer/test/process-contract.test.ts`

- [ ] **Step 1: Write failing additive-contract tests**

Add tests for both omitted/default and supplied exclusions:

```ts
it('defaults canonical pickup exclusions to an empty array');
it('passes canonical exclusions to the plugin and returns delivered ids');
```

For the second test, send:

```ts
excludeCanonicalEpisodeIds: ['episode-already-delivered'],
```

Use a corpus containing that canonical episode plus a new one. Assert the
response omits the old packet and contains:

```ts
deliveredCanonicalEpisodeIds: ['episode-new'],
```

Also assert `contractVersion` remains `1`.

- [ ] **Step 2: Run the process tests and confirm RED**

Run:

```bash
cd packages/layer && yarn test test/process-contract.test.ts
```

Expected: strict request parsing rejects the new field.

- [ ] **Step 3: Extend the request schema additively**

In `process-contract.ts`:

```ts
export const SessionPickupRequestV1Schema = z.strictObject({
  contractVersion: z.literal(PROCESS_CONTRACT_VERSION),
  meta: SessionMetaSchema,
  firstMessage: z.string(),
  excludeCanonicalEpisodeIds: z.array(z.string().min(1)).default([]),
});
```

No version bump.

- [ ] **Step 4: Forward exclusions through the CLI**

In the session pickup command:

```ts
const result = await createJinnPlugin(tracked.deps)
  .session(request.meta)
  .firstTurnPickup(request.firstMessage, {
    excludeCanonicalEpisodeIds: request.excludeCanonicalEpisodeIds,
  });
```

`FirstTurnPickupResult` already carries the response field, so the envelope
needs no separate projection.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
cd packages/layer && yarn test test/process-contract.test.ts && yarn typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/layer/src/process-contract.ts \
  packages/layer/src/cli.ts \
  packages/layer/test/process-contract.test.ts
git commit -m "feat: carry pickup episode exclusions"
```

---

## Task 8: Add the Hermes task/repository pickup checkpoint

**Files:**

- Modify: `apps/jinn-agent/plugins/jinn/pickup.py`
- Modify: `apps/jinn-agent/plugins/jinn/__init__.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_pickup.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_plugin.py`

- [ ] **Step 1: Write failing pickup metadata tests**

Extend `ok_response()` with:

```py
"deliveredCanonicalEpisodeIds": ["episode-dashboard-fix"],
```

Add tests:

```py
def test_pickup_sends_canonical_exclusions_and_returns_delivered_ids():
    runner = PickupRunner()
    outcome = pickup.pickup_with_outcome(
        MSG,
        runner=runner,
        exclude_canonical_episode_ids=["episode-old"],
    )
    request = json.loads(runner.calls[0][1])
    assert request["excludeCanonicalEpisodeIds"] == ["episode-old"]
    assert outcome.delivered_canonical_episode_ids == (
        "episode-dashboard-fix",
    )
```

Also prove malformed/non-string response IDs are ignored and the legacy
`pickup.pickup(...) -> {"context": ...} | None` API remains unchanged.

- [ ] **Step 2: Write failing checkpoint behavior tests**

Add hook-level tests for:

```py
def test_same_task_and_repository_only_pick_up_once()
def test_changed_non_empty_task_id_triggers_pickup_again()
def test_changed_repository_triggers_pickup_again()
def test_missing_stable_task_id_stays_first_turn_only()
def test_repeat_pickup_sends_ids_delivered_by_the_prior_pickup()
```

Use a response sequence with different delivered IDs and inspect the second
request body. For repository changes, pass two distinct `cwd` values and
monkeypatch `session_bridge.snapshot_repository` to return snapshots with
different `repository_slug` values. Preserve the original session-start
snapshot used for accepted-diff capture.

- [ ] **Step 3: Run the focused Hermes tests and confirm RED**

Run:

```bash
cd apps/jinn-agent && scripts/run_tests.sh \
  tests/plugins/test_jinn_pickup.py \
  tests/plugins/test_jinn_plugin.py
```

Expected: only `is_first_turn` can currently trigger pickup and the bridge has
no canonical metadata surface.

- [ ] **Step 4: Add a metadata-preserving pickup outcome**

In `pickup.py`:

```py
from dataclasses import dataclass

@dataclass(frozen=True)
class PickupOutcome:
    context: Optional[Dict[str, str]]
    delivered_canonical_episode_ids: tuple[str, ...] = ()
```

Add the request field:

```py
def _build_request(
    user_message: str,
    session_id: str,
    model: str,
    repository_slug: Optional[str],
    exclude_canonical_episode_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    return {
        "contractVersion": jinn_layer.CONTRACT_VERSION,
        "meta": meta,
        "firstMessage": user_message or "",
        "excludeCanonicalEpisodeIds": [
            value for value in (exclude_canonical_episode_ids or [])
            if isinstance(value, str) and value
        ],
    }
```

Refactor the existing fail-open wrapper so:

```py
def pickup_with_outcome(...) -> PickupOutcome:
    try:
        return _pickup_inner(...)
    except Exception as exc:
        logger.warning("jinn: pickup failed open: %s", exc)
        return PickupOutcome(context=None)

def pickup(...) -> Optional[Dict[str, str]]:
    return pickup_with_outcome(...).context
```

Keep all existing arguments on `pickup`. Add
`exclude_canonical_episode_ids` only as an optional keyword and forward it.
Have `_pickup_inner` return `PickupOutcome`, filtering response IDs exactly as
the test specifies. Every fail-open/nothing path returns an empty tuple.

- [ ] **Step 5: Add checkpoint state without polluting activity**

In `__init__.py`:

```py
def _empty_pickup_checkpoint() -> Dict[str, Any]:
    return {
        "hasRun": False,
        "taskId": None,
        "repositorySlug": None,
        "repositoryCwd": None,
        "deliveredCanonicalEpisodeIds": [],
    }
```

Add it to `_state_for` and `_pop_state` defaults. In `_peek_state`, copy the
checkpoint and its delivered-ID list just as activity lists are copied.
Canonical IDs are host control state, not `SessionActivityFacts`; do not add
them to `_empty_activity`.

- [ ] **Step 6: Resolve current repository identity read-only**

Read `cwd` or `working_directory` from the pre-LLM hook kwargs. Reuse the
session-start snapshot when no working directory is supplied. When a supplied
working directory differs from the checkpoint's cached directory, use
`session_bridge.snapshot_repository` as a read-only identity probe and cache
only its `repository_slug`/cwd in the pickup checkpoint.

Do not replace `state["snapshot"]`: session end still needs the original
root/head for accepted-diff evidence.

The helper should follow:

```py
def _pickup_repository_slug(
    logical_session_id: str,
    state: Dict[str, Any],
    cwd_value: Any,
) -> tuple[Optional[str], Optional[str]]:
    checkpoint = state["pickupCheckpoint"]
    if not isinstance(cwd_value, str) or not cwd_value:
        snapshot = state.get("snapshot")
        return (
            snapshot.repository_slug if snapshot is not None else None,
            None,
        )
    resolved = str(Path(cwd_value).resolve())
    if checkpoint.get("repositoryCwd") == resolved:
        return checkpoint.get("repositorySlug"), resolved
    snapshot = session_bridge.snapshot_repository(
        f"{logical_session_id}:pickup",
        cwd=Path(resolved),
    )
    return (
        snapshot.repository_slug if snapshot is not None else None,
        resolved,
    )
```

- [ ] **Step 7: Trigger only on a new checkpoint and merge delivered IDs**

Replace the `if is_first_turn` branch with:

```py
state = _state_for(logical_session_id)
checkpoint = state["pickupCheckpoint"]
stable_task_id = task_id.strip() or None
repository_slug, repository_cwd = _pickup_repository_slug(
    logical_session_id,
    state,
    _.get("cwd") or _.get("working_directory"),
)

has_run = bool(checkpoint.get("hasRun"))
checkpoint_changed = has_run and (
    (
        stable_task_id is not None
        and stable_task_id != checkpoint.get("taskId")
    )
    or repository_slug != checkpoint.get("repositorySlug")
)
should_pick_up = (is_first_turn and not has_run) or checkpoint_changed
if not should_pick_up:
    return None

excluded = list(checkpoint.get("deliveredCanonicalEpisodeIds") or [])
outcome = pickup.pickup_with_outcome(
    user_message,
    runner=_runner,
    activity=state["activity"],
    session_id=logical_session_id,
    model=model,
    repository_slug=repository_slug,
    session_kind=session_kind,
    parent_session_id=parent_session_id,
    exclude_canonical_episode_ids=excluded,
)
```

After the call, update the checkpoint even when context is empty so a failed
or empty pickup does not run again on every model iteration:

```py
checkpoint["hasRun"] = True
checkpoint["taskId"] = stable_task_id
checkpoint["repositorySlug"] = repository_slug
checkpoint["repositoryCwd"] = repository_cwd
delivered = checkpoint["deliveredCanonicalEpisodeIds"]
for episode_id in outcome.delivered_canonical_episode_ids:
    if episode_id not in delivered:
        delivered.append(episode_id)
return outcome.context
```

Use `_session_state_lock` around checkpoint reads/writes or a copied
decision/update helper so concurrent hooks cannot corrupt the list. Do not
hold the lock while running the child process.

- [ ] **Step 8: Run the focused Hermes tests**

Run:

```bash
cd apps/jinn-agent && scripts/run_tests.sh \
  tests/plugins/test_jinn_pickup.py \
  tests/plugins/test_jinn_plugin.py \
  tests/plugins/test_jinn_session_end_delegate.py
```

Expected: PASS. The session-end delegation suite protects the existing
repository snapshot/diff path.

- [ ] **Step 9: Commit**

```bash
git add apps/jinn-agent/plugins/jinn/pickup.py \
  apps/jinn-agent/plugins/jinn/__init__.py \
  apps/jinn-agent/tests/plugins/test_jinn_pickup.py \
  apps/jinn-agent/tests/plugins/test_jinn_plugin.py
git commit -m "feat: repeat pickup on task checkpoints"
```

---

## Task 9: Prove the complete local/public behavior and regressions

**Files:**

- Modify: `packages/layer/test/process-contract.test.ts`
- Modify: `packages/plugin/test/plugin/first-turn-pickup.test.ts`
- Modify: `apps/jinn-agent/tests/plugins/test_jinn_pickup.py`

- [ ] **Step 1: Add the acceptance-level mixed-source cases**

Ensure the combined suites explicitly prove:

```text
local relevant + public relevant      -> one global rank, at most 2 packets
public unavailable + local relevant   -> degraded envelope with local context
local empty + public relevant         -> public context
same canonical episode in both        -> one local packet
duplicate plus another unique record  -> local duplicate + unique second packet
unmarked public record                -> excluded
stored-unmarked local record           -> included by adapter projection
prior delivered canonical id          -> not redelivered on repeat pickup
```

Prefer behavioral assertions over snapshots. Do not assert an exact catalogue
of all fields or test names.

- [ ] **Step 2: Run all affected TypeScript suites**

Run:

```bash
cd packages/plugin && yarn test && yarn typecheck
cd packages/layer && yarn test && yarn typecheck
```

Expected: PASS.

- [ ] **Step 3: Run all affected Hermes plugin suites through the required wrapper**

Run:

```bash
cd apps/jinn-agent && scripts/run_tests.sh \
  tests/plugins/test_jinn_pickup.py \
  tests/plugins/test_jinn_plugin.py \
  tests/plugins/test_jinn_session_end_delegate.py \
  tests/plugins/test_jinn_session_evidence.py
```

Expected: PASS.

- [ ] **Step 4: Run build-level verification**

Run:

```bash
yarn workspace @jinn-network/plugin build
yarn workspace @jinn-network/jinn-layer build
git diff --check
git status --short
```

Expected:

- both packages build;
- no whitespace errors;
- only intentional files are modified;
- no generated `dist/`, cache, SQLite, episode, or Hermes home files are
  staged.

- [ ] **Step 5: Self-review the implementation against the approved design**

Read the complete diff and answer each question with code/test evidence:

1. Is ranking still owned only by `packages/plugin`?
2. Is `retrievalVisible` applied identically at both existing gates?
3. Does local projection leave stored files untouched?
4. Is the cap still globally two?
5. Does one child failure retain the other's values?
6. Is local preference limited to a canonical duplicate rather than a score
   bonus?
7. Does explicit `overrides.corpus` bypass all default corpus construction?
8. Are contract additions optional/defaulted and still version 1?
9. Can Hermes repeat only on an actual task/repository checkpoint change?
10. Is publication/usefulness/retention behavior unchanged?

Fix any mismatch and rerun the closest focused test plus the relevant
typecheck.

- [ ] **Step 6: Commit final integration adjustments**

```bash
git add packages/layer/test/process-contract.test.ts \
  packages/plugin/test/plugin/first-turn-pickup.test.ts \
  apps/jinn-agent/tests/plugins/test_jinn_pickup.py
git commit -m "test: verify federated pickup behavior"
```

If no final adjustments were required, do not create an empty commit.
