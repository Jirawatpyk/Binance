import { describe, it, expect } from 'vitest';
import { jwtExpiryMs } from '../../src/auth/jwt.js';

// A real TMS auth_token (HS256) with exp=1779940699 in its payload.
const TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEwNSwiZW1haWwiOiJiaW5hbmNlQGVxaG8uY29tIiwidXNlcm5hbWUiOiJiaW5hbmNlQGVxaG8uY29tIiwicm9sZXMiOlsiQUdFTkNZX01BTkFHRVIiXSwiaWF0IjoxNzc5ODk3NDk5LCJleHAiOjE3Nzk5NDA2OTl9.Io8o4VH46KS5kpFcENH5Jsq86kARfL-h7Zvkl5z912Q';

describe('jwtExpiryMs', () => {
  it('reads exp from a real JWT and returns epoch ms', () => {
    expect(jwtExpiryMs(TOKEN)).toBe(1779940699 * 1000);
  });

  it('returns null for null/empty/garbage', () => {
    expect(jwtExpiryMs(null)).toBeNull();
    expect(jwtExpiryMs(undefined)).toBeNull();
    expect(jwtExpiryMs('')).toBeNull();
    expect(jwtExpiryMs('not-a-jwt')).toBeNull();
    expect(jwtExpiryMs('a.b.c')).toBeNull(); // segment not valid base64-json
  });

  it('returns null when payload has no numeric exp', () => {
    const noExp = 'h.' + Buffer.from(JSON.stringify({ sub: 1 })).toString('base64url') + '.s';
    expect(jwtExpiryMs(noExp)).toBeNull();
  });
});
