import { useEffect, useRef, useState, type JSX } from 'react';
import { HermesPrecheckPanel } from './HermesPrecheckPanel.js';
import { useLocation, useParams } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type {
  HarnessReadinessEntry,
  RegistryManifestResponse,
  SolverNetCatalogEntry,
  SolverNetsCatalogResponse,
} from '../../../../../api/contract/index.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Label } from '../../components/ui/label.js';
import { cn } from '../../lib/utils.js';
import {
  defaultModelForHarness,
  modelOptionsForHarness,
  providerForModel,
  resolveModelOption,
} from '../configuration/claudeModels.js';
import {
  canonicalHarnessName,
  CLAUDE_CODE_HARNESS,
  HERMES_AGENT_HARNESS,
  harnessDisplayName,
  harnessOptionLabel,
} from '../configuration/harnessNames.js';
import { PluginPicker } from '../configuration/PluginPicker.js';
import { decideCostSurface } from '../../../../../harnesses/cost-estimates.js';
import { CostEstimatePanel } from '../configuration/CostEstimatePanel.js';
import { HarnessFootprintPanel } from '../configuration/HarnessFootprintPanel.js';
import { useHarnessUsesPaidApiKey } from '../../hooks/useHarnessUsesPaidApiKey.js';
import { formatWeiAmount } from '../launcher-launched/helpers.js';
import { InlineHelp } from '../../components/InlineHelp.js';

const HERMES_AGENT_DESCRIPTION =
  'Self-improving agent by Nous Research. Built-in learning loop.';

/**
 * Long-form decision context for the join form lives in
 * `client/docs/operator/join-form-context.md`. Inline help points operators
 * there for the full picture (Issue #334).
 */
const JOIN_FORM_CONTEXT_DOC =
  'https://github.com/Jinn-Network/mono/blob/next/client/docs/operator/join-form-context.md';

/**
 * Operator participation flow keyed by `manifestCid`.
 *
 * Route: `/operator/join/:cid`. Reached from `RegistryCatalog`'s [Join] CTA.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §12.
 *
 * Loads the manifest body via the registry endpoint, lets the operator pick
 * which open roles to take + (for the solver role only) harness / plugins /
 * model, and writes the manifest-keyed entry to `config.joinedSolverNets[<cid>]`
 * via `POST /v1/operator/join/:cid`. The evaluator role binds harness from
 * the manifest's `contract.evaluationFunction.implementation` — the harness
 * picker is hidden when only `evaluator` is selected.
 */

const DEFAULT_HARNESS = CLAUDE_CODE_HARNESS;

const pageClass = 'mx-auto flex max-w-[880px] flex-col gap-4 p-6';
const cardLabelClass =
  'font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]';
const fieldLabelClass = cardLabelClass;
const labelRowClass = 'flex items-start gap-2';
const selectClass =
  'rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[14px] text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export interface JoinFlowProps {
  /** Override the manifest cid for tests (skips wouter route param lookup). */
  manifestCid?: string;
  /** Override navigation hook for tests. */
  navigateTo?: (path: string) => void;
}

type Role = 'solver' | 'evaluator';

interface JoinFormState {
  roles: Role[];
  harness: string;
  plugins: string[];
  disabledDefaultPlugins: string[];
  model: string;
}

/**
 * Result of a successful join, retained so the flow can render an explicit
 * success affordance on the join page rather than redirecting silently to
 * `/operator` — the v0.1.6 dogfood paper cut where rvx couldn't tell the join
 * had succeeded (#333).
 */
interface JoinSuccess {
  manifestCid: string;
  name: string;
  roles: Role[];
  restartRequired: boolean;
}

/**
 * Match a manifest's contract to a catalog entry by the canonical
 * `{id, version}` pair. Replaces the predecessor concatenated-solverType
 * string match (PRs d4491879 / 26548969 removed the `solverType` concept
 * from the SDK; the catalog now exposes `contract: { id, version }` to
 * match).
 */
function findCatalogEntry(
  catalog: SolverNetsCatalogResponse | undefined,
  contract: { id: string; version: string },
): SolverNetCatalogEntry | undefined {
  return catalog?.nets.find(
    (n) => n.contract.id === contract.id && n.contract.version === contract.version,
  );
}

