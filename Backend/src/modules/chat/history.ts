import prisma from "../../config/prisma";

export async function saveConversation(
  userId: string,
  question: string,
  answer: string,
  sources: string[],
  documentId?: string,
): Promise<void> {
  await prisma.conversation.create({
    data: {
      userId,
      messages: {
        create: [
          { role: "user", content: question, documentId },
          { role: "assistant", content: answer, sources, documentId },
        ],
      },
    },
  });
}

export async function listConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { role: true, content: true, sources: true, documentId: true },
      },
    },
  });
}

export async function clearConversations(userId: string): Promise<void> {
  await prisma.conversation.deleteMany({ where: { userId } });
}

/** Deletes one conversation, scoped to its owner. Returns false when the id
 *  doesn't exist or belongs to someone else — callers answer 404 either way. */
export async function deleteConversation(userId: string, conversationId: string): Promise<boolean> {
  const result = await prisma.conversation.deleteMany({
    where: { id: conversationId, userId },
  });
  return result.count > 0;
}
