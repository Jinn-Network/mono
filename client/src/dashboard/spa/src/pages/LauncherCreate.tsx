import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type {
  BootstrapState,
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
} from '../../../../api/contract/index.js';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.js';
import { Step1Define } from './launcher-create/Step1Define.js';
import { Step2ReviewContract } from './launcher-create/Step2ReviewContract.js';
import { Step3ConfigureGenerator } from './launcher-create/Step3ConfigureGenerator.js';
import { Step4ConfigurePricing } from './launcher-create/Step4ConfigurePricing.js';
import { Step5ReviewLaunch } from './launcher-create/Step5ReviewLaunch.js';
import {
  DEFAULT_TEMPLATE_KEY,
  TEMPLATES_BY_KEY,
  type CreateWizardTemplate,
} from './launcher-create/templates.js';

/**
 * 5-step Create wizard at `/launcher/create`.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §10 + §17 Decision 10.
 *
 * Architecture:
 *   - The wizard owns a single `DraftSolverNetRecord` plus `step` state
 *     (1..5). Each step is a focused component that reads the draft and
 *     calls `onAdvance(patch)` on Next; the wizard PATCHes the draft via
 *     `api.solvernets.updateDraft` then bumps the step.
 *   - The URL stays `/launcher/create` — step is local state, not a route
 *     param. Per-step deep-linking is a follow-up if / when the operator
 *     ever needs it.
 *   - The active SolverNet template is selected via the
 *     `?template=<id>.<version>` query parameter (default
 *     `prediction.v1`). Unknown keys render an inline error rather than
 *     silently falling back. Each future SolverNet ships its own
 *     template entry in `templates.ts` and the team navigates to the
 *     corresponding URL — there is no community-discoverable picker UI.
 *   - The draftId is persisted to `localStorage` under
 *     `STORAGE_KEY` so a refresh resumes the same draft. If the stored
 *     draft has been deleted server-side (404), we drop the stale id and
 *     create a new one.
 */

const STORAGE_KEY = 'jinn.launcher-create.draftId.v1';

function readStoredDraftId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredDraftId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage unavailable (e.g. tests in node) — silent fallback
  }
}

interface FundingSafeQuery {
  master_address?: string;
  masterGas?: { balanceWei?: string };
}

/**
 * Read `?template=<id>.<version>` from the current URL. Returns the
 * template lookup key, or `null` when there is no `?template=` param
 * (the caller falls back to {@link DEFAULT_TEMPLATE_KEY}). Returns the
 * raw value even when unknown — the caller is responsible for surfacing
 * the unknown-template error.
 *
 * Hand-rolled rather than wouter's `useLocation` because wouter's hook
 * strips query strings; we need raw access via `window.location.search`.
 */
function readTemplateKey(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('template');
  return raw && raw.length > 0 ? raw : null;
}

export interface LauncherCreatePageProps {
  /**
   * Override the active template lookup key. Tests use this to drive
   * the wizard against a specific template without manipulating
   * `window.location`. Production renders without a prop and reads from
   * the URL.
   */
  templateKey?: string;
}

