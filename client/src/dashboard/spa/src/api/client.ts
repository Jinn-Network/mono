import type {
  BootstrapState,
  ClaudeAuthState,
  StructuredEvent,
  ActivityEventRow,
  ActivityEventsResponse,
  SolverNetsCatalogResponse,
  LauncherStatusResponse,
  LauncherTasksResponse,
  LauncherTasksRequestOptions,
  LauncherSolverNetPatch,
  LauncherSolverNetPatchResponse,
  DraftListResponse,
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
  GeneratorConfig,
  LaunchAction,
  LaunchedSolverNetRecord,
  LaunchedStatus,
  LifecycleTarget,
  OwnedLaunchedListResponse,
  RegistryListResponse,
  RegistryManifestResponse,
  OperatorArtifactSource,
  OperatorArtifactsResponse,
  OperatorPricingConfig,
  CapturesListResponse,
  CaptureDetailResponse,
  Iso8601,
  DiscoveryPluginPublicationsResponse,
  DiscoveryBuilderArtifactsResponse,
  DiscoveryPluginScoresResponse,
  DiscoverySolverNetOperatorCountResponse,
  DiscoveryTaskPostCountsResponse,
  HarnessReadinessEntry,
  HarnessAuthStatusResponse,
  CodexDoctorResponse,
  DebugReportManifest,
  RewardsResponse,
  ClaimRewardsResponse,
  ClaimPolicyConfig,
  ClaimPolicyResponse,
  ExecutionWiringConfigEntry,
} from './types.js';
import type { ProviderRef } from '../../../../harnesses/provider-ref.js';

interface JsonErrorPayload {
  error?: string;
  message?: string;
}

async function readJsonErrorPayload(res: Response): Promise<JsonErrorPayload | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try {
    const body = await res.json() as unknown;
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    return {
      error: typeof record.error === 'string' ? record.error : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
    };
  } catch {
    return null;
  }
}

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const payload = await readJsonErrorPayload(res);
    const detail = payload?.message ?? payload?.error;
    const error = new Error(
      detail
        ? `${res.status} ${res.statusText}: ${detail} on ${path}`
        : `${res.status} ${res.statusText} on ${path}`,
    ) as Error & { status?: number; code?: string };
    error.status = res.status;
    error.code = payload?.error;
    throw error;
  }
  return res.json() as Promise<T>;
}

