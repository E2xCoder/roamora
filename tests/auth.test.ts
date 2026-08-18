import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import {
  createSession,
  verifySession,
  isAuthConfigured,
} from "@/server/auth/session";

const SECRET = "a-test-secret-at-least-16-chars-long";

describe("password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    // Both must still verify.
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("embeds its parameters so they can be raised later", async () => {
    const hash = await hashPassword("some password");
    expect(hash.startsWith("scrypt.16384.8.1.")).toBe(true);
    expect(hash.split(".")).toHaveLength(6);
  });

  it("contains no '$', which Next.js expands inside .env files", async () => {
    // Regression: a `$`-delimited hash was silently reduced to "scrypt" by
    // Next's env variable expansion, so every login failed with no clue why.
    const hash = await hashPassword("some password");
    expect(hash).not.toContain("$");
  });

  it("still verifies a legacy $-delimited hash", async () => {
    // Anyone who generated credentials before the delimiter changed must not
    // be locked out.
    const legacy = (await hashPassword("legacy password")).replace(/\./g, "$");
    expect(await verifyPassword("legacy password", legacy)).toBe(true);
    expect(await verifyPassword("wrong", legacy)).toBe(false);
  });

  it("refuses to hash a short password", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });

  it("returns false for malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt.0.0.0.aa.bb")).toBe(false);
    expect(await verifyPassword("x", "bcrypt.1.2.3.aa.bb")).toBe(false);
    // What a $-delimited hash collapses to after Next expands it.
    expect(await verifyPassword("x", "scrypt")).toBe(false);
  });
});

describe("sessions", () => {
  it("accepts a session it just issued", async () => {
    const { value } = await createSession(SECRET);
    expect(await verifySession(value, SECRET)).toBe(true);
  });

  it("rejects a session signed with a different secret", async () => {
    const { value } = await createSession(SECRET);
    expect(await verifySession(value, "a-completely-different-secret-value")).toBe(
      false
    );
  });

  it("rejects a tampered payload", async () => {
    const { value } = await createSession(SECRET);
    const sig = value.split(".")[1];
    const forged = Buffer.from(
      JSON.stringify({ iat: 0, exp: 9999999999 })
    ).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`, SECRET)).toBe(false);
  });

  it("rejects missing or malformed tokens", async () => {
    expect(await verifySession(undefined, SECRET)).toBe(false);
    expect(await verifySession("", SECRET)).toBe(false);
    expect(await verifySession("no-dot", SECRET)).toBe(false);
    expect(await verifySession(".", SECRET)).toBe(false);
  });

  it("rejects an expired session", async () => {
    // Forge a correctly-signed but already-expired payload.
    const expired = Buffer.from(
      JSON.stringify({ iat: 1000, exp: 2000 })
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(expired).digest("base64url");
    expect(await verifySession(`${expired}.${sig}`, SECRET)).toBe(false);
  });

  it("runs on Web Crypto so the Edge middleware can verify sessions", () => {
    // Regression: this module imported node:crypto, which the Edge runtime
    // does not provide. Middleware only survived because auth was unconfigured
    // and it returned before verifying.
    expect(typeof globalThis.crypto?.subtle?.importKey).toBe("function");
  });
});

describe("isAuthConfigured", () => {
  it("requires both a sufficiently long secret and a password hash", () => {
    expect(isAuthConfigured(undefined, undefined)).toBe(false);
    expect(isAuthConfigured(SECRET, undefined)).toBe(false);
    expect(isAuthConfigured(undefined, "scrypt$...")).toBe(false);
    expect(isAuthConfigured("tooshort", "scrypt$...")).toBe(false);
    expect(isAuthConfigured(SECRET, "scrypt$...")).toBe(true);
  });
});
