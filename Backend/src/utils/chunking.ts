type Chunk = {
  index: number;
  content: string;
};

function tokenCount(text: string): number {
  // Rough estimate (replace with tiktoken later)
  return Math.ceil(text.length / 4);
}

/* -------------------- Splitters -------------------- */

function splitByNumberedHeadings(text: string): string[] {
  const lines = text.split("\n");
  const headingIndexes: number[] = [];

  lines.forEach((line, index) => {
    if (/^\d+(?:\.\d+)*\s+.+/.test(line.trim())) {
      headingIndexes.push(index);
    }
  });

  if (headingIndexes.length === 0) {
    return [text];
  }

  const sections: string[] = [];

  for (let i = 0; i < headingIndexes.length; i++) {
    const start = headingIndexes[i];
    const end =
      i + 1 < headingIndexes.length
        ? headingIndexes[i + 1]
        : lines.length;

    sections.push(lines.slice(start, end).join("\n").trim());
  }

  return sections;
}

function splitByParagraph(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitBySentence(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitByWords(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(Boolean);
}

/* -------------------- Recursive -------------------- */

function process(
  text: string,
  maxTokens: number,
  result: string[]
) {
  text = text.trim();

  if (!text) return;

  // Base case
  if (tokenCount(text) <= maxTokens) {
    result.push(text);
    return;
  }

  // Paragraph
  const paragraphs = splitByParagraph(text);

  if (paragraphs.length > 1) {
    for (const paragraph of paragraphs) {
      process(paragraph, maxTokens, result);
    }
    return;
  }

  // Sentence
  const sentences = splitBySentence(text);

  if (sentences.length > 1) {
    let current = "";

    for (const sentence of sentences) {
      const candidate = current
        ? `${current} ${sentence}`
        : sentence;

      if (tokenCount(candidate) <= maxTokens) {
        current = candidate;
      } else {
        if (current) {
          process(current, maxTokens, result);
        }
        current = sentence;
      }
    }

    if (current) {
      process(current, maxTokens, result);
    }

    return;
  }

  // Words
  const words = splitByWords(text);

  let current = "";

  for (const word of words) {
    const candidate = current
      ? `${current} ${word}`
      : word;

    if (tokenCount(candidate) <= maxTokens) {
      current = candidate;
    } else {
      if (current) {
        result.push(current);
      }
      current = word;
    }
  }

  if (current) {
    result.push(current);
  }
}

/* -------------------- Overlap -------------------- */

function addOverlap(
  chunks: string[],
  overlapWords = 20
): Chunk[] {
  return chunks.map((chunk, index) => {
    if (index === 0) {
      return {
        index,
        content: chunk,
      };
    }

    const previousWords = chunks[index - 1].split(/\s+/);
    const overlap = previousWords
      .slice(-overlapWords)
      .join(" ");

    return {
      index,
      content: overlap + "\n" + chunk,
    };
  });
}

/* -------------------- Main -------------------- */

export function chunkText(
  text: string,
  maxTokens = 512,
  overlapWords = 20
): Chunk[] {
  const chunks: string[] = [];

  // First split by numbered headings
  const sections = splitByNumberedHeadings(text);

  for (const section of sections) {
    process(section, maxTokens, chunks);
  }

  // Add overlap
  return addOverlap(chunks, overlapWords);
}