import { useState, type FormEvent, type JSX } from 'react';
import type {
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
} from '../../../../../api/contract/index.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { cn } from '../../lib/utils.js';
import { ensureCompletedStep } from './draft-helpers.js';
import { FieldShell, StepNav, StepShell } from './StepShell.js';

/**
 * Step 1 of the Create wizard — name + description.
 *
 * Validation: both fields non-empty (after trim). Errors surface inline
 * when the operator attempts Next. On valid Next, the parent's
 * `onAdvance` is called with the new patch; the parent owns the actual
 * `api.solvernets.updateDraft` call so a single network round-trip
 * advances the wizard.
 */

export interface Step1DefineProps {
  draft: DraftSolverNetRecord;
  /**
   * Apply a patch to the draft (parent calls `api.solvernets.updateDraft`)
   * and advance to the next step on success. The parent surfaces network
   * errors via `error`.
   */
  onAdvance: (patch: DraftSolverNetRecordPatch) => Promise<void> | void;
  busy?: boolean;
  error?: string | null;
}

const textareaBase =
  'flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[13px] text-foreground placeholder:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export function Step1Define({
  draft,
  onAdvance,
  busy,
  error,
}: Step1DefineProps): JSX.Element {
  const [name, setName] = useState(draft.name ?? '');
  const [description, setDescription] = useState(draft.description ?? '');
  const [touched, setTouched] = useState(false);

  const nameError = touched && name.trim().length === 0 ? 'Name is required.' : null;
  const descriptionError =
    touched && description.trim().length === 0 ? 'Description is required.' : null;

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    setTouched(true);
    if (name.trim().length === 0 || description.trim().length === 0) return;
    await onAdvance({
      name: name.trim(),
      description: description.trim(),
      completedSteps: ensureCompletedStep(draft.completedSteps, 'define'),
    });
  };

  return (
    <StepShell
      step={1}
      title="Name your SolverNet"
      blurb="Pick a short, recognisable name and describe what kind of knowledge work this SolverNet directs operators toward."
      error={error}
      footer={
        <StepNav
          onNext={() => {
            void submit();
          }}
          nextDisabled={
            name.trim().length === 0 || description.trim().length === 0
          }
          busy={busy}
        />
      }
    >
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
        className="flex flex-col gap-4"
      >
        <FieldShell
          label="Name"
          error={nameError}
          helperText="Shown in the registry catalog and the operator opt-in cards."
        >
          <Input
            data-testid="launcher-create-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Polymarket forecasts"
            className={cn(nameError && 'border-break-red')}
            disabled={busy}
          />
        </FieldShell>

        <FieldShell
          label="Description"
          error={descriptionError}
          helperText="One or two sentences. Operators read this when deciding whether to opt in."
        >
          <textarea
            data-testid="launcher-create-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="Forecast resolved Polymarket outcomes; rewarded by Brier score on verified resolutions."
            className={cn(
              textareaBase,
              'min-h-[96px] resize-y',
              descriptionError && 'border-break-red',
            )}
            disabled={busy}
          />
        </FieldShell>

        {/* Hidden submit so Enter inside an input fires the form */}
        <Button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </StepShell>
  );
}
