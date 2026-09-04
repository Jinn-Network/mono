import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_support/source-text.js';

function rawSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

function source(path: string): string {
  return codeOnly(rawSource(path));
}

const coordinator = source('../../src/daemon/native-solution-coordinator.ts');
const verification = source('../../src/daemon/native-solution-verification.ts');
const settlement = source('../../src/daemon/native-solution-settlement.ts');
const publisher = source('../../src/daemon/native-solution-publisher.ts');
const composition = source('../../src/daemon/composition-root.ts');
const workLoop = source('../../src/daemon/work-loop.ts');
const main = source('../../src/main.ts');
const e2eHelpers = source('../e2e/_daemon-harness-helpers.ts');
const marketplaceE2e = rawSource('../e2e/task-creator-marketplace.ts');
const nativeModules = [coordinator, verification, settlement, publisher].join('\n');

describe('Phase B native solution architecture boundaries', () => {
  it('ignores dependency markers in prose without hiding executable bridge code', () => {
    const prose = codeOnly([
      '/** bridge-legacy-delivery and DeliveryWatcherLoop are historical terms. */',
      '// synthesizeLegacyExecutionDocuments and verifyVerdictObservationGap',
      'const safe = true;',
    ].join('\n'));
    expect(prose).not.toMatch(
      /bridge-legacy-delivery|synthesizeLegacyExecutionDocuments|DeliveryWatcherLoop|verifyVerdictObservationGap/u,
    );
    expect(codeOnly('/** safe */\nDeliveryWatcherLoop.start();')).toMatch(
      /bridge-legacy-delivery|synthesizeLegacyExecutionDocuments|DeliveryWatcherLoop|verifyVerdictObservationGap/u,
    );
  });

  it('keeps native execution free of bridge records, legacy watchers, and placeholder gap ports', () => {
    expect(nativeModules).not.toMatch(
      /bridge-legacy-delivery|synthesizeLegacyExecutionDocuments|DeliveryWatcherLoop|verifyVerdictObservationGap/u,
    );
    expect(nativeModules).not.toContain("archive.since('')");
    expect(nativeModules).not.toContain('capabilityMatch: async () => ({ ok: true })');
  });

  it('persists exact dispatch bytes before the first backend submit call', () => {
    const begin = coordinator.indexOf('this.input.state.beginSolutionExecution');
    const submit = coordinator.indexOf('this.input.backend.submit');
    expect(begin).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(begin);
    expect(coordinator).toContain('dispatchContextBytes');
    expect(verification).toContain("resolveEffective(\n        'solver-delivery',\n        delivery.createdAt");
  });

  it('owns a distinct solver-records source and wires concrete production ports', () => {
    expect(publisher).toContain("const SOLVER_RECORDS_SOURCE_NAME = 'solver-records'");
    expect(publisher).not.toContain("name: 'operator-projector'");
    expect(composition).toContain('await openNativeSolutionPublisher');
    expect(composition).toContain('new NativeSolutionCoordinator');
    expect(composition).toContain('buildNativeSolutionVerification');
    expect(composition).toContain('buildNativeSolutionSettlementPort');
    expect(workLoop).toContain('nativeSolutionCoordinator!.reconcileStartup()');
    expect(workLoop).toContain('nativeSolutionCoordinator!.reconcileEngagement(result.engagementId)');
  });

  it('distinguishes the legacy marketplace E2E gap from native settlement wiring', () => {
    expect(codeOnly(marketplaceE2e)).toContain('composition: { manifestCid: KNOWN_MANIFEST_CID }');
    expect(e2eHelpers).toMatch(/composition = await buildOperatorComposition\(\{\s*mode: 'legacy'/u);
    expect(e2eHelpers).toContain('acceptLegacyCards: true');

    expect(main).toContain("COMPOSITION_MODE === 'native'");
    expect(main).toContain("mode: 'native' as const");
    expect(main).toContain('nativeClaimRuntime: nativeRuntime.claimRuntime');
    expect(main).toContain('nativeSolutionCoordinator: composition.nativeSolutionCoordinator!');
    expect(composition).toMatch(
      /new NativeSolutionCoordinator\(\{[\s\S]*settlement: buildNativeSolutionSettlementPort\(\{/u,
    );
    expect(workLoop).toContain('nativeSolutionCoordinator!.reconcileStartup()');
    expect(workLoop).toContain('nativeSolutionCoordinator!.reconcileEngagement(result.engagementId)');

    const beginSettlement = coordinator.indexOf('this.input.state.beginSolutionSettlement');
    const broadcastSettlement = coordinator.indexOf('this.input.settlement.broadcast', beginSettlement);
    const recordBroadcast = coordinator.indexOf(
      'this.input.state.recordSolutionSettlementBroadcast',
      broadcastSettlement,
    );
    const recordFinalized = coordinator.indexOf(
      'this.input.state.recordSolutionSettlementFinalized',
      recordBroadcast,
    );
    expect(beginSettlement).toBeGreaterThan(-1);
    expect(broadcastSettlement).toBeGreaterThan(beginSettlement);
    expect(recordBroadcast).toBeGreaterThan(broadcastSettlement);
    expect(recordFinalized).toBeGreaterThan(recordBroadcast);

    expect(marketplaceE2e).toContain(
      'This is a legacy-lane E2E gap, not missing settlement in production native mode.',
    );
    expect(marketplaceE2e).not.toContain(
      'the composition `WorkLoop` delivers to the mech but never settles',
    );
  });

  it('uses canonical projector state rather than transaction receipts as finality authority', () => {
    expect(settlement).toContain('readObservations');
    expect(settlement).toContain('readFinalizedBlockNumber');
    expect(settlement).toContain('readCanonicalBlockHash');
    expect(settlement).not.toMatch(/receipt.*finalized|finalized.*receipt/iu);
  });
});
