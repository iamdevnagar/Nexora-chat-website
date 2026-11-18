import "dotenv/config";
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { z } from "zod";
import { prisma } from "./db.js";
import { SESSION_COOKIE } from "./auth.js";
import { areFriends } from "./friends.js";
import { isAllowedOrigin, parseClientOrigins } from "./origin.js";
import { ensurePublicGroup } from "./public-group.js";
import { api } from "./routes.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(currentDir, "..");
const clientDist = path.join(projectDir, "dist");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST || "0.0.0.0";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port number.");
}
const origins = parseClientOrigins(process.env.CLIENT_ORIGIN, process.env.NODE_ENV === "production");
const allowCodespacesOrigin = process.env.NODE_ENV !== "production" && process.env.CODESPACES === "true";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be configured.");
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set to a random secret of at least 32 characters.");
}

const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(projectDir, "uploads"));
mkdirSync(uploadDir, { recursive: true });

function checkOrigin(origin, callback) {
  if (isAllowedOrigin(origin, origins, allowCodespacesOrigin)) return callback(null, true);
  callback(new Error("Origin is not allowed by CORS."));
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: checkOrigin, credentials: true },
  serveClient: false,
});
const onlineUsers = new Set();
const socketCounts = new Map();
app.set("io", io);
app.set("onlineUsers", onlineUsers);

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production" || allowCodespacesOrigin) app.set("trust proxy", 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", ...origins, ...origins.map((origin) => origin.replace(/^http/, "ws"))],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(cors({
  origin: checkOrigin,
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many account requests. Please try again later." },
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many uploads. Please try again later." },
});
app.use("/api/auth", authLimiter);
app.use("/api/uploads", uploadLimiter);
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api", api);

if (existsSync(clientDist)) app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) {
    return res.status(404).json({ error: "Not found." });
  }
  if (existsSync(path.join(clientDist, "index.html"))) return res.sendFile(path.join(clientDist, "index.html"));
  next();
});
app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  const status = Number(error.status || error.statusCode) || 500;
  res.status(status).json({ error: status >= 500 ? "An unexpected server error occurred." : error.message });
});

function getCookie(header, name) {
  const item = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

async function canAccessConversation(conversationId, userId) {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    include: { conversation: { select: { type: true, members: { select: { userId: true } } } } },
  });
  if (!membership) return false;
  if (membership.conversation.type !== "DIRECT") return true;
  const other = membership.conversation.members.find((member) => member.userId !== userId);
  if (!other || !await areFriends(userId, other.userId)) return false;
  return !await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userId, blockedId: other.userId },
        { blockerId: other.userId, blockedId: userId },
      ],
    },
    select: { id: true },
  });
}

io.use(async (socket, next) => {
  try {
    const token = getCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    if (!token) return next(new Error("Authentication required."));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { sub, sv } = decoded;
    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user || user.isBanned || sv !== user.sessionVersion) return next(new Error("This account is unavailable."));
    socket.data.user = { id: user.id, username: user.username };
    socket.data.expiresAt = decoded.exp * 1000;
    next();
  } catch (error) {
    console.error("Socket authentication failed:", error);
    next(new Error("Authentication required."));
  }
});

