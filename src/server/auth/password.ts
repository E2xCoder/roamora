import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * `promisify(scrypt)` resolves to the three-argument overload, which drops the
 * options parameter we need for the cost factors. Wrapping it by hand keeps
 * them typed.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt is memory-hard and built in, so this adds no native dependency and
 * no recurring cost — both of which matter for a personal deployment (§8).
 *
 * Format: `scrypt.N.r.p.<salt-hex>.<hash-hex>`
 *
 * Dots, not the conventional `$`: Next.js expands `$NAME` inside .env files as
 * a reference to another variable, so a `$`-delimited hash silently became
 * `scrypt` with the parameters stripped, and every login failed with no
 * indication why. Dots have no meaning to the .env parser.
 *
 * Storing the parameters alongside the digest means they can be raised later
 * without invalidating existing hashes.
 */

const PARAMS = { N: 16384, r: 8, p: 1, keyLen: 64 };
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new Error("Parola en az 8 karakter olmalı");
  }

  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, PARAMS.keyLen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    // scrypt's default maxmem is too small for N=16384.
    maxmem: 64 * 1024 * 1024,
  });

  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join(".");
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  try {
    // Accept `$` as well, so a hash generated before the delimiter changed
    // still verifies rather than locking the user out.
    const parts = stored.split(stored.includes(".") ? "." : "$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!N || !r || !p) return false;

    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");

    const derived = await scryptAsync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });

    // Constant-time comparison — a length mismatch alone must not short-circuit
    // in a way that leaks timing information about the digest.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
