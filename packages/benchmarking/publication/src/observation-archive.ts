import {
  BENCHMARK_OBSERVATION_ARCHIVE_PROFILE,
  compareCodeUnitStrings,
  sealObservationArchive,
  serializeCanonicalJson,
  type ObservationArchive,
  type ObservationArchiveStream,
  type SealedRecord,
} from "@jinn-network/benchmarking-records";
import type { AcceptedObservationSnapshot, ObservationArchiveBuildInput } from "./types.js";

const decoder = new TextDecoder();

function compare(left: string, right: string): number { return compareCodeUnitStrings(left, right); }
function observationKey(snapshot: AcceptedObservationSnapshot): string {
  return `${snapshot.observation.source}\u001f${snapshot.observation.id}`;
}
function canonicalKey(value: unknown): string { return decoder.decode(serializeCanonicalJson(value as never)); }
function sortedDescriptors<T extends { readonly digest: { readonly sha256: string }; readonly name?: string }>(values: readonly T[]): T[] {
  const selected = new Map<string, T>();
  for (const value of values) {
    const key = `${value.digest.sha256}\u001f${value.name ?? ""}`;
    const current = selected.get(key);
    if (current === undefined || compare(canonicalKey(value), canonicalKey(current)) < 0) selected.set(key, value);
  }
  return [...selected.entries()].sort(([left], [right]) => compare(left, right)).map(([, value]) => value);
}

/**
 * Turns accepted TEP snapshots into the profile's deterministic, sealed archive.  It never
 * invents a global sequence: source/subject streams remain independent and conflicting copies
 * of one `(source,id)` are retained, not overwritten.
 */
export function buildObservationArchive(input: ObservationArchiveBuildInput): { readonly archive: ObservationArchive; readonly sealed: SealedRecord } {
  const streams = new Map<string, AcceptedObservationSnapshot[]>();
  for (const snapshot of input.snapshots) {
    const key = `${snapshot.observation.source}\u001f${snapshot.observation.subject}`;
    const values = streams.get(key) ?? [];
    values.push(snapshot);
    streams.set(key, values);
  }
  const archiveStreams: ObservationArchiveStream[] = [...streams.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([, snapshots]) => {
      const first = snapshots[0]!.observation;
      const byId = new Map<string, AcceptedObservationSnapshot[]>();
      for (const snapshot of snapshots) {
        const values = byId.get(observationKey(snapshot)) ?? [];
        values.push(snapshot);
        byId.set(observationKey(snapshot), values);
      }
      const observations = [] as ObservationArchiveStream["observations"];
      const conflicts = [] as ObservationArchiveStream["conflicts"];
      for (const [key, candidates] of [...byId.entries()].sort(([left], [right]) => compare(left, right))) {
        const distinct = new Map(candidates.map((candidate) => [canonicalKey(candidate.observation), candidate]));
        const selected = [...distinct.values()].sort((left, right) => compare(canonicalKey(left.observation), canonicalKey(right.observation)));
        if (selected.length === 1) observations.push(selected[0]!.observation);
        else {
          const [source, id] = key.split("\u001f") as [string, string];
          conflicts.push({ source, id, observations: selected.map((candidate) => candidate.observation) });
        }
      }
      observations.sort((left, right) => compare(`${left.sequence}\u001f${left.id}`, `${right.sequence}\u001f${right.id}`));
      const engaged = observations.find((observation) => observation.type === "network.jinn.task-execution.attempt-engaged.v1");
      return {
        source: first.source,
        subject: first.subject,
        authority: engaged !== undefined || snapshots.some((snapshot) => snapshot.observation.type === "network.jinn.task-execution.attempt-engaged.v1") ? "authoritative" : "corroborating",
        observations,
        conflicts,
        exactEnvelopes: sortedDescriptors(snapshots.flatMap((snapshot) => snapshot.exactEnvelope === undefined ? [] : [snapshot.exactEnvelope])),
      };
    });
  const archive: ObservationArchive = {
    profile: BENCHMARK_OBSERVATION_ARCHIVE_PROFILE,
    submission: input.submission,
    capturedThrough: input.capturedThrough,
    streams: archiveStreams,
  };
  return { archive, sealed: sealObservationArchive(archive) };
}
