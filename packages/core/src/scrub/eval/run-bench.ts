import { buildLayer2ScrubPipeline } from '../layer2.js';
import { buildScrubPipeline, buildSeedScrubPipeline } from '../build.js';
import type { ScrubPipeline } from '../pipeline.js';
import { aggregateClassMap, emptyCounts, scoreClass } from './metrics.js';
import { findingsFromScrubResult } from './findings-from-scrub.js';
import type {
  BenchReport,
  ClassCounts,
  EvalFixture,
  ScrubClass,
} from './types.js';

export function pipelineForProfile(
  profile: EvalFixture['profile'],
  fixture?: EvalFixture,
): ScrubPipeline {
  const knownIdentity =
    fixture?.identityPack || fixture?.allowlist
      ? { pack: fixture.identityPack, allowlist: fixture.allowlist }
      : undefined;
  switch (profile ?? 'seed') {
    case 'trace':
      return buildScrubPipeline({ knownIdentity });
    case 'layer2':
      return buildLayer2ScrubPipeline({ knownIdentity });
    case 'seed':
    default:
      return buildSeedScrubPipeline({ knownIdentity });
  }
}

export async function scoreFixture(fixture: EvalFixture): Promise<{
  counts: Partial<Record<ScrubClass, ClassCounts>>;
  corruptionFailure: boolean;
}> {
  const pipeline = pipelineForProfile(fixture.profile, fixture);
  const key = fixture.key ?? 'content';
  const result = await pipeline.run({ [key]: fixture.text });
  const scrubbed = String(result.attributes[key] ?? '');

  if (fixture.mustSurvive) {
    return {
      counts: {},
      corruptionFailure: scrubbed !== fixture.text,
    };
  }

  const findings = findingsFromScrubResult(fixture, scrubbed, result.redactions);
  const classes = new Set<ScrubClass>([
    ...fixture.labels.map((l) => l.class),
    ...findings.map((f) => f.class),
  ]);
  const counts: Partial<Record<ScrubClass, ClassCounts>> = {};
  for (const cls of classes) {
    const gold = fixture.labels.filter((l) => l.class === cls);
    const pred = findings.filter((f) => f.class === cls);
    counts[cls] = scoreClass(gold, pred);
  }
  // Ensure every labeled class appears even if empty pred
  for (const l of fixture.labels) {
    if (!counts[l.class]) counts[l.class] = emptyCounts();
  }
  return { counts, corruptionFailure: false };
}

export async function runBench(fixtures: EvalFixture[]): Promise<BenchReport> {
  const started = Date.now();
  const perFixture: Array<Partial<Record<ScrubClass, ClassCounts>>> = [];
  let corruptionFixtures = 0;
  let corruptionFailures = 0;
  const profiles = new Set<string>();

  for (const fixture of fixtures) {
    profiles.add(fixture.profile ?? 'seed');
    if (fixture.mustSurvive) {
      corruptionFixtures += 1;
      const { corruptionFailure } = await scoreFixture(fixture);
      if (corruptionFailure) corruptionFailures += 1;
      continue;
    }
    const { counts } = await scoreFixture(fixture);
    perFixture.push(counts);
  }

  return {
    schemaVersion: 1,
    profiles: [...profiles].sort(),
    classes: aggregateClassMap(perFixture),
    corruption: { fixtures: corruptionFixtures, failures: corruptionFailures },
    elapsedMs: Date.now() - started,
  };
}
