import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  analyzeAttributionInstrument,
  AttributionPreregistrationSchema,
  buildAttributionFacts,
  deriveAttributionCellOrder,
  renderAttributionReadoutMarkdown,
  type AttributionEvidenceBundle,
  type AttributionFacts,
  type AttributionPreregistration,
} from '../../src/eval/attribution-instrument.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import { createAttributionVerdictProof } from './attribution-verdict-fixture.js';

const digest = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const ref = (character: string): string => `sha256:${character.repeat(64)}`;
const AFTER = new Date('2026-07-22T10:00:00.000Z');

function prereg(): AttributionPreregistration {
  return {
    schema: 'jinn.attribution-preregistration.v1',
    instrumentId: 'stage2-daemon-autoload',
    registeredAt: '2026-07-20T08:00:00.000Z',
    design: 'matched-daemon-autoload-1x2',
    window: {
      startsAt: '2026-07-21T08:00:00.000Z',
      endsAt: '2026-07-22T08:00:00.000Z',
    },
    primaryOutcome: 'completed-with-accepted-diff',
    alpha: 0.05,
    minimumMatchedPairs: 6,
    minimumDiscordantPairs: 6,
    executionOrderSeed: 'frozen-order-seed',
    runtime: {
      modelRef: 'provider/model@version',
      harnessRef: 'daemon-task-engine.v1',
      graderRef: 'eval-semantics:v1',
      taskSourceRef: ref('1'),
      sourceRevision: '4bb1c1a21b9cc8966fa29ba67b3211eca3a676fa',
    },
    population: {
      instanceIds: Array.from({ length: 12 }, (_, index) => `task-${index}`),
    },
    cells: [
      { autoload: 'off', corpusSnapshotRef: ref('2'), treatmentConfigDigest: ref('3') },
      { autoload: 'on', corpusSnapshotRef: ref('2'), treatmentConfigDigest: ref('4') },
    ],
  };
}

function facts(offPass = 0, onPass = 10): AttributionFacts {
  const registration = prereg();
  const recorded: AttributionFacts = {
    schema: 'jinn.attribution-facts.v1',
    instrumentId: registration.instrumentId,
    completedAt: '2026-07-22T09:00:00.000Z',
    evidenceManifestDigest: ref('0'),
    cells: registration.cells.map((cell, cellIndex) => ({
      ...cell,
      runtime: registration.runtime,
      isolation: {
        runId: `daemon-run-${cell.autoload}`,
        agentHomeDigest: ref(cell.autoload === 'off' ? '5' : '6'),
        storeDigest: ref(cell.autoload === 'off' ? '7' : '8'),
      },
      startedAt: `2026-07-21T${cellIndex === 0 ? '08' : '14'}:00:00.000Z`,
      completedAt: `2026-07-21T${cellIndex === 0 ? '13' : '19'}:00:00.000Z`,
      results: registration.population.instanceIds.map((instanceId, index) => ({
        instanceId,
        startedAt: `2026-07-21T${cellIndex === 0 ? '09' : '15'}:${String(index).padStart(2, '0')}:00.000Z`,
        completedAt: `2026-07-21T${cellIndex === 0 ? '09' : '15'}:${String(index).padStart(2, '0')}:30.000Z`,
        passed: index < (cell.autoload === 'off' ? offPass : onPass),
        unscorable: false,
        sessionKind: 'user',
        origin: 'marketplace',
        verdictRef: `verdict:${cell.autoload}:${instanceId}`,
        verdictEvidenceDigest: ref('0'),
        deliveredRefs: cell.autoload === 'on' ? [ref(String((index % 9) + 1))] : [],
        cost: {
          inputTokens: 100 + index,
          outputTokens: 20 + index,
          usdMicros: 1_000 + index,
          usdMicrosEstimated: false,
        },
      })),
    })),
  };
  return recorded;
}

