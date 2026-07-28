# Autopilot Mutation Delivery Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `jinn-repo.v1` Autopilot mutation workers emit a valid pre-envelope typed result and bind it to the authenticated delivery-envelope CID before adoption, receipt, or evaluation.

**Architecture:** The SDK gains a strict producer-side mutation schema that contains every correlation field available before envelope assembly and a single binding function that enriches it with the authenticated envelope CID. The learner and Hermes harvesters use authoritative runtime attempt identity to emit that producer payload for `source: autopilot-session`, while delivery, receipt, engine-recovery, and evaluator consumers call the binding function before using the existing strict `AutopilotMutationResultSchema`.

**Tech Stack:** TypeScript, Zod v3, Vitest, Yarn, the Jinn harness engine, `@jinn-network/sdk`, and the `@jinn-network/client` marketplace daemon.

## Global Constraints

- Preserve legacy `jinn-repo-solution.v1` behavior for non-Autopilot Tasks.
- Keep `AutopilotMutationResultSchema`, `AutopilotCorrelationSchema`, and every adoption receipt schema strict; `deliveryEnvelopeCid` remains required after envelope authentication.
- The producer-side correlation must reject a producer-authored `deliveryEnvelopeCid`.
- Runtime Task identity must not mutate or re-hash the signed Task.
- Missing Task, attempt, or request identity for a declared Autopilot session fails closed before delivery.
- Do not add another marketplace Task for evaluator execution.
- Do not implement Verdict adoption, child-result adoption, or merge behavior.
- Do not edit existing plan documents other than this plan's checkbox progress.
- Run Node 22 commands with `PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH`.

---

## File map

- `packages/sdk/src/autopilot-session.ts`: defines producer-time and verified mutation-result schemas plus the one producer-to-verified binding function.
- `packages/sdk/src/payloads/jinn-repo.ts`: selects the producer-time schema for Autopilot Solution envelopes while retaining the legacy payload branch.
- `packages/sdk/src/autopilot.ts`: exports the binding function and producer result type through the public Autopilot SDK surface.
- `packages/sdk/src/solvernets/jinn-repo.ts`: exports the same API through the public `jinn-repo` SolverNet surface used by the client.
- `packages/sdk/test/autopilot-session.test.ts`: proves producer/verified schema separation and envelope binding.
- `packages/sdk/test/payloads.jinn-repo.test.ts`: proves the additive jinn-repo Solution union accepts the producer payload and retains legacy behavior.
- `client/src/harnesses/types.ts`: carries authoritative Task/attempt/request identity in runtime-only `HarnessContext`.
- `client/src/harnesses/engine/engine.ts`: populates runtime identity and enriches persisted mutation output before receipt-prefix checks.
- `client/src/harnesses/impls/learner/harvest.ts`: emits the typed producer payload for an Autopilot session and retains the legacy materializer otherwise.
- `client/src/harnesses/impls/learner/harness.ts`: forwards runtime attempt identity to the shared harvester.
- `client/src/harnesses/impls/hermes-agent/harness.ts`: forwards the same identity for the Hermes-backed learner path.
- `client/plugins/jinn-repo-runtime/skills/task/SKILL.md`: documents both ordinary and Autopilot-session payload behavior.
- `client/src/autopilot/marketplace-delivery-observer.ts`: binds authenticated envelope CID before strict verified delivery validation.
- `client/src/autopilot/github-adoption-receipt-observer.ts`: binds persisted producer output to persisted `manifestCid` before receipt polling.
- `client/src/adapters/mech/adapter.ts`: binds discovered Solution envelope payload before evaluator admission.
- `client/src/harnesses/impls/jinn-repo-evaluator/harness.ts`: binds the Solution envelope payload before the evaluator's second admission check.
- Tests under `client/test/`: cover harvesting, runtime identity, delivery observation, receipt recovery, Mech evaluator admission, and evaluator harness admission.

---

### Task 1: Add the SDK producer-result boundary

**Files:**
- Modify: `packages/sdk/src/autopilot-session.ts`
- Modify: `packages/sdk/src/payloads/jinn-repo.ts`
- Modify: `packages/sdk/src/autopilot.ts`
- Modify: `packages/sdk/src/solvernets/jinn-repo.ts`
- Test: `packages/sdk/test/autopilot-session.test.ts`
- Test: `packages/sdk/test/payloads.jinn-repo.test.ts`

**Interfaces:**
- Produces: `AutopilotMutationDeliveryResultSchema`
- Produces: `AutopilotMutationDeliveryResult`
- Produces: `bindAutopilotMutationDeliveryResult(value: unknown, deliveryEnvelopeCid: string): AutopilotMutationResult`
- Changes: `JinnRepoAutopilotSolutionPayloadSchema` validates `AutopilotMutationDeliveryResult`, not the post-envelope result.
- Preserves: `AutopilotMutationResultSchema` remains the strict verified-result schema.

