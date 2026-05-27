import { describe, it, expect } from 'vitest';
import { isBrowserDeadError } from '../../src/core/recovery-utils.js';

describe('isBrowserDeadError', () => {
  it('detects "Target closed"', () => {
    expect(isBrowserDeadError(new Error('Target closed'))).toBe(true);
  });
  it('detects "Target page, context or browser has been closed"', () => {
    expect(isBrowserDeadError(new Error('Target page, context or browser has been closed'))).toBe(true);
  });
  it('detects "Browser has been closed"', () => {
    expect(isBrowserDeadError(new Error('Browser has been closed'))).toBe(true);
  });
  it('detects a BrowserContext closed message', () => {
    expect(isBrowserDeadError(new Error('BrowserContext has been closed'))).toBe(true);
  });
  it('false for an ordinary error', () => {
    expect(isBrowserDeadError(new Error('TranslatorNotFoundError: x not in popup'))).toBe(false);
  });
  it('false for non-Error input', () => {
    expect(isBrowserDeadError('nope')).toBe(false);
    expect(isBrowserDeadError(undefined)).toBe(false);
  });
});
