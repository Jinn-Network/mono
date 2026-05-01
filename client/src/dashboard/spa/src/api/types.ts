export type StructuredEventKind = 'intent' | 'reward' | 'fleet' | 'system' | 'error' | 'log';

export interface StructuredEvent {
  schemaVersion: 1;
  id: string;
  ts: string;
  kind: StructuredEventKind;
  message: string;
  requestId?: string;
  txHash?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export type DaemonMode = 'setup' | 'running' | 'uninitialized';

export interface BootstrapErrorEnvelope {
  schemaVersion: 1;
  generatedAt: string;
  code: 'funding_required' | 'invalid_invocation' | 'bootstrap_incomplete' | 'reconcile_needed' | 'transient_error' | 'fatal';
  exitCode: number;
  message: string;
  hint?: string;
  exampleCli?: string;
  details?: Record<string, unknown>;
}

export interface BootstrapState {
  schemaVersion: 1;
  mode: DaemonMode;
  steps: string[];
  currentStep: string;
  services: Array<{
    index: number;
    step: string;
    safe_address?: string;
    service_id?: number;
  }>;
  master_address?: string;
  chain?: string;
  /** Persisted from the last fatal bootstrap exit. Absent on healthy state. */
  error?: BootstrapErrorEnvelope;
}

export interface ClaudeAuthState {
  schemaVersion: 1;
  authenticated: boolean;
  context: 'bare' | 'docker-compose' | 'container';
  detail: string;
  email?: string;
}