- [ ] **Step 1: Write failing producer-schema and binding tests**

In `packages/sdk/test/autopilot-session.test.ts`, import the new symbols and
add tests equivalent to:

```ts
import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  AutopilotEvaluationContextSchema,
  AutopilotMutationDeliveryResultSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  autopilotCorrelationMatches,
  bindAutopilotMutationDeliveryResult,
} from '../src/autopilot-session.js';

function mutationDeliveryFixture(): Record<string, unknown> {
  const value = structuredClone(
    fixture('mutation-complete') as Record<string, unknown>,
  );
  const correlation = value.correlation as Record<string, unknown>;
  delete correlation.deliveryEnvelopeCid;
  return value;
}

it('accepts a producer mutation result without an envelope CID', () => {
  expect(
    AutopilotMutationDeliveryResultSchema.parse(mutationDeliveryFixture()),
  ).toEqual(mutationDeliveryFixture());
});

it('keeps producer and verified correlation boundaries distinct', () => {
  const producer = mutationDeliveryFixture();
  expect(() => AutopilotMutationResultSchema.parse(producer)).toThrow();
  expect(() => AutopilotMutationDeliveryResultSchema.parse({
    ...producer,
    correlation: {
      ...(producer.correlation as Record<string, unknown>),
      deliveryEnvelopeCid: 'bafy-producer-authored',
    },
  })).toThrow();
});

it('binds the authenticated envelope CID into a strict mutation result', () => {
  const bound = bindAutopilotMutationDeliveryResult(
    mutationDeliveryFixture(),
    'bafy-authenticated-envelope',
  );
  expect(bound.correlation.deliveryEnvelopeCid)
    .toBe('bafy-authenticated-envelope');
  expect(AutopilotMutationResultSchema.parse(bound)).toEqual(bound);
});

it('rejects an invalid authenticated envelope CID', () => {
  expect(() => bindAutopilotMutationDeliveryResult(
    mutationDeliveryFixture(),
    '',
  )).toThrow();
});
```

In `packages/sdk/test/payloads.jinn-repo.test.ts`, replace the Autopilot
Solution fixture loop with a producer-boundary assertion:

```ts
it('accepts pre-envelope mutation results through the additive Solution branch', () => {
  for (const name of ['mutation-complete', 'mutation-human']) {
    const value = structuredClone(
      autopilotFixture(name) as Record<string, unknown>,
    );
    const correlation = value.correlation as Record<string, unknown>;
    delete correlation.deliveryEnvelopeCid;
    expect(JinnRepoAutopilotSolutionPayloadSchema.parse(value)).toEqual(value);
    expect(JinnRepoSolutionPayloadSchema.parse(value)).toEqual(value);
  }
});
```

- [ ] **Step 2: Run the SDK tests and verify the new API is absent**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd packages/sdk test \
  test/autopilot-session.test.ts \
  test/payloads.jinn-repo.test.ts
```

Expected: TypeScript/Vitest fails because
`AutopilotMutationDeliveryResultSchema` and
`bindAutopilotMutationDeliveryResult` are not exported.

- [ ] **Step 3: Implement the producer schema and binder**

In `packages/sdk/src/autopilot-session.ts`:

1. Define a strict producer correlation schema by omitting
   `deliveryEnvelopeCid` from the existing correlation fields.
2. Define producer complete/human result branches with the same patch,
   summary, evidence, and Human-reason validators used by the verified result.
3. Export their discriminated union and inferred type.
4. Export a binder that parses the producer payload, adds the supplied
   authenticated CID, and then parses the result with the existing strict
   schema.

The implementation shape is:

```ts
const {
  deliveryEnvelopeCid: _deliveryEnvelopeCid,
  ...autopilotMutationDeliveryCorrelationFields
} = autopilotCorrelationFields;

const AutopilotMutationDeliveryCorrelationSchema = z.object(
  autopilotMutationDeliveryCorrelationFields,
).strict();

const AutopilotMutationDeliveryCompleteResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-mutation-result.v1'),
  outcome: z.literal('mutation-complete'),
  correlation: AutopilotMutationDeliveryCorrelationSchema,
  patch: PatchSchema,
  summary: boundedSingleLine(
    MAX_MUTATION_SUMMARY_BYTES,
    'Mutation summary',
  ),
  evidence: AutopilotMutationEvidenceSchema,
}).strict();

const AutopilotMutationDeliveryHumanResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-mutation-result.v1'),
  outcome: z.literal('human'),
  correlation: AutopilotMutationDeliveryCorrelationSchema,
  reason: AutopilotHumanReasonSchema,
}).strict();

