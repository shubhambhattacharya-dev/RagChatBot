-- Google sign-in + document ownership.
-- Users are created on first Google login (upsert by googleId).
-- ownerId/userId are nullable: documents and conversations that existed
-- before auth have no owner and stay hidden from all users until deleted
-- or re-uploaded by their owner.

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "googleId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "picture" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AlterTable: attribute existing rows to no one (nullable + SetNull).
-- sessionId is dropped: conversations are scoped by the signed-in user now.
ALTER TABLE "Document" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "userId" TEXT;
DROP INDEX IF EXISTS "Conversation_sessionId_updatedAt_idx";
ALTER TABLE "Conversation" DROP COLUMN IF EXISTS "sessionId";

-- CreateIndex
CREATE INDEX "Document_ownerId_idx" ON "Document"("ownerId");

-- CreateIndex
CREATE INDEX "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
