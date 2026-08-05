import { Fragment, useEffect, useState, type JSX } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { CaptureDrillIn } from './CaptureDrillIn.js';
import { OperatorDataMarket } from '../pages/operator/OperatorDataMarket.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { ScrollArea } from '../components/ui/scroll-area.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../components/ui/sheet.js';
import { cn } from '../lib/utils.js';
import type {
  CaptureSummary,
  OperatorArtifact,
  OperatorArtifactsResponse,
} from '../../../../api/contract/index.js';

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

function explorerTxUrl(chainId: number, txHash: string): string | null {
  switch (chainId) {
    case 8453:
      return `https://basescan.org/tx/${txHash}`;
    case 84532:
      return `https://sepolia.basescan.org/tx/${txHash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${txHash}`;
    default:
      return null;
  }
}

function formatUnixSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  return formatTime(new Date(seconds * 1000).toISOString());
}

function DetailSection({
  title,
  children,
}: { title: string; children: ReactNode }): JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">{children}</CardContent>
    </Card>
  );
}

function DetailList({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
}): JSX.Element {
  return (
    <dl className="m-0 grid gap-x-3.5 gap-y-2.5 [grid-template-columns:140px_minmax(0,1fr)]">
      {rows.map(({ label, value }) => (
        <Fragment key={label}>
          <dt className="font-mono text-[12px] text-muted-foreground">{label}</dt>
          <dd className="m-0 break-all font-mono text-[12px] text-foreground">{value ?? '—'}</dd>
        </Fragment>
      ))}
    </dl>
  );
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

function ExecutionDataNotice({
  kind,
  message,
}: {
  kind: 'permission' | 'error';
  message?: string;
}): JSX.Element {
  const copy =
    kind === 'permission'
      ? 'Permission required to view execution data. Open the dashboard from the daemon handshake URL or refresh an authenticated session.'
      : `Execution data could not be loaded${message ? `: ${message}` : '.'}`;
  return (
    <Alert
      variant={kind === 'permission' ? 'warning' : 'blocking'}
      data-testid={kind === 'permission' ? 'execution-data-permission' : 'execution-data-error'}
    >
      <AlertDescription>{copy}</AlertDescription>
    </Alert>
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
    meta: `${artifact.source === 'served' ? 'produced' : 'peer'} · ${formatBytes(
      artifact.contentSize,
    )} · ${shortSha(artifact.sha256)}`,
    at: artifactTime(artifact),
  };
}

function ExecutionArtifactDetail({ artifact }: { artifact: OperatorArtifact }): JSX.Element {
  const when = artifactTime(artifact);
  const projection = artifact.projection;
  const anchors = artifact.anchors ?? [];

  const identityRows: Array<{ label: string; value: ReactNode }> = [
    { label: 'state', value: artifactState(artifact) },
    { label: 'sha256', value: artifact.sha256 },
    { label: 'recorded', value: formatTime(when) },
  ];

  const envelopeRows: Array<{ label: string; value: ReactNode }> = [
    { label: 'envelope', value: artifact.envelopeCid ?? '—' },
  ];
  if (projection) {
    envelopeRows.push(
      { label: 'signature', value: projection.signatureHash },
      { label: 'generated', value: formatUnixSeconds(projection.generatedAt) },
      { label: 'role', value: projection.role },
      { label: 'solver', value: projection.solverType },
      { label: 'evidence tier', value: projection.evidenceTier },
    );
  }

  const participantRows = projection
    ? [
        { label: 'safe', value: projection.participantSafeAddress ?? '—' },
        { label: 'agent EOA', value: projection.participantAgentEoa ?? '—' },
        { label: 'impl', value: projection.executor.implName ?? '—' },
        { label: 'impl version', value: projection.executor.implVersion ?? '—' },
        { label: 'runtime digest', value: projection.executor.runtimeBundleDigest ?? '—' },
        {
          label: 'plugins',
          value: projection.executor.plugins && projection.executor.plugins.length > 0
            ? (
                <div className="flex flex-wrap gap-1">
                  {projection.executor.plugins.map((p) => (
                    <Badge key={p} variant="outline">{p}</Badge>
                  ))}
                </div>
              )
            : '—',
        },
      ]
    : null;

  const taskRows = projection
    ? [
        { label: 'task CID', value: projection.taskCid ?? '—' },
        { label: 'task ID', value: projection.taskId ?? '—' },
        { label: 'request', value: projection.requestId ?? '—' },
        {
          label: 'solution ref',
          value: projection.solutionRef
            ? `${projection.solutionRef.envelopeCid}${projection.solutionRef.ref ? ` (${projection.solutionRef.ref})` : ''}`
            : '—',
        },
      ]
    : null;

  return (
    <div className="flex flex-col gap-5">
      <DetailSection title="Identity">
        <DetailList rows={identityRows} />
      </DetailSection>

      <DetailSection title="Envelope">
        <DetailList rows={envelopeRows} />
      </DetailSection>

      {participantRows ? (
        <DetailSection title="Participant">
          <DetailList rows={participantRows} />
        </DetailSection>
      ) : null}

      {taskRows ? (
        <DetailSection title="Task">
          <DetailList rows={taskRows} />
        </DetailSection>
      ) : null}

      <DetailSection title="On-chain anchors">
        {anchors.length === 0 ? (
          <div className="font-mono text-[12px] text-muted-foreground">
            no on-chain anchor recorded yet
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {anchors.map((anchor) => {
              const explorerHref = explorerTxUrl(anchor.chainId, anchor.txHash);
              const rows: Array<{ label: string; value: ReactNode }> = [
                { label: 'content kind', value: anchor.contentKind },
                { label: 'agent ID', value: anchor.agentId },
                { label: 'chain ID', value: String(anchor.chainId) },
                {
                  label: 'tx',
                  value: explorerHref ? (
                    <a
                      href={explorerHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all underline underline-offset-2 hover:text-foreground"
                    >
                      {anchor.txHash}
                    </a>
                  ) : (
                    anchor.txHash
                  ),
                },
                { label: 'block', value: anchor.blockNumber !== null ? String(anchor.blockNumber) : 'pending' },
                { label: 'anchored', value: formatUnixSeconds(anchor.anchoredAt) },
                { label: 'registry', value: anchor.identityRegistryAddress },
                { label: 'metadata key', value: anchor.metadataKey },
              ];
              return (
                <div key={`${anchor.contentKind}:${anchor.txHash}`} className="rounded-md border border-border bg-card p-3">
                  <DetailList rows={rows} />
                  <details className="mt-2">
                    <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
                      payload (ABI-encoded)
                    </summary>
                    <div className="mt-1 break-all font-mono text-[11px] text-foreground">
                      {anchor.payloadHex}
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        )}
      </DetailSection>

      {artifact.source === 'served' ? (
        <DetailSection title="Access">
          <DetailList
            rows={[
              { label: 'request', value: artifact.requestId ?? '—' },
              {
                label: 'accesses',
                value: `${artifact.access.accessCount} total · ${artifact.access.failedPaymentCount} failed`,
              },
              { label: 'paid serves', value: String(artifact.access.paidServeCount) },
              { label: 'free serves', value: String(artifact.access.freeServeCount) },
              { label: 'revenue', value: `${artifact.access.revenueUsdc} USDC` },
            ]}
          />
        </DetailSection>
      ) : (
        <DetailSection title="Source">
          <DetailList
            rows={[
              { label: 'operator', value: artifact.sourceOperator ?? '—' },
              { label: 'endpoint', value: artifact.sourceEndpoint ?? '—' },
              { label: 'origin', value: artifact.origin },
              { label: 'paid', value: `${artifact.paidAmountUsdc} USDC` },
              { label: 'peer catalog', value: artifact.peerCatalogId ?? '—' },
            ]}
          />
        </DetailSection>
      )}
    </div>
  );
}

export function CapturesTab(): JSX.Element {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<ExecutionDataSelection | undefined>();
  const [sheetOpen, setSheetOpen] = useState(false);
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
  const rows = [...captures.map(captureRow), ...artifacts.map(artifactRow)].sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const selectedCaptureId = selected?.kind === 'capture' ? selected.id : undefined;
  const selectedArtifact =
    selected?.kind === 'artifact'
      ? artifacts.find(
          (artifact) => artifact.source === selected.source && artifact.sha256 === selected.sha256,
        )
      : undefined;
  const loading = listQuery.isLoading || servedQuery.isLoading || networkQuery.isLoading;
  const listErrors = [
    listQuery.isError ? listQuery.error : listQuery.failureReason,
    servedQuery.isError ? servedQuery.error : servedQuery.failureReason,
    networkQuery.isError ? networkQuery.error : networkQuery.failureReason,
  ].filter(Boolean);
  const listPermissionError = listErrors.find(isPermissionError);
  const listError = listPermissionError ?? listErrors[0];

  // Keep `selected` in sync with the row set so navigation never points at
  // a stale id. The Sheet auto-opens when the operator activates a row;
  // it does NOT auto-open just because a default selection exists.
  useEffect(() => {
    if (rows.length === 0) {
      if (selected) setSelected(undefined);
      if (sheetOpen) setSheetOpen(false);
      return;
    }
    if (!selected || !rows.some((row) => sameSelection(selected, row.selection))) {
      setSelected(rows[0].selection);
    }
  }, [rows, selected, sheetOpen]);

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

  const handleRowActivate = (selection: ExecutionDataSelection): void => {
    setSelected(selection);
    setSheetOpen(true);
  };

  const sheetTitle =
    selected?.kind === 'capture'
      ? detailQuery.data?.capture.sessionId ?? 'Capture'
      : selectedArtifact?.artifactType ?? 'Artifact';

  const sheetDescription =
    selected?.kind === 'capture' && detailQuery.data
      ? `${new Date(detailQuery.data.capture.capturedAt).toLocaleString()} · ${
          detailQuery.data.spans.length
        } spans`
      : selected?.kind === 'artifact' && selectedArtifact
        ? `${artifactState(selectedArtifact)} · ${formatBytes(selectedArtifact.contentSize)} · ${formatTime(artifactTime(selectedArtifact))}`
        : 'Execution data detail.';

  return (
    <div className="flex flex-col gap-6 p-6">
      <OperatorDataMarket defaultExpanded={true} />

      <Card>
        <CardHeader>
          <CardTitle>Execution data</CardTitle>
        </CardHeader>
        <CardContent>
          {listError ? (
            <div className="mb-3">
              <ExecutionDataNotice
                kind={listPermissionError ? 'permission' : 'error'}
                message={listPermissionError ? undefined : queryErrorMessage(listError)}
              />
            </div>
          ) : null}

          {loading && rows.length === 0 ? (
            <div className="p-6 font-mono text-[12px] text-muted-foreground">
              Loading execution data.
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 font-mono text-[12px] text-muted-foreground">
              No execution data yet.
            </div>
          ) : (
            <ScrollArea className="max-h-[560px]">
              <div className="flex flex-col gap-2 pr-2">
                {rows.map((row) => {
                  const active = sameSelection(selected, row.selection);
                  return (
                    <Button
                      key={row.id}
                      variant="ghost"
                      data-testid="execution-data-row"
                      data-state={active ? 'active' : undefined}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => handleRowActivate(row.selection)}
                      className={cn(
                        'flex h-auto w-full flex-col items-stretch gap-1.5 rounded-md border border-border bg-card px-4 py-3 text-left font-mono text-[12px] normal-case tracking-normal hover:bg-accent',
                        active && 'border-primary bg-primary/[0.06]',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <strong className="min-w-0 truncate font-medium text-foreground">
                          {row.title}
                        </strong>
                        <Badge variant="outline" className="shrink-0">
                          {row.state}
                        </Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {row.meta} · {formatTime(row.at)}
                      </div>
                    </Button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-xl"
          data-testid="execution-data-sheet"
        >
          <SheetHeader>
            <SheetTitle className="break-all">{sheetTitle}</SheetTitle>
            <SheetDescription>{sheetDescription}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            {detailQuery.error ? (
              <ExecutionDataNotice
                kind={isPermissionError(detailQuery.error) ? 'permission' : 'error'}
                message={
                  isPermissionError(detailQuery.error)
                    ? undefined
                    : queryErrorMessage(detailQuery.error)
                }
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
              <div className="p-6 font-mono text-[12px] text-muted-foreground">
                {loading ? 'Loading execution data.' : 'Select execution data.'}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