export const AutopilotMutationDeliveryResultSchema = z.discriminatedUnion(
  'outcome',
  [
    AutopilotMutationDeliveryCompleteResultSchema,
    AutopilotMutationDeliveryHumanResultSchema,
  ],
);

export type AutopilotMutationDeliveryResult = z.infer<
  typeof AutopilotMutationDeliveryResultSchema
>;

export function bindAutopilotMutationDeliveryResult(
  value: unknown,
  deliveryEnvelopeCid: string,
): AutopilotMutationResult {
  const delivery = AutopilotMutationDeliveryResultSchema.parse(value);
  return AutopilotMutationResultSchema.parse({
    ...delivery,
    correlation: {
      ...delivery.correlation,
      deliveryEnvelopeCid,
    },
  });
}
```

In `packages/sdk/src/payloads/jinn-repo.ts`, import
`AutopilotMutationDeliveryResultSchema` and assign it to
`JinnRepoAutopilotSolutionPayloadSchema`.

Export the schema, type, and binding function from
`packages/sdk/src/autopilot.ts` and
`packages/sdk/src/solvernets/jinn-repo.ts`.

- [ ] **Step 4: Run focused SDK tests and typecheck**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd packages/sdk test \
  test/autopilot-session.test.ts \
  test/payloads.jinn-repo.test.ts
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd packages/sdk typecheck
```

Expected: both focused test files pass and SDK typecheck exits zero.

- [ ] **Step 5: Commit the SDK boundary**

```bash
git add \
  packages/sdk/src/autopilot-session.ts \
  packages/sdk/src/payloads/jinn-repo.ts \
  packages/sdk/src/autopilot.ts \
  packages/sdk/src/solvernets/jinn-repo.ts \
  packages/sdk/test/autopilot-session.test.ts \
  packages/sdk/test/payloads.jinn-repo.test.ts
git commit -m "fix(sdk): bind Autopilot mutation delivery results"
```

---

### Task 2: Emit typed Autopilot results from learner harvest

**Files:**
- Modify: `client/src/harnesses/types.ts`
- Modify: `client/src/harnesses/engine/engine.ts`
- Modify: `client/src/harnesses/impls/learner/harvest.ts`
- Modify: `client/src/harnesses/impls/learner/harness.ts`
- Modify: `client/src/harnesses/impls/hermes-agent/harness.ts`
- Modify: `client/plugins/jinn-repo-runtime/skills/task/SKILL.md`
- Test: `client/test/harnesses/learner/jinn-repo-harvest.test.ts`
- Test: `client/test/harnesses/engine/bug-fixes.test.ts`

**Interfaces:**
- Consumes: `AutopilotMutationDeliveryResultSchema` from Task 1.
- Produces: `AutopilotHarvestIdentity` with optional raw runtime fields that
  are validated as a complete triple for Autopilot sessions.
- Changes: `harvestOutput(workingDir, phaseRange?, task?, identity?)`.
- Adds to `HarnessContext`: `taskId?: string` and `attemptIndex?: number`;
  existing `requestId?: string` remains authoritative.

- [ ] **Step 1: Write failing Autopilot harvest tests**

Extend `client/test/harnesses/learner/jinn-repo-harvest.test.ts` with an
Autopilot Task fixture:

```ts
const SESSION = {
  schemaVersion: 'jinn-autopilot-session.v1',
  workflow: 'implement',
  repository: 'Jinn-Network/mono',
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  issueNumber: 2253,
  prNumber: 2255,
  targetBase: 'next',
  branch: 'autopilot/2253',
  claimOid: '1'.repeat(40),
  expectedHead: '2'.repeat(40),
  v2AttemptId: '11111111-1111-4111-8111-111111111111',
  runnerId: 'marketplace-canary',
  taskSnapshot: {
    title: 'Canary',
    body: 'Clarify the command.',
    prBody: 'Closes #2253',
    baseSha: '3'.repeat(40),
    targetBaseOid: '3'.repeat(40),
  },
  workflowContract: {
    skill: 'implement-issue',
    version: 'v2',
    resultSchema: 'jinn-autopilot-mutation-result.v1',
  },
  deadline: '2026-07-28T12:00:00.000Z',
  receiptAuthors: ['ritsukai'],
} as const;

function autopilotTask() {
  return {
    id: `autopilot:${SESSION.v2AttemptId}`,
    description: 'Canary',
    solverType: 'jinn-repo.v1',
    role: 'restoration',
    spec: {
      schemaVersion: 'jinn-repo.v1',
      source: 'autopilot-session',
      instance_id: `autopilot:${SESSION.v2AttemptId}`,
      repo: 'Jinn-Network/mono',
      base_commit: SESSION.expectedHead,
      problem_statement: 'Clarify the command.',
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      session: SESSION,
    },
  } as never;
}
```