io.on("connection", async (socket) => {
  const user = socket.data.user;
  let memberships;
  try {
    const [acceptedFriendships, blocks] = await Promise.all([
      prisma.friendRequest.findMany({
        where: {
          status: "ACCEPTED",
          OR: [{ lowUserId: user.id }, { highUserId: user.id }],
        },
        select: { requesterId: true, recipientId: true },
      }),
      prisma.block.findMany({
        where: { OR: [{ blockerId: user.id }, { blockedId: user.id }] },
        select: { blockerId: true, blockedId: true },
      }),
    ]);
    const friendIds = new Set(acceptedFriendships.map(({ requesterId, recipientId }) =>
      requesterId === user.id ? recipientId : requesterId));
    const blockedIds = new Set(blocks.flatMap(({ blockerId, blockedId }) => [blockerId, blockedId]));
    memberships = await prisma.conversationMember.findMany({
      where: { userId: user.id },
      include: { conversation: { select: { type: true, members: { select: { userId: true } } } } },
    });
    memberships.filter(({ conversation }) => {
      if (conversation.type !== "DIRECT") return true;
      return conversation.members.some(({ userId }) =>
        userId !== user.id && friendIds.has(userId) && !blockedIds.has(userId));
    }).forEach(({ conversationId }) => socket.join(conversationId));
  } catch (error) {
    console.error("Could not load socket conversation memberships:", error);
    socket.disconnect(true);
    return;
  }
  const sessionExpiryTimer = setTimeout(() => {
    socket.emit("session:expired");
    socket.disconnect(true);
  }, Math.max(0, socket.data.expiresAt - Date.now()));
  const count = socketCounts.get(user.id) || 0;
  socketCounts.set(user.id, count + 1);
  if (!count) {
    onlineUsers.add(user.id);
    io.emit("presence:update", { userId: user.id, username: user.username, isOnline: true });
  }
  socket.join(user.id);

  socket.on("conversation:join", async (payload) => {
    try {
      const parsed = z.object({ conversationId: z.string().min(1) }).safeParse(payload);
      if (!parsed.success) return;
      if (await canAccessConversation(parsed.data.conversationId, user.id)) socket.join(parsed.data.conversationId);
    } catch (error) {
      console.error("Could not join conversation room:", error);
    }
  });

  let messageTimes = [];
  socket.on("message:send", async (payload, acknowledge = () => {}) => {
    const now = Date.now();
    messageTimes = messageTimes.filter((time) => now - time < 10_000);
    if (messageTimes.length >= 30) return acknowledge({ error: "You are sending messages too quickly." });
    messageTimes.push(now);
    const parsed = z.object({
      conversationId: z.string().min(1),
      content: z.string().trim().max(4000).optional().default(""),
      attachmentUrl: z.string().startsWith("/api/files/").optional(),
      attachmentName: z.string().max(160).optional(),
      attachmentType: z.string().max(100).optional(),
    }).safeParse(payload);
    if (!parsed.success || (!parsed.data.content && !parsed.data.attachmentUrl)) {
      return acknowledge({ error: "Enter a message or attach a supported file." });
    }
    try {
      const membership = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: parsed.data.conversationId, userId: user.id } },
        include: { conversation: { include: { members: { select: { userId: true } } } } },
      });
      if (!membership) return acknowledge({ error: "Conversation not found." });
      if (membership.conversation.type === "DIRECT") {
        const peer = membership.conversation.members.find((member) => member.userId !== user.id);
        if (!peer || !await areFriends(user.id, peer.userId)) {
          return acknowledge({ error: "You must be friends to send direct messages." });
        }
        if (peer && await prisma.block.findFirst({
          where: { OR: [{ blockerId: user.id, blockedId: peer.userId }, { blockerId: peer.userId, blockedId: user.id }] },
        })) return acknowledge({ error: "This conversation is unavailable." });
      }
      if (parsed.data.attachmentUrl) {
        const filename = path.basename(parsed.data.attachmentUrl);
        const uploadPath = path.join(uploadDir, filename);
        if (!existsSync(uploadPath)) return acknowledge({ error: "The attached file is no longer available." });
      }
      const message = await prisma.$transaction(async (transaction) => {
        const savedMessage = await transaction.message.create({
          data: {
            conversationId: parsed.data.conversationId,
            senderId: user.id,
            content: parsed.data.content,
            attachmentUrl: parsed.data.attachmentUrl,
            attachmentName: parsed.data.attachmentName,
            attachmentType: parsed.data.attachmentType,
          },
          include: { sender: { select: { id: true, username: true, avatarUrl: true } }, reads: true },
        });
        await transaction.conversation.update({
          where: { id: savedMessage.conversationId },
          data: { updatedAt: new Date() },
        });
        return savedMessage;
      });
      io.to(message.conversationId).emit("message:new", message);
      acknowledge({ message });
    } catch (error) {
      console.error("Could not save chat message:", error);
      acknowledge({ error: "Message could not be sent. Please try again." });
    }
  });

  socket.on("typing:update", async (payload) => {
    try {
      const parsed = z.object({ conversationId: z.string().min(1), isTyping: z.boolean() }).safeParse(payload);
      if (!parsed.success || !await canAccessConversation(parsed.data.conversationId, user.id)) return;
      socket.to(parsed.data.conversationId).emit("typing:update", {
        conversationId: parsed.data.conversationId,
        userId: user.id,
        username: user.username,
        isTyping: parsed.data.isTyping,
      });
    } catch (error) {
      console.error("Could not update typing state:", error);
    }
  });

  socket.on("messages:read", async (payload) => {
    try {
      const parsed = z.object({
        conversationId: z.string().min(1),
        messageIds: z.array(z.string().min(1)).max(100),
      }).safeParse(payload);
      if (!parsed.success || !await canAccessConversation(parsed.data.conversationId, user.id)) return;
      const messages = await prisma.message.findMany({
        where: {
          id: { in: parsed.data.messageIds },
          conversationId: parsed.data.conversationId,
          senderId: { not: user.id },
        },
        select: { id: true },
      });
      if (!messages.length) return;
      const readAt = new Date();
      await prisma.messageRead.createMany({
        data: messages.map(({ id }) => ({ messageId: id, userId: user.id, readAt })),
        skipDuplicates: true,
      });
      await prisma.conversationMember.update({
        where: { conversationId_userId: { conversationId: parsed.data.conversationId, userId: user.id } },
        data: { lastReadAt: readAt },
      });
      io.to(parsed.data.conversationId).emit("messages:read", {
        conversationId: parsed.data.conversationId,
        messageIds: messages.map(({ id }) => id),
        userId: user.id,
        readAt,
      });
    } catch (error) {
      console.error("Could not save read receipt:", error);
    }
  });

  socket.on("disconnect", async () => {
    clearTimeout(sessionExpiryTimer);
    const remaining = (socketCounts.get(user.id) || 1) - 1;
    if (remaining > 0) {
      socketCounts.set(user.id, remaining);
      return;
    }
    socketCounts.delete(user.id);
    onlineUsers.delete(user.id);
    const lastSeenAt = new Date();
    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt } }).catch((error) => {
      console.error("Could not update last-seen status:", error);
    });
    io.emit("presence:update", { userId: user.id, username: user.username, isOnline: false, lastSeenAt });
  });
});

let server;

async function startServer() {
  await ensurePublicGroup();
  await new Promise((resolve, reject) => {
    server = httpServer.listen(port, host, () => {
      console.log(`NEXORA server listening on ${host}:${port}`);
      resolve();
    });
    server.once("error", reject);
  });
}

async function shutdown() {
  server?.close();
  io.close();
  await prisma.$disconnect();
}

startServer().catch(async (error) => {
  console.error("Could not start NEXORA server:", error);
  await prisma.$disconnect();
  process.exitCode = 1;
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
