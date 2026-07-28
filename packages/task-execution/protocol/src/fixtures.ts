import { readFile } from "node:fs/promises";

function fixtureUrl(relativePath: string): URL {
  return new URL(`../fixtures/${relativePath}`, import.meta.url);
}

async function readFixtureBytes(relativePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(fixtureUrl(relativePath)));
}

async function readFixtureJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(fixtureUrl(relativePath), "utf8"));
}

const GOLDEN_ROOT = "golden-task-execution-v1";

/** The golden scenario pair's shared Task, sealed bytes (§24). */
export async function loadGoldenTaskBytes(): Promise<Uint8Array> {
  return readFixtureBytes(`${GOLDEN_ROOT}/task.json`);
}

export type GoldenScenario = "local" | "marketplace";

export async function loadGoldenSubmissionBytes(scenario: GoldenScenario): Promise<Uint8Array> {
  return readFixtureBytes(`${GOLDEN_ROOT}/${scenario}/submission.json`);
}

export async function loadGoldenDeliveryBytes(scenario: GoldenScenario): Promise<Uint8Array> {
  return readFixtureBytes(`${GOLDEN_ROOT}/${scenario}/delivery.json`);
}

export async function loadGoldenObservations(scenario: GoldenScenario): Promise<unknown[]> {
  return (await readFixtureJson(`${GOLDEN_ROOT}/${scenario}/observations.json`)) as unknown[];
}

export interface GoldenConformanceReport {
  taskDigest: `sha256:${string}`;
  scenarios: Record<GoldenScenario, {
    submission: string;
    submissionDigest: `sha256:${string}`;
    attempt: string;
    deliveryDigest: `sha256:${string}`;
  }>;
}

export async function loadGoldenConformanceReport(): Promise<GoldenConformanceReport> {
  return (await readFixtureJson(`${GOLDEN_ROOT}/conformance-report.json`)) as GoldenConformanceReport;
}

export async function loadEquivalenceTaskBytes(variant: "a" | "b"): Promise<Uint8Array> {
  return readFixtureBytes(`${GOLDEN_ROOT}/equivalence/task-${variant}.json`);
}

export async function loadEquivalenceExpectedDigest(): Promise<`sha256:${string}`> {
  const { digest } = (await readFixtureJson(`${GOLDEN_ROOT}/equivalence/expected-digest.json`)) as {
    digest: `sha256:${string}`;
  };
  return digest;
}

const ADVERSARIAL_ROOT = "adversarial-v1";

export interface AdversarialManifestEntry {
  id: string;
  description: string;
  expectedDisposition: string;
}

export interface AdversarialManifest {
  taskDigest: `sha256:${string}`;
  fixtures: readonly AdversarialManifestEntry[];
}

export async function loadAdversarialManifest(): Promise<AdversarialManifest> {
  return (await readFixtureJson(`${ADVERSARIAL_ROOT}/manifest.json`)) as AdversarialManifest;
}

/** Reads an arbitrary file inside a named adversarial fixture directory. */
export async function readAdversarialFile(id: string, filename: string): Promise<Uint8Array> {
  return readFixtureBytes(`${ADVERSARIAL_ROOT}/${id}/${filename}`);
}

export async function readAdversarialJson(id: string, filename: string): Promise<unknown> {
  return readFixtureJson(`${ADVERSARIAL_ROOT}/${id}/${filename}`);
}
