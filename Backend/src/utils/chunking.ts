type Chunk = {
  index: number;
  content: string;
};

export function estimateTokens(text: string): number {
  // Character/byte ratios vary substantially by script. This intentionally
  // overestimates non-Latin text so chunks stay safely inside model limits.
  let cjk = 0;
  let indic = 0;
  let arabic = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) cjk++;
    else if ((code >= 0x0900 && code <= 0x0d7f)) indic++;
    else if ((code >= 0x0600 && code <= 0x06ff)) arabic++;
  }
  const utf8Bytes = new TextEncoder().encode(text).length;
  const scriptEstimate = cjk * 1.5 + indic + arabic * 0.8;
  return Math.max(1, Math.ceil(Math.max(utf8Bytes / 4, scriptEstimate)));
}

function tokenCount(text: string): number {
  return estimateTokens(text);
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

    
    const previous = chunks[index - 1];
    if (!previous) {
      return { index, content: chunk };
    }
    if (looksLikeContact(previous)) {
      return {
        index,
        content: chunk,
      };
    }

    const previousWords = previous.split(/\s+/);
    const overlap = previousWords
      .slice(-overlapWords)
      .join(" ");

    return {
      index,
      content: overlap + "\n" + chunk,
    };
  });
}


const CONTACT_LINE_RE = /(?:[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{9,}|https?:\/\/\S+|\bwww\.\S+)/i;

function looksLikeContact(text: string): boolean {
  return CONTACT_LINE_RE.test(text);
}


function labelContactFields(text: string): string {
  const emails = [...text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/gi)].map((match) => match[0]);
  const phones = [...text.matchAll(/\+?\d[\d\s-]{9,}/g)].map((match) => match[0].trim());
  const websites = [...text.matchAll(/https?:\/\/[^\s|]+/gi)].map((match) => match[0]);

  return [...new Set([
    ...emails.map((email) => `Email: ${email}`),
    ...phones.map((phone) => `Phone: ${phone}`),
    ...websites.map((website) => `Website: ${website}`),
  ])].join("\n");
}

// Detect the section a chunk belongs to (ALL-CAPS resume headers like
// "EXPERIENCE", or numbered paper headings like "3. Methodology").
function detectSection(content: string): string | null {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (/^[A-Z][A-Z\s&/()-]{2,}$/.test(firstLine) && firstLine.length <= 40) {
    return firstLine;
  }
  const heading = content.match(/^\d+(?:\.\d+)*\s+[A-Z][^:\n]{0,60}/);
  if (heading) return heading[0];
  return null;
}

// Wrap each chunk with document + section metadata and label contact fields.
// The embedding now contains the words "Document", "Section", "Email",
// "Phone", "Website" — so "what is the email?" matches "Email:" directly.
// (Fixes the biggest RAG mistake: embedding raw values with zero context.)
export function enrichChunks(
  chunks: Chunk[],
  documentName: string
): Chunk[] {
  // Detect the document OWNER (a resume's first line is a person's name,
  // e.g. "Shubham Bhattacharya"). Two-word capitalized pattern only — a
  // paper title like "Attention Is All You Need" fails this check, so
  // papers never get a bogus owner. Prepend "Owner:" to EVERY chunk so
  // multi-hop questions ("who built DocNow?") find the name IN the chunk,
  // not across chunks — no inference needed, grounding stays strict.
  const owner = detectOwner(chunks[0]?.content ?? "");

  return chunks.map((chunk) => {
    const content = chunk.content;
    const ownerLine = owner ? `Owner: ${owner}\n` : "";

    // Contact chunk (email/phone/url present): label it explicitly
    if (looksLikeContact(content)) {
      const labeled = labelContactFields(content);
      return {
        index: chunk.index,
        // Labels improve exact-value retrieval, but the original chunk must
        // remain intact. A paper's author block can contain many emails; the
        // previous implementation silently discarded all authors but the first.
        content: `Document: ${documentName}\n${ownerLine}Metadata: Contact details detected\n\n${labeled}\n\nContent:\n${content}`,
      };
    }

    // Non-contact chunk: prepend document + detected section
    const section = detectSection(content);
    const sectionLabel = section
      ? `Section: ${section}\n\n`
      : "";

    return {
      index: chunk.index,
      content: `Document: ${documentName}\n${ownerLine}${sectionLabel}${content}`,
    };
  });
}

// Two-word capitalized name on the first line = resume owner.
// "Shubham Bhattacharya" ✓   "Attention Is All You Need" ✗ (4 words)
// "Manish Bhattacharya" ✓
function detectOwner(content: string): string | null {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  const match = firstLine.match(/^([A-Z][a-zA-Z]+)\s+([A-Z][a-zA-Z-]+)$/);
  return match ? `${match[1]} ${match[2]}` : null;
}

/** Structured retrieval metadata stored with every chunk during indexing. */
export function getChunkMetadata(
  rawChunk: Chunk,
  documentName: string,
  owner: string | null
): Record<string, string | number | null> {
  return {
    filename: documentName,
    chunkIndex: rawChunk.index,
    owner,
    section: detectSection(rawChunk.content),
    documentType: owner ? "resume" : "document",
  };
}

export function detectDocumentOwner(chunks: Chunk[]): string | null {
  return detectOwner(chunks[0]?.content ?? "");
}

export function chunkText(
  text: string,
  maxTokens = 512,
  overlapWords = 0
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
