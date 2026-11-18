import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import multer from "multer";
import { z } from "zod";
import { prisma } from "./db.js";
import { createSessionToken, publicUser, requireAdmin, requireAuth, setSessionCookie } from "./auth.js";
import { passwordSchema, usernameSchema } from "./validation.js";
import { decryptTotpSecret, encryptTotpSecret } from "./totp-crypto.js";
import { areFriends, getFriendPair } from "./friends.js";
import { ensurePublicGroup } from "./public-group.js";

export const api = Router();
const authRoutes = Router();
const userRoutes = Router();
const friendRoutes = Router();
const conversationRoutes = Router();
const adminRoutes = Router();

const cleanUser = (user) => publicUser(user);

function io(req) {
  return req.app.get("io");
}

async function isBlockedBetween(firstId, secondId) {
  return Boolean(await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: firstId, blockedId: secondId },
        { blockerId: secondId, blockedId: firstId },
      ],
    },
  }));
}

async function ensureMember(conversationId, userId) {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    include: {
      conversation: {
        select: { type: true, members: { select: { userId: true } } },
      },
    },
  });
  if (!membership) return null;
  if (membership.conversation.type === "DIRECT") {
    const other = membership.conversation.members.find((member) => member.userId !== userId);
    if (!other || !await areFriends(userId, other.userId) || await isBlockedBetween(userId, other.userId)) return null;
  }
  return membership;
}

authRoutes.post("/register", async (req, res) => {
  const parsed = z.object({ username: usernameSchema, password: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const username = parsed.data.username;
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return res.status(409).json({ error: "That username is already in use." });
  const publicGroup = await ensurePublicGroup();
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash: await bcrypt.hash(parsed.data.password, 12),
      memberships: { create: { conversationId: publicGroup.id } },
    },
  }).catch((error) => {
    if (error.code === "P2002") return null;
    throw error;
  });
  if (!user) return res.status(409).json({ error: "That username is already in use." });
  setSessionCookie(res, createSessionToken(user.id, user.sessionVersion));
  res.status(201).json({ user: cleanUser(user) });
});

authRoutes.post("/login", async (req, res) => {
  const parsed = z.object({
    username: z.string().min(1).max(20),
    password: passwordSchema,
    twoFactorCode: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your username and password." });
  const user = await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });
  const validPassword = user && await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!validPassword || user.isBanned) return res.status(401).json({ error: "Incorrect username or password." });
  if (user.twoFactorEnabled) {
    if (!process.env.TOTP_ENCRYPTION_KEY) return res.status(503).json({ error: "Two-factor authentication is temporarily unavailable." });
    const secret = user.twoFactorSecret ? decryptTotpSecret(user.twoFactorSecret) : null;
    if (!parsed.data.twoFactorCode || !secret || !authenticator.check(parsed.data.twoFactorCode, secret)) {
      return res.status(401).json({ error: "Enter a valid two-factor authentication code.", code: "TWO_FACTOR_REQUIRED" });
    }
  }
  setSessionCookie(res, createSessionToken(user.id, user.sessionVersion));
  res.json({ user: cleanUser(user) });
});

authRoutes.post("/logout", (_req, res) => {
  res.clearCookie("nexora_session", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  res.json({ success: true });
});

authRoutes.get("/me", requireAuth, (req, res) => res.json({ user: cleanUser(req.user) }));

authRoutes.post("/change-password", requireAuth, async (req, res) => {
  const parsed = z.object({
    currentPassword: z.string().min(1).max(72),
    newPassword: passwordSchema,
    socketId: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (!await bcrypt.compare(parsed.data.currentPassword, req.user.passwordHash)) {
    return res.status(401).json({ error: "Your current password is incorrect." });
  }
  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12), sessionVersion: { increment: 1 } },
  });
  setSessionCookie(res, createSessionToken(updated.id, updated.sessionVersion));
  const sockets = await io(req).in(updated.id).fetchSockets();
  for (const socket of sockets) {
    if (socket.id === parsed.data.socketId) continue;
    socket.emit("session:expired");
    socket.disconnect(true);
  }
  res.json({ message: "Password updated successfully." });
});