function truncateAddress(address: string): string {
  if (!address) return '';
  if (address.length <= 13) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Mirrors `evaluatorHarnessNameForContract` in
 * `client/src/solver-nets/registry.ts` (the daemon-side source of truth) so
 * the join form probes the same harness the daemon would pair to this
 * contract. Returns `undefined` when no known evaluator harness matches —
 * callers must then skip the probe and the gate. New evaluator harnesses
 * get added in both places.
 */
function evaluatorHarnessNameForManifest(
  manifest: RegistryManifestResponse['manifest'] | undefined,
): string | undefined {
  const implementation = manifest?.contract.evaluationFunction.implementation;
  if (!implementation) return undefined;
  if (implementation.includes('swe-rebench-v2-evaluator')) return 'swe-rebench-v2-evaluator';
  if (implementation.includes('prediction-v1-evaluator')) return 'prediction-v1-evaluator';
  return undefined;
}

/**
 * Readiness lookup keyed by harness name. `undefined` for a name means the
 * probe is still in flight or the harness is absent from the daemon's
 * readiness snapshot (404 — treated as not-yet-known, not a hard failure).
 */
type ReadinessMap = Map<string, HarnessReadinessEntry | undefined>;

/**
 * Probes `GET /v1/harnesses/:name/readiness` for each candidate harness so
 * the join form (#332) can disable harness options whose external
 * dependencies (CLI install, provider API key) are unsatisfied — and gate
 * Save & Join on the selected harness reporting ready.
 *
 * The daemon's readiness snapshot covers every registered harness (not just
 * joined ones — see `readiness-registry.ts` `_doRefresh`), so an unjoined
 * harness still resolves here. A 404 is swallowed to `undefined` rather than
 * thrown: a harness the daemon does not know about should not crash the form.
 */
function useReadiness(harnessNames: string[]): { readiness: ReadinessMap } {
  // Sort + dedupe for a stable query key regardless of catalog ordering.
  const sortedNames = [...new Set(harnessNames)].sort();
  const query = useQuery<ReadinessMap>({
    queryKey: ['harness-readiness', sortedNames.join(',')],
    enabled: sortedNames.length > 0,
    // Re-probe periodically so an operator who installs a CLI / adds a key
    // in another window sees the option un-disable without a full reload.
    refetchInterval: 5_000,
    queryFn: async () => {
      const entries = await Promise.all(
        sortedNames.map(async (name): Promise<[string, HarnessReadinessEntry | undefined]> => {
          try {
            return [name, await api.harnessReadiness(name)];
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'harness_not_found') return [name, undefined];
            throw err;
          }
        }),
      );
      return new Map(entries);
    },
  });
  return { readiness: query.data ?? new Map() };
}

