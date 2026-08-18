/**
 * Generates the value for ROAMORA_PASSWORD_HASH.
 *
 *   npm run auth:hash -- "your password"
 *
 * The password is taken as an argument rather than read from stdin so it never
 * needs to be stored anywhere; the resulting hash is safe to paste into .env.
 */

import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const password = process.argv[2];

if (!password) {
  console.error('Kullanım: npm run auth:hash -- "parolan"');
  process.exit(1);
}

if (password.length < 8) {
  console.error("Parola en az 8 karakter olmalı.");
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;

const salt = randomBytes(16);
const derived = await scryptAsync(password, salt, 64, {
  N,
  r,
  p,
  maxmem: 64 * 1024 * 1024,
});

const hash = ["scrypt", N, r, p, salt.toString("hex"), derived.toString("hex")].join("$");
const secret = randomBytes(32).toString("base64");

console.log("\n.env dosyana ekle:\n");
console.log(`AUTH_SECRET=${secret}`);
console.log(`ROAMORA_PASSWORD_HASH=${hash}\n`);
console.log("AUTH_SECRET'i yalnızca oturumları geçersiz kılmak istediğinde değiştir.\n");