Add:

```ts
it('materializes a typed Autopilot mutation result from the worktree diff', async () => {
  const repoDir = makeRepo(workingDir);
  writeFileSync(join(repoDir, 'README.md'), 'before\n');
  commitBase(repoDir);
  writeFileSync(join(repoDir, 'README.md'), 'after\n');

  const out = await harvestOutput(
    workingDir,
    undefined,
    autopilotTask(),
    {
      taskId: '1192',
      attemptIndex: 0,
      requestId: `0x${'4'.repeat(64)}`,
    },
  );

  expect(out.solutionPayload).toMatchObject({
    schemaVersion: 'jinn-autopilot-mutation-result.v1',
    outcome: 'mutation-complete',
    correlation: {
      taskId: '1192',
      attemptIndex: 0,
      requestId: `0x${'4'.repeat(64)}`,
      v2AttemptId: SESSION.v2AttemptId,
      claimOid: SESSION.claimOid,
      prNumber: SESSION.prNumber,
      expectedHead: SESSION.expectedHead,
    },
  });
  expect(
    (out.solutionPayload?.correlation as Record<string, unknown>)
      .deliveryEnvelopeCid,
  ).toBeUndefined();
});

it('fails closed when an Autopilot session lacks runtime attempt identity', async () => {
  const repoDir = makeRepo(workingDir);
  writeFileSync(join(repoDir, 'README.md'), 'before\n');
  commitBase(repoDir);
  writeFileSync(join(repoDir, 'README.md'), 'after\n');

  await expect(
    harvestOutput(workingDir, undefined, autopilotTask()),
  ).rejects.toThrow(/Autopilot runtime attempt identity/);
});
```

In `client/test/harnesses/engine/bug-fixes.test.ts`, extend
`jinn-mono-egi: full Task round-trip`'s captured-context test. Add
`taskId: '7'` and `attemptIndex: 2` to its `engine.observe(...)` input, then
assert the runtime-only values alongside its existing `ctx.task` assertion:

```ts
expect(received.ctx).toMatchObject({
  taskId: '7',
  attemptIndex: 2,
  requestId: 'egi-1',
});
```

- [ ] **Step 2: Run focused client tests and verify legacy-only behavior fails**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/harnesses/learner/jinn-repo-harvest.test.ts \
  test/harnesses/engine/bug-fixes.test.ts
```

Expected: the Autopilot harvest test receives
`jinn-repo-solution.v1`, and the context identity assertion lacks
`taskId`/`attemptIndex`.

- [ ] **Step 3: Add runtime identity to `HarnessContext`**

In `client/src/harnesses/types.ts`, add:

```ts
/** Canonical on-chain Task id for this attempt. */
taskId?: string;
/** Canonical zero-based marketplace attempt index. */
attemptIndex?: number;
```

In the `HarnessContext` construction inside
`client/src/harnesses/engine/engine.ts`, add:

```ts
taskId: task.taskId,
attemptIndex: task.attemptIndex,
requestId: task.requestId,
```

Do not place these values in `ctx.task` or persist them into the signed Task.

- [ ] **Step 4: Implement Autopilot-aware harvest**

In `client/src/harnesses/impls/learner/harvest.ts`:

1. Import `JinnRepoAutopilotSessionTaskSchema` and
   `AutopilotMutationDeliveryResultSchema` from
   `@jinn-network/sdk/solvernets/jinn-repo`.
2. Add:

```ts
export interface AutopilotHarvestIdentity {
  readonly taskId?: string;
  readonly attemptIndex?: number;
  readonly requestId?: string;
}
```

3. Change `maybeMaterializeJinnRepoPatchPayload` to accept the identity.
4. After deriving the filtered patch, route on raw
   `task.spec?.['source']`.
5. When the source is `autopilot-session`, parse the spec with
   `JinnRepoAutopilotSessionTaskSchema`, require a non-empty `taskId`,
   nonnegative integer `attemptIndex`, and 32-byte hex `requestId`, then build:

```ts
const payload = AutopilotMutationDeliveryResultSchema.parse({
  schemaVersion: 'jinn-autopilot-mutation-result.v1',
  outcome: 'mutation-complete',
  correlation: {
    taskId: identity.taskId,
    attemptIndex: identity.attemptIndex,
    requestId: identity.requestId,
    v2AttemptId: session.v2AttemptId,
    claimOid: session.claimOid,
    prNumber: session.prNumber,
    expectedHead: session.expectedHead,
  },
  patch,
  summary: `Completed ${session.workflow} workflow for PR #${session.prNumber}.`,
  evidence: {
    commands: [],
    tests: [],
    notes: ['Patch harvested from the completed repository worktree.'],
  },
});
```

6. If raw source declares `autopilot-session` but the spec or identity is
   invalid, throw with a stable prefix:
   `"[claude-code-learner] harvestOutput: Autopilot runtime attempt identity..."`.
7. Keep the existing legacy payload byte-for-byte for every non-Autopilot
   jinn-repo Task.
8. Extend `harvestOutput` to accept and forward the optional identity.

In the learner harness, call:

```ts
await harvestOutput(ctx.workingDir, phaseRange, ctx.task, {
  taskId: ctx.taskId,
  attemptIndex: ctx.attemptIndex,
  requestId: ctx.requestId,
});
```

In the Hermes harness, preserve its existing `undefined` phase range:

```ts
await harvestOutput(ctx.workingDir, undefined, ctx.task, {
  taskId: ctx.taskId,
  attemptIndex: ctx.attemptIndex,
  requestId: ctx.requestId,
});
```

- [ ] **Step 5: Update the bundled jinn-repo runtime documentation**

In `client/plugins/jinn-repo-runtime/skills/task/SKILL.md`:

- retain the legacy `jinn-repo-solution.v1` section for retrospective and
  ordinary live-issue Tasks;
- add a section for `goal.spec.source: autopilot-session`;
- state that the daemon materializes
  `jinn-autopilot-mutation-result.v1`;
- state that the agent leaves the patch uncommitted and does not invent
  Task/request/attempt identity;
- state that `deliveryEnvelopeCid` is derived after signed-envelope assembly
  and must not be authored by the agent.

- [ ] **Step 6: Run focused harvest and engine tests**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/harnesses/learner/jinn-repo-harvest.test.ts \
  test/harnesses/engine/bug-fixes.test.ts \
  test/harnesses/impls/hermes-agent/harness.test.ts
```