export function JoinFlow({
  manifestCid: manifestCidOverride,
  navigateTo,
}: JoinFlowProps = {}): JSX.Element {
  const params = useParams<{ cid: string }>();
  const [, navigateHook] = useLocation();
  const navigate = navigateTo ?? navigateHook;
  const queryClient = useQueryClient();
  const cid = manifestCidOverride ?? params.cid;

  const manifestQuery = useQuery<RegistryManifestResponse>({
    queryKey: ['solvernets', 'manifest', cid],
    queryFn: () => api.solvernets.getManifest(cid!),
    enabled: Boolean(cid),
    retry: false,
  });

  const catalogQuery = useQuery<SolverNetsCatalogResponse>({
    queryKey: ['solvernets', 'catalog'],
    queryFn: () => api.getSolverNets(),
  });

  // Default form state seeds Solver if available, otherwise Evaluator. Harness
  // / plugins / model default to the catalog's first compatible option.
  const manifest = manifestQuery.data?.manifest;
  const catalogEntry = manifest
    ? findCatalogEntry(catalogQuery.data, manifest.contract)
    : undefined;
  const solverCompatibleHarnesses = (catalogEntry?.compatibleHarnesses ?? [])
    .filter((h) => h.supportsRoles.includes('solving'))
    .map((h) => ({ ...h, name: canonicalHarnessName(h.name) }))
    .filter((h, index, all) => all.findIndex((candidate) => candidate.name === h.name) === index);
  const defaultHarness =
    solverCompatibleHarnesses[0]?.name ?? DEFAULT_HARNESS;
  const defaultModel = defaultModelForHarness(defaultHarness);

  const [form, setForm] = useState<JoinFormState>({
    roles: [],
    harness: defaultHarness,
    plugins: [],
    disabledDefaultPlugins: [],
    model: defaultModel,
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [joinSuccess, setJoinSuccess] = useState<JoinSuccess | null>(null);
  const [showHermesPrecheck, setShowHermesPrecheck] = useState(false);
  // Tracks whether the operator has explicitly picked a harness in this
  // session. Once true, the catalog-arrival effect below MUST NOT stomp
  // their choice — that was the cause of issue #329, where SWE-rebench v2
  // (whose catalog default is Hermes) re-overrode every Claude Code click.
  const operatorPickedHarness = useRef(false);
  const [highCostAcknowledged, setHighCostAcknowledged] = useState(false);

  // The catalog loads independently of the manifest — when it arrives, if
  // the operator hasn't picked a harness yet, shift the seed default to the
  // catalog's first compatible option. Once-per-catalog-load via useEffect
  // (NOT a render-time setState) so subsequent dropdown selections don't
  // get reverted on every re-render.
  const catalogPreferredHarness = solverCompatibleHarnesses[0]?.name;
  useEffect(() => {
    if (operatorPickedHarness.current) return;
    if (!catalogPreferredHarness) return;
    if (catalogPreferredHarness === form.harness) return;
    setForm((prev) => ({
      ...prev,
      harness: catalogPreferredHarness,
      model: defaultModelForHarness(catalogPreferredHarness),
    }));
    // form.harness intentionally omitted: we only react to the catalog
    // value changing (initial load / contract switch). Including form.harness
    // would re-fire this effect after the operator picks something and
    // bounce them back to the catalog default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogPreferredHarness]);
  const modelOptions = modelOptionsForHarness(form.harness);

  // Per-harness readiness probes. Solver-compatible harnesses (#332) so
  // not-ready options render disabled and Save & Join can gate on the
  // selected harness reporting ready; plus the manifest-bound evaluator
  // harness when the evaluator role is selected (#523) — symmetric gate
  // catches e.g. a Docker outage failing the evaluator's `isReady()` check.
  // The daemon keys the readiness endpoint by `Harness.name`, the same
  // canonical name `form.harness` carries.
  const evaluatorHarnessName = evaluatorHarnessNameForManifest(manifest);
  // Whether the solver picker (and its cost-protection surface) is shown.
  // Drives both the solver readiness probes below and the paid-key gate later.
  const showSolverFields = form.roles.includes('solver');
  const readinessProbeNames = [
    // Solver-harness probes only when the solver picker is shown (#374): an
    // evaluator-only join hides the picker, so probing those — and the 5s
    // refetch that drives it — has nothing to act on. The evaluator-harness
    // probe below stays independent so the evaluator gate works on its own.
    ...(showSolverFields ? solverCompatibleHarnesses.map((h) => h.name) : []),
    ...(form.roles.includes('evaluator') && evaluatorHarnessName
      ? [evaluatorHarnessName]
      : []),
  ];
  const { readiness } = useReadiness(readinessProbeNames);
  const selectedHarnessReadiness = readiness.get(form.harness);
  const evaluatorReadiness = evaluatorHarnessName
    ? readiness.get(evaluatorHarnessName)
    : undefined;

  // Cost-protection hooks must run before any conditional return (Rules of
  // Hooks). Pass undefined harness when solver fields are hidden — the hook
  // treats that as no paid-key surface.
  const usesPaidApiKey = useHarnessUsesPaidApiKey(
    showSolverFields ? form.harness : undefined,
  );
  const costDecision = decideCostSurface(
    usesPaidApiKey,
    showSolverFields ? form.model : undefined,
  );
  const requiresCostConfirmation =
    showSolverFields && costDecision.requiresConfirmation;
  const costGateBlocked = requiresCostConfirmation && !highCostAcknowledged;

  const submitMutation = useMutation({
    mutationFn: () => {
      // Persist the selected model's declared provider first-class (issue
      // #1243) so the adapter routes through it rather than inferring from the
      // id shape at runtime.
      const provider = providerForModel(form.model, form.harness);
      return api.operator.join(cid!, {
        ...(manifest?.name !== undefined ? { name: manifest.name } : {}),
        ...(manifest?.contract !== undefined
          ? { contract: { id: manifest.contract.id, version: manifest.contract.version } }
          : {}),
        roles: form.roles,
        ...(form.roles.includes('solver')
          ? {
              harness: form.harness,
              plugins: form.plugins,
              disabledDefaultPlugins: form.disabledDefaultPlugins,
              model: form.model,
              ...(provider !== undefined ? { provider } : {}),
            }
          : {}),
      });
    },
    onSuccess: (result) => {
      // Invalidate so the catalog's joined-indicator badge and the Overview
      // page's joined list pick the new entry up on the next tick instead of
      // waiting up to 30s for the next refetch.
      void queryClient.invalidateQueries({ queryKey: ['operator', 'joined'] });
      void queryClient.invalidateQueries({ queryKey: ['bootstrap'] });
      // Render an explicit success state on this page rather than a silent
      // redirect to /operator — the v0.1.6 dogfood paper cut (#333). The
      // operator confirms the join landed, then chooses where to go next.
      setJoinSuccess({
        manifestCid: result.manifestCid,
        name: result.config.name ?? manifest?.name ?? result.manifestCid,
        roles: result.config.roles,
        restartRequired: result.restartRequired,
      });
    },
    onError: (err) => {
      setSubmitError(err instanceof Error ? err.message : String(err));
    },
  });

  if (!cid) {
    return (
      <main data-testid="join-flow-missing-cid" className={pageClass}>
        <ErrorBanner
          message="No manifest cid supplied."
          onBack={() => navigate('/operator#solvernets')}
        />
      </main>
    );
  }

  if (manifestQuery.isLoading) {
    return (
      <main data-testid="join-flow-loading" className={pageClass}>
        <p className="m-0 font-mono text-[13px] text-[var(--fg-muted)]">
          Loading manifest…
        </p>
      </main>
    );
  }

  if (manifestQuery.isError || !manifest) {
    const message =
      manifestQuery.error instanceof Error
        ? manifestQuery.error.message
        : 'Unknown error';
    return (
      <main data-testid="join-flow-error" className={pageClass}>
        <ErrorBanner
          message={`Failed to load manifest: ${message}`}
          onBack={() => navigate('/operator#solvernets')}
          onRetry={() => {
            void manifestQuery.refetch();
          }}
        />
      </main>
    );
  }

  // Successful join — show an explicit confirmation on this page instead of
  // a silent redirect to /operator (#333). The operator sees the SolverNet
  // they just joined, the restart hint, and clear next-step CTAs.
  if (joinSuccess) {
    return (
      <main data-testid="join-flow-success" className={pageClass}>
        <JoinSuccessCard success={joinSuccess} navigate={navigate} />
      </main>
    );
  }

  const { openRoles } = manifest;
  const toggleRole = (role: Role): void => {
    if (!openRoles.includes(role)) return;
    setForm((prev) => {
      const has = prev.roles.includes(role);
      const nextRoles = has
        ? prev.roles.filter((r) => r !== role)
        : openRoles.filter((r) => r === role || prev.roles.includes(r));
      return { ...prev, roles: nextRoles };
    });
  };

  const showEvaluatorInfo = form.roles.includes('evaluator');

  // Readiness gate (#332): block Save & Join when the selected solver harness
  // reports a definitive `ready: false`. A still-loading or unknown probe
  // (`undefined`) does NOT block — the not-ready *options* are disabled in
  // the select, so an operator cannot land on a known-not-ready harness, and
  // we avoid flashing a disabled button before the first probe resolves.
  const harnessReadinessBlocked =
    showSolverFields && selectedHarnessReadiness?.ready === false;
  // Symmetric gate for the evaluator role (#523). An unknown evaluator
  // implementation resolves `evaluatorHarnessName` to undefined → no probe
  // → `evaluatorReadiness` stays undefined → no gate.
  const evaluatorReadinessBlocked =
    showEvaluatorInfo && evaluatorReadiness?.ready === false;

  const canSubmit =
    form.roles.length > 0 &&
    !submitMutation.isPending &&
    !costGateBlocked &&
    !harnessReadinessBlocked &&
    !evaluatorReadinessBlocked;

  const evaluatorNotReadyBanner =
    evaluatorReadinessBlocked && evaluatorHarnessName ? (
      <div
        data-testid="join-evaluator-not-ready"
        data-harness={evaluatorHarnessName}
        role="status"
        className="flex flex-col gap-1 rounded-md border border-destructive bg-[var(--bg)] p-2.5 font-mono text-[11px] text-foreground"
      >
        <span className="text-destructive">
          {harnessDisplayName(evaluatorHarnessName)} is not ready
          {evaluatorReadiness?.reason ? `: ${evaluatorReadiness.reason}` : ''}
        </span>
        {evaluatorReadiness?.nextStep && (
          <span
            data-testid="join-evaluator-not-ready-next-step"
            className="text-[var(--fg-muted)]"
          >
            {evaluatorReadiness.nextStep.description}
            {evaluatorReadiness.nextStep.cli
              ? ` (${evaluatorReadiness.nextStep.cli})`
              : ''}
          </span>
        )}
      </div>
    ) : null;

  return (
    <main
      data-testid="join-flow"
      data-manifest-cid={cid}
      className={pageClass}
    >
      <header className="flex flex-col gap-1.5">
        <span
          data-testid="join-flow-title"
          className="font-mono text-[20px] font-medium text-foreground"
        >
          Join {manifest.name}
        </span>
        <span className="font-mono text-[12px] text-[var(--fg-muted)]">
          {manifest.description}
        </span>
      </header>

      <Card data-testid="join-flow-summary" className="flex flex-col gap-3 p-4">
        <span className={cardLabelClass}>Manifest</span>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-mono text-[12px] text-[var(--fg-muted)]">
          <span>Contract</span>
          <span className="text-foreground">
            {manifest.contract.id} · {manifest.contract.version}
          </span>
          <span>Solution price</span>
          <span className="text-foreground">
            {formatWeiAmount(manifest.solutionPriceWei)}
          </span>
          <span>Verdict price</span>
          <span className="text-foreground">
            {formatWeiAmount(manifest.verdictPriceWei)}
          </span>
          <span>Open roles</span>
          <span data-testid="join-flow-open-roles" className="text-foreground">
            {openRoles.join(', ') || 'none'}
          </span>
          <span>Launcher</span>
          <span className="text-foreground">
            {truncateAddress(manifest.launcher.safeAddress)} · agentId{' '}
            {manifest.launcher.agentId}
          </span>
          <span>Manifest CID</span>
          <span
            data-testid="join-flow-manifest-cid"
            className="truncate text-[var(--fg-dim)]"
          >
            {cid}
          </span>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <span className={labelRowClass}>
          <span className={cardLabelClass}>Roles</span>
          <InlineHelp
            label="Roles help"
            docHref={`${JOIN_FORM_CONTEXT_DOC}#solver-vs-evaluator`}
          >
            Solver attempts tasks and submits solutions. It is the spending
            role: you pay for model inference and gas. It also has the most
            upside per task.
            {'\n\n'}
            Evaluator checks other operators' solutions. Lower spend, steadier
            returns, less variance.
            {'\n\n'}
            You can take either role, or both. New here? Start as a solver on
            one SolverNet, using a model you already pay for.
          </InlineHelp>
        </span>
        <div className="flex overflow-hidden rounded-md border border-border">
          {openRoles.map((role, idx) => {
            const active = form.roles.includes(role);
            const checkboxId = `join-role-${role}`;
            return (
              <label
                key={role}
                htmlFor={checkboxId}
                data-testid="join-role-option"
                data-role={role}
                data-role-active={active ? 'true' : 'false'}
                className={cn(
                  'flex flex-1 cursor-pointer flex-col gap-1.5 p-3 font-mono',
                  active ? 'bg-[var(--bg)] text-foreground' : 'bg-transparent text-[var(--fg-muted)]',
                  idx < openRoles.length - 1 && 'border-r border-border',
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleRole(role)}
                    aria-label={role === 'solver' ? 'Solver' : 'Evaluator'}
                    className="size-3.5 accent-primary"
                  />
                  <span className="text-[14px] font-medium">
                    {role === 'solver' ? 'Solver' : 'Evaluator'}
                  </span>
                </span>
                <span
                  className={cn(
                    'pl-[22px] text-[11px]',
                    active ? 'text-[var(--fg-muted)]' : 'text-[var(--fg-dim)]',
                  )}
                >
                  {role === 'solver'
                    ? 'attempt tasks; submit solutions'
                    : 'verify solutions submitted by other operators'}
                </span>
              </label>
            );
          })}
        </div>
      </Card>

      {showSolverFields && (
        <Card
          data-testid="join-flow-solver-fields"
          className="flex flex-col gap-3 p-4"
        >
          <span className={cardLabelClass}>Solver configuration</span>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <span className={labelRowClass}>
                <Label htmlFor="join-harness-select" className={fieldLabelClass}>
                  Harness
                </Label>
                <InlineHelp
                  label="Harness help"
                  docHref={`${JOIN_FORM_CONTEXT_DOC}#harness-and-model`}
                >
                  The harness is the runtime that runs a task.
                  {'\n\n'}
                  You only need credentials for one harness — the harness, not
                  the harness and the model separately.
                  {'\n\n'}
                  Claude Code uses whatever the `claude` CLI is signed in with:
                  a Claude subscription or an Anthropic API key. Hermes Agent is
                  a separate package; the join form checks it is installed.
                  {'\n\n'}
                  The default is the SolverNet's first compatible harness. Pick
                  one. You do not need to pay for two.
                </InlineHelp>
              </span>
              <select
                id="join-harness-select"
                aria-label="Harness"
                data-testid="join-harness-select"
                value={form.harness}
                onChange={(e) => {
                  const harness = e.target.value;
                  // Mark the choice as operator-driven so the catalog-arrival
                  // effect above doesn't bounce them back to the catalog
                  // default on the next render (issue #329).
                  operatorPickedHarness.current = true;
                  setForm({
                    ...form,
                    harness,
                    model: defaultModelForHarness(harness),
                  });
                  setHighCostAcknowledged(false);
                }}
                className={selectClass}
              >
                {solverCompatibleHarnesses.map((h) => {
                  const entry = readiness.get(h.name);
                  const notReady = entry?.ready === false;
                  return (
                    <option
                      key={h.name}
                      value={h.name}
                      disabled={notReady}
                      data-testid="join-harness-option"
                      data-harness={h.name}
                      data-harness-ready={
                        entry === undefined ? 'unknown' : entry.ready ? 'true' : 'false'
                      }
                    >
                      {harnessOptionLabel(h.name, h.version)}
                      {notReady ? ' — setup required' : ''}
                    </option>
                  );
                })}
                {(!catalogEntry || solverCompatibleHarnesses.length === 0) && (
                  <option value={form.harness}>{harnessDisplayName(form.harness)}</option>
                )}
              </select>
              {form.harness === HERMES_AGENT_HARNESS && (
                <span
                  data-testid="join-harness-hermes-description"
                  className="font-mono text-[11px] text-[var(--fg-muted)]"
                >
                  {HERMES_AGENT_DESCRIPTION}
                </span>
              )}
              {selectedHarnessReadiness?.ready === false && (
                <div
                  data-testid="join-harness-not-ready"
                  data-harness={form.harness}
                  role="status"
                  className="flex flex-col gap-1 rounded-md border border-destructive bg-[var(--bg)] p-2.5 font-mono text-[11px] text-foreground"
                >
                  <span className="text-destructive">
                    {harnessDisplayName(form.harness)} is not ready
                    {selectedHarnessReadiness.reason
                      ? `: ${selectedHarnessReadiness.reason}`
                      : ''}
                  </span>
                  {selectedHarnessReadiness.nextStep && (
                    <span
                      data-testid="join-harness-not-ready-next-step"
                      className="text-[var(--fg-muted)]"
                    >
                      {selectedHarnessReadiness.nextStep.description}
                      {selectedHarnessReadiness.nextStep.cli
                        ? ` (${selectedHarnessReadiness.nextStep.cli})`
                        : ''}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className={labelRowClass}>
                <Label htmlFor="join-model-select" className={fieldLabelClass}>
                  Model
                </Label>
                <InlineHelp
                  label="Model help"
                  docHref={`${JOIN_FORM_CONTEXT_DOC}#harness-and-model`}
                >
                  The model is the LLM the harness runs.
                  {'\n\n'}
                  This list only shows models the selected harness supports.
                  Change the harness and the model resets to that harness's
                  default.
                  {'\n\n'}
                  You pay for the model through the harness's credentials. There
                  is no extra model subscription on top.
                  {'\n\n'}
                  Check the cost estimate below before you join.
                </InlineHelp>
              </span>
              <select
                id="join-model-select"
                aria-label="Model"
                data-testid="join-model-select"
                value={form.model}
                onChange={(e) => {
                  setForm({ ...form, model: e.target.value });
                  setHighCostAcknowledged(false);
                }}
                className={selectClass}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {(() => {
                  const resolved = resolveModelOption(form.model, form.harness);
                  if (resolved.isCustom) {
                    return (
                      <option key={form.model} value={form.model}>
                        {resolved.label}
                      </option>
                    );
                  }
                  return null;
                })()}
              </select>
            </div>
          </div>

          <CostEstimatePanel
            modelId={form.model}
            usesPaidApiKey={usesPaidApiKey}
            testIdPrefix="join-flow-cost"
          />

          {/* Issue #815 — AI-units ceiling footprint, layered under the
              per-task USD surface so the operator commits to a 48h
              burn-in knowing the node's per-block + per-week shape. */}
          <HarnessFootprintPanel
            harness={form.harness}
            modelId={form.model}
            testIdPrefix="join-flow-footprint"
          />

          {requiresCostConfirmation && (
            <label
              data-testid="join-flow-cost-confirmation"
              data-cost-confirmation-checked={highCostAcknowledged ? 'true' : 'false'}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-destructive bg-[var(--bg)] p-3 font-mono text-[12px] text-foreground"
            >
              <input
                type="checkbox"
                data-testid="join-flow-cost-confirmation-checkbox"
                checked={highCostAcknowledged}
                onChange={(e) => setHighCostAcknowledged(e.target.checked)}
                className="mt-0.5 size-3.5 accent-destructive"
                aria-label="I understand the per-task cost and have a budget for this"
              />
              <span>
                I understand — I have a budget for this. The selected model is estimated at more than $1
                per task; I am responsible for the API spend on my own provider key.
              </span>
            </label>
          )}

          <div className="flex flex-col gap-2">
            <span className={labelRowClass}>
              <span className={fieldLabelClass}>Plugins</span>
              <InlineHelp
                label="Plugins help"
                docHref={`${JOIN_FORM_CONTEXT_DOC}#plug-ins`}
              >
                Plug-ins are optional. On your first run you do not need to
                touch this section.
                {'\n\n'}
                A plug-in is reusable AI tooling — MCP servers, skills,
                extensions — that the harness can load while it solves.
                {'\n\n'}
                This SolverNet already enables the plug-ins its tasks need. Add
                your own only if you have built one.
                {'\n\n'}
                You can re-join later with more plug-ins.
              </InlineHelp>
            </span>
            <PluginPicker
              available={catalogEntry?.compatiblePlugins ?? []}
              selected={form.plugins}
              disabledDefaultPlugins={form.disabledDefaultPlugins}
              onChange={(plugins, disabledDefaultPlugins) =>
                setForm({ ...form, plugins, disabledDefaultPlugins })
              }
              rowTestId="join-plugin-option"
              searchTestId="join-plugin-search"
              harness={form.harness}
            />
          </div>
        </Card>
      )}

      {showEvaluatorInfo && !showSolverFields && (
        <Card
          data-testid="join-flow-evaluator-info"
          className="flex flex-col gap-3 p-4"
        >
          <span className={labelRowClass}>
            <span className={cardLabelClass}>Evaluator configuration</span>
            <InlineHelp
              label="Evaluator configuration help"
              docHref={`${JOIN_FORM_CONTEXT_DOC}#why-the-evaluator-role-has-no-model-selector`}
            >
              The evaluator role has no harness or model picker. That is by
              design.
              {'\n\n'}
              Every evaluator on a SolverNet must run the same evaluation
              function, so verdicts can be compared. The SolverNet's manifest
              sets it for you.
              {'\n\n'}
              For many SolverNets that function is deterministic and uses no
              model at all.
            </InlineHelp>
          </span>
          <p className="m-0 font-mono text-[12px] text-[var(--fg-muted)]">
            The evaluator harness is bound to{' '}
            <code className="text-foreground">
              {manifest.contract.evaluationFunction.implementation}
            </code>{' '}
            by the manifest's contract; no operator selection required.
          </p>
          {evaluatorNotReadyBanner}
        </Card>
      )}

      {showEvaluatorInfo && showSolverFields && (
        <Card
          data-testid="join-flow-evaluator-info"
          className="flex flex-col gap-3 p-4"
        >
          <span className={labelRowClass}>
            <span className={cardLabelClass}>Evaluator binding</span>
            <InlineHelp
              label="Evaluator binding help"
              docHref={`${JOIN_FORM_CONTEXT_DOC}#why-the-evaluator-role-has-no-model-selector`}
            >
              The SolverNet's manifest sets the evaluator harness for you.
              {'\n\n'}
              Every evaluator runs the same evaluation function, so verdicts can
              be compared and trusted.
              {'\n\n'}
              The harness and model fields above apply only to the solver role.
            </InlineHelp>
          </span>
          <p className="m-0 font-mono text-[12px] text-[var(--fg-muted)]">
            Evaluator harness is bound to{' '}
            <code className="text-foreground">
              {manifest.contract.evaluationFunction.implementation}
            </code>{' '}
            by the manifest. The fields above only configure the solver role.
          </p>
          {evaluatorNotReadyBanner}
        </Card>
      )}

      {showHermesPrecheck && (
        <HermesPrecheckPanel
          onSuccess={() => {
            setShowHermesPrecheck(false);
            submitMutation.mutate();
          }}
          onCancel={() => {
            setShowHermesPrecheck(false);
          }}
        />
      )}

      {submitError && (
        <p
          data-testid="join-flow-submit-error"
          role="alert"
          className="m-0 font-mono text-[13px] text-destructive"
        >
          {submitError}
        </p>
      )}

      <footer className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          data-testid="join-flow-cancel"
          onClick={() => navigate('/operator#solvernets')}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          data-testid="join-flow-submit"
          disabled={!canSubmit}
          onClick={() => {
            setSubmitError(null);
            // If Hermes Agent is selected as the solver harness, run the install
            // precheck before persisting the join config.
            if (form.roles.includes('solver') && form.harness === HERMES_AGENT_HARNESS) {
              setShowHermesPrecheck(true);
              return;
            }
            submitMutation.mutate();
          }}
        >
          {submitMutation.isPending ? 'Joining…' : 'Join SolverNet'}
        </Button>
      </footer>
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
            data-testid="join-flow-retry"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="join-flow-back"
          onClick={onBack}
        >
          Back
        </Button>
      </div>
    </Alert>
  );
}

/**
 * Post-join success affordance (#333). Renders in place of the form once the
 * join config write succeeds: a green-bordered confirmation naming the
 * SolverNet just joined, the restart hint when the daemon needs a restart to
 * pick the config up, and explicit CTAs into the joined list / catalog. This
 * replaces the silent redirect to `/operator` that left v0.1.6 operators
 * unsure whether their join had landed.
 */
function JoinSuccessCard({
  success,
  navigate,
}: {
  success: JoinSuccess;
  navigate: (path: string) => void;
}): JSX.Element {
  const roleLabel = success.roles
    .map((r) => (r === 'solver' ? 'Solver' : 'Evaluator'))
    .join(' + ');
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const handleRestart = async (): Promise<void> => {
    setRestarting(true);
    setRestartError(null);
    try {
      const res = await api.restartDaemon();
      if (!res.ok) {
        throw new Error('Restart request failed.');
      }
      // Send the operator to the overview so they can watch the node
      // come back up after the restart.
      navigate('/overview');
    } catch (err) {
      setRestartError(
        err instanceof Error ? err.message : 'Restart request failed.',
      );
      setRestarting(false);
    }
  };
  return (
    <>
      <Card
        data-testid="join-flow-success-card"
        role="status"
        // var(--vow-green) is unmapped in tailwind config (no shadcn
        // equivalent for the protocol "vow" tone); used to signal a
        // successful join visually distinct from default green.
        className="flex flex-col gap-2.5 border-[var(--vow-green)] p-5"
      >
        <Badge variant="success" className="self-start">
          Joined
        </Badge>
        <span
          data-testid="join-flow-success-name"
          className="font-mono text-[18px] font-medium text-foreground"
        >
          You joined {success.name}
        </span>
        <span className="font-mono text-[12px] leading-relaxed text-[var(--fg-muted)]">
          You're in as {roleLabel || 'an operator'}. This SolverNet now shows in
          your joined list.
        </span>
        {success.restartRequired && (
          <span
            data-testid="join-flow-success-restart"
            // var(--accent-gold) is unmapped in tailwind config; used here as
            // the canonical "attention required" tone (matches the design
            // system's wane/gold ramp for advisory messaging).
            className="font-mono text-[12px] leading-relaxed text-[var(--accent-gold)]"
          >
            Restart the node to start participating — the daemon picks up
            SolverNet config on restart.
          </span>
        )}
      </Card>
      {restartError && (
        <AlertTitle
          role="alert"
          data-testid="join-flow-success-restart-error"
          className="font-mono text-[12px] leading-relaxed text-destructive"
        >
          {restartError}
        </AlertTitle>
      )}
      <footer className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          data-testid="join-flow-success-browse"
          onClick={() => navigate('/operator#solvernets')}
        >
          Browse SolverNets
        </Button>
        <Button
          type="button"
          variant="secondary"
          data-testid="join-flow-success-view"
          onClick={() =>
            navigate(`/operator#solvernets/${success.manifestCid}`)
          }
        >
          View joined SolverNet
        </Button>
        <Button
          type="button"
          variant="default"
          data-testid="join-flow-success-restart-button"
          onClick={() => {
            void handleRestart();
          }}
          disabled={restarting}
        >
          {restarting ? 'Restarting…' : 'Restart node now'}
        </Button>
      </footer>
    </>
  );
}