export function LauncherCreatePage({ templateKey }: LauncherCreatePageProps = {}): JSX.Element {
  const resolvedTemplateKey = templateKey ?? readTemplateKey() ?? DEFAULT_TEMPLATE_KEY;
  const template = useMemo<CreateWizardTemplate | null>(
    () => TEMPLATES_BY_KEY[resolvedTemplateKey] ?? null,
    [resolvedTemplateKey],
  );

  const [draft, setDraft] = useState<DraftSolverNetRecord | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const bootstrappingRef = useRef(false);

  // Fetch bootstrap state for Step 4's master Safe address + balance.
  const { data: bootstrap } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 30_000,
  });
  const { data: status } = useQuery<FundingSafeQuery>({
    queryKey: ['status'],
    queryFn: () => api.getStatus() as Promise<FundingSafeQuery>,
    refetchInterval: 30_000,
  });
  const fundingSafeAddress = bootstrap?.master_address ?? status?.master_address ?? null;
  const fundingSafeBalanceWei = status?.masterGas?.balanceWei ?? null;

  // On mount, load or create the draft. The ref guards against React's
  // dev-mode StrictMode double-invocation creating two drafts.
  useEffect(() => {
    if (bootstrappingRef.current) return;
    bootstrappingRef.current = true;

    let cancelled = false;
    const ensureDraft = async (): Promise<void> => {
      const stored = readStoredDraftId();
      if (stored) {
        try {
          const existing = await api.solvernets.getDraft(stored);
          if (cancelled) return;
          setDraft(existing);
          return;
        } catch {
          // Draft was deleted server-side — fall through to create.
          writeStoredDraftId(null);
        }
      }
      try {
        const created = await api.solvernets.createDraft();
        if (cancelled) return;
        writeStoredDraftId(created.draftId);
        setDraft(created);
      } catch (err) {
        if (cancelled) return;
        setBootstrapError(
          err instanceof Error ? err.message : 'Failed to create draft.',
        );
      }
    };
    void ensureDraft();
    return () => {
      cancelled = true;
    };
  }, []);

  const advance = async (patch: DraftSolverNetRecordPatch): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setStepError(null);
    try {
      const updated = await api.solvernets.updateDraft(draft.draftId, patch);
      setDraft(updated);
      setStep((current) => (current < 5 ? ((current + 1) as 1 | 2 | 3 | 4 | 5) : current));
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const updateInPlace = async (patch: DraftSolverNetRecordPatch): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setStepError(null);
    try {
      const updated = await api.solvernets.updateDraft(draft.draftId, patch);
      setDraft(updated);
    } catch (err) {
      setStepError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const back = (): void => {
    setStepError(null);
    setStep((current) => (current > 1 ? ((current - 1) as 1 | 2 | 3 | 4 | 5) : current));
  };

  const onLaunchFailure = (): void => {
    // Failure is shown inside Step 5; the wizard parent doesn't need to
    // do much here, but we clear the step-level error so the operator
    // can retry without seeing a stale message above the inline failure
    // banner.
    setStepError(null);
  };

  if (template === null) {
    return (
      <main
        data-testid="launcher-create-unknown-template"
        data-template-key={resolvedTemplateKey}
        className="mx-auto flex max-w-[720px] flex-col gap-4 p-6"
      >
        <h1 className="m-0 font-serif text-[28px] font-normal text-foreground">
          Unknown SolverNet template
        </h1>
        <Alert variant="blocking">
          <AlertDescription className="font-mono text-[13px]">
            No template registered for <code>{resolvedTemplateKey}</code>. Available keys:{' '}
            {Object.keys(TEMPLATES_BY_KEY)
              .map((k) => `?template=${k}`)
              .join(', ')}
            .
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  if (bootstrapError) {
    return (
      <main
        data-testid="launcher-create-bootstrap-error"
        className="mx-auto flex max-w-[720px] flex-col gap-4 p-6"
      >
        <h1 className="m-0 font-serif text-[28px] font-normal text-foreground">
          Couldn't start a new draft
        </h1>
        <Alert variant="blocking">
          <AlertTitle className="font-mono text-[12px]">Bootstrap error</AlertTitle>
          <AlertDescription className="font-mono text-[13px]">
            {bootstrapError}
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  if (!draft) {
    return (
      <main
        data-testid="launcher-create-loading"
        className="p-6 font-mono text-[13px] text-fg-muted"
      >
        Loading draft…
      </main>
    );
  }

  switch (step) {
    case 1:
      return (
        <Step1Define
          draft={draft}
          onAdvance={advance}
          busy={busy}
          error={stepError}
        />
      );
    case 2:
      return (
        <Step2ReviewContract
          draft={draft}
          template={template}
          onAdvance={advance}
          onBack={back}
          busy={busy}
          error={stepError}
        />
      );
    case 3:
      return (
        <Step3ConfigureGenerator
          draft={draft}
          template={template}
          onAdvance={advance}
          onBack={back}
          busy={busy}
          error={stepError}
        />
      );
    case 4:
      return (
        <Step4ConfigurePricing
          draft={draft}
          template={template}
          onAdvance={advance}
          onBack={back}
          fundingSafeAddress={fundingSafeAddress}
          fundingSafeBalanceWei={fundingSafeBalanceWei ?? null}
          busy={busy}
          error={stepError}
        />
      );
    case 5:
      return (
        <Step5ReviewLaunch
          draft={draft}
          template={template}
          onUpdateDraft={updateInPlace}
          onBack={back}
          onLaunchFailure={onLaunchFailure}
        />
      );
    default:
      // exhaustiveness guard
      return <Step1Define draft={draft} onAdvance={advance} busy={busy} error={stepError} />;
  }
}

// Re-export storage key for tests so they can seed / clear localStorage.
export const LAUNCHER_CREATE_STORAGE_KEY = STORAGE_KEY;
