import type {
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
} from '../../../../../api/contract/index.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Separator } from '../../components/ui/separator.js';
import { cn } from '../../lib/utils.js';
import { ensureCompletedStep } from './draft-helpers.js';
import { StepNav, StepShell } from './StepShell.js';
import { PREDICTION_V1_TEMPLATE, type CreateWizardTemplate } from './templates.js';

import type { JSX } from 'react';

/**
 * Step 2 — Review the contract template the SolverNet will pin.
 *
 * Read-only: the operator confirms by clicking Next, and we persist
 * `templateContractId` + `templateContractVersion` onto the draft. The
 * active template is chosen by the wizard parent via the `?template=`
 * URL parameter (see `LauncherCreate.tsx`); each template ships in
 * `templates.ts` as a static mirror of the SDK's canonical contract.
 * See `templates.ts` for the drift policy.
 */

export interface Step2ReviewContractProps {
  draft: DraftSolverNetRecord;
  /**
   * Active template. Defaults to {@link PREDICTION_V1_TEMPLATE} so existing
   * tests render without explicitly threading a template through; the wizard
   * always passes the URL-selected template explicitly.
   */
  template?: CreateWizardTemplate;
  onAdvance: (patch: DraftSolverNetRecordPatch) => Promise<void> | void;
  onBack: () => void;
  busy?: boolean;
  error?: string | null;
}

const eyebrow =
  'font-mono text-[11px] uppercase tracking-[0.14em] text-fg-dim';

export function Step2ReviewContract({
  draft,
  template = PREDICTION_V1_TEMPLATE,
  onAdvance,
  onBack,
  busy,
  error,
}: Step2ReviewContractProps): JSX.Element {
  const advance = (): void => {
    void onAdvance({
      templateContractId: template.id,
      templateContractVersion: template.version,
      completedSteps: ensureCompletedStep(draft.completedSteps, 'reviewContract'),
    });
  };

  return (
    <StepShell
      step={2}
      title="Review contract"
      blurb="The contract defines the schemas, evaluation, and aggregation that this SolverNet will pin to its manifest."
      error={error}
      footer={<StepNav onBack={onBack} onNext={advance} busy={busy} />}
    >
      <Card
        data-testid="launcher-create-template"
        data-template-id={`${template.id}.${template.version}`}
      >
        <CardContent className="flex flex-col gap-4 p-6">
          <header className="flex flex-col gap-1">
            <span className={eyebrow}>
              {template.id}.{template.version}
            </span>
            <h2 className="m-0 font-serif text-[24px] font-normal text-foreground">
              {template.name}
            </h2>
            <p className="m-0 text-[13px] leading-relaxed text-fg-muted">
              {template.description}
            </p>
          </header>

          <SectionBlock title="Schemas">
            <ReadonlyRow
              label="Task"
              value={template.schemas.task.name}
              hint={template.schemas.task.description}
            />
            <ReadonlyRow
              label="Solution"
              value={template.schemas.solution.name}
              hint={template.schemas.solution.description}
            />
            <ReadonlyRow
              label="Verdict"
              value={template.schemas.verdict.name}
              hint={template.schemas.verdict.description}
            />
          </SectionBlock>

          <SectionBlock title="Evaluation function">
            <ReadonlyRow label="Id" value={template.evaluationFunction.id} mono />
            <ReadonlyRow
              label="Deterministic"
              value={template.evaluationFunction.deterministic ? 'yes' : 'no'}
            />
            <ReadonlyRow
              label="Inputs"
              value={template.evaluationFunction.inputs.join(', ')}
            />
            <ReadonlyRow label="Output" value={template.evaluationFunction.output} />
          </SectionBlock>

          <SectionBlock title="Aggregation function">
            <ReadonlyRow label="Id" value={template.aggregationFunction.id} mono />
            <ReadonlyRow
              label="Window"
              value={
                template.aggregationFunction.windowDays !== undefined
                  ? `${template.aggregationFunction.windowDays} days`
                  : '—'
              }
            />
            <ReadonlyRow label="Output" value={template.aggregationFunction.output} />
          </SectionBlock>

          <SectionBlock title="Claim policy defaults">
            <ReadonlyRow label="Mode" value={template.claimPolicyDefaults.mode} />
            <ReadonlyRow
              label="Max claims"
              value={String(template.claimPolicyDefaults.maxClaims)}
            />
            <ReadonlyRow
              label="Per operator"
              value={String(template.claimPolicyDefaults.maxClaimsPerOperator)}
            />
            <ReadonlyRow
              label="Lease TTL"
              value={`${template.claimPolicyDefaults.claimLeaseTtlSeconds}s`}
            />
          </SectionBlock>

          <SectionBlock title="Credential requirements">
            <CredentialList role="creator" creds={template.credentialRequirements.creator} />
            <CredentialList role="solver" creds={template.credentialRequirements.solver} />
            <CredentialList
              role="evaluator"
              creds={template.credentialRequirements.evaluator}
            />
          </SectionBlock>
        </CardContent>
      </Card>
    </StepShell>
  );
}

function SectionBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <Separator />
      <h3
        className={cn(
          'm-0 pt-2 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted',
        )}
      >
        {title}
      </h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function ReadonlyRow({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[140px_1fr] items-baseline gap-3">
      <span className="font-mono text-[11px] tracking-[0.06em] text-fg-dim">
        {label}
      </span>
      <span className="flex flex-col gap-0.5">
        <span
          className={cn(
            'text-[13px] text-foreground',
            mono ? 'font-mono' : 'font-sans',
          )}
        >
          {value}
        </span>
        {hint && (
          <span className="font-mono text-[12px] leading-relaxed text-fg-muted">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}

function CredentialList({
  role,
  creds,
}: {
  role: 'creator' | 'solver' | 'evaluator';
  creds: ReadonlyArray<{ id: string; kind: string; required: boolean; description: string }>;
}): JSX.Element {
  return (
    <div
      data-testid={`launcher-create-credentials-${role}`}
      className="flex flex-col gap-1.5"
    >
      <div className="font-mono text-[11px] capitalize tracking-[0.06em] text-fg-dim">
        {role}
      </div>
      {creds.length === 0 ? (
        <div className="text-[12px] text-fg-muted">None.</div>
      ) : (
        creds.map((cred) => (
          <div
            key={cred.id}
            className="flex flex-col gap-0.5 font-mono text-[12px] leading-relaxed"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-accent-sky">{cred.id}</span>
              <Badge variant="secondary">{cred.kind}</Badge>
              {cred.required && <Badge variant="warning">required</Badge>}
            </div>
            <div className="text-fg-muted">{cred.description}</div>
          </div>
        ))
      )}
    </div>
  );
}
