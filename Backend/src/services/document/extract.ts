const { PDFParse } = await import("pdf-parse");
const mammoth = await import("mammoth");

/** Extract plain text from one of the document formats accepted by /upload. */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const extension = filename.split(".").pop()?.toLowerCase();

  if (mimeType === "application/pdf" || extension === "pdf") {
    return (await new PDFParse({ data: buffer }).getText()).text;
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === "docx"
  ) {
    return (await mammoth.extractRawText({ buffer })).value;
  }
  if (
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    extension === "txt" ||
    extension === "md"
  ) {
    return buffer.toString("utf8");
  }

  throw new Error(`Unsupported document type: ${mimeType || extension || "unknown"}`);
}
