import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

export const SESSION_COOKIE = "nexora_session";
const sessionDuration = "7d";

export function createSessionToken(userId, sessionVersion = 0) {
  return jwt.sign({ sub: userId, sv: sessionVersion }, process.env.JWT_SECRET, { expiresIn: sessionDuration });
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: "Please sign in to continue." });
    const { sub, sv } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user || user.isBanned || sv !== user.sessionVersion) {
      res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
      return res.status(401).json({ error: "Your session is no longer available." });
    }
    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
      return res.status(401).json({ error: "Your session has expired. Please sign in again." });
    }
    next(error);
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Administrator access is required." });
  next();
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    isAdmin: user.isAdmin,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt,
  };
}
