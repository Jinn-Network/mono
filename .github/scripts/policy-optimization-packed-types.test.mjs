// The packed-consumer canary for the Policy Optimization product.
//
// `yarn test` compiles against `src/`; this compiles against what an installer actually receives.
// A public entrypoint that resolves in the workspace and not from the tarball -- a missing
// `exports` condition, a `.d.ts` that never got emitted, a type that leaked out of the build's
// rootDir -- shows up here and nowhere else. The product is publication-disabled, but its
// consumers are the operator's own tooling and the following sub-units, and they install it the
// same way.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const productRoot = join(root, 'packages', 'policy-optimization');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-policy-optimization-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

// Ordered: each entry's prepack build reads the already-built `dist/` of the ones before it.
// `task-execution-protocol`, `-profiles`, and `trust-core` are not this package's dependencies --
// they are `benchmarking-records`', `benchmarking-run`'s, and `benchmarking-aggregate`'s own
// runtime edges, and an unpacked transitive Jinn dependency makes `npm install` reach for a
// registry version that does not exist.
//
// `task-execution-testing` is deliberately absent: it is a devDependency, so no installer of this
// package ever receives it, and packing it would drag the whole local-backend tree into a canary
// whose subject is the product's public types.
const CROSS_TREE_PACKAGES = [
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/task-execution-backend', join(root, 'packages', 'task-execution', 'backend')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
  ['@jinn-network/benchmarking-run', join(root, 'packages', 'benchmarking', 'run')],
  ['@jinn-network/benchmarking-aggregate', join(root, 'packages', 'benchmarking', 'aggregate')],
  ['@jinn-network/benchmarking-local', join(root, 'packages', 'benchmarking', 'local')],
  ['@jinn-network/policy-identity', join(root, 'packages', 'policy', 'identity')],
  ['@jinn-network/policy-outcomes', join(root, 'packages', 'policy', 'outcomes')],
];

const packages = [['.', '@jinn-network/policy-optimization']];
const codeEntrypoints = ['@jinn-network/policy-optimization'];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) { resolvePromise(output); return; }
      reject(new Error(`${command} exited with ${code}:\n${output}${errorOutput}`));
    });
  });
}