Expected: all focused tests pass, including the unchanged legacy materializer
cases.

- [ ] **Step 7: Commit typed harvest**

```bash
git add \
  client/src/harnesses/types.ts \
  client/src/harnesses/engine/engine.ts \
  client/src/harnesses/impls/learner/harvest.ts \
  client/src/harnesses/impls/learner/harness.ts \
  client/src/harnesses/impls/hermes-agent/harness.ts \
  client/plugins/jinn-repo-runtime/skills/task/SKILL.md \
  client/test/harnesses/learner/jinn-repo-harvest.test.ts \
  client/test/harnesses/engine/bug-fixes.test.ts \
  client/test/harnesses/impls/hermes-agent/harness.test.ts
git commit -m "fix(client): harvest typed Autopilot mutation results"
```

---

### Task 3: Bind every authenticated consumer to the envelope CID

**Files:**
- Modify: `client/src/autopilot/marketplace-delivery-observer.ts`
- Modify: `client/src/autopilot/github-adoption-receipt-observer.ts`
- Modify: `client/src/adapters/mech/adapter.ts`
- Modify: `client/src/harnesses/engine/engine.ts`
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/harness.ts`
- Test: `client/test/autopilot/marketplace-delivery-observer.test.ts`
- Test: `client/test/autopilot/github-adoption-receipt-observer.test.ts`
- Test: `client/test/adapters/mech/adapter.test.ts`
- Test: `client/test/harnesses/jinn-repo-evaluator/harness.test.ts`

**Interfaces:**
- Consumes:
  `bindAutopilotMutationDeliveryResult(value, deliveryEnvelopeCid)` from Task 1.
- Produces: only strict `AutopilotMutationResult` values after envelope
  authentication or persisted-manifest recovery.
- Preserves: review/Verdict parsing is unchanged.

- [ ] **Step 1: Convert consumer fixtures to producer-side payloads**

In each listed test file, find the helper that constructs an Autopilot
Solution payload or signed Solution envelope. Before embedding the mutation
result, remove only:

```ts
const producerResult = structuredClone(mutationResult);
delete (
  producerResult.correlation as Record<string, unknown>
).deliveryEnvelopeCid;
```

Keep strict mutation fixtures unchanged where the test directly targets
`AutopilotMutationResultSchema`, evaluation context, or an accepted receipt.

Add focused assertions:

```ts
it('derives deliveryEnvelopeCid from the authenticated Solution envelope', async () => {
  const observed = await observer.observe(expectation);
  expect(observed).toMatchObject({
    status: 'verified',
    result: {
      correlation: {
        deliveryEnvelopeCid: ENVELOPE_CID,
      },
    },
  });
});
```

For receipt recovery, persist a producer-side `solutionPayload` without the
CID and retain the existing accepted-receipt expectation.

For Mech and evaluator harness admission, embed the producer-side payload in
the signed envelope and retain the existing accepted-context expectation.

- [ ] **Step 2: Run focused consumer tests and verify strict parsing rejects the producer payload**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/autopilot/marketplace-delivery-observer.test.ts \
  test/autopilot/github-adoption-receipt-observer.test.ts \
  test/adapters/mech/adapter.test.ts \
  test/harnesses/jinn-repo-evaluator/harness.test.ts
```

