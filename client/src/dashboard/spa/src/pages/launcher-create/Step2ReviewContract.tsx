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
 * Day-1 there is one template (`prediction.v1`); this step is read-only.
 * Forward-only: the operator just confirms by clicking Next, and we
 * persist `templateContractId` + `templateContractVersion` onto the draft.
 *
 * The template body comes from `templates.ts` (a static mirror of the
 * SDK's `PREDICTION_V1_SOLVER_NET_CONTRACT`); see that file for the
 * drift policy.
 */

export interface Step2ReviewContractProps {
  draft: DraftSolverNetRecord;
  onAdvance: (patch: DraftSolverNetRecordPatch) => Promise<void> | void;
  onBack: () => void;
  busy?: boolean;
  error?: string | null;
}

const TEMPLATE: CreateWizardTemplate = PREDICTION_V1_TEMPLATE;

export function Step2ReviewContract({
  draft,
  onAdvance,
  onBack,
  busy,
  error,
}: Step2ReviewContractProps): JSX.Element {
  const advance = (): void => {
    void onAdvance({
      templateContractId: TEMPLATE.id,
      templateContractVersion: TEMPLATE.version,
      completedSteps: ensureCompletedStep(draft.completedSteps, 'reviewContract'),
    });
  };

  return (
    <StepShell
      step={2}
      title="Review contract"
      blurb="The contract defines the schemas, evaluation, and aggregation that this SolverNet will pin to its manifest. Day-1 only one template ships."
      error={error}
      footer={<StepNav onBack={onBack} onNext={advance} busy={busy} />}
    >
      <article
        data-testid="launcher-create-template"
        data-template-id={`${TEMPLATE.id}.${TEMPLATE.version}`}
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
            {TEMPLATE.id}.{TEMPLATE.version}
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
            {TEMPLATE.name}
          </h2>
          <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '13px', lineHeight: 1.5 }}>
            {TEMPLATE.description}
          </p>
        </header>

        <SectionBlock title="Schemas">
          <ReadonlyRow label="Task" value={TEMPLATE.schemas.task.name} hint={TEMPLATE.schemas.task.description} />
          <ReadonlyRow
            label="Solution"
            value={TEMPLATE.schemas.solution.name}
            hint={TEMPLATE.schemas.solution.description}
          />
          <ReadonlyRow
            label="Verdict"
            value={TEMPLATE.schemas.verdict.name}
            hint={TEMPLATE.schemas.verdict.description}
          />
        </SectionBlock>

        <SectionBlock title="Evaluation function">
          <ReadonlyRow label="Id" value={TEMPLATE.evaluationFunction.id} mono />
          <ReadonlyRow
            label="Deterministic"
            value={TEMPLATE.evaluationFunction.deterministic ? 'yes' : 'no'}
          />
          <ReadonlyRow label="Inputs" value={TEMPLATE.evaluationFunction.inputs.join(', ')} />
          <ReadonlyRow label="Output" value={TEMPLATE.evaluationFunction.output} />
        </SectionBlock>

        <SectionBlock title="Aggregation function">
          <ReadonlyRow label="Id" value={TEMPLATE.aggregationFunction.id} mono />
          <ReadonlyRow
            label="Window"
            value={
              TEMPLATE.aggregationFunction.windowDays !== undefined
                ? `${TEMPLATE.aggregationFunction.windowDays} days`
                : '—'
            }
          />
          <ReadonlyRow label="Output" value={TEMPLATE.aggregationFunction.output} />
        </SectionBlock>

        <SectionBlock title="Claim policy defaults">
          <ReadonlyRow label="Mode" value={TEMPLATE.claimPolicyDefaults.mode} />
          <ReadonlyRow
            label="Max claims"
            value={String(TEMPLATE.claimPolicyDefaults.maxClaims)}
          />
          <ReadonlyRow
            label="Per operator"
            value={String(TEMPLATE.claimPolicyDefaults.maxClaimsPerOperator)}
          />
          <ReadonlyRow
            label="Lease TTL"
            value={`${TEMPLATE.claimPolicyDefaults.claimLeaseTtlSeconds}s`}
          />
        </SectionBlock>

        <SectionBlock title="Credential requirements">
          <CredentialList role="creator" creds={TEMPLATE.credentialRequirements.creator} />
          <CredentialList role="solver" creds={TEMPLATE.credentialRequirements.solver} />
          <CredentialList role="evaluator" creds={TEMPLATE.credentialRequirements.evaluator} />
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
