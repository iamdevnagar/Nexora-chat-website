import { prisma } from "./db.js";

export function getFriendPair(firstId, secondId) {
  return firstId < secondId
    ? { lowUserId: firstId, highUserId: secondId }
    : { lowUserId: secondId, highUserId: firstId };
}

export async function areFriends(firstId, secondId) {
  const relationship = await prisma.friendRequest.findUnique({
    where: { lowUserId_highUserId: getFriendPair(firstId, secondId) },
    select: { status: true },
  });
  return relationship?.status === "ACCEPTED";
}