Expected: tests fail at current strict mutation-result parsing with
`deliveryEnvelopeCid` missing.

- [ ] **Step 3: Bind the delivery observer**

In `client/src/autopilot/marketplace-delivery-observer.ts`, import the SDK
binder. Replace the Solution branch's direct strict parse with:

```ts
let result: AutopilotMutationResult | AutopilotReviewResult;
if (expected.role === 'solution') {
  try {
    result = bindAutopilotMutationDeliveryResult(
      envelope.payload,
      lookup.envelope.manifestCid,
    );
  } catch (error) {
    return contradiction('invalid-result', errorDetail(error));
  }
} else {
  const parsed = AutopilotReviewResultSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    return contradiction(
      'invalid-result',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    );
  }
  result = parsed.data;
}
```

Use `result.correlation` for the complete expected-correlation comparison and
return `result` in the verified observation.

- [ ] **Step 4: Bind persisted output before receipt polling**

In `client/src/autopilot/github-adoption-receipt-observer.ts`:

- keep Verdict parsing unchanged;
- require `run.manifestCid` for a Solution;
- call the binder on `payload.solutionPayload` and `run.manifestCid`;
- on failure return the existing strict-SDK-schema error;
- perform the current correlation checks against the bound strict result.

The Solution branch must be equivalent to:

```ts
let parsedMutation: AutopilotMutationResult | undefined;
if (role === 'solution') {
  if (!run.manifestCid) {
    return { error: 'persisted solution envelope CID is unavailable' };
  }
  try {
    parsedMutation = bindAutopilotMutationDeliveryResult(
      payload.solutionPayload,
      run.manifestCid,
    );
  } catch {
    return { error: 'persisted solution output failed its strict SDK schema' };
  }
}
```

- [ ] **Step 5: Bind evaluator discovery and evaluator harness admission**

In `client/src/adapters/mech/adapter.ts`, after the authenticated Solution
envelope and `solutionEnvelopeCid` are known:

```ts
let parsedSolution: AutopilotMutationResult;
try {
  parsedSolution = bindAutopilotMutationDeliveryResult(
    parsedEnvelope.data.payload,
    solutionEnvelopeCid,
  );
} catch {
  console.log(
    `[mech] keeping Autopilot evaluation opportunity ${solution.requestId} pending: invalid mutation result`,
  );
  return undefined;
}
```

Pass `parsedSolution` to the evaluation-context resolver and admission helper.

In
`client/src/harnesses/impls/jinn-repo-evaluator/harness.ts`, resolve
`solutionEnvelopeCid` before parsing the Solution payload, then call the same
binder and pass the strict result to
`admitAutopilotEvaluationOpportunity`.

- [ ] **Step 6: Bind engine receipt-prefix recovery**

In `client/src/harnesses/engine/engine.ts`, update
`persistedAutopilotCorrelation`:

```ts
if (role === 'solution') {
  if (!task.manifestCid) return null;
  const result = bindAutopilotMutationDeliveryResult(
    output.solutionPayload,
    task.manifestCid,
  );
  return result.correlation;
}
```

Keep the Verdict branch's strict parse unchanged. Catch parsing failures and
return `null` as today.

- [ ] **Step 7: Run focused consumer and engine tests**

Run:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client vitest run \
  test/autopilot/marketplace-delivery-observer.test.ts \
  test/autopilot/github-adoption-receipt-observer.test.ts \
  test/adapters/mech/adapter.test.ts \
  test/harnesses/jinn-repo-evaluator/harness.test.ts \
  test/harnesses/engine/bug-fixes.test.ts
```

Expected: all focused consumers accept producer payloads only after binding,
and all existing mismatch/contradiction tests remain green.

- [ ] **Step 8: Commit consumer binding**

```bash
git add \
  client/src/autopilot/marketplace-delivery-observer.ts \
  client/src/autopilot/github-adoption-receipt-observer.ts \
  client/src/adapters/mech/adapter.ts \
  client/src/harnesses/engine/engine.ts \
  client/src/harnesses/impls/jinn-repo-evaluator/harness.ts \
  client/test/autopilot/marketplace-delivery-observer.test.ts \
  client/test/autopilot/github-adoption-receipt-observer.test.ts \
  client/test/adapters/mech/adapter.test.ts \
  client/test/harnesses/jinn-repo-evaluator/harness.test.ts
