import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed-cookie sessions.
 *
 * No session table and no external identity provider: for a single-user
 * personal deployment an HMAC-signed cookie is sufficient and free. The
 * payload carries only an issue and expiry timestamp — there is nothing
 * sensitive to leak if the cookie is read.
 *
 * This module is deliberately free of `server-only` and of any Node-specific
 * import beyond `node:crypto`, so the Edge middleware can verify sessions too.
 */

export const SESSION_COOKIE = "roamora_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  /** Issued at (epoch seconds). */
  iat: number;
  /** Expires at (epoch seconds). */
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(data: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(data).digest());
}

export function createSession(secret: string): {
  value: string;
  maxAge: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { iat: now, exp: now + MAX_AGE_SECONDS };
  const body = base64url(JSON.stringify(payload));
  return { value: `${body}.${sign(body, secret)}`, maxAge: MAX_AGE_SECONDS };
}

export function verifySession(
  token: string | undefined,
  secret: string
): boolean {
  if (!token) return false;

  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const payload = JSON.parse(fromBase64url(body).toString()) as SessionPayload;
    return typeof payload.exp === "number" && payload.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/**
 * Whether authentication is configured at all.
 *
 * If the secret or the password hash is missing the app runs unprotected —
 * necessary so a fresh clone is usable — but the UI states this explicitly
 * rather than implying the instance is secured (§98).
 */
export function isAuthConfigured(
  secret: string | undefined,
  passwordHash: string | undefined
): boolean {
  return Boolean(secret && secret.length >= 16 && passwordHash);
}
