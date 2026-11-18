import test from "node:test";
import assert from "node:assert/strict";
import { passwordSchema, usernameSchema } from "../server/validation.js";
import { decryptTotpSecret, encryptTotpSecret } from "../server/totp-crypto.js";
import { isAllowedOrigin, parseClientOrigins } from "../server/origin.js";

test("usernames enforce length and safe characters and normalize case", () => {
  assert.equal(usernameSchema.parse("Nexora_7"), "nexora_7");
  assert.equal(usernameSchema.safeParse("ab").success, false);
  assert.equal(usernameSchema.safeParse("a".repeat(21)).success, false);
  assert.equal(usernameSchema.safeParse("name-with-dash").success, false);
});

test("passwords meet the minimum length and bcrypt byte limit", () => {
  assert.equal(passwordSchema.safeParse("long-pass-1").success, true);
  assert.equal(passwordSchema.safeParse("short7").success, false);
  assert.equal(passwordSchema.safeParse("é".repeat(37)).success, false);
});

test("origin policy allows configured origins and Codespaces only in development", () => {
  const configuredOrigins = ["http://localhost:5173"];
  assert.equal(isAllowedOrigin(undefined, configuredOrigins), true);
  assert.equal(isAllowedOrigin("http://localhost:5173", configuredOrigins), true);
  assert.equal(isAllowedOrigin("https://codespace-5173.app.github.dev", configuredOrigins, true), true);
  assert.equal(isAllowedOrigin("https://codespace-5173.app.github.dev", configuredOrigins), false);
  assert.equal(isAllowedOrigin("https://example.com", configuredOrigins, true), false);
});

test("production client origins must be explicit, exact HTTPS origins", () => {
  assert.deepEqual(parseClientOrigins(undefined, false), ["http://localhost:5173"]);
  assert.deepEqual(parseClientOrigins("https://chat.example.com, https://nexora.up.railway.app", true), [
    "https://chat.example.com",
    "https://nexora.up.railway.app",
  ]);
  assert.throws(() => parseClientOrigins(undefined, true), /CLIENT_ORIGIN must contain/);
  assert.throws(() => parseClientOrigins("http://chat.example.com", true), /exact HTTPS origins/);
  assert.throws(() => parseClientOrigins("https://chat.example.com/", true), /without paths or trailing slashes/);
  assert.throws(() => parseClientOrigins("https://localhost", true), /cannot use localhost/);
  assert.throws(() => parseClientOrigins("https://my-space-5173.app.github.dev", true), /Codespaces development domain/);
});

test("TOTP secrets are encrypted and authenticated before storage", () => {
  const previousKey = process.env.TOTP_ENCRYPTION_KEY;
  process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const secret = "JBSWY3DPEHPK3PXP";
    const encrypted = encryptTotpSecret(secret);
    assert.notEqual(encrypted, secret);
    assert.equal(decryptTotpSecret(encrypted), secret);
    const parts = encrypted.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    assert.throws(() => decryptTotpSecret(parts.join(".")));
  } finally {
    if (previousKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = previousKey;
  }
});