git commit -m "fix(client): bind mutation results to delivery envelopes"
```

---

### Task 4: Run complete SDK/client verification and build the canary daemon

**Files:**
- Modify only files required to fix failures caused by Tasks 1–3.
- Do not change unrelated failing tests or suppress checks.

**Interfaces:**
- Consumes: all code from Tasks 1–3.
- Produces: a built `client/dist/bin/jinn.js` whose vendored SDK contains the
  new producer schema and binder.

- [ ] **Step 1: Run diff and schema hygiene checks**

```bash
git diff --check origin/next...HEAD
git diff --name-only origin/next...HEAD
```

Expected: `git diff --check` is clean and only the planned implementation,
test, skill, design, and plan files appear.

- [ ] **Step 2: Run the complete SDK suite**

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd packages/sdk test
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd packages/sdk typecheck
```

Expected: all SDK tests and typecheck pass.

- [ ] **Step 3: Run client typecheck and the complete client suite**

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client typecheck
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client test
```

Expected: client typecheck and the complete hermetic test suite pass. If a
pre-existing network-dependent test is explicitly skipped by the suite,
record the skip count without converting it to a pass.

- [ ] **Step 4: Build and inspect the distributable client**

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
  yarn --cwd client build
rg -n "bindAutopilotMutationDeliveryResult|AutopilotMutationDeliveryResultSchema" \
  client/dist \
  client/dist/vendor/@jinn-network/sdk/dist
```

Expected: build exits zero and both the client output and vendored SDK contain
the new boundary.

- [ ] **Step 5: Review the complete branch diff**

```bash
git status --short
git diff --stat origin/next...HEAD
git diff origin/next...HEAD -- \
  packages/sdk/src \
  client/src \
  client/plugins/jinn-repo-runtime \
  packages/sdk/test \
  client/test
```

Confirm:

- no unrelated path changed;
- strict receipts still require envelope CID;
- legacy payload behavior remains;
- every producer-side consumer binds from authenticated or persisted envelope
  provenance.

- [ ] **Step 6: Commit any verification-only correction**

If Steps 1–5 required a source or test correction, stage only those exact
files and commit:

```bash
git commit -m "test(client): cover Autopilot mutation delivery binding"
```

If no correction was required, do not create an empty commit.

---

### Task 5: Run a fresh live marketplace canary through Solution claimability

**Files and state:**
- Built client: `client/dist/bin/jinn.js`
- Existing operator home: `/Users/adrianobradley/.jinn-client`
- Standalone Autopilot worktree:
  `/Users/adrianobradley/life's-work/autopilot/.worktrees/marketplace-solution-adoption`
- Dedicated target checkout:
  `/Users/adrianobradley/life's-work/jinn-mono-standalone-autopilot-canary`
- Dedicated new attempt base and `AUTOPILOT_HOME` using the fresh issue number.

**Interfaces:**
- Consumes: built client with the fixed producer/binder contract.
- Produces: one accepted Solution adoption receipt plus exact-head evaluator
  claim/readiness for the same Task, with no second evaluator Task.

- [ ] **Step 1: Preserve the failed canary evidence**

Record without mutation:

```text
Issue: 2253
PR: 2255
Task: 1192
Request: 0x1b69ae25072e6965a97f2f8ecd94b2054dae2ddc772cdb1e8d517d2225cef970
Invalid envelope: bafkreiedr3fzaa3x7rkl6typ4mjm6xxdzgjvd5obxuq4j5lp3zmc6umra4
Observer result: invalid-result, missing mutation-complete/human discriminator
```

Do not rewrite the Task row, delivery, or envelope.

- [ ] **Step 2: Restart the existing daemon with the built client**

Stop only the current foreground daemon process through its supported
interrupt/stop path. Start:

```bash
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH \
JINN_DISABLE_AUTO_TASKS=1 \
<existing operator authentication environment> \
/Users/adrianobradley/life's-work/jinn-mono/.worktrees/autopilot-mutation-payload-binding/client/dist/bin/jinn.js \
run --no-ui
```

Do not print secrets. Confirm:

- the configured API port is healthy;
- Docker remains healthy;
- canonical SolverNet `jinn-repo.v1` has solver and evaluator membership;
- no second daemon is running.

- [ ] **Step 3: Create one fresh disposable canary issue**

Create one Low-effort documentation issue in `Jinn-Network/mono` that:

- modifies only a non-CODEOWNER Markdown file;
- is on the engineering Project as Todo;
- has Blocked on `Nothing`, Priority `P4`, Effort `Low`;
- contains a unique marketplace canary marker;
- has no dependency and no Human hold.

