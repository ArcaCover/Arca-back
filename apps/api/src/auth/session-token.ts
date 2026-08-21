import { SignJWT, jwtVerify } from 'jose';

/** El token vive 24h: es una llave de sesión anónima, no una cuenta. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

const ALGORITHM = 'HS256';
const ISSUER = 'arca-api';
const AUDIENCE = 'arca-assessment';

export type SessionClaims = { scan_id: string };

function keyFrom(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Firma un token que solo autoriza a operar sobre este scan. Nada sensible viaja adentro. */
export async function issueSessionToken(scanId: string, secret: string): Promise<string> {
  return new SignJWT({ scan_id: scanId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(keyFrom(secret));
}

/** Devuelve los claims o null: un token inválido, vencido o de otro emisor no se distingue. */
export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keyFrom(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALGORITHM],
    });
    const scanId = payload['scan_id'];
    return typeof scanId === 'string' && scanId.length > 0 ? { scan_id: scanId } : null;
  } catch {
    return null;
  }
}

/** Extrae el token de un header Authorization: Bearer <token>. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}