authRoutes.post("/password-reset/request", async (req, res) => {
  const parsed = z.object({ username: usernameSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const user = await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });
  await prisma.passwordResetRequest.create({
    data: { username: parsed.data.username, userId: user?.id },
  });
  res.json({ message: "If the account exists, an administrator will review your reset request." });
});

authRoutes.post("/2fa/setup", requireAuth, async (req, res) => {
  if (!process.env.TOTP_ENCRYPTION_KEY) return res.status(503).json({ error: "Two-factor authentication is not configured on this server." });
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(req.user.username, "NEXORA", secret);
  await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorSecret: encryptTotpSecret(secret), twoFactorEnabled: false },
  });
  res.json({ secret, qrCode: await QRCode.toDataURL(otpauthUrl) });
});

authRoutes.post("/2fa/enable", requireAuth, async (req, res) => {
  const parsed = z.object({ code: z.string().length(6) }).safeParse(req.body);
  if (!process.env.TOTP_ENCRYPTION_KEY) return res.status(503).json({ error: "Two-factor authentication is not configured on this server." });
  const secret = req.user.twoFactorSecret ? decryptTotpSecret(req.user.twoFactorSecret) : null;
  if (!parsed.success || !secret || !authenticator.check(parsed.data.code, secret)) {
    return res.status(400).json({ error: "Enter the current code from your authenticator app." });
  }
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { twoFactorEnabled: true } });
  res.json({ user: cleanUser(user) });
});

authRoutes.post("/2fa/disable", requireAuth, async (req, res) => {
  const parsed = z.object({ code: z.string().length(6) }).safeParse(req.body);
  if (!process.env.TOTP_ENCRYPTION_KEY) return res.status(503).json({ error: "Two-factor authentication is not configured on this server." });
  const secret = req.user.twoFactorSecret ? decryptTotpSecret(req.user.twoFactorSecret) : null;
  if (!parsed.success || !secret || !authenticator.check(parsed.data.code, secret)) {
    return res.status(400).json({ error: "Enter the current code from your authenticator app." });
  }
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });
  res.json({ user: cleanUser(user) });
});

api.use("/auth", authRoutes);
api.use(requireAuth);

userRoutes.get("/search", async (req, res) => {
  const groupSearch = req.query.mode === "group";
  const query = (groupSearch ? z.string().trim().min(1).max(20) : usernameSchema).safeParse(req.query.q);
  if (!query.success) return res.json({ users: [] });
  const excluded = await prisma.block.findMany({
    where: { OR: [{ blockerId: req.user.id }, { blockedId: req.user.id }] },
    select: { blockerId: true, blockedId: true },
  });
  const excludedIds = new Set([req.user.id]);
  excluded.forEach((block) => {
    excludedIds.add(block.blockerId);
    excludedIds.add(block.blockedId);
  });
  const users = await prisma.user.findMany({
    where: {
      username: groupSearch
        ? { contains: query.data, mode: "insensitive" }
        : { equals: query.data, mode: "insensitive" },
      id: { notIn: [...excludedIds] },
      isBanned: false,
    },
    select: { id: true, username: true, avatarUrl: true, bio: true, isAdmin: true },
    take: groupSearch ? 20 : 1,
  });
  const onlineUsers = req.app.get("onlineUsers");
  if (groupSearch) {
    return res.json({ users: users.map((user) => ({ ...user, isOnline: onlineUsers.has(user.id) })) });
  }
  const target = users[0];
  if (!target) return res.json({ users: [] });
  const relationship = await prisma.friendRequest.findUnique({
    where: { lowUserId_highUserId: getFriendPair(req.user.id, target.id) },
    select: { id: true, requesterId: true, status: true },
  });
  let friendStatus = "NONE";
  if (relationship?.status === "ACCEPTED") friendStatus = "FRIEND";
  else if (relationship?.status === "PENDING") {
    friendStatus = relationship.requesterId === req.user.id ? "OUTGOING" : "INCOMING";
  }
  res.json({
    users: [{
      ...target,
      isOnline: onlineUsers.has(target.id),
      friendStatus,
      friendRequestId: relationship?.status === "PENDING" ? relationship.id : null,
    }],
  });
});

