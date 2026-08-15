import type { Corpus, EnvelopeRef, ManifestPreview } from '../corpus/index.js';
import type { SignedEnvelope } from '../types/envelope.js';
import type { SessionDerivedState } from './_session-derived-state.js';

export interface SessionDerivedCaptureCandidate {
  ref: EnvelopeRef;
  preview: ManifestPreview;
  dedupKey: string;
}

export function captureDedupKey(envelope: SignedEnvelope, fallbackCid: string): string {
  const provenance = envelope.sessionProvenance;
  const repo = provenance?.repo;
  if (provenance?.sessionId && repo?.commitHash) {
    return `${repo.remoteUrl ?? 'repo:unknown'}@${repo.commitHash}:${provenance.sessionId}`;
  }
  return envelope.trajectory?.sha256 ?? envelope.signature.hash ?? fallbackCid;
}

export async function pollSessionDerivedCaptures(
  corpus: Pick<Corpus, 'query' | 'fetchManifest'>,
  state: SessionDerivedState,
  limit = 25,
): Promise<SessionDerivedCaptureCandidate[]> {
  const refs = await corpus.query({ solverType: 'capture', evidenceTier: 'self-signed', limit });
  const candidates: SessionDerivedCaptureCandidate[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (state.hasProcessed(ref.manifestCid)) continue;
    const preview = await corpus.fetchManifest(ref);
    if (preview.envelope.role !== 'capture') continue;
    const dedupKey = captureDedupKey(preview.envelope, ref.manifestCid);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    candidates.push({ ref, preview, dedupKey });
  }
  return candidates;
}