async function packOne(directory, name) {
  const packed = JSON.parse(await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
    { cwd: directory },
  ));
  if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result for ${name}`);
  }
  return join(archivesRoot, packed[0].filename);
}

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const [name, directory] of CROSS_TREE_PACKAGES) {
    archives.set(name, await packOne(directory, name));
  }
  for (const [directory, name] of packages) {
    archives.set(name, await packOne(join(productRoot, directory), name));
  }

  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...[...archives].map(([name, archive]) => [name, `file:${archive}`]),
      ['@types/node', '^22.0.0'],
      ['typescript', '^5.9.3'],
    ]),
  }, null, 2));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type PolicyOptimizationEntrypoints = [\n${codeEntrypoints
        .map((_, index) => `  typeof Entry${index},`)
        .join('\n')}\n];\n`
      // The namespace import above proves the entrypoint resolves; the frozen surface is
      // additionally named symbol-by-symbol, so a rename in the packed `.d.ts` is a compile error
      // here rather than a silently-narrower public surface for the following sub-units.
      + [
        '',
        'import {',
        '  validateCampaign,',
        '  sealCampaign,',
        '  parseExactCampaign,',
        '  checkSeedAgreement,',
        '  isNamespacedExtensionKey,',
        '  isExactPin,',
        '  assertExactPin,',
        '  axisValuesByteShare,',
        '  checkExploringEntry,',
        '  validateJournalEntry,',
        '  buildJournalEntry,',
        '  journalEntryText,',
        '  journalEntryDigest,',
        '  parseExactJournalLine,',
        '  checkEventLegality,',
        '  entersExploring,',
        '  legalEventsIn,',
        '  createCampaign,',
        '  openCampaign,',
        '  appendCampaignEvent,',
        '  PolicyOptimizationError,',
        '  CAMPAIGN_FORMAT_TOKEN,',
        '  CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN,',
        '  CAMPAIGN_JOURNAL_EVENT_TYPES,',
        '  CAMPAIGN_LIFECYCLE_PHASES,',
        '  CAMPAIGN_DOCUMENT_FILENAME,',
        '  CAMPAIGN_JOURNAL_FILENAME,',
        '  CORE_AXES,',
        '  V0_MUTATION_SURFACE,',
        '  curateAnnouncements,',
        '  deriveOutcomeObservations,',
        '  WAVE_DERIVATION_EXTENSION_KEY,',
        '  buildWaveArms,',
        '  assertArmsAgreeOnFrozenAxes,',
        '  checkCandidateAgainstCampaign,',
        '  ALLOCATION_POLICY_REFS,',
        '  bareTaskDigest,',
        '  quoteWave,',
        '  checkBenchmarkDisjointness,',
        '  decideAllocation,',
        '  compareExactDecimals,',
        '  compareObservedRates,',
        '  STOPPING_RULE_REFS,',
        '  checkStoppingRule,',
        '  committedCells,',
        '  deriveWaveBenchmark,',
        '  planWave,',
        '  executeWave,',
        '  assembleWaveMatrix,',
        '  objectiveMethod,',
        '  produceWaveReport,',
        '  checkPromotionReveal,',
        '  objectiveAnalysisPlan,',
        '  planPromotionRun,',
        '  appendWaveEvent,',
        '  wavePlannedPayload,',
        '  runSealedPayload,',
        '  promotionRunSealedPayload,',
        '  allocationDecidedPayload,',
        '  matrixAssembledPayload,',
        '  reportRecordedPayload,',
        '  NO_CELLS_COMMITTED,',
        '  assembleEvidenceBundle,',
        '  provenanceMatchesBundle,',
        '  recordListDigest,',
        '  assertValidBoundary,',
        '  assertValidRecordRefs,',
        '  boundaryIsEmpty,',
        '  heldOutBoundaryDigest,',
        '  partitionHeldOut,',
        '  scanLexical,',
        '  createReferenceProposer,',
        '  enumerateReferenceCandidates,',
        '  enumerateRemovalSets,',
        '  skillNames,',
        '  REFERENCE_PROPOSER_ID,',
        '  admitCandidate,',
        '  admittedTupleText,',
        '  classifiedRoots,',
        '  classifyPayload,',
        '  isHostilePayloadClass,',
        '  payloadClassRank,',
        '  admitToPopulation,',
        '  armIdForTuple,',
        '  parseExactPopulation,',
        '  populationBytes,',
        '  populationDigest,',
        '  EMPTY_POPULATION,',
        '  appendAdmissionEvent,',
        '  candidateAdmittedPayload,',
        '  candidateRejectedPayload,',
        '  EVIDENCE_BUNDLE_FORMAT_TOKEN,',
        '  PAYLOAD_CLASSES,',
        '  HOSTILE_PAYLOAD_CLASSES,',
        '  CAMPAIGN_POPULATION_FILENAME,',
        '  CAMPAIGN_POPULATION_FORMAT_TOKEN,',
        '  lineageGraph,',
        '  lineageFromEntries,',
        '  lineagePosition,',
        '  evaluatedHistory,',
        '  frontier,',
        '  frontierMembers,',
        '  adopt,',
        '  rollback,',
        '  currentAdoption,',
        '  scopeKey,',
        '  ADOPTION_COMPONENT_CLASSES,',
        '  declaredAdoptionComponentClasses,',
        '  sortAdoptionComponentClasses,',
        '  isAdoptionComponentClass,',
        '  formatAdoptionComponentClasses,',
        '  adoptionConfigFragment,',
        '  emptyAdoptionLog,',
        '  deriveArchive,',
        '  archiveLayout,',
        '  defaultArchiveRoot,',
        '  readAdoptionLog,',
        '  appendAdoptionRecord,',
        '  readArchiveProjection,',
        '  writeArchiveProjection,',
        '  runCli,',
        '  USAGE,',
        '  PRODUCT_FRONTIER_DIMENSIONS,',
        '  ADOPTION_RECORD_FORMAT_TOKEN,',
        '  ARCHIVE_PROJECTION_FORMAT_TOKEN,',
        '  ARCHIVE_DIRNAME,',
        '  ARCHIVE_DERIVED_DIRNAME,',
        '  ARCHIVE_PROJECTION_FILENAME,',
        '  ADOPTION_LOG_FILENAME,',
        '  WAVES_DIRNAME,',
        '} from "@jinn-network/policy-optimization";',
        'import type {',
        '  CampaignDocument, CampaignTarget, CampaignObjective, CampaignBudgets,',
        '  CampaignAllocation, CampaignStoppingRule, ObjectiveMethodRef, ObjectiveConstraint,',
        '  PolicyRef, SealedCampaign, SeedResolution, CampaignHandle, CampaignJournalEntry,',
        '  CampaignJournalEntryInput, CampaignJournalEventType, CampaignLifecyclePhase,',
        '  CampaignLifecycleState, CreateCampaignInput, AppendOptions,',
        '  ExploringEntryAdmission, ExploringEntryInput, ExploringEntryRefusal,',
        '  ExploringEntryResult, PolicyOptimizationErrorCategory, PolicyOptimizationIssue,',
        '  AdapterInputRef, AdapterRefusal, AdapterRefusalReason, AnnouncedVerdict,',
        '  MirroredProvenance, MirroredRecordRef, MirroredSourceIdentity, AdapterObservedVerdict,',
        '  CurationAdapterResult, CurationInputRef, CurationObservation,',
        '  AnnouncedPolicyVerdict, DivergentRecordDigestGroup, OutcomesAdapterResult,',
        '  PolicyFidelityEvidence,',
        '  AdmittedCandidate, AllocationDecision, AllocationInput, AllocationInputRefs,',
        '  AllocationPolicyRef, AssembleWaveInput, CommittedCells, DerivedWaveBenchmark,',
        '  DroppedTask, ExecuteWaveInput, OutcomesProjectionRow, PlanPromotionRunInput,',
        '  PlanWaveInput, PlannedPromotion, PromotionAdmission, PromotionReveal, PrunedCandidate,',
        '  RateBound, StoppingRuleResult, TaskInformativenessRow, WaveArm, WaveAssemblyVenue,',
        '  WaveCellEvidence, WaveCellEvidencePort, WaveDispatch, WaveExecution, WaveLaunchOptions,',
        '  WavePlan, WaveReportInput, WaveReportRow, WaveRunSettings, WaveVerdictRule,',
        '  WaveQuote, BenchmarkDisjointnessResult, CampaignBenchmarkBytes,',
        '  AssembleEvidenceBundleInput,',
        '  AssembledEvidenceBundle,',
        '  EvidenceBundleManifest,',
        '  EvidenceRecordRef,',
        '  HeldOutBoundary,',
        '  HeldOutHit,',
        '  HeldOutPartition,',
        '  EvidenceBundleRef,',
        '  PolicyProposalRequest,',
        '  PolicyProposer,',
        '  ProposalBudget,',
        '  ReferenceProposal,',
        '  ReferenceProposerInput,',
        '  PayloadClass,',
        '  PayloadClassification,',
        '  AdoptionComponentClass,',
        '  AdmitToPopulationInput,',
        '  Population,',
        '  PopulationAdmission,',
        '  PopulationEntry,',
        '  AdmissionAccepted,',
        '  AdmissionCheck,',
        '  AdmissionCheckName,',
        '  AdmissionConsent,',
        '  AdmissionRejected,',
        '  AdmissionRequest,',
        '  AdmissionResult,',
        '  MaterializerPort,',
        '  SignatureOutcome,',
        '  SignaturePort,',
        '  SmokeCanaryOutcome,',
        '  SmokeCanaryPort,',
        '  AdoptInput,',
        '  AdoptionLog,',
        '  AdoptionRecord,',
        '  AdoptionScope,',
        '  ArchiveLayout,',
        '  ArchiveProjection,',
        '  CliContext,',
        '  CliResult,',
        '  DeriveArchiveInput,',
        '  EvaluatedHistory,',
        '  FrontierDimension,',
        '  FrontierDirection,',
        '  FrontierEntry,',
        '  LineageEntry,',
        '  LineageGraph,',
        '  LineageNode,',
        '  LineagePosition,',
        '} from "@jinn-network/policy-optimization";',
        '',
        'export type PolicyOptimizationWaveSurface = [',
        '  typeof buildWaveArms, typeof assertArmsAgreeOnFrozenAxes,',
        '  typeof checkCandidateAgainstCampaign, typeof ALLOCATION_POLICY_REFS,',
        '  typeof decideAllocation, typeof compareExactDecimals, typeof compareObservedRates,',
        '  typeof bareTaskDigest, typeof quoteWave, typeof checkBenchmarkDisjointness,',
        '  typeof STOPPING_RULE_REFS, typeof checkStoppingRule, typeof committedCells,',
        '  typeof deriveWaveBenchmark, typeof planWave, typeof executeWave,',
        '  typeof assembleWaveMatrix, typeof objectiveMethod, typeof produceWaveReport,',
        '  typeof checkPromotionReveal, typeof objectiveAnalysisPlan, typeof planPromotionRun,',
        '  typeof appendWaveEvent, typeof wavePlannedPayload, typeof runSealedPayload,',
        '  typeof promotionRunSealedPayload, typeof allocationDecidedPayload,',
        '  typeof matrixAssembledPayload, typeof reportRecordedPayload,',
        '  typeof NO_CELLS_COMMITTED, typeof WAVE_DERIVATION_EXTENSION_KEY,',
        '  AdmittedCandidate, AllocationDecision, AllocationInput, AllocationInputRefs,',
        '  AllocationPolicyRef, AssembleWaveInput, CommittedCells, DerivedWaveBenchmark,',
        '  DroppedTask, ExecuteWaveInput, OutcomesProjectionRow, PlanPromotionRunInput,',
        '  PlanWaveInput, PlannedPromotion, PromotionAdmission, PromotionReveal, PrunedCandidate,',
        '  RateBound, StoppingRuleResult, TaskInformativenessRow, WaveArm, WaveAssemblyVenue,',
        '  WaveCellEvidence, WaveCellEvidencePort, WaveDispatch, WaveExecution, WaveLaunchOptions,',
        '  WavePlan, WaveReportInput, WaveReportRow, WaveRunSettings, WaveVerdictRule,',
        '  WaveQuote, BenchmarkDisjointnessResult, CampaignBenchmarkBytes,',
        '];',
        '',
        'export type PolicyOptimizationAdmissionSurface = [',
        '  typeof assembleEvidenceBundle, typeof provenanceMatchesBundle,',
        '  typeof recordListDigest, typeof assertValidBoundary, typeof assertValidRecordRefs,',
        '  typeof boundaryIsEmpty, typeof heldOutBoundaryDigest, typeof partitionHeldOut,',
        '  typeof scanLexical, typeof EVIDENCE_BUNDLE_FORMAT_TOKEN,',
        '  typeof createReferenceProposer, typeof enumerateReferenceCandidates,',
        '  typeof enumerateRemovalSets, typeof skillNames, typeof REFERENCE_PROPOSER_ID,',
        '  typeof admitCandidate, typeof admittedTupleText,',
        '  typeof classifiedRoots, typeof classifyPayload, typeof isHostilePayloadClass,',
        '  typeof payloadClassRank, typeof PAYLOAD_CLASSES, typeof HOSTILE_PAYLOAD_CLASSES,',
        '  typeof admitToPopulation, typeof armIdForTuple, typeof parseExactPopulation,',
        '  typeof populationBytes, typeof populationDigest, typeof EMPTY_POPULATION,',
        '  typeof CAMPAIGN_POPULATION_FILENAME, typeof CAMPAIGN_POPULATION_FORMAT_TOKEN,',
        '  typeof appendAdmissionEvent, typeof candidateAdmittedPayload,',
        '  typeof candidateRejectedPayload,',
        '  AssembleEvidenceBundleInput, AssembledEvidenceBundle, EvidenceBundleManifest,',
        '  EvidenceRecordRef, HeldOutBoundary, HeldOutHit, HeldOutPartition,',
        '  EvidenceBundleRef, PolicyProposalRequest, PolicyProposer, ProposalBudget,',
        '  ReferenceProposal, ReferenceProposerInput, PayloadClass, PayloadClassification,',
        '  AdmitToPopulationInput, Population, PopulationAdmission, PopulationEntry,',
        '  AdmissionAccepted, AdmissionCheck, AdmissionCheckName, AdmissionConsent,',
        '  AdmissionRejected, AdmissionRequest, AdmissionResult, MaterializerPort,',
        '  SignatureOutcome, SignaturePort, SmokeCanaryOutcome, SmokeCanaryPort,',
        '];',
        '',
        'export type PolicyOptimizationSurface = [',
        '  typeof validateCampaign, typeof sealCampaign, typeof parseExactCampaign,',
        '  typeof checkSeedAgreement, typeof isNamespacedExtensionKey,',
        '  typeof isExactPin, typeof assertExactPin, typeof axisValuesByteShare,',
        '  typeof checkExploringEntry,',
        '  typeof validateJournalEntry, typeof buildJournalEntry, typeof journalEntryText,',
        '  typeof journalEntryDigest, typeof parseExactJournalLine,',
        '  typeof checkEventLegality, typeof entersExploring, typeof legalEventsIn,',
        '  typeof createCampaign, typeof openCampaign, typeof appendCampaignEvent,',
        '  typeof PolicyOptimizationError,',
        '  typeof CAMPAIGN_FORMAT_TOKEN, typeof CAMPAIGN_JOURNAL_ENTRY_FORMAT_TOKEN,',
        '  typeof CAMPAIGN_JOURNAL_EVENT_TYPES, typeof CAMPAIGN_LIFECYCLE_PHASES,',
        '  typeof CAMPAIGN_DOCUMENT_FILENAME, typeof CAMPAIGN_JOURNAL_FILENAME,',
        '  typeof CORE_AXES, typeof V0_MUTATION_SURFACE,',
        '  typeof curateAnnouncements, typeof deriveOutcomeObservations,',
        '  CampaignDocument, CampaignTarget, CampaignObjective, CampaignBudgets,',
        '  CampaignAllocation, CampaignStoppingRule, ObjectiveMethodRef, ObjectiveConstraint,',
        '  PolicyRef, SealedCampaign, SeedResolution, CampaignHandle, CampaignJournalEntry,',
        '  CampaignJournalEntryInput, CampaignJournalEventType, CampaignLifecyclePhase,',
        '  CampaignLifecycleState, CreateCampaignInput, AppendOptions,',
        '  ExploringEntryAdmission, ExploringEntryInput, ExploringEntryRefusal,',
        '  ExploringEntryResult, PolicyOptimizationErrorCategory, PolicyOptimizationIssue,',
        '  AdapterInputRef, AdapterRefusal, AdapterRefusalReason, AnnouncedVerdict,',
        '  MirroredProvenance, MirroredRecordRef, MirroredSourceIdentity, AdapterObservedVerdict,',
        '  CurationAdapterResult, CurationInputRef, CurationObservation,',
        '  AnnouncedPolicyVerdict, DivergentRecordDigestGroup, OutcomesAdapterResult,',
        '  PolicyFidelityEvidence,',
        '];',
        '',
        '// C7d — the archive (§8.3), adoption (§9), and the `optimize` verb tree.',
        'export type PolicyOptimizationArchiveSurface = [',
        '  typeof lineageGraph, typeof lineageFromEntries, typeof lineagePosition,',
        '  typeof evaluatedHistory, typeof frontier, typeof frontierMembers,',
        '  typeof adopt, typeof rollback, typeof currentAdoption, typeof scopeKey,',
        '  typeof declaredAdoptionComponentClasses, typeof sortAdoptionComponentClasses, typeof isAdoptionComponentClass,',
        '  typeof formatAdoptionComponentClasses, typeof adoptionConfigFragment, typeof emptyAdoptionLog,',
        '  typeof deriveArchive, typeof archiveLayout, typeof defaultArchiveRoot,',
        '  typeof readAdoptionLog, typeof appendAdoptionRecord, typeof readArchiveProjection,',
        '  typeof writeArchiveProjection, typeof runCli, typeof USAGE,',
        '  typeof ADOPTION_COMPONENT_CLASSES, typeof PRODUCT_FRONTIER_DIMENSIONS,',
        '  typeof ADOPTION_RECORD_FORMAT_TOKEN, typeof ARCHIVE_PROJECTION_FORMAT_TOKEN,',
        '  typeof ARCHIVE_DIRNAME, typeof ARCHIVE_DERIVED_DIRNAME,',
        '  typeof ARCHIVE_PROJECTION_FILENAME, typeof ADOPTION_LOG_FILENAME, typeof WAVES_DIRNAME,',
        '  AdoptInput, AdoptionLog, AdoptionRecord, AdoptionScope, ArchiveLayout,',
        '  ArchiveProjection, CliContext, CliResult, DeriveArchiveInput, EvaluatedHistory,',
        '  FrontierDimension, FrontierDirection, FrontierEntry, LineageEntry, LineageGraph,',
        '  LineageNode, LineagePosition, AdoptionComponentClass,',
        '];',
        '',
      ].join('\n'),
  );
  await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2022',
    },
    include: ['consumer.ts'],
  }, null, 2));

  const typescript = join(
    consumerRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  await run(typescript, ['--project', 'tsconfig.json'], { cwd: consumerRoot });

  for (const [directory, name] of packages) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8',
    ));
    if (installed.name !== name) {
      throw new Error(`${directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoint(s) across all ${packages.length} policy-optimization package(s).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
