import { useState, useEffect, type JSX } from 'react';
import { api } from '../../api/client.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';

/**
 * Runs `GET /api/hermes/doctor` and presents three states:
 *
 * - `not-installed` — binary not found; shows curl-pipe-bash install command +
 *    retry button.
 * - `config-issue` — binary present but exits non-zero; shows stderr diagnostic
 *    and instructions to run `hermes model` / `hermes setup`.
 * - `ok` — binary present and exits 0; calls onSuccess() immediately.
 *
 * `onCancel` returns the user to the harness selector.
 */

export type HermesPrecheckState =
  | 'checking'
  | 'not-installed'
  | 'config-issue'
  | 'network-error'
  | 'ok';

export interface HermesPrecheckPanelProps {
  onSuccess: () => void;
  onCancel: () => void;
}

const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash';

const codeBlockClass =
  'm-0 overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-[var(--bg-sunken)] p-2.5 font-mono text-[12px] text-foreground';

export function HermesPrecheckPanel({
  onSuccess,
  onCancel,
}: HermesPrecheckPanelProps): JSX.Element {
  const [state, setState] = useState<HermesPrecheckState>('checking');
  const [stderr, setStderr] = useState<string>('');
  const [networkError, setNetworkError] = useState<string>('');

  const runPrecheck = (): void => {
    setState('checking');
    api
      .hermesDoctor()
      .then((r) => {
        if (!r.installed) {
          setState('not-installed');
          return;
        }
        if (r.exitCode !== 0) {
          setState('config-issue');
          setStderr(r.stderr);
          return;
        }
        setState('ok');
        onSuccess();
      })
      .catch((err: unknown) => {
        // Distinguish network/transport errors from "Hermes not installed".
        // Falling through to not-installed would tell operators to reinstall
        // a Hermes that's already there when the daemon API is unreachable.
        setNetworkError(err instanceof Error ? err.message : String(err));
        setState('network-error');
      });
  };

  const copyInstallCommand = (): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(INSTALL_COMMAND).catch(() => {
        // Clipboard write rejected (insecure context, permission denied).
        // Silent — the operator can still manually select the text.
      });
    }
  };

  useEffect(() => {
    runPrecheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'checking') {
    return (
      <Card
        data-testid="hermes-precheck-checking"
        className="flex flex-col gap-3 p-4"
      >
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          Hermes install check
        </span>
        <p className="m-0 font-mono text-[12px] text-[var(--fg-muted)]">
          Checking hermes install…
        </p>
      </Card>
    );
  }

  if (state === 'not-installed') {
    return (
      <Card
        data-testid="hermes-precheck-not-installed"
        className="flex flex-col gap-3 p-4"
      >
        <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          Hermes Agent not installed
        </span>
        <p className="m-0 font-mono text-[13px] text-foreground">
          Hermes Agent is not installed on this machine. Run this command in
          your terminal, then click Retry:
        </p>
        <div className="flex items-start gap-2">
          <pre className={`${codeBlockClass} flex-1`}>{INSTALL_COMMAND}</pre>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="hermes-precheck-copy-install"
            aria-label="Copy install command"
            onClick={copyInstallCommand}
          >
            Copy
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="hermes-precheck-retry"
            onClick={runPrecheck}
          >
            I&apos;ve installed Hermes — retry precheck
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="hermes-precheck-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  if (state === 'network-error') {
    return (
      <Alert
        data-testid="hermes-precheck-network-error"
        variant="blocking"
        className="flex flex-col gap-3 border-l-0 border border-destructive p-4"
      >
        <AlertTitle className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          Hermes precheck failed
        </AlertTitle>
        <AlertDescription className="font-mono text-[13px] text-foreground">
          Could not reach the daemon API to run <code>hermes doctor</code>.
          Check that the daemon is running and the UI token is valid.
        </AlertDescription>
        {networkError ? <pre className={codeBlockClass}>{networkError}</pre> : null}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="hermes-precheck-retry"
            onClick={runPrecheck}
          >
            Retry precheck
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="hermes-precheck-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </Alert>
    );
  }

  if (state === 'config-issue') {
    return (
      <Alert
        data-testid="hermes-precheck-config-issue"
        variant="warning"
        className="flex flex-col gap-3 border-l-0 border border-[var(--severity-warning-fg)] p-4"
      >
        <AlertTitle className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--fg-muted)]">
          Hermes Agent configuration issue
        </AlertTitle>
        <AlertDescription className="font-mono text-[13px] text-foreground">
          Hermes is installed but reports configuration issues:
        </AlertDescription>
        <pre className={codeBlockClass}>{stderr || '(no diagnostic output)'}</pre>
        <p className="m-0 font-mono text-[12px] text-[var(--fg-muted)]">
          Run <code>hermes model</code> or <code>hermes setup</code> to
          configure a provider, then retry.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            data-testid="hermes-precheck-retry"
            onClick={runPrecheck}
          >
            Retry precheck
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="hermes-precheck-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </Alert>
    );
  }

  // state === 'ok' — onSuccess() already called in the effect; render nothing
  return <></>;
}
