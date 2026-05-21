import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { CaptureDrillIn } from './CaptureDrillIn.js';
import { OperatorDataMarket } from '../pages/operator/OperatorDataMarket.js';
import type {
  CaptureSummary,
  OperatorArtifact,
  OperatorArtifactsResponse,
} from '../api/types.js';

type ExecutionDataSelection =
  | { kind: 'capture'; id: string }
  | { kind: 'artifact'; source: OperatorArtifact['source']; sha256: string };

interface ExecutionDataRow {
  id: string;
  selection: ExecutionDataSelection;
  title: string;
  state: string;
  meta: string;
  at: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function shortSha(sha: string): string {
  return sha.length > 14 ? `${sha.slice(0, 10)}…${sha.slice(-6)}` : sha;
}

function artifactTime(artifact: OperatorArtifact): string {
  return artifact.source === 'served' ? artifact.createdAt : artifact.fetchedAt;
}

function artifactState(artifact: OperatorArtifact): string {
  if (artifact.source === 'served') return 'shared';
  return artifact.paidAmountUsdc === '0' ? 'peer donated' : 'peer used';
}

function sameSelection(a: ExecutionDataSelection | undefined, b: ExecutionDataSelection): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'capture' && b.kind === 'capture') return a.id === b.id;
  if (a.kind === 'artifact' && b.kind === 'artifact') {
    return a.source === b.source && a.sha256 === b.sha256;
  }
  return false;
}

function queryErrorMessage(error: unknown): string {
  if (!error) return 'Unknown error';
  return error instanceof Error ? error.message : String(error);
}

function isPermissionError(error: unknown): boolean {
  return /\b(401|403)\b|unauthorized|forbidden/i.test(queryErrorMessage(error));
}

function ExecutionDataNotice({ kind, message }: { kind: 'permission' | 'error'; message?: string }): JSX.Element {
  const copy = kind === 'permission'
    ? 'Permission required to view execution data. Open the dashboard from the daemon handshake URL or refresh an authenticated session.'
    : `Execution data could not be loaded${message ? `: ${message}` : '.'}`;
  return (
    <div
      role="alert"
      data-testid={kind === 'permission' ? 'execution-data-permission' : 'execution-data-error'}
      style={{
        marginBottom: 12,
        padding: '12px 14px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--panel)',
        color: kind === 'permission' ? 'var(--accent-warn)' : 'var(--accent-danger)',
      }}
    >
      {copy}
    </div>
  );
}

function captureRow(capture: CaptureSummary): ExecutionDataRow {
  return {
    id: `capture:${capture.sessionId}`,
    selection: { kind: 'capture', id: capture.sessionId },
    title: 'execution-capture.v1',
    state: capture.status,
    meta: `${capture.originatingTool.name} · ${capture.spanCount} spans · ${capture.redactedSpanCount} redacted`,
    at: capture.capturedAt,
  };
}

function artifactRow(artifact: OperatorArtifact): ExecutionDataRow {
  const state = artifactState(artifact);
  return {
    id: `artifact:${artifact.source}:${artifact.sha256}`,
    selection: { kind: 'artifact', source: artifact.source, sha256: artifact.sha256 },
    title: artifact.artifactType,
    state,
    meta: `${artifact.source === 'served' ? 'produced' : 'peer'} · ${formatBytes(artifact.contentSize)} · ${shortSha(artifact.sha256)}`,
    at: artifactTime(artifact),
  };
}

