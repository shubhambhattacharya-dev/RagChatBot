import prisma from "../../config/prisma";

export async function saveConversation(
  sessionId: string,
  question: string,
  answer: string,
  sources: string[],
  documentId?: string,
): Promise<void> {
  await prisma.conversation.create({
    data: {
      sessionId,
      messages: {
        create: [
          { role: "user", content: question, documentId },
          { role: "assistant", content: answer, sources, documentId },
        ],
      },
    },
  });
}

export async function listConversations(sessionId: string) {
  return prisma.conversation.findMany({
    where: { sessionId },
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

export async function clearConversations(sessionId: string): Promise<void> {
  await prisma.conversation.deleteMany({ where: { sessionId } });
}