async function evidenceFor(recorded: AttributionFacts): Promise<AttributionEvidenceBundle> {
  const files: AttributionEvidenceBundle['files'] = [];
  for (let cellIndex = 0; cellIndex < recorded.cells.length; cellIndex++) {
    const cell = recorded.cells[cellIndex]!;
    for (let resultIndex = 0; resultIndex < cell.results.length; resultIndex++) {
      const result = cell.results[resultIndex]!;
      const verdictProof = await createAttributionVerdictProof({
        instanceId: result.instanceId,
        acceptedDiff: result.passed === true,
        nonce: cellIndex * 1_000 + resultIndex,
      });
      result.verdictRef =
        `verdict:${verdictProof.marketplace.verdict.chainId}:`
        + `${verdictProof.marketplace.verdict.taskId}:`
        + `${verdictProof.marketplace.verdict.attemptIndex}:`
        + `${verdictProof.marketplace.verdict.verdictIndex}:`
        + verdictProof.marketplace.verdict.requestId;
      const receipt = {
        schema: 'jinn.attribution-verdict-receipt.v1',
        instrumentId: recorded.instrumentId,
        autoload: cell.autoload,
        corpusSnapshotRef: cell.corpusSnapshotRef,
        treatmentConfigDigest: cell.treatmentConfigDigest,
        runtime: cell.runtime,
        isolation: cell.isolation,
        cellStartedAt: cell.startedAt,
        cellCompletedAt: cell.completedAt,
        instanceId: result.instanceId,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        sessionKind: result.sessionKind,
        origin: 'marketplace',
        verdictProof,
        deliveredRefs: result.deliveredRefs,
        cost: result.cost,
      };
      const content = Buffer.from(`${canonicalJson(receipt)}\n`);
      result.verdictEvidenceDigest = digest(content);
      files.push({
        path: `cells/${cell.autoload}/${result.instanceId}.verdict.json`,
        content,
      });
    }
  }
  const manifest = `${files
    .map((file) => `${digest(file.content).slice(7)}  ${file.path}`)
    .sort((left, right) => left < right ? -1 : 1)
    .join('\n')}\n`;
  recorded.evidenceManifestDigest = digest(manifest);
  return { manifest, files };
}

function options(
  registration: unknown,
  recorded: unknown,
  evidence: AttributionEvidenceBundle,
  now: Date = AFTER,
) {
  return {
    now,
    evidence,
    sourceBytes: {
      preregistration: Buffer.from(JSON.stringify(registration)),
      facts: Buffer.from(JSON.stringify(recorded)),
    },
  };
}

async function analyze(recorded: AttributionFacts, registration = prereg()) {
  const evidence = await evidenceFor(recorded);
  return await analyzeAttributionInstrument(
    registration,
    recorded,
    options(registration, recorded, evidence),
  );
}

