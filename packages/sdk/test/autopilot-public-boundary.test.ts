import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  AutopilotDeliveryCommandResultV1Schema,
  AutopilotDeliveryExpectationSchema,
  AutopilotDeliveryObservationSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  TaskSubmitRequestV1Schema,
  TaskSubmitResultV1Schema,
  parseAutopilotAdoptionReceiptComment,
  type AcceptedSolutionAdoptionReceipt,
  type AutopilotDeliveryCommandResultV1,
  type AutopilotDeliveryContradictionReason,
  type AutopilotDeliveryExpectation,
  type AutopilotDeliveryObservation,
  type AutopilotDeliveryPendingReason,
  type AutopilotMutationEvidence,
  type AutopilotReviewCorrelation,
  type TaskSubmitRequestV1,
  type TaskSubmitResultV1,
} from '../src/autopilot.js';
import {
  AutopilotDeliveryExpectationSchema as SolverNetDeliveryExpectationSchema,
  TaskSubmitRequestV1Schema as SolverNetTaskSubmitRequestV1Schema,
} from '../src/solvernets/jinn-repo.js';

const canonicalFixtureDirectory = fileURLToPath(
  new URL('../fixtures/autopilot/', import.meta.url),
);

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(canonicalFixtureDirectory, name), 'utf8'),
  ) as unknown;
}

const decoderByManifestName = {
  'AutopilotSessionCapsuleSchema': (text: string) =>
    AutopilotSessionCapsuleSchema.safeParse(JSON.parse(text)).success,
  'AutopilotMutationResultSchema': (text: string) =>
    AutopilotMutationResultSchema.safeParse(JSON.parse(text)).success,
  'AutopilotReviewResultSchema': (text: string) =>
    AutopilotReviewResultSchema.safeParse(JSON.parse(text)).success,
  'AutopilotAdoptionReceiptSchema': (text: string) =>
    AutopilotAdoptionReceiptSchema.safeParse(JSON.parse(text)).success,
  'AutopilotCorrelationSchema': (text: string) =>
    AutopilotCorrelationSchema.safeParse(JSON.parse(text)).success,
  'AutopilotAdoptionReceiptComment': (text: string) =>
    parseAutopilotAdoptionReceiptComment(text.trimEnd()) !== null,
  'TaskSubmitRequestV1Schema': (text: string) =>
    TaskSubmitRequestV1Schema.safeParse(JSON.parse(text)).success,
  'TaskSubmitResultV1Schema': (text: string) =>
    TaskSubmitResultV1Schema.safeParse(JSON.parse(text)).success,
  'AutopilotDeliveryExpectationSchema': (text: string) =>
    AutopilotDeliveryExpectationSchema.safeParse(JSON.parse(text)).success,
  'AutopilotDeliveryObservationSchema': (text: string) =>
    AutopilotDeliveryObservationSchema.safeParse(JSON.parse(text)).success,
} as const;

describe('@jinn-network/sdk/autopilot public boundary', () => {
  it('exports every host-facing schema and inferred type', () => {
    expect(AutopilotSessionCapsuleSchema).toBeDefined();
    expect(AutopilotMutationResultSchema).toBeDefined();
    expect(AutopilotReviewResultSchema).toBeDefined();
    expect(AutopilotAdoptionReceiptSchema).toBeDefined();
    expect(AutopilotCorrelationSchema).toBeDefined();
    expect(TaskSubmitRequestV1Schema).toBeDefined();
    expect(TaskSubmitResultV1Schema).toBeDefined();
    expect(AutopilotDeliveryExpectationSchema).toBeDefined();
    expect(AutopilotDeliveryObservationSchema).toBeDefined();
    expect(AutopilotDeliveryCommandResultV1Schema).toBeDefined();

    expectTypeOf<TaskSubmitRequestV1>().not.toBeAny();
    expectTypeOf<TaskSubmitResultV1>().not.toBeAny();
    expectTypeOf<AutopilotReviewCorrelation>().not.toBeAny();
    expectTypeOf<AutopilotMutationEvidence>().not.toBeAny();
    expectTypeOf<AcceptedSolutionAdoptionReceipt>().not.toBeAny();
    expectTypeOf<AutopilotDeliveryExpectation>().not.toBeAny();
    expectTypeOf<AutopilotDeliveryPendingReason>().not.toBeAny();
    expectTypeOf<AutopilotDeliveryContradictionReason>().not.toBeAny();
    expectTypeOf<AutopilotDeliveryObservation>().not.toBeAny();
    expectTypeOf<AutopilotDeliveryCommandResultV1>().not.toBeAny();
  });

  it('keeps the SolverNet barrel on the identical schema objects', () => {
    expect(SolverNetTaskSubmitRequestV1Schema).toBe(TaskSubmitRequestV1Schema);
    expect(SolverNetDeliveryExpectationSchema)
      .toBe(AutopilotDeliveryExpectationSchema);
  });
});

