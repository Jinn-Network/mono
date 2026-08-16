import { useState, type JSX } from 'react';
import { useLocation, useParams } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type {
  GeneratorConfig,
  LaunchedSolverNetRecord,
  LifecycleTarget,
  RegistryManifestResponse,
} from '../../../../api/contract/index.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { GeneratorPanel } from './launcher-launched/GeneratorPanel.js';
import { PauseRetireDialog } from './launcher-launched/PauseRetireDialog.js';
import { SpendPanel } from './launcher-launched/SpendPanel.js';
import { StatusHeader } from './launcher-launched/StatusHeader.js';
import { TasksPanel } from './launcher-launched/TasksPanel.js';
import {
  TEMPLATES_BY_KEY,
  type CreateWizardTemplate,
} from './launcher-create/templates.js';

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

/**
 * Operator count changes slowly (a new operator appears only when one claims a
 * task) and each poll fans out to a paginated discovery scan, so it polls far
 * less often than the 2.5s record poll. Tests override it via `pollIntervalMs`.
 */
const OPERATOR_COUNT_POLL_INTERVAL_MS = 30_000;

export interface LauncherLaunchedPageProps {
  /** Override poll interval (tests). */
  pollIntervalMs?: number;
  /** Override navigation hook (tests). */
  navigateTo?: (path: string) => void;
  /** Override solverNetId (tests that don't want to wire up wouter routing). */
  solverNetId?: string;
}

const pageClass =
  'mx-auto flex max-w-[960px] flex-col gap-4 p-6';

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

  // Distinct operators with on-chain activity on this SolverNet (issue #351).
  // Polls on its own slower cadence (OPERATOR_COUNT_POLL_INTERVAL_MS) rather
  // than the 2.5s record poll: the count changes only when an operator claims
  // a task, and each poll fans out to a paginated discovery scan. A discovery
  // outage / pre-bootstrap 503 leaves the query in error; StatusHeader renders
  // nothing in that case rather than a stale 0.
  const operatorCountQuery = useQuery<number>({
    queryKey: ['solvernets', 'operator-count', manifestCid],
    queryFn: async () => {
      const res = await api.discovery.getSolverNetOperatorCount(manifestCid!);
      return res.operatorCount;
    },
    enabled: Boolean(manifestCid),
    refetchInterval: OPERATOR_COUNT_POLL_INTERVAL_MS,
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
      <main data-testid="launcher-launched-missing-id" className={pageClass}>
        <ErrorBanner
          message="No solverNetId supplied."
          onBack={() => navigate('/launcher')}
        />
      </main>
    );
  }

  if (recordQuery.isLoading) {
    return (
      <main data-testid="launcher-launched-loading" className={pageClass}>
        <p className="m-0 font-mono text-[13px] text-[var(--fg-muted)]">
          Loading…
        </p>
      </main>
    );
  }

  if (recordQuery.isError || !recordQuery.data) {
    const message =
      recordQuery.error instanceof Error
        ? recordQuery.error.message
        : 'Unknown error';
    return (
      <main data-testid="launcher-launched-error" className={pageClass}>
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
  const template = resolveLaunchedTemplate(record, manifest);
  const solverNetName = manifest?.name ?? record.summary?.name ?? record.solverNetId;

  return (
    <main
      data-testid="launcher-launched"
      data-solvernet-id={solverNetId}
      className={pageClass}
    >
      <StatusHeader
        record={record}
        manifest={manifest}
        operatorCount={operatorCountQuery.data}
        onAction={(target) => {
          setDialogError(null);
          setDialogTarget(target);
        }}
        pending={lifecycleMutation.isPending ? lifecycleMutation.variables?.target ?? null : null}
      />

      <GeneratorPanel
        record={record}
        manifest={manifest}
        template={template}
        onSave={async (patch) => {
          await generatorMutation.mutateAsync(patch);
        }}
      />

      <SpendPanel record={record} manifest={manifest} />

      <TasksPanel record={record} />

      {manifestQuery.isError && (
        <p
          data-testid="launcher-launched-manifest-error"
          className="m-0 font-mono text-[12px] text-destructive"
        >
          Failed to load manifest:{' '}
          {formatManifestLoadError(manifestQuery.error)}
        </p>
      )}

      <PauseRetireDialog
        open={dialogTarget !== null}
        target={dialogTarget ?? 'paused'}
        solverNetName={solverNetName}
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

function formatManifestLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  if (/404|manifest_not_found|registry_unavailable/i.test(message)) {
    return `Manifest unavailable from local cache or registry (${message})`;
  }
  return message;
}

function resolveLaunchedTemplate(
  record: LaunchedSolverNetRecord,
  manifest: RegistryManifestResponse['manifest'] | undefined,
): CreateWizardTemplate | undefined {
  const contract = manifest?.contract ?? (
    record.summary
      ? { id: record.summary.contractId, version: record.summary.contractVersion }
      : undefined
  );
  if (!contract) return undefined;
  return TEMPLATES_BY_KEY[`${contract.id}.${contract.version}`];
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
    <Alert
      variant="blocking"
      className="flex items-center justify-between gap-4 border-l-0 border border-destructive p-4"
    >
      <AlertDescription className="font-mono text-[13px] text-destructive">
        {message}
      </AlertDescription>
      <div className="flex gap-2">
        {onRetry && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="launcher-launched-error-retry"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="launcher-launched-error-back"
          onClick={onBack}
        >
          Back to launcher
        </Button>
      </div>
    </Alert>
  );
}
