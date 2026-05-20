import { useEffect, useRef, useState } from 'react';
import { HermesPrecheckPanel } from './HermesPrecheckPanel.js';
import { useLocation, useParams } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type {
  HarnessReadinessEntry,
  RegistryManifestResponse,
  SolverNetCatalogEntry,
  SolverNetsCatalogResponse,
} from '../../api/types.js';
import {
  defaultModelForHarness,
  modelOptionsForHarness,
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
import { CostEstimatePanel, useCostSurfaceDecision } from '../configuration/CostEstimatePanel.js';
import { formatWeiAmount } from '../launcher-launched/helpers.js';

const HERMES_AGENT_DESCRIPTION =
  'Self-improving agent by Nous Research. Built-in learning loop.';

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

  // Per-harness readiness (#332). Probe every solver-compatible harness so
  // not-ready options render disabled, and Save & Join can gate on the
  // selected harness reporting ready. The daemon keys the readiness endpoint
  // by `Harness.name` — the same canonical name `form.harness` carries.
  const { readiness } = useReadiness(
    solverCompatibleHarnesses.map((h) => h.name),
  );
  const selectedHarnessReadiness = readiness.get(form.harness);

  const submitMutation = useMutation({
    mutationFn: () =>
      api.operator.join(cid!, {
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
            }
          : {}),
      }),
    onSuccess: () => {
      // Invalidate so the catalog's joined-indicator badge appears on the
      // next tick instead of waiting up to 30s for the next refetch.
      void queryClient.invalidateQueries({ queryKey: ['operator', 'joined'] });
      navigate('/operator#solvernets');
    },
    onError: (err) => {
      setSubmitError(err instanceof Error ? err.message : String(err));
    },
  });

  if (!cid) {
    return (
      <main data-testid="join-flow-missing-cid" style={pageStyle}>
        <ErrorBanner
          message="No manifest cid supplied."
          onBack={() => navigate('/operator#solvernets')}
        />
      </main>
    );
  }

  if (manifestQuery.isLoading) {
    return (
      <main data-testid="join-flow-loading" style={pageStyle}>
        <p style={mutedTextStyle}>Loading manifest…</p>
      </main>
    );
  }

  if (manifestQuery.isError || !manifest) {
    const message =
      manifestQuery.error instanceof Error
        ? manifestQuery.error.message
        : 'Unknown error';
    return (
      <main data-testid="join-flow-error" style={pageStyle}>
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

  const showSolverFields = form.roles.includes('solver');
  const showEvaluatorInfo = form.roles.includes('evaluator');

  // Cost-protection surface (Issue #331). Only consulted when the solver
  // role is selected — the evaluator role binds to a manifest-supplied
  // implementation and bypasses operator harness choice entirely.
  const costDecision = useCostSurfaceDecision(
    showSolverFields ? form.harness : undefined,
    showSolverFields ? form.model : undefined,
  );
  const requiresCostConfirmation = showSolverFields && costDecision.requiresConfirmation;
  const costGateBlocked = requiresCostConfirmation && !highCostAcknowledged;

  // Readiness gate (#332): block Save & Join when the selected solver harness
  // reports a definitive `ready: false`. A still-loading or unknown probe
  // (`undefined`) does NOT block — the not-ready *options* are disabled in
  // the select, so an operator cannot land on a known-not-ready harness, and
  // we avoid flashing a disabled button before the first probe resolves.
  const harnessReadinessBlocked =
    showSolverFields && selectedHarnessReadiness?.ready === false;

  const canSubmit =
    form.roles.length > 0 &&
    !submitMutation.isPending &&
    !costGateBlocked &&
    !harnessReadinessBlocked;

  return (
    <main data-testid="join-flow" data-manifest-cid={cid} style={pageStyle}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <span
          data-testid="join-flow-title"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '20px',
            fontWeight: 500,
            color: 'var(--fg)',
          }}
        >
          Join {manifest.name}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
          }}
        >
          {manifest.description}
        </span>
      </header>

      <section
        data-testid="join-flow-summary"
        style={cardStyle}
      >
        <span style={cardLabelStyle}>Manifest</span>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 12px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '12px',
            color: 'var(--fg-muted)',
          }}
        >
          <span>Contract</span>
          <span style={{ color: 'var(--fg)' }}>
            {manifest.contract.id} · {manifest.contract.version}
          </span>
          <span>Solution price</span>
          <span style={{ color: 'var(--fg)' }}>
            {formatWeiAmount(manifest.solutionPriceWei)}
          </span>
          <span>Verdict price</span>
          <span style={{ color: 'var(--fg)' }}>
            {formatWeiAmount(manifest.verdictPriceWei)}
          </span>
          <span>Open roles</span>
          <span data-testid="join-flow-open-roles" style={{ color: 'var(--fg)' }}>
            {openRoles.join(', ') || 'none'}
          </span>
          <span>Launcher</span>
          <span style={{ color: 'var(--fg)' }}>
            {truncateAddress(manifest.launcher.safeAddress)} · agentId{' '}
            {manifest.launcher.agentId}
          </span>
          <span>Manifest CID</span>
          <span
            data-testid="join-flow-manifest-cid"
            style={{
              color: 'var(--fg-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {cid}
          </span>
        </div>
      </section>

      <section style={cardStyle}>
        <span style={cardLabelStyle}>Roles</span>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${openRoles.length || 1}, 1fr)`,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-2)',
            overflow: 'hidden',
          }}
        >
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
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  background: active ? 'var(--bg)' : 'transparent',
                  color: active ? 'var(--fg)' : 'var(--fg-muted)',
                  borderRight:
                    idx < openRoles.length - 1
                      ? '1px solid var(--border)'
                      : 'none',
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleRole(role)}
                    aria-label={role === 'solver' ? 'Solver' : 'Evaluator'}
                    style={{ accentColor: 'var(--accent-sky)', width: '14px', height: '14px' }}
                  />
                  <span style={{ fontSize: '14px', fontWeight: 500 }}>
                    {role === 'solver' ? 'Solver' : 'Evaluator'}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    color: active ? 'var(--fg-muted)' : 'var(--fg-dim)',
                    paddingLeft: '22px',
                  }}
                >
                  {role === 'solver'
                    ? 'attempt tasks; submit solutions'
                    : 'verify solutions submitted by other operators'}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {showSolverFields && (
        <section data-testid="join-flow-solver-fields" style={cardStyle}>
          <span style={cardLabelStyle}>Solver configuration</span>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={fieldLabelStyle}>Harness</span>
              <select
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
                style={selectStyle}
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
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '11px',
                    color: 'var(--fg-muted)',
                  }}
                >
                  {HERMES_AGENT_DESCRIPTION}
                </span>
              )}
              {selectedHarnessReadiness?.ready === false && (
                <div
                  data-testid="join-harness-not-ready"
                  data-harness={form.harness}
                  role="status"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    padding: '10px 12px',
                    border: '1px solid var(--break-red)',
                    borderRadius: 'var(--radius-2)',
                    background: 'var(--bg)',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '11px',
                    color: 'var(--fg)',
                  }}
                >
                  <span style={{ color: 'var(--break-red)' }}>
                    {harnessDisplayName(form.harness)} is not ready
                    {selectedHarnessReadiness.reason
                      ? `: ${selectedHarnessReadiness.reason}`
                      : ''}
                  </span>
                  {selectedHarnessReadiness.nextStep && (
                    <span
                      data-testid="join-harness-not-ready-next-step"
                      style={{ color: 'var(--fg-muted)' }}
                    >
                      {selectedHarnessReadiness.nextStep.description}
                      {selectedHarnessReadiness.nextStep.cli
                        ? ` (${selectedHarnessReadiness.nextStep.cli})`
                        : ''}
                    </span>
                  )}
                  {selectedHarnessReadiness.nextStep?.url && (
                    <a
                      href={selectedHarnessReadiness.nextStep.url}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="join-harness-not-ready-url"
                      style={{ color: 'var(--accent-sky)' }}
                    >
                      {selectedHarnessReadiness.nextStep.url}
                    </a>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={fieldLabelStyle}>Model</span>
              <select
                aria-label="Model"
                data-testid="join-model-select"
                value={form.model}
                onChange={(e) => {
                  setForm({ ...form, model: e.target.value });
                  setHighCostAcknowledged(false);
                }}
                style={selectStyle}
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
            harness={form.harness}
            modelId={form.model}
            testIdPrefix="join-flow-cost"
          />

          {requiresCostConfirmation && (
            <label
              data-testid="join-flow-cost-confirmation"
              data-cost-confirmation-checked={highCostAcknowledged ? 'true' : 'false'}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '12px 14px',
                border: '1px solid var(--break-red)',
                borderRadius: 'var(--radius-2)',
                background: 'var(--bg)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '12px',
                color: 'var(--fg)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                data-testid="join-flow-cost-confirmation-checkbox"
                checked={highCostAcknowledged}
                onChange={(e) => setHighCostAcknowledged(e.target.checked)}
                style={{ accentColor: 'var(--break-red)', marginTop: '2px', width: '14px', height: '14px' }}
                aria-label="I understand the per-task cost and have a budget for this"
              />
              <span>
                I understand — I have a budget for this. The selected model is estimated at more than $1
                per task; I am responsible for the API spend on my own provider key.
              </span>
            </label>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={fieldLabelStyle}>Plugins</span>
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
        </section>
      )}

      {showEvaluatorInfo && !showSolverFields && (
        <section data-testid="join-flow-evaluator-info" style={cardStyle}>
          <span style={cardLabelStyle}>Evaluator configuration</span>
          <p
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg-muted)',
              margin: 0,
            }}
          >
            The evaluator harness is bound to{' '}
            <code style={{ color: 'var(--fg)' }}>
              {manifest.contract.evaluationFunction.implementation}
            </code>{' '}
            by the manifest's contract; no operator selection required.
          </p>
        </section>
      )}

      {showEvaluatorInfo && showSolverFields && (
        <section data-testid="join-flow-evaluator-info" style={cardStyle}>
          <span style={cardLabelStyle}>Evaluator binding</span>
          <p
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '12px',
              color: 'var(--fg-muted)',
              margin: 0,
            }}
          >
            Evaluator harness is bound to{' '}
            <code style={{ color: 'var(--fg)' }}>
              {manifest.contract.evaluationFunction.implementation}
            </code>{' '}
            by the manifest. The fields above only configure the solver role.
          </p>
        </section>
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
          style={{
            color: 'var(--break-red)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '13px',
            margin: 0,
          }}
        >
          {submitError}
        </p>
      )}

      <footer
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <button
          type="button"
          data-testid="join-flow-cancel"
          onClick={() => navigate('/operator#solvernets')}
          style={ghostButtonStyle}
        >
          Cancel
        </button>
        <button
          type="button"
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
          style={{
            ...ghostButtonStyle,
            background: canSubmit ? 'var(--accent-sky)' : 'transparent',
            color: canSubmit ? 'var(--bg-sunken)' : 'var(--fg-dim)',
            border: `1px solid ${canSubmit ? 'var(--accent-sky)' : 'var(--border)'}`,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {submitMutation.isPending ? 'Joining…' : 'Join SolverNet'}
        </button>
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
            data-testid="join-flow-retry"
            onClick={onRetry}
            style={ghostButtonStyle}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          data-testid="join-flow-back"
          onClick={onBack}
          style={ghostButtonStyle}
        >
          Back
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
  maxWidth: '880px',
  margin: '0 auto',
};

const mutedTextStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  color: 'var(--fg-muted)',
  margin: 0,
};

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const cardLabelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
};

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  padding: '10px 12px',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '14px',
  color: 'var(--fg)',
};

const ghostButtonStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '13px',
  padding: '8px 16px',
  background: 'transparent',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-2)',
  cursor: 'pointer',
};
