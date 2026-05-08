import type {
  DraftSolverNetRecord,
  DraftSolverNetRecordPatch,
} from '../../api/types.js';
import { ensureCompletedStep } from './draft-helpers.js';
import { StepNav, StepShell } from './StepShell.js';
import { PREDICTION_V1_TEMPLATE, type CreateWizardTemplate } from './templates.js';

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
      <article
        data-testid="launcher-create-template"
        data-template-id={`${template.id}.${template.version}`}
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3)',
          padding: '20px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <header style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '11px',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
            }}
          >
            {template.id}.{template.version}
          </span>
          <h2
            style={{
              margin: 0,
              fontFamily: "'Instrument Serif', 'Times New Roman', serif",
              fontSize: '24px',
              fontWeight: 400,
              color: 'var(--fg)',
            }}
          >
            {template.name}
          </h2>
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px', lineHeight: 1.5 }}>
            {template.description}
          </p>
        </header>

        <SectionBlock title="Schemas">
          <ReadonlyRow label="Task" value={template.schemas.task.name} hint={template.schemas.task.description} />
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
          <ReadonlyRow label="Inputs" value={template.evaluationFunction.inputs.join(', ')} />
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
          <CredentialList role="evaluator" creds={template.credentialRequirements.evaluator} />
        </SectionBlock>
      </article>
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
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        paddingTop: '12px',
        borderTop: '1px solid var(--border)',
      }}
    >
      <h3
        style={{
          margin: 0,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
        }}
      >
        {title}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>{children}</div>
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
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 1fr',
        gap: '12px',
        alignItems: 'baseline',
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          color: 'var(--fg-dim)',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span
          style={{
            fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
            fontSize: '13px',
            color: 'var(--fg)',
          }}
        >
          {value}
        </span>
        {hint && (
          <span
            style={{
              fontSize: '12px',
              color: 'var(--fg-muted)',
              fontFamily: "'JetBrains Mono', monospace",
              lineHeight: 1.5,
            }}
          >
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
      style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '11px',
          color: 'var(--fg-dim)',
          letterSpacing: '0.06em',
          textTransform: 'capitalize',
        }}
      >
        {role}
      </div>
      {creds.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>None.</div>
      ) : (
        creds.map((cred) => (
          <div
            key={cred.id}
            style={{
              fontSize: '12px',
              color: 'var(--fg)',
              fontFamily: "'JetBrains Mono', monospace",
              lineHeight: 1.5,
            }}
          >
            <span style={{ color: 'var(--accent-sky)' }}>{cred.id}</span>
            <span style={{ color: 'var(--fg-dim)' }}> · {cred.kind}</span>
            {cred.required && <span style={{ color: 'var(--wane)' }}> · required</span>}
            <div style={{ color: 'var(--fg-muted)' }}>{cred.description}</div>
          </div>
        ))
      )}
    </div>
  );
}