describe('Task submit wire contracts', () => {
  it('accepts the canonical request and command result fixtures', () => {
    expect(TaskSubmitRequestV1Schema.parse(fixture('submit-request.json')))
      .toEqual(fixture('submit-request.json'));
    expect(TaskSubmitResultV1Schema.parse(fixture('submit-result.json')))
      .toEqual(fixture('submit-result.json'));
  });

  it('rejects malformed requests and preserves all private-validator invariants', () => {
    expect(TaskSubmitRequestV1Schema.safeParse(
      fixture('malformed-submit-request.json'),
    ).success).toBe(false);

    const valid = fixture('submit-request.json') as Record<string, any>;
    const invalidCases = [
      { ...valid, id: 'manual-key' },
      {
        ...valid,
        solverNet: 'Autopilot production',
      },
      {
        ...valid,
        window: {
          ...valid.window,
          endTs: valid.window.startTs,
        },
      },
      {
        ...valid,
        claimPolicy: {
          ...valid.claimPolicy,
          claimWindowStartTs: valid.window.startTs - 1,
        },
      },
      {
        ...valid,
        claimPolicy: {
          ...valid.claimPolicy,
          submissionDeadlineTs: valid.window.endTs + 1,
        },
      },
      {
        ...valid,
        spec: {
          ...valid.spec,
          session: {
            ...valid.spec.session,
            deadline: new Date(
              valid.claimPolicy.submissionDeadlineTs + 1,
            ).toISOString(),
          },
        },
      },
    ];
    for (const invalid of invalidCases) {
      expect(TaskSubmitRequestV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('is strict and JSON-safe at every new command boundary', () => {
    const request = fixture('submit-request.json') as Record<string, unknown>;
    const result = fixture('submit-result.json') as Record<string, unknown>;
    expect(TaskSubmitRequestV1Schema.safeParse({
      ...request,
      unexpected: true,
    }).success).toBe(false);
    expect(TaskSubmitResultV1Schema.safeParse({
      ...result,
      unexpected: true,
    }).success).toBe(false);
    expect(() => JSON.stringify(TaskSubmitResultV1Schema.parse(result)))
      .not.toThrow();
  });
});

describe('Autopilot delivery wire contracts', () => {
  it('accepts solution and verdict expectations', () => {
    for (const name of [
      'solution-expectation.json',
      'verdict-expectation.json',
    ]) {
      expect(AutopilotDeliveryExpectationSchema.parse(fixture(name)))
        .toEqual(fixture(name));
    }
  });

  it('requires paired attempt pins and a Solution operator for Verdicts', () => {
    const solution =
      fixture('solution-expectation.json') as Record<string, unknown>;
    const verdict =
      fixture('verdict-expectation.json') as Record<string, unknown>;
    expect(AutopilotDeliveryExpectationSchema.safeParse({
      ...solution,
      requestId: undefined,
    }).success).toBe(false);
    expect(AutopilotDeliveryExpectationSchema.safeParse({
      ...verdict,
      solutionOperator: undefined,
    }).success).toBe(false);
  });

  it('accepts pending, contradiction, and verified role-specific observations', () => {
    for (const name of [
      'delivery-pending.json',
      'delivery-contradiction.json',
      'verified-solution.json',
      'verified-verdict.json',
    ]) {
      const value = fixture(name);
      expect(AutopilotDeliveryObservationSchema.parse(value)).toEqual(value);
      expect(() => JSON.stringify(value)).not.toThrow();
    }
  });

  it('exposes only authenticated envelope provenance in verified observations', () => {
    const value =
      fixture('verified-solution.json') as Record<string, any>;
    const parsed = AutopilotDeliveryObservationSchema.parse(value);
    expect(parsed.status).toBe('verified');
    if (parsed.status !== 'verified') return;

    expect(parsed.envelope).toEqual({
      cid: value.envelope.cid,
      digest: value.envelope.digest,
      executionSchema: 'jinn.execution.v1',
      solverType: 'jinn-repo.v1',
      role: 'solution',
      participant: {
        safeAddress: value.envelope.participant.safeAddress,
        agentEoa: value.envelope.participant.agentEoa,
      },
      signer: value.envelope.signer,
    });
    expect(parsed.envelope).not.toHaveProperty('payload');
    expect(parsed.envelope).not.toHaveProperty('signature');
  });

  it('binds verified role, envelope role, result role, session, and correlation', () => {
    const solution =
      fixture('verified-solution.json') as Record<string, any>;
    const correlationFailure =
      fixture('correlation-failure.json') as Record<string, unknown>;
    expect(AutopilotDeliveryObservationSchema.safeParse({
      ...solution,
      envelope: { ...solution.envelope, role: 'verdict' },
    }).success).toBe(false);
    expect(AutopilotDeliveryObservationSchema.safeParse(
      correlationFailure,
    ).success).toBe(false);
    expect(AutopilotDeliveryObservationSchema.safeParse({
      ...solution,
      result: {
        ...solution.result,
        correlation: {
          ...solution.result.correlation,
          taskId: '999',
        },
      },
    }).success).toBe(false);
  });

  // PUBLISHED EXTERNAL BOUNDARY. `Jinn-Network/autopilot` value-imports
  // `AutopilotDeliveryCommandResultV1Schema` from `@jinn-network/sdk/autopilot`
  // (`src/lifecycle/marketplace-delivery.ts:18`) and parses the verb's stdout
  // with it (`:317`). Dropping the export breaks that consumer's compile on its
  // next SDK bump, so this pin asserts PRESENCE from both barrels.
  it('publishes the delivery command-result envelope from both barrels', async () => {
    const autopilotModule: Record<string, unknown> =
      await import('../src/autopilot.js');
    const jinnRepoModule: Record<string, unknown> =
      await import('../src/solvernets/jinn-repo.js');
    expect(autopilotModule['AutopilotDeliveryCommandResultV1Schema'])
      .toBeDefined();
    expect(jinnRepoModule['AutopilotDeliveryCommandResultV1Schema'])
      .toBe(autopilotModule['AutopilotDeliveryCommandResultV1Schema']);
  });

  it('parses the verb envelope the external consumer sends and rejects drift', () => {
    const observation = fixture('verified-solution.json');
    const envelope = {
      schemaVersion: 1,
      generatedAt: '2026-07-27T12:00:00.000Z',
      verb: 'tasks observe-autopilot-delivery',
      observation,
    };
    expect(AutopilotDeliveryCommandResultV1Schema.parse(envelope))
      .toEqual(envelope);
    // The `verb` literal is the contract the consumer keys on; a renamed verb
    // must fail loudly here rather than parse into a stale shape.
    expect(AutopilotDeliveryCommandResultV1Schema.safeParse({
      ...envelope,
      verb: 'tasks observe-delivery',
    }).success).toBe(false);
    expect(AutopilotDeliveryCommandResultV1Schema.safeParse({
      ...envelope,
      unexpected: true,
    }).success).toBe(false);
  });
});

describe('published Autopilot fixture manifest', () => {
  it('keeps both delivery roles on the originating submitted Task', () => {
    const submitted = fixture('submit-result.json') as Record<string, any>;
    const solutionExpectation =
      fixture('solution-expectation.json') as Record<string, any>;
    const verdictExpectation =
      fixture('verdict-expectation.json') as Record<string, any>;
    const verifiedSolution =
      fixture('verified-solution.json') as Record<string, any>;
    const verifiedVerdict =
      fixture('verified-verdict.json') as Record<string, any>;

    for (const expectation of [solutionExpectation, verdictExpectation]) {
      expect(expectation).toMatchObject({
        taskId: submitted.taskId,
        taskCid: submitted.taskCid,
        creationBlockNumber: submitted.creationBlock,
      });
    }
    for (const observation of [verifiedSolution, verifiedVerdict]) {
      expect(observation.task).toMatchObject({
        taskId: submitted.taskId,
        taskCid: submitted.taskCid,
        createdAtBlock: submitted.creationBlock,
        createdAtTx: submitted.creationTx,
      });
    }
  });

  it('lists, hashes, and decodes every canonical fixture exactly once', () => {
    const manifest = fixture('manifest.json') as {
      schemaVersion: string;
      fixtures: Array<{
        path: string;
        schema: keyof typeof decoderByManifestName;
        disposition: string;
        sha256: string;
        decode: 'accept' | 'reject';
      }>;
    };
    expect(manifest.schemaVersion).toBe('jinn-autopilot-fixtures.v1');

    const files = readdirSync(canonicalFixtureDirectory)
      .filter((name) => name !== 'manifest.json')
      .sort();
    const listed = manifest.fixtures.map((entry) => entry.path).sort();
    expect(listed).toEqual(files);
    expect(new Set(listed).size).toBe(listed.length);

    for (const entry of manifest.fixtures) {
      const bytes = readFileSync(join(canonicalFixtureDirectory, entry.path));
      expect(createHash('sha256').update(bytes).digest('hex'))
        .toBe(entry.sha256);
      const decoded =
        decoderByManifestName[entry.schema](bytes.toString('utf8'));
      expect(decoded, entry.path).toBe(entry.decode === 'accept');
    }
  });
});
