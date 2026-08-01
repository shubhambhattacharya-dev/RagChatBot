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
    const t = line.trim();
    // Skip page markers like "9 of 11" — they are not headings
    if (/^\d+\s+of\s+\d+$/.test(t)) return;
    // Headings: numbered, start with a capital letter, short line.
    // (Long lines starting with digits are prose, e.g. "28.4 BLEU ...")
    if (/^\d+(?:\.\d+)*\s+[A-Z]/.test(t) && t.length <= 60) {
      headingIndexes.push(index);
      return;
    }
    // Resumes/cover letters: ALL-CAPS section headers with no number
    // ("EXPERIENCE", "EDUCATION", "SKILLS"...) — without this the contact
    // line (name/email/phone/url) gets glued into one giant chunk and
    // "what is the email?" can never retrieve it.
    if (/^[A-Z][A-Z\s&/()-]{2,}$/.test(t) && t.length <= 40) {
      headingIndexes.push(index);
    }
  });

  if (headingIndexes.length === 0) {
    return [text];
  }

  const sections: string[] = [];

  // Front matter (title, authors, abstract...) before the first heading
  // MUST be kept — dropping it makes metadata questions unanswerable.
  // Split it at the Abstract line so the title+authors block stays its own
  // atomic chunk: a mixed title+authors+abstract chunk embeds like the
  // abstract, so "who are the authors?" never matches it.
  const preamble = lines.slice(0, headingIndexes[0]).join("\n").trim();
  if (preamble) {
    const absMatch = preamble.match(/\n\s*(Abstract|ABSTRACT|Summary|SUMMARY)\s*\n/);
    if (absMatch?.index) {
      const metadata = preamble.slice(0, absMatch.index).trim();
      const abstract = preamble.slice(absMatch.index).trim();
      if (metadata) sections.push(metadata);
      if (abstract) sections.push(abstract);
    } else {
      sections.push(preamble);
    }
  }

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

function splitByLine(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
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

  // Line (fallback for PDFs where blank lines were lost — e.g. resumes:
  // "Name\nemail | phone | url\nEXPERIENCE\n..." would otherwise stay one
  // giant mixed chunk and the contact line would never retrieve).
  const lines = splitByLine(text);

  if (lines.length > 1) {
    let current = "";

    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;

      if (tokenCount(candidate) <= maxTokens) {
        current = candidate;
      } else {
        if (current) {
          process(current, maxTokens, result);
        }
        current = line;
      }
    }

    if (current) {
      process(current, maxTokens, result);
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