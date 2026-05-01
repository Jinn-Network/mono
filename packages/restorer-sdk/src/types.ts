// Public contract surface for Jinn external RestorerImpl authors.
//
// These types are mirrored from `client/src/restorer/types.ts` at SDK
// publish time. The SDK is the stable boundary; @jinn-network/client
// internals are not.

export type Hex = `0x${string}`;
export type Address = Hex;

export interface IntentWindow {
  startTs: number;
  endTs: number;
}

export interface DesiredStateSpec {
  kind: string;
  [key: string]: unknown;
}

export interface RestorationJob {
  id: string;
  description?: string;
  type?: 'restoration' | 'evaluation';
  spec?: DesiredStateSpec;
  eligibility?: Record<string, unknown>;
  window?: IntentWindow;
}

export interface OutputArtifact {
  type: string;
  path?: string;
  cid?: string;
  [key: string]: unknown;
}

export interface RationaleEntry {
  message: string;
  [key: string]: unknown;
}

export interface RestorationOutput {
  venueRef: { name: string };
  preSnapshot?: Record<string, unknown>;
  postSnapshot?: Record<string, unknown>;
  fills?: unknown[];
  gating: Record<string, unknown>;
  informational?: Record<string, unknown>;
  restorationPayload?: Record<string, unknown>;
  verdictPayload?: Record<string, unknown>;
  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];
}

export interface ReadyStatus {
  ready: boolean;
  reason?: string;
  nextStep?: { description: string; cli?: string; url?: string };
}

export const REQUIRES_LIVE_DAEMON_READINESS: ReadyStatus = {
  ready: false,
  reason: 'requires live daemon',
  nextStep: {
    description: 'Run the daemon with a configured fleet and wallet',
    cli: 'jinn run',
  },
};

export interface EnableArgDef {
  name: string;
  description: string;
  required: boolean;
}

export interface IntentEnableMetadata {
  description: string;
  requiredArgs?: EnableArgDef[];
  externalResources?: Array<{ name: string; url: string }>;
}

export type EnableResult =
  | { status: 'ready'; details?: Record<string, unknown> }
  | {
      status: 'waiting_for_external_action';
      action: { description: string; url?: string };
      details?: Record<string, unknown>;
      nextInvocation: { cli: string; purpose: string };
    }
  | {
      status: 'missing_args';
      required: EnableArgDef[];
      example: { cli: string };
    }
  | { status: 'error'; message: string; details?: Record<string, unknown> };

export class SkippableError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'SkippableError';
    this.reason = reason;
  }
}
