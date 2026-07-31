import { FastifyReply, FastifyRequest } from "fastify";
import { v4 as uuid } from "uuid";

import { env } from "../../config/env";
import { minio } from "../../config/minio";
import prisma from "../../config/prisma";

import { processDocument } from "./processor";

// Whitelist: extension → expected MIME (check both — never trust just one)
const ALLOWED_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

function validateFile(filename: string, mimetype: string): string | null {
  const ext = "." + (filename.split(".").pop() || "").toLowerCase();

  if (!ALLOWED_TYPES[ext]) {
    return `File type "${ext || "(none)"}" not allowed. Use PDF, DOCX, TXT, or MD.`;
  }

  // Loose MIME check — some browsers send "application/octet-stream" for .docx
  const expected = ALLOWED_TYPES[ext];
  if (mimetype && mimetype !== "application/octet-stream" && !mimetype.startsWith(expected.split("/")[0] + "/")) {
    return `File content looks like ${mimetype}, not ${expected}.`;
  }

  return null;
}

export async function handleUpload(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // 1. Read uploaded file
    const file = await request.file();

    if (!file) {
      return reply.status(400).send({
        message: "No file uploaded.",
      });
    }

    // Validate type BEFORE any storage — reject early
    const validationError = validateFile(file.filename, file.mimetype);
    if (validationError) {
      return reply.status(400).send({ message: validationError });
    }

    // 2. Convert stream → Buffer
    const buffer = await file.toBuffer();

    // 3. Generate IDs
    const documentId = uuid();
    const fileKey = `${documentId}/${file.filename}`;

    // 4. Upload original file to MinIO
    await minio.putObject(
      env.MINIO_BUCKET,
      fileKey,
      buffer,
      buffer.length,
      {
        "Content-Type": file.mimetype,
      }
    );

    // 5. Save metadata
    await prisma.document.create({
      data: {
        id: documentId,
        filename: file.filename,
        mimeType: file.mimetype,
        fileKey,
        status: "QUEUED",
      },
    });

    // 6. Start indexing in background
    processDocument(documentId, fileKey).catch((error) => {
      request.log.error(
        {
          error,
          documentId,
        },
        "Document processing failed"
      );
    });

    // 7. Respond immediately
    reply.status(201).send({
      documentId,
      filename: file.filename,
      status: "QUEUED",
    });
  } catch (error) {
    request.log.error(error, "Upload failed");

    reply.status(500).send({
      message: "Failed to upload file.",
    });
  }
}