Record the new issue number as `<CANARY_ISSUE>`.

- [ ] **Step 4: Run the live capability probe**

From the standalone Autopilot worktree, use the built client path and the same
canonical network configuration to create a fresh immutable capability
attestation. Verify the attestation reports:

- repository `Jinn-Network/mono`;
- language `typescript`;
- verification profile `jinn-mono.v1`;
- Docker image digest available;
- exactly one compatible launched `jinn-repo.v1` SolverNet.

- [ ] **Step 5: Run one tightly allowlisted active cycle**

From the target checkout, run standalone Autopilot with:

```bash
JINN_AUTOPILOT_EXECUTION_BACKEND=marketplace
JINN_AUTOPILOT_ONLY_ISSUES=<CANARY_ISSUE>
JINN_AUTOPILOT_IMPLEMENTATION_CAP=1
JINN_AUTOPILOT_REVIEW_CAP=1
JINN_AUTOPILOT_RUNNER_ID=marketplace-canary-<CANARY_ISSUE>-<UTC_STAMP>
JINN_AUTOPILOT_WORKTREE_BASE=/Users/adrianobradley/.jinn-client/autopilot/marketplace-canary-<CANARY_ISSUE>-attempts
JINN_AUTOPILOT_CAPABILITY_ATTESTATION=<FRESH_ATTESTATION>
AUTOPILOT_HOME=/Users/adrianobradley/.jinn-client/autopilot/marketplace-canary-<CANARY_ISSUE>-home
JINN_IMPL_GH_TOKEN=<implementer token>
AUTOPILOT_GITHUB_IMPLEMENT_TOKEN=<implementer token>
JINN_REVIEW_GH_TOKEN=<reviewer token>
AUTOPILOT_GITHUB_REVIEW_TOKEN=<reviewer token>
JINN_REVIEW_BOT_LOGIN=ritsukai
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH
```

Invoke:

```bash
env -u JINN_DISPATCHER_AUTHOR_ALLOWLIST \
  /Users/adrianobradley/life's-work/autopilot/.worktrees/marketplace-solution-adoption/node_modules/.bin/tsx \
  /Users/adrianobradley/life's-work/autopilot/.worktrees/marketplace-solution-adoption/scripts/run-autopilot-v2.ts \
  --mode active --once --json status
```

Confirm exactly one implementation Task is submitted.

- [ ] **Step 6: Observe the fixed delivery payload**

Wait for the daemon to reach `AWAITING_ADOPTION`. Run the released-command
surface from the built client:

```bash
client/dist/bin/jinn.js tasks observe-autopilot-delivery \
  --expectation-file <ATTEMPT_DIR>/marketplace-solution-expectation.json \
  --json
```

Require:

- observation status `verified`;
- result schema `jinn-autopilot-mutation-result.v1`;
- outcome `mutation-complete`;
- result correlation matches Task, attempt, request, V2 attempt, claim, PR,
  expected head, and actual authenticated envelope CID;
- no legacy `jinn-repo-solution.v1` payload.

- [ ] **Step 7: Recover adoption without dispatching another Task**

Run the same Autopilot environment with:

```bash
env -u JINN_DISPATCHER_AUTHOR_ALLOWLIST \
  /Users/adrianobradley/life's-work/autopilot/.worktrees/marketplace-solution-adoption/node_modules/.bin/tsx \
  /Users/adrianobradley/life's-work/autopilot/.worktrees/marketplace-solution-adoption/scripts/run-autopilot-v2.ts \
  --mode recover --once --json status
```

Repeat only recovery cycles as necessary for indexer/GitHub readback. Never run
a second active implementation dispatch for the same issue.

- [ ] **Step 8: Verify the parity stop condition**

Require all of:

- Solution observed;
- immutable Docker verification passed;
- patch applied to the existing Autopilot attempt worktree;
- marketplace-evidence commit pushed to the existing PR branch;
- implementation completion marker and lifecycle readback present;
- exact-head evaluator review claim acquired;
- evaluator leg uses the same Task and no second Task was submitted;
- authenticated accepted Solution adoption receipt present on the PR;
- daemon observes the receipt and can claim, or has claimed, the Solution.

Stop before Verdict result adoption.

- [ ] **Step 9: Capture final evidence**

Record:

- issue and PR numbers;
- Task ID/CID, request ID, creation transaction/block;
- Solution envelope CID/digest and delivery transaction/block;
- V2 attempt path and resulting PR head;
- Docker image digest and verification result;
- evaluator review attempt/generation/ref/head;
- adoption receipt marker, author, disposition, and operation;
- daemon Solution-claim transaction or exact claimability evidence;
- confirmation that only one top-level Task exists.