export const api = {
  getStatus: () => jfetch<unknown>('/v1/status'),
  getRewards: () => jfetch<RewardsResponse>('/v1/rewards'),
  getBootstrap: () => jfetch<BootstrapState>('/v1/bootstrap'),
  getRecentEvents: (kinds?: string[], limit = 100) => {
    const q = new URLSearchParams();
    if (kinds && kinds.length > 0) q.set('kinds', kinds.join(','));
    q.set('limit', String(limit));
    return jfetch<{ events: StructuredEvent[] }>(`/v1/events/recent?${q.toString()}`);
  },
  getActivityEvents: (opts?: {
    kinds?: string[];
    outcome?: string;
    requestId?: string;
    beforeId?: number;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    if (opts?.kinds && opts.kinds.length > 0) q.set('kinds', opts.kinds.join(','));
    if (opts?.outcome) q.set('outcome', opts.outcome);
    if (opts?.requestId) q.set('requestId', opts.requestId);
    if (opts?.beforeId !== undefined) q.set('beforeId', String(opts.beforeId));
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return jfetch<ActivityEventsResponse>(`/v1/activity-events${qs ? `?${qs}` : ''}`);
  },
  getActivityEvent: (id: number | string) =>
    jfetch<ActivityEventRow>(`/v1/activity-events/${encodeURIComponent(String(id))}`),
  getClaudeAuth: () => jfetch<ClaudeAuthState>('/v1/auth/claude'),
  installClaudeCode: () =>
    jfetch<{
      ok: boolean;
      status: 'already_present' | 'installed' | 'install_failed';
      detail: string;
      binary?: ClaudeAuthState['binary'];
    }>('/v1/setup/claude/install', {
      method: 'POST',
    }),
  signInClaude: () =>
    jfetch<{ ok: boolean; reason?: string }>('/v1/auth/claude/spawn', {
      method: 'POST',
    }),
  /**
   * Trigger a Base Sepolia faucet drip for the master EOA.
   *
   * - Default (bootstrap funding gate): the daemon loops the tiny CDP drip
   *   until the wallet clears the entire bootstrap floor.
   * - `{ singleDrip: true }` (running-mode Dashboard "Top up"): the daemon
   *   fires the faucet EXACTLY ONCE and returns immediately with a `deltaWei`
   *   reporting how much the balance moved. This is what makes the Dashboard
   *   Gas top-up an explicit, one-shot action with no re-firing loop
   *   (jinn-mono #336).
   */
  triggerDrip: (opts?: { singleDrip?: boolean; batch?: boolean; signal?: AbortSignal }) =>
    jfetch<{
      ok: boolean;
      address?: string;
      txHash?: string;
      txHashes?: string[];
      attempts?: number;
      balanceWei?: string;
      targetWei?: string;
      deltaWei?: string;
      reason?: string;
      rateLimited?: boolean;
      // Issue #560 — batched daily-cap top-up fields.
      dailyCap?: number;
      callsRemaining?: number;
      cooldownExpiresAt?: number | null;
    }>(
      opts?.singleDrip
        ? '/v1/setup/drip?singleDrip=true'
        : opts?.batch
          ? '/v1/setup/drip?batch=true'
          : '/v1/setup/drip',
      { method: 'POST', signal: opts?.signal },
    ),
  /**
   * Read the operator's batched faucet top-up quota for today (issue #560):
   * how many drips remain and when the 24h cooldown expires. Soft-renders the
   * full cap pre-bootstrap so the WalletCard always has something to show.
   */
  getDripQuota: () =>
    jfetch<{
      ok: boolean;
      address?: string;
      dailyCap?: number;
      callsRemaining?: number;
      cooldownExpiresAt?: number | null;
      reason?: string;
    }>('/v1/setup/drip/quota'),
  changeKeystorePassword: (current: string, next: string) =>
    jfetch<{ ok: boolean }>('/v1/setup/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current, next }),
    }),
  /**
   * Trigger a daemon restart. The Node Health card's Restart button passes
   * `forceRespawn: true` so the daemon comes back even under a supervisor
   * (`JINN_NO_UI=1`) — without it the operator clicks Restart in `--no-ui`
   * mode and the daemon stops dead. Other callers (MCP tools, config-change
   * flows) leave `forceRespawn` unset so the supervisor keeps its contract.
   */
  restartDaemon: (opts?: { forceRespawn?: boolean }) =>
    jfetch<{ ok: boolean; scheduled?: boolean }>('/api/admin/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    }),
  /**
   * Stop the daemon process. The operator clicked Stop; the daemon exits and
   * stays down until they explicitly start it again (from the terminal,
   * since there's no out-of-band Start endpoint by design).
   */
  stopDaemon: () =>
    jfetch<{ ok: boolean; scheduled?: boolean }>('/api/admin/stop', {
      method: 'POST',
    }),
  claimRewards: () =>
    jfetch<ClaimRewardsResponse>('/api/admin/claim-rewards', {
      method: 'POST',
    }),
  getSolverNets: () => jfetch<SolverNetsCatalogResponse>('/v1/solvernets'),
  updateSolverNet: (
    name: string,
    patch: {
      enabled?: boolean;
      roles?: Array<'solving' | 'evaluating'>;
      harness?: string;
      model?: string;
      plugins?: string[];
      solverType?: string; // deprecated; remove next release
    },
  ) =>
    jfetch<{
      ok: boolean;
      restartRequired: boolean;
      name: string;
      config: {
        enabled?: boolean;
        roles?: Array<'solving' | 'evaluating'>;
        harness?: string;
        model?: string;
        plugins?: string[];
      };
    }>(`/v1/setup/solvernets/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  updateNetwork: (patch: { rpcUrl: string | null }) =>
    jfetch<{ ok: boolean; restartRequired: boolean; rpcUrl: string | string[] }>(
      '/v1/setup/network',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),
  retryAgentBinding: (patch?: { serviceIndex?: number }) =>
    jfetch<{
      ok: boolean;
      attempts: Array<{ serviceIndex: number; status: 'success' | 'reverted' | 'queued'; txHash?: string; detail?: string }>;
    }>('/v1/setup/agent-binding/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch ?? {}),
    }),
  /** Re-enter the bootstrap state machine in-process. jinn-mono-hjex.6 */
  retryBootstrap: () =>
    jfetch<{ ok: boolean; error?: string }>('/v1/setup/bootstrap/retry', {
      method: 'POST',
    }),
  updateHarnessMode: (mode: 'train' | 'frozen') =>
    jfetch<{ ok: boolean; restartRequired: boolean; mode: 'train' | 'frozen' }>(
      '/v1/setup/harness',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      },
    ),

  hermesDoctor: () =>
    jfetch<{ installed: boolean; exitCode: number | null; stdout: string; stderr: string }>(
      '/api/hermes/doctor',
    ),

  /**
   * Codex CLI install + auth + version snapshot. Surfaces a yellow
   * untested-version hint when the operator's installed codex CLI falls
   * outside the harness's tested range (#675).
   */
  codexDoctor: () => jfetch<CodexDoctorResponse>('/api/codex/doctor'),

  /**
   * Per-harness readiness snapshot (vh74.2 Stage A — #248 / #332).
   * `GET /v1/harnesses/:name/readiness` keys by the daemon's `Harness.name`,
   * which is the canonical harness name the join form already carries in
   * `form.harness`. A 404 (`harness_not_found`) propagates as a thrown Error
   * with `code === 'harness_not_found'`.
   */
  harnessReadiness: (name: string) =>
    jfetch<HarnessReadinessEntry>(
      `/v1/harnesses/${encodeURIComponent(name)}/readiness`,
    ),

  /**
   * Per-harness auth-source status (#564) — auth source path, masked last-4
   * key suffix, credential mtime, and a loaded/missing/unknown badge. The
   * endpoint NEVER returns full key bytes.
   */
  harnessAuthStatus: () =>
    jfetch<HarnessAuthStatusResponse>('/v1/harnesses/auth-status'),

  // ---- Launcher mode (spec/2026-05-05-launcher-role-and-mode.md §5.3) ----
  // Operator mode never calls these — Operator-mode UI shows zero launcher
  // state per §6.3 strict separation.
  fetchLauncherStatus: () =>
    jfetch<LauncherStatusResponse>('/v1/launcher/status'),
  fetchLauncherTasks: (opts: LauncherTasksRequestOptions = {}) => {
    const q = new URLSearchParams();
    if (opts.cursor) q.set('cursor', opts.cursor);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.manifestCid) q.set('manifestCid', opts.manifestCid);
    const qs = q.toString();
    return jfetch<LauncherTasksResponse>(
      `/v1/launcher/tasks${qs ? `?${qs}` : ''}`,
    );
  },
  patchLauncherSolverNet: (name: string, patch: LauncherSolverNetPatch) =>
    jfetch<LauncherSolverNetPatchResponse>(
      `/v1/launcher/solvernets/${encodeURIComponent(name)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
    ),

  // ---- SolverNet creation + launch (spec/2026-05-05-solvernet-creation-and-launch.md) ----
  // The new shape that supersedes the predecessor `fetchLauncher*` methods.
  // The predecessor methods remain available above for components not yet
  // migrated; the new pages (Tasks 17-19) will call only `api.solvernets.*`.
  solvernets: {
    // ── Drafts CRUD (Task 13) ──
    listDrafts: () =>
      jfetch<DraftListResponse>('/v1/solvernets/drafts'),
    getDraft: (id: string) =>
      jfetch<DraftSolverNetRecord>(
        `/v1/solvernets/drafts/${encodeURIComponent(id)}`,
      ),
    createDraft: (body?: DraftSolverNetRecordPatch) =>
      jfetch<DraftSolverNetRecord>('/v1/solvernets/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    updateDraft: (id: string, patch: DraftSolverNetRecordPatch) =>
      jfetch<DraftSolverNetRecord>(
        `/v1/solvernets/drafts/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      ),
    deleteDraft: (id: string) =>
      jfetch<{ ok: true }>(
        `/v1/solvernets/drafts/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),

    // ── Launch (Task 14) ──
    launch: (draftId: string) =>
      jfetch<LaunchAction>(
        `/v1/solvernets/drafts/${encodeURIComponent(draftId)}/launch`,
        { method: 'POST' },
      ),

    // ── Lifecycle (Task 14) ──
    transitionLifecycle: (solverNetId: string, target: LifecycleTarget) =>
      jfetch<LaunchedSolverNetRecord>(
        `/v1/solvernets/launched/${encodeURIComponent(solverNetId)}/lifecycle`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target }),
        },
      ),

    // ── Generator config hot-apply (Task 14) ──
    updateGeneratorConfig: (
      solverNetId: string,
      patch: Partial<GeneratorConfig>,
    ) =>
      jfetch<GeneratorConfig>(
        `/v1/solvernets/launched/${encodeURIComponent(solverNetId)}/generator-config`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      ),

    // ── Owned launched records (Task 15) ──
    get: (solverNetId: string) =>
      jfetch<LaunchedSolverNetRecord>(
        `/v1/solvernets/launched/${encodeURIComponent(solverNetId)}`,
      ),
    listLaunched: (filter?: { status?: LaunchedStatus }) => {
      const q = new URLSearchParams();
      if (filter?.status) q.set('status', filter.status);
      const qs = q.toString();
      return jfetch<OwnedLaunchedListResponse>(
        `/v1/solvernets/launched${qs ? `?${qs}` : ''}`,
      );
    },

    // ── Global registry (Task 15) ──
    listRegistry: (opts?: {
      status?: 'launched' | 'paused' | 'retired';
      refresh?: boolean;
    }) => {
      const q = new URLSearchParams();
      if (opts?.status) q.set('status', opts.status);
      if (opts?.refresh) q.set('refresh', '1');
      const qs = q.toString();
      return jfetch<RegistryListResponse>(
        `/v1/solvernets/registry${qs ? `?${qs}` : ''}`,
      );
    },
    getManifest: (cid: string) =>
      jfetch<RegistryManifestResponse>(
        `/v1/solvernets/registry/${encodeURIComponent(cid)}`,
      ),
  },

  // ---- Operator participation flow (Task 21) ----
  // Spec: spec/2026-05-05-solvernet-creation-and-launch.md §12. Writes a
  // manifest-keyed entry to `config.joinedSolverNets[<cid>]`; restart-required
  // — the daemon does not hot-reload SolverNet config.
  operator: {
    listArtifacts: (opts: { source?: OperatorArtifactSource; artifactType?: string; limit?: number } = {}) => {
      const q = new URLSearchParams();
      if (opts.source) q.set('source', opts.source);
      if (opts.artifactType) q.set('artifactType', opts.artifactType);
      if (opts.limit !== undefined) q.set('limit', String(opts.limit));
      const qs = q.toString();
      return jfetch<OperatorArtifactsResponse>(
        `/v1/operator/execution-data${qs ? `?${qs}` : ''}`,
      );
    },
    updatePricing: (pricing: OperatorPricingConfig) =>
      jfetch<{ ok: boolean; restartRequired: boolean; pricing: OperatorPricingConfig }>(
        '/v1/operator/pricing',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(pricing),
        },
      ),
    join: (
      manifestCid: string,
      body: {
        name?: string;
        contract?: { id: string; version: string };
        roles: Array<'solver' | 'evaluator'>;
        harness?: string;
        model?: string;
        provider?: ProviderRef;
        plugins?: string[];
        disabledDefaultPlugins?: string[];
      },
    ) =>
      jfetch<{
        ok: boolean;
        restartRequired: boolean;
        manifestCid: string;
        config: {
          manifestCid: string;
          name?: string;
          contract?: { id: string; version: string };
          roles: Array<'solver' | 'evaluator'>;
          harness?: string;
          model?: string;
          provider?: ProviderRef;
          plugins?: string[];
          disabledDefaultPlugins?: string[];
        };
      }>(`/v1/operator/join/${encodeURIComponent(manifestCid)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    leave: (manifestCid: string) =>
      jfetch<{ ok: boolean; restartRequired: boolean; manifestCid: string }>(
        `/v1/operator/join/${encodeURIComponent(manifestCid)}`,
        { method: 'DELETE' },
      ),
    listJoined: () =>
      jfetch<{
        joinedSolverNets: Record<
          string,
          {
            manifestCid: string;
            name?: string;
            contract?: { id: string; version: string };
            roles: Array<'solver' | 'evaluator'>;
            harness?: string;
            model?: string;
            provider?: ProviderRef;
            plugins?: string[];
            disabledDefaultPlugins?: string[];
          }
        >;
      }>('/v1/operator/joined'),
    completeOnboarding: () =>
      jfetch<{ ok: boolean; onboardingComplete: boolean }>(
        '/v1/operator/onboarding-complete',
        { method: 'POST' },
      ),
    getClaimPolicy: () => jfetch<ClaimPolicyResponse>('/v1/operator/claim-policy'),
    setClaimPolicy: (body: { claimPolicy: ClaimPolicyConfig }) =>
      jfetch<{ restartRequired: boolean }>('/v1/operator/claim-policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    setExecutionWiring: (body: { executionWiring: ExecutionWiringConfigEntry[] }) =>
      jfetch<{ restartRequired: boolean }>('/v1/operator/execution-wiring', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  },
  captures: {
    listPending: () => jfetch<CapturesListResponse>('/api/captures/pending'),
    get: (sessionId: string) =>
      jfetch<CaptureDetailResponse>(`/api/captures/${encodeURIComponent(sessionId)}`),
    approve: (sessionId: string) =>
      jfetch<{ ok: boolean; sessionId: string; envelopeCid: string; publishedAt: Iso8601 }>(
        `/api/captures/${encodeURIComponent(sessionId)}/approve`,
        { method: 'POST' },
      ),
    skip: (sessionId: string) =>
      jfetch<{ ok: boolean; sessionId: string; skippedAt: Iso8601 }>(
        `/api/captures/${encodeURIComponent(sessionId)}/skip`,
        { method: 'POST' },
      ),
    trustRepo: (repoRemoteUrl: string, trusted: boolean) =>
      jfetch<{ ok: boolean; repoRemoteUrl: string; trusted: boolean }>(
        '/api/captures/trust-repos',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoRemoteUrl, trusted }),
        },
      ),
  },

  // ── One-click operator debug report (issue #420) ──────────────────────────
  debugReport: {
    /** Describe the support bundle before download (file list + redaction). */
    manifest: () => jfetch<DebugReportManifest>('/v1/debug-report/manifest'),
    /**
     * Download the redacted `.tar.gz` support bundle. `jfetch` assumes JSON,
     * so this uses a raw `fetch` and reads the binary body via `res.blob()`.
     * `screenshotPngBase64` is the client-captured dashboard PNG (base64, no
     * data-URI prefix); omitted when capture failed.
     */
    download: async (screenshotPngBase64?: string): Promise<Blob> => {
      const res = await fetch('/v1/debug-report', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          screenshotPngBase64 ? { screenshotPngBase64 } : {},
        ),
      });
      if (!res.ok) {
        throw new Error(`debug report failed: ${res.status} ${res.statusText}`);
      }
      return res.blob();
    },
  },

  // ── Discovery (hfmf) — proxied via daemon's /v1/discovery/* routes ──────────
  discovery: {
    listPluginPublications: (args?: {
      solverType?: string;
      builderAgentId?: string;
      includeRevoked?: boolean;
    }) => {
      const q = new URLSearchParams();
      if (args?.solverType) q.set('solverType', args.solverType);
      if (args?.builderAgentId) q.set('builderAgentId', args.builderAgentId);
      if (args?.includeRevoked !== undefined) q.set('includeRevoked', String(args.includeRevoked));
      const qs = q.toString();
      return jfetch<DiscoveryPluginPublicationsResponse>(
        `/v1/discovery/plugin-publications${qs ? `?${qs}` : ''}`,
      );
    },
    listBuilderArtifacts: (builderAgentId: string, limit?: number) => {
      const q = new URLSearchParams({ builderAgentId });
      if (limit !== undefined) q.set('limit', String(limit));
      return jfetch<DiscoveryBuilderArtifactsResponse>(
        `/v1/discovery/builder-artifacts?${q.toString()}`,
      );
    },
    getPluginScores: (cid: string, limit?: number) => {
      const q = new URLSearchParams({ cid });
      if (limit !== undefined) q.set('limit', String(limit));
      return jfetch<DiscoveryPluginScoresResponse>(
        `/v1/discovery/plugin-scores?${q.toString()}`,
      );
    },
    // Distinct operators with on-chain activity on a SolverNet (issue #351).
    getSolverNetOperatorCount: (cid: string) => {
      const q = new URLSearchParams({ cid });
      return jfetch<DiscoverySolverNetOperatorCountResponse>(
        `/v1/discovery/solvernet-operator-count?${q.toString()}`,
      );
    },
    // Windowed on-chain task-post counts (1h / 6h / 24h). No cids → chain-wide
    // totals only; cids → per-SolverNet `byCid` map too. Issue #918.
    getTaskPostCounts: (cids?: string[]) => {
      const q = new URLSearchParams();
      (cids ?? []).forEach((c) => q.append('cid', c));
      const qs = q.toString();
      return jfetch<DiscoveryTaskPostCountsResponse>(
        `/v1/discovery/task-post-counts${qs ? `?${qs}` : ''}`,
      );
    },
  },
};

/**
 * On first load, the daemon prints a handshake URL with `?k=<key>` that the
 * launcher opens in the browser. The SPA picks up that key, exchanges it for
 * a `jinn_ui_token` cookie, then strips the param so refreshes work without it.
 *
 * Subsequent loads (no `?k=` in URL) silently no-op; the cookie is reused.
 */
export async function ensureSessionToken(): Promise<void> {
  const url = new URL(window.location.href);
  const k = url.searchParams.get('k');
  if (!k) return;
  try {
    await fetch(`/auth/handshake?k=${encodeURIComponent(k)}`, { credentials: 'same-origin' });
  } catch {
    // best-effort: if handshake fails we'll still render; later API calls will 401
  }
  url.searchParams.delete('k');
  window.history.replaceState({}, '', url.toString());
}
