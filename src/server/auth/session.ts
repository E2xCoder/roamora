/**
 * Stateless signed-cookie sessions.
 *
 * No session table and no external identity provider: for a single-user
 * personal deployment an HMAC-signed cookie is sufficient and free. The
 * payload carries only issue and expiry timestamps — there is nothing
 * sensitive to leak if the cookie is read.
 *
 * Built on Web Crypto rather than `node:crypto` because `middleware.ts` runs
 * in the Edge runtime, where Node's crypto module is unavailable. Web Crypto
 * exists in both runtimes, so the same code verifies sessions in middleware
 * and in route handlers.
 */

export const SESSION_COOKIE = "roamora_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  /** Issued at (epoch seconds). */
  iat: number;
  /** Expires at (epoch seconds). */
  exp: number;
}

const encoder = new TextEncoder();

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromString(input: string): string {
  return base64urlFromBytes(encoder.encode(input));
}

function bytesFromBase64url(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64urlFromBytes(new Uint8Array(signature));
}

/** Constant-time comparison; Web Crypto has no timingSafeEqual equivalent. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSession(
  secret: string
): Promise<{ value: string; maxAge: number }> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { iat: now, exp: now + MAX_AGE_SECONDS };
  const body = base64urlFromString(JSON.stringify(payload));
  const signature = await sign(body, secret);
  return { value: `${body}.${signature}`, maxAge: MAX_AGE_SECONDS };
}

export async function verifySession(
  token: string | undefined,
  secret: string
): Promise<boolean> {
  if (!token) return false;

  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!signature) return false;

  let expected: string;
  try {
    expected = await sign(body, secret);
  } catch {
    return false;
  }

  if (!constantTimeEquals(signature, expected)) return false;

  try {
    const json = new TextDecoder().decode(bytesFromBase64url(body));
    const payload = JSON.parse(json) as SessionPayload;
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
