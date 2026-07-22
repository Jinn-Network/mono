import { buildLayer2ScrubPipeline } from '../layer2.js';
import { buildScrubPipeline, buildSeedScrubPipeline } from '../build.js';
import type { ScrubPipeline } from '../pipeline.js';
import { RejectPublishError } from '../reject-publish-error.js';
import { UnresolvedFlagError } from '../review-queue.js';
import { aggregateClassMap, emptyCounts, scoreClass } from './metrics.js';
import { findingsFromScrubResult } from './findings-from-scrub.js';
import type {
  BenchReport,
  ClassCounts,
  EvalFixture,
  ScrubClass,
} from './types.js';
import { createMemoryReviewQueueStore } from '../review-queue.js';

export function pipelineForProfile(
  profile: EvalFixture['profile'],
  fixture?: EvalFixture,
): ScrubPipeline {
  const knownIdentity =
    fixture?.identityPack || fixture?.allowlist
      ? { pack: fixture.identityPack, allowlist: fixture.allowlist }
      : undefined;
  // Bench must not fail-closed on flags (metrics need the scrubbed text +
  // unresolvedFlags); use an in-memory review store and disable abort.
  const reviewOpts = {
    reviewStore: createMemoryReviewQueueStore(),
    failClosedOnUnresolvedFlags: false as const,
  };
  switch (profile ?? 'seed') {
    case 'trace':
      return buildScrubPipeline({ knownIdentity, ...reviewOpts });
    case 'layer2':
      return buildLayer2ScrubPipeline({ knownIdentity });
    case 'seed':
    default:
      return buildSeedScrubPipeline({ knownIdentity, ...reviewOpts });
  }
}

export async function scoreFixture(fixture: EvalFixture): Promise<{
  counts: Partial<Record<ScrubClass, ClassCounts>>;
  corruptionFailure: boolean;
}> {
  const pipeline = pipelineForProfile(fixture.profile, fixture);
  const key = fixture.key ?? 'content';

  let scrubbed: string;
  let redactions: Array<{ stage: string; detail?: string }> = [];
  let rejectClass: ScrubClass | undefined;

  try {
    const result = await pipeline.run({ [key]: fixture.text });
    scrubbed = String(result.attributes[key] ?? '');
    redactions = result.redactions;
  } catch (err) {
    if (err instanceof RejectPublishError) {
      // Reject-publish aborts without redacting the span — count as a hit on
      // the labeled class (or the error's class when unlabeled).
      rejectClass = err.scrubClass;
      scrubbed = fixture.text;
      redactions = [];
    } else if (err instanceof UnresolvedFlagError) {
      // Flag-hold aborts publish; for bench metrics treat as a class hit on
      // the first flagged finding (flag-or-redact recall).
      rejectClass = err.findings[0]?.class;
      scrubbed = fixture.text;
      redactions = [];
    } else {
      throw err;
    }
  }

  if (fixture.mustSurvive) {
    return {
      counts: {},
      corruptionFailure: scrubbed !== fixture.text || rejectClass !== undefined,
    };
  }

  if (rejectClass) {
    const counts: Partial<Record<ScrubClass, ClassCounts>> = {};
    const labeled = fixture.labels.filter((l) => l.class === rejectClass);
    if (labeled.length > 0) {
      counts[rejectClass] = scoreClass(
        labeled,
        labeled.map((l) => ({ class: rejectClass!, start: l.start, end: l.end })),
      );
    } else {
      counts[rejectClass] = { tp: 0, fp: 1, fn: 0 };
    }
    for (const l of fixture.labels) {
      if (!counts[l.class]) counts[l.class] = emptyCounts();
      if (l.class !== rejectClass) {
        // Other labeled classes missed because publish aborted first.
        counts[l.class] = scoreClass([l], []);
      }
    }
    return { counts, corruptionFailure: false };
  }

  const findings = findingsFromScrubResult(fixture, scrubbed, redactions);
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