userRoutes.patch("/me", async (req, res) => {
  const parsed = z.object({
    username: usernameSchema.optional(),
    bio: z.string().max(160).optional(),
    avatarUrl: z.string().regex(/^\/api\/files\/[a-f0-9]+\.(jpg|jpeg|png|gif|webp)$/).nullable().optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (parsed.data.username && parsed.data.username !== req.user.username) {
    const existing = await prisma.user.findUnique({ where: { username: parsed.data.username } });
    if (existing) return res.status(409).json({ error: "That username is already in use." });
  }
  const user = await prisma.user.update({ where: { id: req.user.id }, data: parsed.data }).catch((error) => {
    if (error.code === "P2002") return null;
    throw error;
  });
  if (!user) return res.status(409).json({ error: "That username is already in use." });
  io(req).emit("profile:updated", cleanUser(user));
  res.json({ user: cleanUser(user) });
});

userRoutes.get("/blocked", async (req, res) => {
  const blocks = await prisma.block.findMany({
    where: { blockerId: req.user.id },
    include: { blocked: { select: { id: true, username: true, avatarUrl: true } } },
  });
  res.json({ users: blocks.map(({ blocked }) => blocked) });
});

userRoutes.post("/:id/block", async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot block yourself." });
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found." });
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId: req.user.id, blockedId: target.id } },
    create: { blockerId: req.user.id, blockedId: target.id },
    update: {},
  });
  io(req).emit("block:changed", { blockerId: req.user.id, blockedId: target.id });
  io(req).to(target.id).emit("friends:changed");
  io(req).to(req.user.id).emit("friends:changed");
  res.json({ success: true });
});

userRoutes.delete("/:id/block", async (req, res) => {
  await prisma.block.deleteMany({ where: { blockerId: req.user.id, blockedId: req.params.id } });
  io(req).emit("block:changed", { blockerId: req.user.id, blockedId: req.params.id, blocked: false });
  io(req).to(req.params.id).emit("friends:changed");
  io(req).to(req.user.id).emit("friends:changed");
  res.json({ success: true });
});

api.use("/users", userRoutes);

