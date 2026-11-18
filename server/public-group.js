import { prisma } from "./db.js";

export const PUBLIC_GROUP_KEY = "nexora-public-group";
export const PUBLIC_GROUP_TITLE = "NEXORA PUBLIC GROUP";

export async function ensurePublicGroup() {
  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.upsert({
      where: { publicKey: PUBLIC_GROUP_KEY },
      create: {
        type: "GROUP",
        title: PUBLIC_GROUP_TITLE,
        isPublic: true,
        publicKey: PUBLIC_GROUP_KEY,
      },
      update: {
        type: "GROUP",
        title: PUBLIC_GROUP_TITLE,
        isPublic: true,
      },
    });
    const users = await transaction.user.findMany({ select: { id: true } });
    if (users.length) {
      await transaction.conversationMember.createMany({
        data: users.map(({ id }) => ({ conversationId: conversation.id, userId: id })),
        skipDuplicates: true,
      });
    }
    return conversation;
  });
}
