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
    expect(hash.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(hash.split("$")).toHaveLength(6);
  });

  it("refuses to hash a short password", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });

  it("returns false for malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$0$0$0$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$1$2$3$aa$bb")).toBe(false);
  });
});

describe("sessions", () => {
  it("accepts a session it just issued", () => {
    const { value } = createSession(SECRET);
    expect(verifySession(value, SECRET)).toBe(true);
  });

  it("rejects a session signed with a different secret", () => {
    const { value } = createSession(SECRET);
    expect(verifySession(value, "a-completely-different-secret-value")).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const { value } = createSession(SECRET);
    const [body, sig] = value.split(".");
    const forged = Buffer.from(
      JSON.stringify({ iat: 0, exp: 9999999999 })
    ).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, SECRET)).toBe(false);
    expect(body).toBeTruthy();
  });

  it("rejects missing or malformed tokens", () => {
    expect(verifySession(undefined, SECRET)).toBe(false);
    expect(verifySession("", SECRET)).toBe(false);
    expect(verifySession("no-dot", SECRET)).toBe(false);
    expect(verifySession(".", SECRET)).toBe(false);
  });

  it("rejects an expired session", () => {
    // Forge a correctly-signed but already-expired payload.
    const expired = Buffer.from(
      JSON.stringify({ iat: 1000, exp: 2000 })
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET)
      .update(expired)
      .digest("base64url");
    expect(verifySession(`${expired}.${sig}`, SECRET)).toBe(false);
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