friendRoutes.get("/", async (req, res) => {
  const [relationships, blocks] = await Promise.all([
    prisma.friendRequest.findMany({
      where: {
        OR: [{ lowUserId: req.user.id }, { highUserId: req.user.id }],
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      include: {
        requester: { select: { id: true, username: true, avatarUrl: true } },
        recipient: { select: { id: true, username: true, avatarUrl: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.block.findMany({
      where: { OR: [{ blockerId: req.user.id }, { blockedId: req.user.id }] },
      select: { blockerId: true, blockedId: true },
    }),
  ]);
  const blockedIds = new Set(blocks.flatMap(({ blockerId, blockedId }) => [blockerId, blockedId]));
  const onlineUsers = req.app.get("onlineUsers");
  const withPresence = (user) => ({ ...user, isOnline: onlineUsers.has(user.id) });
  const friends = [];
  const incomingRequests = [];
  const outgoingRequests = [];
  relationships.forEach((relationship) => {
    if (relationship.status === "ACCEPTED") {
      const friend = relationship.requesterId === req.user.id ? relationship.recipient : relationship.requester;
      if (!blockedIds.has(friend.id)) friends.push(withPresence(friend));
    } else if (relationship.recipientId === req.user.id) {
      if (!blockedIds.has(relationship.requester.id)) {
        incomingRequests.push({ id: relationship.id, createdAt: relationship.createdAt, user: withPresence(relationship.requester) });
      }
    } else {
      if (!blockedIds.has(relationship.recipient.id)) {
        outgoingRequests.push({ id: relationship.id, createdAt: relationship.createdAt, user: withPresence(relationship.recipient) });
      }
    }
  });
  res.json({ friends, incomingRequests, outgoingRequests });
});

friendRoutes.post("/requests", async (req, res) => {
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success || parsed.data.userId === req.user.id) {
    return res.status(400).json({ error: "Choose another user to send a friend request." });
  }
  const target = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, username: true, isBanned: true },
  });
  if (!target || target.isBanned) return res.status(404).json({ error: "User not found." });
  if (await isBlockedBetween(req.user.id, target.id)) {
    return res.status(403).json({ error: "A friend request cannot be sent because one of you has blocked the other." });
  }

  const pair = getFriendPair(req.user.id, target.id);
  const existing = await prisma.friendRequest.findUnique({ where: { lowUserId_highUserId: pair } });
  if (existing?.status === "ACCEPTED") return res.status(409).json({ error: "You are already friends." });
  if (existing?.status === "PENDING" && existing.requesterId === req.user.id) {
    return res.status(409).json({ error: "A friend request is already pending." });
  }
  if (existing?.status === "PENDING") {
    return res.status(409).json({ error: "This user already sent you a request. Accept or reject it from your incoming requests." });
  }

  let request;
  if (existing) {
    request = await prisma.friendRequest.update({
      where: { id: existing.id },
      data: { requesterId: req.user.id, recipientId: target.id, status: "PENDING", createdAt: new Date() },
    });
  } else {
    request = await prisma.friendRequest.create({
      data: { ...pair, requesterId: req.user.id, recipientId: target.id },
    }).catch((error) => {
      if (error.code === "P2002") return null;
      throw error;
    });
    if (!request) return res.status(409).json({ error: "A friend request already exists. Refresh your friend list." });
  }
  io(req).to(target.id).emit("friend:notification", { type: "request", username: req.user.username });
  io(req).to(target.id).emit("friends:changed");
  io(req).to(req.user.id).emit("friends:changed");
  res.status(201).json({ status: request.status, requestId: request.id });
});

friendRoutes.post("/requests/:id/accept", async (req, res) => {
  const request = await prisma.friendRequest.findUnique({
    where: { id: req.params.id },
    include: { requester: { select: { username: true } } },
  });
  if (!request || request.recipientId !== req.user.id) return res.status(404).json({ error: "Friend request not found." });
  if (request.status !== "PENDING") return res.status(409).json({ error: "This friend request is no longer pending." });
  if (await isBlockedBetween(request.requesterId, req.user.id)) {
    return res.status(403).json({ error: "This request cannot be accepted while one of you has blocked the other." });
  }
  const updated = await prisma.friendRequest.updateMany({
    where: { id: request.id, recipientId: req.user.id, status: "PENDING" },
    data: { status: "ACCEPTED" },
  });
  if (!updated.count) return res.status(409).json({ error: "This friend request is no longer pending." });
  io(req).to(request.requesterId).emit("friend:notification", { type: "accepted", username: req.user.username });
  io(req).to(request.requesterId).emit("friends:changed");
  io(req).to(req.user.id).emit("friends:changed");
  res.json({ success: true });
});

friendRoutes.post("/requests/:id/reject", async (req, res) => {
  const request = await prisma.friendRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.recipientId !== req.user.id) return res.status(404).json({ error: "Friend request not found." });
  if (request.status !== "PENDING") return res.status(409).json({ error: "This friend request is no longer pending." });
  const updated = await prisma.friendRequest.updateMany({
    where: { id: request.id, recipientId: req.user.id, status: "PENDING" },
    data: { status: "REJECTED" },
  });
  if (!updated.count) return res.status(409).json({ error: "This friend request is no longer pending." });
  const requester = await prisma.user.findUnique({ where: { id: request.requesterId }, select: { username: true } });
  if (requester) io(req).to(request.requesterId).emit("friend:notification", { type: "rejected", username: req.user.username });
  io(req).to(request.requesterId).emit("friends:changed");
  io(req).to(req.user.id).emit("friends:changed");
  res.json({ success: true });
});

friendRoutes.delete("/:userId", async (req, res) => {
  if (req.params.userId === req.user.id) return res.status(400).json({ error: "You cannot remove yourself." });
  const pair = getFriendPair(req.user.id, req.params.userId);
  const relationship = await prisma.friendRequest.findUnique({
    where: { lowUserId_highUserId: pair },
    select: { id: true, status: true },
  });
  if (!relationship || relationship.status !== "ACCEPTED") return res.status(404).json({ error: "Friend not found." });
  await prisma.friendRequest.delete({ where: { id: relationship.id } });
  const directConversations = await prisma.conversation.findMany({
    where: {
      type: "DIRECT",
      members: { some: { userId: req.user.id } },
      AND: [{ members: { some: { userId: req.params.userId } } }],
    },
    select: { id: true },
  });
  directConversations.forEach(({ id }) => io(req).in(id).socketsLeave(id));
  io(req).to(req.params.userId).emit("friends:changed");
  io(req).to(req.user.id).emit("friends:changed");
  res.json({ success: true });
});

api.use("/friends", friendRoutes);

api.post("/reports", async (req, res) => {
  const parsed = z.object({
    userId: z.string().min(1),
    messageId: z.string().optional(),
    reason: z.string().trim().min(8).max(1000),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a user and provide at least 8 characters of context." });
  if (parsed.data.userId === req.user.id) return res.status(400).json({ error: "You cannot report yourself." });
  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target) return res.status(404).json({ error: "User not found." });
  if (parsed.data.messageId) {
    const message = await prisma.message.findUnique({ where: { id: parsed.data.messageId } });
    if (!message || message.senderId !== target.id || !await ensureMember(message.conversationId, req.user.id)) {
      return res.status(400).json({ error: "That message cannot be reported." });
    }
  }
  const report = await prisma.report.create({
    data: { reporterId: req.user.id, reportedUserId: target.id, messageId: parsed.data.messageId, reason: parsed.data.reason },
  });
  res.status(201).json({ reportId: report.id });
});

conversationRoutes.get("/", async (req, res) => {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId: req.user.id },
    include: {
      conversation: {
        include: {
          members: { include: { user: { select: { id: true, username: true, avatarUrl: true, isBanned: true } } } },
          messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, include: { sender: { select: { username: true } } } },
        },
      },
    },
  });
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: req.user.id }, { blockedId: req.user.id }] },
  });
  const blockedIds = new Set(blocks.flatMap((block) => [block.blockerId, block.blockedId]));
  const acceptedFriendships = await prisma.friendRequest.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ lowUserId: req.user.id }, { highUserId: req.user.id }],
    },
    select: { requesterId: true, recipientId: true },
  });
  const friendIds = new Set(acceptedFriendships.map(({ requesterId, recipientId }) =>
    requesterId === req.user.id ? recipientId : requesterId));
  const onlineUsers = req.app.get("onlineUsers");
  const conversations = memberships.filter(({ conversation }) => {
    if (conversation.type !== "DIRECT") return true;
    return conversation.members.some(({ user }) => user.id !== req.user.id && friendIds.has(user.id) && !blockedIds.has(user.id));
  }).map(({ conversation }) => {
    const members = conversation.members.filter(({ user }) => !user.isBanned);
    const others = members.filter(({ user }) => user.id !== req.user.id && !blockedIds.has(user.id));
    const lastMessage = conversation.messages[0];
    return {
      id: conversation.id,
      type: conversation.type,
      title: conversation.title,
      isPublic: conversation.isPublic,
      updatedAt: conversation.updatedAt,
      members: members.map(({ user }) => ({ ...user, isOnline: onlineUsers.has(user.id) })),
      displayUser: conversation.type === "DIRECT" ? others[0]?.user ?? null : null,
      lastMessage: lastMessage ? {
        content: lastMessage.deletedAt ? "Message deleted" : lastMessage.content,
        attachmentName: lastMessage.attachmentName,
        senderUsername: lastMessage.sender.username,
        createdAt: lastMessage.createdAt,
      } : null,
    };
  });
  conversations.sort((a, b) => Number(b.isPublic) - Number(a.isPublic) || new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ conversations });
});