function ExecutionArtifactDetail({ artifact }: { artifact: OperatorArtifact }): JSX.Element {
  const when = artifactTime(artifact);
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{artifact.artifactType}</h1>
          <div style={{ marginTop: 6, color: 'var(--fg-muted)' }}>
            {artifactState(artifact)} · {formatBytes(artifact.contentSize)} · {formatTime(when)}
          </div>
        </div>
      </header>

      <dl
        style={{
          margin: 0,
          padding: '14px 16px',
          border: '1px solid var(--border)',
          borderRadius: 8,
          display: 'grid',
          gridTemplateColumns: '140px minmax(0, 1fr)',
          gap: '10px 14px',
        }}
      >
        <dt style={{ color: 'var(--fg-muted)' }}>type</dt>
        <dd style={{ margin: 0 }}>{artifact.artifactType}</dd>
        <dt style={{ color: 'var(--fg-muted)' }}>state</dt>
        <dd style={{ margin: 0 }}>{artifactState(artifact)}</dd>
        <dt style={{ color: 'var(--fg-muted)' }}>sha256</dt>
        <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{artifact.sha256}</dd>
        <dt style={{ color: 'var(--fg-muted)' }}>envelope</dt>
        <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{artifact.envelopeCid ?? '—'}</dd>
        <dt style={{ color: 'var(--fg-muted)' }}>recorded</dt>
        <dd style={{ margin: 0 }}>{formatTime(when)}</dd>
        {artifact.source === 'served' ? (
          <>
            <dt style={{ color: 'var(--fg-muted)' }}>request</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{artifact.requestId ?? '—'}</dd>
            <dt style={{ color: 'var(--fg-muted)' }}>accesses</dt>
            <dd style={{ margin: 0 }}>
              {artifact.access.accessCount} total · {artifact.access.failedPaymentCount} failed
            </dd>
          </>
        ) : (
          <>
            <dt style={{ color: 'var(--fg-muted)' }}>operator</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{artifact.sourceOperator ?? '—'}</dd>
            <dt style={{ color: 'var(--fg-muted)' }}>source</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{artifact.sourceEndpoint ?? '—'}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function CapturesTab(): JSX.Element {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<ExecutionDataSelection | undefined>();
  const listQuery = useQuery({
    queryKey: ['captures', 'pending'],
    queryFn: () => api.captures.listPending(),
    refetchInterval: 2500,
  });
  const servedQuery = useQuery<OperatorArtifactsResponse>({
    queryKey: ['operator-artifacts', 'served', 'execution-data'],
    queryFn: () => api.operator.listArtifacts({ source: 'served', limit: 100 }),
    refetchInterval: 10_000,
  });
  const networkQuery = useQuery<OperatorArtifactsResponse>({
    queryKey: ['operator-artifacts', 'network', 'execution-data'],
    queryFn: () => api.operator.listArtifacts({ source: 'network', limit: 100 }),
    refetchInterval: 10_000,
  });
  const captures = listQuery.data?.captures ?? [];
  const artifacts = [
    ...(servedQuery.data?.artifacts ?? []),
    ...(networkQuery.data?.artifacts ?? []),
  ].sort((a, b) => artifactTime(b).localeCompare(artifactTime(a)));
  const rows = [
    ...captures.map(captureRow),
    ...artifacts.map(artifactRow),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const selectedCaptureId = selected?.kind === 'capture' ? selected.id : undefined;
  const selectedArtifact = selected?.kind === 'artifact'
    ? artifacts.find((artifact) => artifact.source === selected.source && artifact.sha256 === selected.sha256)
    : undefined;
  const loading = listQuery.isLoading || servedQuery.isLoading || networkQuery.isLoading;
  const listErrors = [
    listQuery.isError ? listQuery.error : listQuery.failureReason,
    servedQuery.isError ? servedQuery.error : servedQuery.failureReason,
    networkQuery.isError ? networkQuery.error : networkQuery.failureReason,
  ].filter(Boolean);
  const listPermissionError = listErrors.find(isPermissionError);
  const listError = listPermissionError ?? listErrors[0];

  useEffect(() => {
    if (rows.length === 0) {
      if (selected) setSelected(undefined);
      return;
    }
    if (!selected || !rows.some((row) => sameSelection(selected, row.selection))) {
      setSelected(rows[0].selection);
    }
  }, [rows, selected]);

  const detailQuery = useQuery({
    queryKey: ['captures', selectedCaptureId],
    queryFn: () => api.captures.get(selectedCaptureId!),
    enabled: Boolean(selectedCaptureId),
  });

  const approve = useMutation({
    mutationFn: (sessionId: string) => api.captures.approve(sessionId),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['captures'] }),
        qc.invalidateQueries({ queryKey: ['operator-artifacts'] }),
      ]);
    },
  });
  const skip = useMutation({
    mutationFn: (sessionId: string) => api.captures.skip(sessionId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['captures'] });
    },
  });
  const trustRepo = useMutation({
    mutationFn: (repoRemoteUrl: string) => api.captures.trustRepo(repoRemoteUrl, true),
  });

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <OperatorDataMarket defaultExpanded={true} />
      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 24 }}>
      <aside>
        <h1 style={{ margin: '0 0 12px', fontSize: 24 }}>Execution data</h1>
        {listError ? (
          <ExecutionDataNotice
            kind={listPermissionError ? 'permission' : 'error'}
            message={listPermissionError ? undefined : queryErrorMessage(listError)}
          />
        ) : null}
        {loading && rows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--fg-muted)' }}>
            Loading execution data.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--fg-muted)' }}>
            No execution data yet.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {rows.map((row) => {
              const active = sameSelection(selected, row.selection);
              return (
                <button
                  key={row.id}
                  type="button"
                  data-testid="execution-data-row"
                  onClick={() => setSelected(row.selection)}
                  style={{
                    textAlign: 'left',
                    padding: '14px 16px',
                    border: `1px solid ${active ? 'var(--accent-sky)' : 'var(--border)'}`,
                    borderRadius: 8,
                    background: active ? 'rgba(56, 189, 248, 0.08)' : 'var(--panel)',
                    color: 'var(--fg)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <strong>{row.title}</strong>
                    <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>{row.state}</span>
                  </div>
                  <div style={{ marginTop: 6, color: 'var(--fg-muted)', fontSize: 12 }}>
                    {row.meta} · {formatTime(row.at)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </aside>
      <main>
        {detailQuery.error ? (
          <ExecutionDataNotice
            kind={isPermissionError(detailQuery.error) ? 'permission' : 'error'}
            message={isPermissionError(detailQuery.error) ? undefined : queryErrorMessage(detailQuery.error)}
          />
        ) : selected?.kind === 'capture' && detailQuery.data ? (
          <CaptureDrillIn
            detail={detailQuery.data}
            approving={approve.isPending}
            skipping={skip.isPending}
            onApprove={() => selectedCaptureId && approve.mutate(selectedCaptureId)}
            onSkip={() => selectedCaptureId && skip.mutate(selectedCaptureId)}
            onTrustRepo={() => {
              const repo = detailQuery.data.capture.repoRemoteUrl;
              if (repo) trustRepo.mutate(repo);
            }}
          />
        ) : selected?.kind === 'artifact' && selectedArtifact ? (
          <ExecutionArtifactDetail artifact={selectedArtifact} />
        ) : (
          <div style={{ padding: 24, color: 'var(--fg-muted)' }}>
            {loading ? 'Loading execution data.' : 'Select execution data.'}
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
