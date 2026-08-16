export const DEFAULT_CAPTURE_IDLE_WINDOW_MS = 5 * 60 * 1000;

export interface CaptureBoundaryEvent {
  tool: string;
  observedAtMs: number;
  sessionId?: string | null;
  repoRemoteUrl?: string | null;
  repoCommitHash?: string | null;
  transcriptPath?: string | null;
  explicitStop?: boolean;
}

export interface CaptureBoundaryDecision {
  startsNewSession: boolean;
  key: string;
  reason: 'first-event' | 'explicit-stop' | 'session-id-changed' | 'transcript-marker' | 'idle-window' | 'same-session';
}

export interface CaptureDeduperOptions {
  idleWindowMs?: number;
}

export function captureBoundaryKey(event: CaptureBoundaryEvent): string {
  const repo = event.repoRemoteUrl && event.repoCommitHash
    ? `${event.repoRemoteUrl}@${event.repoCommitHash}`
    : event.repoRemoteUrl ?? 'repo:unknown';
  const transcript = event.transcriptPath ?? 'transcript:unknown';
  const session = event.sessionId ?? 'session:unknown';
  return `${event.tool}|${repo}|${transcript}|${session}`;
}

export function decideCaptureBoundary(
  previous: CaptureBoundaryEvent | null,
  current: CaptureBoundaryEvent,
  options: CaptureDeduperOptions = {},
): CaptureBoundaryDecision {
  const key = captureBoundaryKey(current);
  if (!previous) return { startsNewSession: true, key, reason: 'first-event' };
  if (current.explicitStop) return { startsNewSession: true, key, reason: 'explicit-stop' };
  if (previous.sessionId && current.sessionId && previous.sessionId !== current.sessionId) {
    return { startsNewSession: true, key, reason: 'session-id-changed' };
  }
  if (previous.transcriptPath && current.transcriptPath && previous.transcriptPath !== current.transcriptPath) {
    return { startsNewSession: true, key, reason: 'transcript-marker' };
  }
  const idleWindowMs = options.idleWindowMs ?? DEFAULT_CAPTURE_IDLE_WINDOW_MS;
  if (current.observedAtMs - previous.observedAtMs >= idleWindowMs) {
    return { startsNewSession: true, key, reason: 'idle-window' };
  }
  return { startsNewSession: false, key, reason: 'same-session' };
}

export class IdleWindowCaptureDeduper {
  private readonly idleWindowMs: number;
  private readonly lastByToolAndRepo = new Map<string, CaptureBoundaryEvent>();

  constructor(options: CaptureDeduperOptions = {}) {
    this.idleWindowMs = options.idleWindowMs ?? DEFAULT_CAPTURE_IDLE_WINDOW_MS;
  }

  observe(event: CaptureBoundaryEvent): CaptureBoundaryDecision {
    const groupKey = this.groupKey(event);
    const previous = this.lastByToolAndRepo.get(groupKey) ?? null;
    const decision = decideCaptureBoundary(previous, event, { idleWindowMs: this.idleWindowMs });
    this.lastByToolAndRepo.set(groupKey, event);
    return decision;
  }

  private groupKey(event: CaptureBoundaryEvent): string {
    const repo = event.repoRemoteUrl && event.repoCommitHash
      ? `${event.repoRemoteUrl}@${event.repoCommitHash}`
      : event.repoRemoteUrl ?? 'repo:unknown';
    return `${event.tool}|${repo}`;
  }
}
