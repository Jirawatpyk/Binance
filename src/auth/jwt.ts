/**
 * Read a JWT's `exp` claim as epoch milliseconds, or null if the token is
 * missing/malformed. Pure decode only — NO signature verification (we just want
 * the expiry to warn before the session dies).
 */
export function jwtExpiryMs(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
