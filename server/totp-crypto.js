import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey() {
  const encoded = process.env.TOTP_ENCRYPTION_KEY;
  if (!encoded) throw new Error("TOTP_ENCRYPTION_KEY must be configured to use two-factor authentication.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

export function encryptTotpSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptTotpSecret(encryptedSecret) {
  const [version, encodedIv, encodedTag, encodedCiphertext] = encryptedSecret?.split(".") ?? [];
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Stored two-factor secret has an invalid format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