describe('daemon autoload attribution analyzer', () => {
  it('derives and enforces the two-cell order from the preregistered seed', () => {
    expect(deriveAttributionCellOrder('2')).toEqual(['off', 'on']);
    expect(deriveAttributionCellOrder('1')).toEqual(['on', 'off']);

    const registration = prereg();
    registration.cells.reverse();
    expect(() => AttributionPreregistrationSchema.parse(registration)).toThrow(
      /execution order seed/i,
    );
  });

  it('deterministically exports analyzer-ready facts from frozen receipts', async () => {
    const registration = prereg();
    const recorded = facts();
    const evidence = await evidenceFor(recorded);
    const exported = await buildAttributionFacts(registration, recorded.completedAt, evidence);

    expect(exported).toEqual(recorded);
    await expect(
      buildAttributionFacts(registration, recorded.completedAt, evidence),
    ).resolves.toEqual(exported);
  });

  it('rejects operator-authored outcome fields even when their receipt is rehashed', async () => {
    const registration = prereg();
    const recorded = facts();
    const evidence = await evidenceFor(recorded);
    const firstFile = evidence.files[0]!;
    const receipt = JSON.parse(
      new TextDecoder().decode(firstFile.content),
    ) as Record<string, unknown>;
    receipt['acceptedDiff'] = false;
    receipt['unscorable'] = false;
    receipt['verdictRef'] = 'verdict:operator-authored';
    firstFile.content = Buffer.from(`${canonicalJson(receipt)}\n`);
    evidence.manifest = `${evidence.files
      .map((file) => `${digest(file.content).slice(7)}  ${file.path}`)
      .sort((left, right) => left < right ? -1 : 1)
      .join('\n')}\n`;

    await expect(
      buildAttributionFacts(registration, recorded.completedAt, evidence),
    ).rejects.toThrow(/unrecognized key/i);
  });

  it('renders deterministic helped JSON and Markdown with paired/Wilson facts', async () => {
    const registration = prereg();
    const recorded = facts();
    const first = await analyze(recorded, registration);
    const second = await analyze(recorded, registration);

    expect(first.design).toBe('matched-daemon-autoload-1x2');
    expect(first.comparison).toMatchObject({
      signal: 'helped',
      plannedN: 12,
      matchedN: 12,
      improved: 10,
      regressed: 0,
      barMet: true,
      offCost: {
        inputTokens: 1266,
        outputTokens: 306,
        usdMicros: 12066,
        estimatedObservations: 0,
      },
    });
    expect(first.comparison.pValue).toBeLessThan(0.05);
    expect(first.comparison.offRate.wilson95).toBeDefined();
    expect(first.preregistrationDigest).toBe(digest(JSON.stringify(registration)));
    expect(first.factsDigest).toBe(digest(JSON.stringify(recorded)));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const markdown = renderAttributionReadoutMarkdown(first);
    expect(markdown).toContain('Primary comparison: daemon autoload off → on');
    expect(markdown).toContain('Mechanical signal: helped');
    expect(markdown).toContain('95% Wilson');
    expect(markdown).toContain('Interpretation and downstream posture decisions remain human');
    expect(renderAttributionReadoutMarkdown({
      ...first,
      instrumentId: 'safe * [label](target)',
    })).toContain('safe \\* \\[label\\]\\(target\\)');
  });

  it.each([
    { off: 10, on: 0, signal: 'harmed' },
    { off: 0, on: 0, signal: 'inconclusive' },
  ])('classifies $signal', async ({ off, on, signal }) => {
    expect((await analyze(facts(off, on))).comparison.signal).toBe(signal);
  });

  it('classifies a powered balanced result as no-difference-detected', async () => {
    const recorded = facts();
    const off = recorded.cells.find((cell) => cell.autoload === 'off')!;
    const on = recorded.cells.find((cell) => cell.autoload === 'on')!;
    off.results.forEach((row, index) => { row.passed = index < 3; });
    on.results.forEach((row, index) => { row.passed = index >= 3 && index < 6; });
    expect((await analyze(recorded)).comparison).toMatchObject({
      signal: 'no-difference-detected',
      improved: 3,
      regressed: 3,
    });
  });

  it('rejects invalid bars and populations too large for exact arithmetic', async () => {
    const recorded = facts();
    const invalidBar = { ...prereg(), minimumDiscordantPairs: 5 };
    const invalidBarEvidence = await evidenceFor(recorded);
    await expect(analyzeAttributionInstrument(
      invalidBar,
      recorded,
      options(invalidBar, recorded, invalidBarEvidence),
    )).rejects.toThrow(/cannot reach significance/i);
    const oversized = {
      ...prereg(),
      population: {
        instanceIds: Array.from({ length: 1024 }, (_, index) => `task-${index}`),
      },
    };
    const oversizedEvidence = await evidenceFor(recorded);
    await expect(analyzeAttributionInstrument(
      oversized,
      recorded,
      options(oversized, recorded, oversizedEvidence),
    )).rejects.toThrow(/at most 1023/i);
  });

  it.each([
    ['runtime drift', (data: AttributionFacts) => { data.cells[0]!.runtime.modelRef = 'other'; }],
    ['treatment drift', (data: AttributionFacts) => { data.cells[0]!.treatmentConfigDigest = ref('9'); }],
    ['population drift', (data: AttributionFacts) => { data.cells[0]!.results[0]!.instanceId = 'other'; }],
    ['host internal', (data: AttributionFacts) => { data.cells[0]!.results[0]!.sessionKind = 'host-internal'; }],
    ['synthetic', (data: AttributionFacts) => { data.cells[0]!.results[0]!.origin = 'synthetic'; }],
    ['off delivery', (data: AttributionFacts) => { data.cells[0]!.results[0]!.deliveredRefs = [ref('9')]; }],
    ['outcome contradiction', (data: AttributionFacts) => {
      data.cells[0]!.results[0]!.passed = !data.cells[0]!.results[0]!.passed;
    }],
    ['cost contradiction', (data: AttributionFacts) => { data.cells[0]!.results[0]!.cost.usdMicros++; }],
    ['excessive delivery refs', (data: AttributionFacts) => {
      data.cells[1]!.results[0]!.deliveredRefs =
        Array.from({ length: 129 }, (_, index) => ref(String(index % 9)));
    }],
    ['observation timing', (data: AttributionFacts) => {
      data.cells[0]!.results[0]!.startedAt = '2026-07-21T07:00:00.000Z';
    }],
    ['reused isolation', (data: AttributionFacts) => {
      data.cells[1]!.isolation.storeDigest = data.cells[0]!.isolation.storeDigest;
    }],
  ])('fails closed on %s', async (_name, mutate) => {
    const recorded = facts();
    const evidence = await evidenceFor(recorded);
    mutate(recorded);
    const registration = prereg();
    await expect(analyzeAttributionInstrument(
      registration,
      recorded,
      options(registration, recorded, evidence),
    )).rejects.toThrow();
  });

  it('rejects manifest tampering, receipt tampering, and facts/receipt contradiction', async () => {
    const changedManifest = facts();
    const changedManifestEvidence = await evidenceFor(changedManifest);
    changedManifestEvidence.manifest += '\n';
    const registration = prereg();
    await expect(analyzeAttributionInstrument(
      registration,
      changedManifest,
      options(registration, changedManifest, changedManifestEvidence),
    )).rejects.toThrow(/manifest digest/i);

    const changedReceipt = facts();
    const changedReceiptEvidence = await evidenceFor(changedReceipt);
    changedReceiptEvidence.files[0]!.content = Buffer.from('tampered');
    await expect(analyzeAttributionInstrument(
      registration,
      changedReceipt,
      options(registration, changedReceipt, changedReceiptEvidence),
    )).rejects.toThrow(/evidence digest/i);

    const contradiction = facts();
    const contradictionEvidence = await evidenceFor(contradiction);
    contradiction.cells[1]!.results[0]!.deliveredRefs = [ref('9')];
    await expect(analyzeAttributionInstrument(
      registration,
      contradiction,
      options(registration, contradiction, contradictionEvidence),
    )).rejects.toThrow(/facts do not match/i);
  });

  it('rejects open-window analysis and multiline Markdown fields', async () => {
    const recorded = facts();
    const registration = prereg();
    const evidence = await evidenceFor(recorded);
    await expect(analyzeAttributionInstrument(
      registration,
      recorded,
      options(
        registration,
        recorded,
        evidence,
        new Date('2026-07-22T07:59:59.000Z'),
      ),
    )).rejects.toThrow(/window has not closed/i);
    const multiline = { ...prereg(), instrumentId: 'safe\nMechanical signal: helped' };
    await expect(analyzeAttributionInstrument(
      multiline,
      recorded,
      options(multiline, recorded, await evidenceFor(recorded)),
    )).rejects.toThrow(/single-line/i);
  });
});
