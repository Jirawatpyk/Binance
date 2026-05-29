import { describe, it, expect } from 'vitest';
import { classifyAuthState } from '../../src/auth/auth-state.js';

const now = Date.parse('2026-05-28T12:00:00.000Z');
const future = Date.parse('2026-05-28T18:00:00.000Z'); // token still valid
const past = Date.parse('2026-05-28T06:00:00.000Z'); // token expired

describe('classifyAuthState', () => {
  it('is VALID when the board renders (no login redirect)', () => {
    expect(classifyAuthState({ loginDetected: false, authExpMs: future, now })).toBe('VALID');
  });

  it('is VALID when the board renders even if we could not read the token', () => {
    // The SPA refreshed and rendered the board; our localStorage read is not the
    // authority once the board is up.
    expect(classifyAuthState({ loginDetected: false, authExpMs: null, now })).toBe('VALID');
  });

  it('is RETRY when /login appears but the access token is still valid (transient)', () => {
    // The false-positive that paused the bot: a momentary /login redirect during a
    // TMS hiccup while auth_token is still live. Must NOT be treated as EXPIRED.
    expect(classifyAuthState({ loginDetected: true, authExpMs: future, now })).toBe('RETRY');
  });

  it('is EXPIRED when /login appears and the access token is in the past', () => {
    expect(classifyAuthState({ loginDetected: true, authExpMs: past, now })).toBe('EXPIRED');
  });

  it('is EXPIRED when /login appears and there is no readable token', () => {
    expect(classifyAuthState({ loginDetected: true, authExpMs: null, now })).toBe('EXPIRED');
  });

  it('is EXPIRED at the exact expiry instant (exp === now is not "valid")', () => {
    expect(classifyAuthState({ loginDetected: true, authExpMs: now, now })).toBe('EXPIRED');
  });
});
