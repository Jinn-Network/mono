/**
 * The requester fixture registry (B0a, issue #2446).
 *
 * Lives in its own module with no dependencies so the CLI can validate a
 * `--fixture` value without pulling the requester's production graph into
 * process start-up.
 *
 * Before this the accepted name was a bare literal compared in eight places in
 * `cli/commands/native-requester.ts` and typed as a string literal across three
 * module boundaries, so every published surface hardcoded the pin. Now the
 * command validates against this registry and names it on refusal, and adding a
 * fixture is a data change here.
 *
 * The set is still one entry, and honestly so: `sealRunBundle` seals whatever
 * `loadPredictionSnapshotFixture()` returns. Sealing a caller-supplied
 * Task/EvaluationSpec is the spec-interview and post beats (B0c/B1), not this
 * item.
 */

/** Public, stable product fixture name. The admission package may retain its
 *  internal snapshot fixture directory; that storage detail must not leak into
 *  the accepted requester command contract. */
export const PREDICTION_FORECAST_GOLDEN = 'prediction-forecast-golden.json';

export type NativeRequesterFixture = typeof PREDICTION_FORECAST_GOLDEN;

/** Every fixture `NativeRequester.request()` can seal. */
export const NATIVE_REQUESTER_FIXTURES: readonly NativeRequesterFixture[] = [
  PREDICTION_FORECAST_GOLDEN,
];

/** True when `request()` can seal `name`. */
export function isNativeRequesterFixture(name: string): name is NativeRequesterFixture {
  return (NATIVE_REQUESTER_FIXTURES as readonly string[]).includes(name);
}

/** Human-readable accepted set, for refusal messages and help text. */
export function nativeRequesterFixtureList(): string {
  return NATIVE_REQUESTER_FIXTURES.join(' | ');
}
