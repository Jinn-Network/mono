import { useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type {
  GeneratorConfig,
  LaunchedSolverNetRecord,
  LifecycleTarget,
  RegistryManifestResponse,
} from '../api/types.js';
import { GeneratorPanel } from './launcher-launched/GeneratorPanel.js';
import { PauseRetireDialog } from './launcher-launched/PauseRetireDialog.js';
import { SpendPanel } from './launcher-launched/SpendPanel.js';
import { StatusHeader } from './launcher-launched/StatusHeader.js';
import { TasksPanel } from './launcher-launched/TasksPanel.js';

/**
 * Post-launch dashboard for `/launcher/launched/:solverNetId`.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §10 + Decision 11.
 *
 * Architecture:
 *   - Polls `api.solvernets.get(:id)` every `POLL_INTERVAL_MS` so the UI
 *     reflects lifecycle transitions, generator state, and hot-applied
 *     config without requiring a manual refresh.
 *   - Pulls the manifest body via `api.solvernets.getManifest(cid)` for
 *     display fields (name, description, prices). The manifest is cached
 *     forever once fetched — manifests are content-addressed.
 *   - Renders four panels stacked vertically: StatusHeader, GeneratorPanel,
 *     SpendPanel, TasksPanel. The lifecycle dialog is overlaid on top.
 *   - Exposes `pollIntervalMs` + `navigateTo` props so tests can inject
 *     deterministic state without standing up a wouter router.
 */

const POLL_INTERVAL_MS = 2_500;

export interface LauncherLaunchedPageProps {
  /** Override poll interval (tests). */
  pollIntervalMs?: number;
  /** Override navigation hook (tests). */
  navigateTo?: (path: string) => void;
  /** Override solverNetId (tests that don't want to wire up wouter routing). */
  solverNetId?: string;
}

export function LauncherLaunchedPage({
  pollIntervalMs = POLL_INTERVAL_MS,
  navigateTo,
  solverNetId: solverNetIdOverride,
}: LauncherLaunchedPageProps = {}): JSX.Element {
  const params = useParams<{ solverNetId: string }>();
  const [, navigateHook] = useLocation();
  const navigate = navigateTo ?? navigateHook;
  const queryClient = useQueryClient();
  const solverNetId = solverNetIdOverride ?? params.solverNetId;

  const recordQuery = useQuery<LaunchedSolverNetRecord>({
    queryKey: ['solvernets', 'launched', solverNetId],
    queryFn: () => api.solvernets.get(solverNetId!),
    refetchInterval: pollIntervalMs,
    enabled: Boolean(solverNetId),
  });

  const manifestCid = recordQuery.data?.manifestCid;
  const manifestQuery = useQuery<RegistryManifestResponse>({
    queryKey: ['solvernets', 'manifest', manifestCid],
    queryFn: () => api.solvernets.getManifest(manifestCid!),
    enabled: Boolean(manifestCid),
    staleTime: Infinity,
  });

  const [dialogTarget, setDialogTarget] = useState<LifecycleTarget | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const lifecycleMutation = useMutation({
    mutationFn: ({ target }: { target: LifecycleTarget }) =>
      api.solvernets.transitionLifecycle(solverNetId!, target),
    onSuccess: async (record) => {
      // jinn-mono-805s: cancel any in-flight poll before priming the cache.
      // Without the cancel, a poll started DURING the (10-15s) on-chain
      // transition resolves AFTER setQueryData and writes back the
      // intermediate `lifecycleProgress` shape — the status badge then
      // stays on the pre-transition value until the next manual reload.
      await queryClient.cancelQueries({
        queryKey: ['solvernets', 'launched', solverNetId],
      });
      queryClient.setQueryData<LaunchedSolverNetRecord>(
        ['solvernets', 'launched', solverNetId],
        record,
      );
      setDialogTarget(null);
      setDialogError(null);
    },
    onError: (err) => {
      setDialogError(err instanceof Error ? err.message : String(err));
    },
  });

  const generatorMutation = useMutation({
    mutationFn: (patch: Partial<GeneratorConfig>) =>
      api.solvernets.updateGeneratorConfig(solverNetId!, patch),
    onSuccess: () => {
      // Trigger an immediate refetch so the polled record picks up the new
      // generatorConfig without waiting for the next interval tick.
      void queryClient.invalidateQueries({
        queryKey: ['solvernets', 'launched', solverNetId],
      });
    },
  });

  if (!solverNetId) {
    return (
      <main
        data-testid="launcher-launched-missing-id"
        style={pageStyle}
      >
        <ErrorBanner message="No solverNetId supplied." onBack={() => navigate('/launcher')} />
      </main>
    );
  }

  if (recordQuery.isLoading) {
    return (
      <main data-testid="launcher-launched-loading" style={pageStyle}>
        <p style={mutedTextStyle}>Loading…</p>
      </main>
    );
  }

  if (recordQuery.isError || !recordQuery.data) {
    const message =
      recordQuery.error instanceof Error
        ? recordQuery.error.message
        : 'Unknown error';
    return (
      <main data-testid="launcher-launched-error" style={pageStyle}>
        <ErrorBanner
          message={`Failed to load SolverNet: ${message}`}
          onBack={() => navigate('/launcher')}
          onRetry={() => {
            void recordQuery.refetch();
          }}
        />
      </main>
    );
  }

  const record = recordQuery.data;
  const manifest = manifestQuery.data?.manifest;

  return (
    <main
      data-testid="launcher-launched"
      data-solvernet-id={solverNetId}
      style={pageStyle}
    >
      <StatusHeader
        record={record}
        manifest={manifest}
        onAction={(target) => {
          setDialogError(null);
          setDialogTarget(target);
        }}
        pending={lifecycleMutation.isPending ? lifecycleMutation.variables?.target ?? null : null}
      />

      <GeneratorPanel
        record={record}
        manifest={manifest}
        onSave={async (patch) => {
          await generatorMutation.mutateAsync(patch);
        }}
      />

      <SpendPanel record={record} manifest={manifest} />

      <TasksPanel record={record} />

      {manifestQuery.isError && (
        <p
          data-testid="launcher-launched-manifest-error"
          style={{
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            margin: 0,
          }}
        >
          Failed to load manifest:{' '}
          {manifestQuery.error instanceof Error
            ? manifestQuery.error.message
            : 'unknown error'}
        </p>
      )}

      <PauseRetireDialog
        open={dialogTarget !== null}
        target={dialogTarget ?? 'paused'}
        solverNetName={manifest?.name ?? ''}
        pending={lifecycleMutation.isPending}
        errorMessage={dialogError ?? undefined}
        onCancel={() => {
          if (lifecycleMutation.isPending) return;
          setDialogTarget(null);
          setDialogError(null);
        }}
        onConfirm={() => {
          if (!dialogTarget) return;
          lifecycleMutation.mutate({ target: dialogTarget });
        }}
      />
    </main>
  );
}

function ErrorBanner({
  message,
  onBack,
  onRetry,
}: {
  message: string;
  onBack: () => void;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--break-red)',
        borderRadius: 'var(--radius-2)',
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '16px',
      }}
    >
      <span
        style={{
          color: 'var(--break-red)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '13px',
        }}
      >
        {message}
      </span>
      <div style={{ display: 'flex', gap: '8px' }}>
        {onRetry && (
          <button
            type="button"
            data-testid="launcher-launched-error-retry"
            onClick={onRetry}
            style={ghostButtonStyle}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          data-testid="launcher-launched-error-back"
          onClick={onBack}
          style={ghostButtonStyle}
        >
          Back to launcher
        </button>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  padding: '24px',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  maxWidth: '960px',
  margin: '0 auto',
};

const mutedTextStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  color: 'var(--fg-muted)',
  margin: 0,
};

const ghostButtonStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  padding: '8px 14px',
  background: 'transparent',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  cursor: 'pointer',
};
