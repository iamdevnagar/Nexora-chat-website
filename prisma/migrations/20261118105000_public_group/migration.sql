ALTER TABLE "Conversation" ALTER COLUMN "createdBy" DROP NOT NULL;
ALTER TABLE "Conversation" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "publicKey" TEXT;
CREATE UNIQUE INDEX "Conversation_publicKey_key" ON "Conversation"("publicKey");

INSERT INTO "Conversation" ("id", "type", "title", "createdBy", "isPublic", "publicKey", "createdAt", "updatedAt")
VALUES ('nexora-public-group', 'GROUP', 'NEXORA PUBLIC GROUP', NULL, true, 'nexora-public-group', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("publicKey") DO NOTHING;

INSERT INTO "ConversationMember" ("id", "conversationId", "userId", "role", "joinedAt")
SELECT 'nexora-public-' || "id", 'nexora-public-group', "id", 'MEMBER', CURRENT_TIMESTAMP
FROM "User"
ON CONFLICT ("conversationId", "userId") DO NOTHING;
