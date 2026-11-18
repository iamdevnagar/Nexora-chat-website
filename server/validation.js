import { z } from "zod";

export const usernameSchema = z.string()
  .regex(/^[A-Za-z0-9_]{3,20}$/, "Username must be 3–20 letters, numbers, or underscores.")
  .transform((value) => value.toLowerCase());

export const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters.")
  .max(72, "Password must not exceed 72 characters.")
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must not exceed 72 bytes.");
