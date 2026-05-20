import type winston from 'winston';

export class GoogleChatNotifier {
  constructor(
    private webhookUrl: string | undefined,
    private logger: winston.Logger
  ) {}

  /**
   * Fire-and-forget notification. Never throws — failures are logged and swallowed.
   */
  async notify(text: string, severity: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    if (!this.webhookUrl) return;

    const emoji = severity === 'error' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
    const body = JSON.stringify({ text: `${emoji} [TMS-Bot] ${text}` });

    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body,
      });
      if (!res.ok) {
        this.logger.warn('Google Chat notification non-2xx', { status: res.status, severity });
      }
    } catch (err) {
      this.logger.warn('Google Chat notification error', { error: (err as Error).message, severity });
    }
  }
}