conversationRoutes.post("/direct", async (req, res) => {
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success || parsed.data.userId === req.user.id) return res.status(400).json({ error: "Choose another user to start a conversation." });
  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target || target.isBanned) return res.status(404).json({ error: "User not found." });
  if (await isBlockedBetween(req.user.id, target.id)) return res.status(403).json({ error: "This conversation is unavailable because one of you has blocked the other." });
  if (!await areFriends(req.user.id, target.id)) {
    return res.status(403).json({ error: "You must accept a friend request before starting a direct conversation." });
  }
  const candidates = await prisma.conversation.findMany({
    where: { type: "DIRECT", members: { some: { userId: req.user.id } } },
    include: { members: true },
  });
  const existing = candidates.find(({ members }) =>
    members.length === 2 && members.some(({ userId }) => userId === target.id));
  if (existing) return res.json({ conversationId: existing.id });
  const conversation = await prisma.conversation.create({
    data: {
      type: "DIRECT",
      createdBy: req.user.id,
      members: { create: [{ userId: req.user.id }, { userId: target.id }] },
    },
  });
  io(req).to(target.id).emit("conversation:created", { conversationId: conversation.id });
  res.status(201).json({ conversationId: conversation.id });
});

conversationRoutes.post("/group", async (req, res) => {
  const parsed = z.object({
    title: z.string().trim().min(1).max(60),
    memberIds: z.array(z.string().min(1)).min(1).max(49),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A group needs a name and at least one other member." });
  const memberIds = [...new Set([req.user.id, ...parsed.data.memberIds])];
  if (memberIds.length < 3) return res.status(400).json({ error: "Group chats need at least three members, including you." });
  const users = await prisma.user.findMany({ where: { id: { in: memberIds }, isBanned: false }, select: { id: true } });
  if (users.length !== memberIds.length) return res.status(400).json({ error: "One or more selected users are unavailable." });
  const blocked = await prisma.block.findFirst({
    where: { OR: memberIds.filter((id) => id !== req.user.id).map((id) => ({
      OR: [{ blockerId: req.user.id, blockedId: id }, { blockerId: id, blockedId: req.user.id }],
    })) },
  });
  if (blocked) return res.status(403).json({ error: "A selected member is unavailable because of a block." });
  const conversation = await prisma.conversation.create({
    data: {
      type: "GROUP",
      title: parsed.data.title,
      createdBy: req.user.id,
      members: { create: memberIds.map((userId) => ({ userId, role: userId === req.user.id ? "OWNER" : "MEMBER" })) },
    },
  });
  memberIds.forEach((userId) => io(req).to(userId).emit("conversation:created", { conversationId: conversation.id }));
  res.status(201).json({ conversationId: conversation.id });
});

conversationRoutes.get("/:id/messages", async (req, res) => {
  if (!await ensureMember(req.params.id, req.user.id)) return res.status(404).json({ error: "Conversation not found." });
  let cursorFilter = {};
  if (req.query.before || req.query.beforeId) {
    const parsedCursor = z.object({
      before: z.string().datetime(),
      beforeId: z.string().min(1),
    }).safeParse({ before: req.query.before, beforeId: req.query.beforeId });
    if (!parsedCursor.success) return res.status(400).json({ error: "Invalid message cursor." });
    const before = new Date(parsedCursor.data.before);
    cursorFilter = {
      OR: [
        { createdAt: { lt: before } },
        { createdAt: before, id: { lt: parsedCursor.data.beforeId } },
      ],
    };
  }
  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id, ...cursorFilter },
    include: {
      sender: { select: { id: true, username: true, avatarUrl: true } },
      reads: { select: { userId: true, readAt: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  res.json({ messages: messages.reverse() });
});

api.use("/conversations", conversationRoutes);

api.patch("/messages/:id", async (req, res) => {
  const parsed = z.object({ content: z.string().trim().min(1).max(4000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Messages must contain between 1 and 4,000 characters." });
  const message = await prisma.message.findUnique({ where: { id: req.params.id } });
  if (!message || message.senderId !== req.user.id || message.deletedAt || !await ensureMember(message.conversationId, req.user.id)) {
    return res.status(404).json({ error: "Message not found or cannot be edited." });
  }
  const updated = await prisma.message.update({ where: { id: message.id }, data: { content: parsed.data.content, editedAt: new Date() } });
  io(req).to(message.conversationId).emit("message:updated", updated);
  res.json({ message: updated });
});

api.delete("/messages/:id", async (req, res) => {
  const message = await prisma.message.findUnique({ where: { id: req.params.id } });
  if (!message || message.senderId !== req.user.id || !await ensureMember(message.conversationId, req.user.id)) {
    return res.status(404).json({ error: "Message not found or cannot be deleted." });
  }
  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { content: "", attachmentUrl: null, attachmentName: null, attachmentType: null, deletedAt: new Date() },
  });
  io(req).to(message.conversationId).emit("message:updated", updated);
  res.json({ message: updated });
});

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
mkdirSync(uploadDir, { recursive: true });
const allowedFiles = new Map([
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/png", [".png"]],
  ["image/gif", [".gif"]],
  ["image/webp", [".webp"]],
  ["application/pdf", [".pdf"]],
  ["text/plain", [".txt"]],
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, file, callback) => callback(null, `${randomBytes(18).toString("hex")}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedFiles.get(file.mimetype)?.includes(extension)) return callback(new Error("Unsupported file type. Use an image, PDF, or text file."));
    callback(null, true);
  },
});

api.post("/uploads", (req, res, next) => upload.single("file")(req, res, (error) => {
  if (error) return res.status(400).json({ error: error.message });
  next();
}), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a file to upload." });
  res.status(201).json({
    url: `/api/files/${req.file.filename}`,
    name: path.basename(req.file.originalname).slice(0, 160),
    type: req.file.mimetype,
  });
});

api.get("/files/:filename", async (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const url = `/api/files/${filename}`;
  const [avatar, attachmentMessage] = await Promise.all([
    prisma.user.findFirst({ where: { avatarUrl: url }, select: { id: true } }),
    prisma.message.findFirst({
      where: { attachmentUrl: url, conversation: { members: { some: { userId: req.user.id } } } },
      select: { id: true, conversationId: true },
    }),
  ]);
  const attachment = attachmentMessage && await ensureMember(attachmentMessage.conversationId, req.user.id)
    ? attachmentMessage
    : null;
  if (!avatar && !attachment) {
    return res.status(404).json({ error: "File not found." });
  }
  const filePath = path.join(uploadDir, filename);
  const contentTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
  };
  const contentType = contentTypes[path.extname(filename).toLowerCase()] || "application/octet-stream";
  res.type(contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", contentType.startsWith("image/") ? "inline" : "attachment");
  createReadStream(filePath).on("error", next).pipe(res);
});

adminRoutes.get("/reports", async (_req, res) => {
  const reports = await prisma.report.findMany({
    include: {
      reporter: { select: { id: true, username: true } },
      reportedUser: { select: { id: true, username: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ reports });
});

adminRoutes.get("/users", async (req, res) => {
  const query = z.string().trim().max(20).safeParse(req.query.q ?? "");
  if (!query.success) return res.status(400).json({ error: "Search query is too long." });
  const users = await prisma.user.findMany({
    where: query.data ? { username: { contains: query.data, mode: "insensitive" } } : {},
    select: { id: true, username: true, isAdmin: true, isBanned: true, twoFactorEnabled: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json({ users });
});

adminRoutes.get("/password-reset-requests", async (_req, res) => {
  const requests = await prisma.passwordResetRequest.findMany({
    where: { resolvedAt: null },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  res.json({ requests });
});

adminRoutes.post("/password-reset-requests/:id/resolve", async (req, res) => {
  const request = await prisma.passwordResetRequest.findUnique({ where: { id: req.params.id } });
  if (!request || request.resolvedAt) return res.status(404).json({ error: "Reset request not found." });
  const parsed = z.object({ temporaryPassword: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (request.userId) {
    await prisma.user.update({
      where: { id: request.userId },
      data: { passwordHash: await bcrypt.hash(parsed.data.temporaryPassword, 12), sessionVersion: { increment: 1 } },
    });
    io(req).to(request.userId).emit("session:expired");
    io(req).in(request.userId).disconnectSockets(true);
  }
  await prisma.passwordResetRequest.update({ where: { id: request.id }, data: { resolvedAt: new Date() } });
  res.json({ message: request.userId ? "Temporary password saved. Share it with the user through a secure channel." : "Request closed; no matching account was found." });
});

adminRoutes.post("/users/:id/password", async (req, res) => {
  const parsed = z.object({ temporaryPassword: passwordSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!user) return res.status(404).json({ error: "User not found." });
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(parsed.data.temporaryPassword, 12), sessionVersion: { increment: 1 } },
  });
  io(req).to(user.id).emit("session:expired");
  io(req).in(user.id).disconnectSockets(true);
  res.json({ message: "Temporary password saved. Share it with the user through a secure channel." });
});

adminRoutes.post("/users/:id/2fa/reset", async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null, sessionVersion: { increment: 1 } },
    select: { id: true, username: true },
  }).catch((error) => {
    if (error.code === "P2025") return null;
    throw error;
  });
  if (!user) return res.status(404).json({ error: "User not found." });
  io(req).to(user.id).emit("session:expired");
  io(req).in(user.id).disconnectSockets(true);
  res.json({ message: `Two-factor authentication has been reset for @${user.username}.` });
});

adminRoutes.patch("/reports/:id", async (req, res) => {
  const parsed = z.object({ status: z.enum(["REVIEWED", "DISMISSED"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a valid report status." });
  const report = await prisma.report.update({
    where: { id: req.params.id },
    data: { status: parsed.data.status },
  }).catch((error) => {
    if (error.code === "P2025") return null;
    throw error;
  });
  if (!report) return res.status(404).json({ error: "Report not found." });
  res.json({ report });
});

adminRoutes.patch("/users/:id", async (req, res) => {
  const parsed = z.object({ isBanned: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a valid account status." });
  if (req.params.id === req.user.id && parsed.data.isBanned) return res.status(400).json({ error: "You cannot ban your own account." });
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { isBanned: parsed.data.isBanned, ...(parsed.data.isBanned ? { sessionVersion: { increment: 1 } } : {}) },
    select: { id: true, username: true, isBanned: true },
  }).catch((error) => {
    if (error.code === "P2025") return null;
    throw error;
  });
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.isBanned) {
    io(req).to(user.id).emit("user:banned", { userId: user.id });
    io(req).in(user.id).disconnectSockets(true);
  }
  res.json({ user });
});

api.use("/admin", requireAdmin, adminRoutes);
