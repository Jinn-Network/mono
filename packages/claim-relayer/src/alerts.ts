import type { Address } from 'viem';
import { errorToLogMessage, redactSecrets } from './redact.js';

export type AlertCondition = 'not-ready' | 'lastError' | 'staleCheckpoint';

export interface AlertEvent {
  condition: AlertCondition;
  message: string;
  checkpoint: string;
  consecutivePollsWithoutProgress: number;
  signerAddress: Address;
  ts: string;
}

export interface AlertConditions {
  notReady: boolean;
  lastError: boolean;
  staleCheckpoint: boolean;
}

export interface AlertContext {
  checkpoint: string;
  consecutivePollsWithoutProgress: number;
  lastErrorMessage: string | null;
}

/**
 * Edge-triggered, de-duped health notifier. Fires a single alert when a
 * condition transitions false->true, a single "recovered" event on
 * true->false, and stays silent while a condition persists. The three
 * conditions are tracked independently. A failing webhook never throws into
 * the caller's poll loop.
 */
export class AlertNotifier {
  private readonly webhookUrl: string | undefined;
  private readonly signerAddress: Address;
  private readonly fetchFn: typeof fetch;
  private warnedNoWebhook = false;
  private readonly lastState: AlertConditions = {
    notReady: false,
    lastError: false,
    staleCheckpoint: false,
  };

  constructor(args: {
    webhookUrl: string | undefined;
    signerAddress: Address;
    fetchFn?: typeof fetch;
  }) {
    this.webhookUrl = args.webhookUrl;
    this.signerAddress = args.signerAddress;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async evaluate(conditions: AlertConditions, ctx: AlertContext): Promise<void> {
    await this.transition('not-ready', 'notReady', conditions.notReady, ctx, 'relayer not ready');
    await this.transition('lastError', 'lastError', conditions.lastError, ctx, ctx.lastErrorMessage ?? 'lastError set');
    await this.transition(
      'staleCheckpoint',
      'staleCheckpoint',
      conditions.staleCheckpoint,
      ctx,
      `checkpoint stale: ${ctx.consecutivePollsWithoutProgress} consecutive retryable-blocked polls`,
    );
  }

  private async transition(
    condition: AlertCondition,
    stateKey: keyof AlertConditions,
    active: boolean,
    ctx: AlertContext,
    rawMessage: string,
  ): Promise<void> {
    const previous = this.lastState[stateKey];
    if (active === previous) return;
    this.lastState[stateKey] = active;

    const message = active
      ? redactSecrets(rawMessage)
      : redactSecrets(`${condition} recovered`);
    await this.fire({
      condition,
      message,
      checkpoint: ctx.checkpoint,
      consecutivePollsWithoutProgress: ctx.consecutivePollsWithoutProgress,
      signerAddress: this.signerAddress,
      ts: new Date().toISOString(),
    });
  }

  private async fire(event: AlertEvent): Promise<void> {
    if (this.webhookUrl === undefined) {
      const prefix = this.warnedNoWebhook
        ? ''
        : '[claim-relayer] alert webhook not configured (JINN_CLAIM_RELAYER_ALERT_WEBHOOK_URL); health alerts are log-only. ';
      this.warnedNoWebhook = true;
      console.error(`${prefix}ALERT ${event.condition}: ${event.message}`);
      return;
    }

    try {
      await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
    } catch (error: unknown) {
      // A failing webhook must never throw into the poll loop.
      console.error(`[claim-relayer] alert webhook POST failed: ${errorToLogMessage(error)}`);
    }
  }
}
