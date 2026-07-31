import { env } from "../../config/env";

const EMBED_MODEL = "models/gemini-embedding-001";
const API_URL = "https://generativelanguage.googleapis.com/v1beta";

interface EmbedResponse {
  embedding?: {
    values?: number[];
  };
}

export async function embedText(text: string): Promise<number[]> {
  try {
    // Validate input
    if (!text.trim()) {
      throw new Error("Text cannot be empty.");
    }

    const response = await fetch(
      `${API_URL}/${EMBED_MODEL}:embedContent?key=${env.GEMINI_API}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: EMBED_MODEL,
          content: {
            parts: [{ text }],
          },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: 768,
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();

      throw new Error(
        `Gemini API Error (${response.status}): ${errorBody}`
      );
    }

    const data: EmbedResponse = await response.json();

    if (!data.embedding?.values) {
      throw new Error("Embedding not found in Gemini response.");
    }

    return data.embedding.values;
  } catch (error) {
    console.error("Embedding generation failed:", error);

    throw new Error("Failed to generate embedding.");
  }
}