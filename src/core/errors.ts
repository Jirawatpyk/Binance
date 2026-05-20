export class BotError extends Error {
  constructor(message: string, public context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class LoginFailedError extends BotError {}
export class SelectorNotFoundError extends BotError {}
export class TranslatorNotFoundError extends BotError {}
export class AssignmentFailedError extends BotError {}
export class ConfigValidationError extends BotError {}
export class LockHeldError extends BotError {}
