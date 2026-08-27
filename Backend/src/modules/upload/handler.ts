import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { env } from "../../config/env";
import { minio } from "../../config/minio";
import prisma from "../../config/prisma";

import { enqueueDocument } from "../../config/redis";

// Whitelist: extension → expected MIME (check both — never trust just one)
const ALLOWED_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

function validateFile(filename: string, mimetype: string): string | null {
  const ext = "." + (basename(filename).split(".").pop() || "").toLowerCase();

  if (!ALLOWED_TYPES[ext]) {
    return `File type "${ext || "(none)"}" not allowed. Use PDF, DOCX, TXT, or MD.`;
  }

  // Loose MIME check — some browsers send "application/octet-stream" for .docx
  const expected = ALLOWED_TYPES[ext];
  if (mimetype && mimetype !== "application/octet-stream" && mimetype !== expected) {
    return `File content looks like ${mimetype}, not ${expected}.`;
  }

  return null;
}

function safeFilename(filename: string): string {
  const sanitized = basename(filename)
    .replace(/[\r\n]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  return sanitized || "document";
}

function validateSignature(buffer: Buffer, extension: string): string | null {
  if (buffer.length === 0) return "The uploaded file is empty.";
  if (extension === ".pdf" && !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return "The uploaded PDF signature is invalid or the file is corrupted.";
  }
  if (extension === ".docx" && !buffer.subarray(0, 2).equals(Buffer.from("PK"))) {
    return "The uploaded DOCX signature is invalid or the file is corrupted.";
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
    const storedFilename = safeFilename(file.filename);
    const extension = "." + (storedFilename.split(".").pop() || "").toLowerCase();
    const signatureError = validateSignature(buffer, extension);
    if (signatureError) {
      return reply.status(400).send({ message: signatureError });
    }

    // 3. Generate IDs
    const documentId = randomUUID();
    const fileKey = `${documentId}/${storedFilename}`;

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
        filename: storedFilename,
        mimeType: file.mimetype,
        fileKey,
        status: "QUEUED",
      },
    });

    // 6. Persist work in Redis so a web-server restart cannot abandon indexing.
    try {
      await enqueueDocument(documentId, fileKey);
    } catch (error) {
      await prisma.document.delete({ where: { id: documentId } }).catch(() => undefined);
      await minio.removeObject(env.MINIO_BUCKET, fileKey).catch(() => undefined);
      throw error;
    }

    // 7. Respond immediately
    reply.status(201).send({
      documentId,
      filename: storedFilename,
      status: "QUEUED",
    });
  } catch (error) {
    request.log.error(error, "Upload failed");

    reply.status(500).send({
      message: "Failed to upload file.",
    });
  }
}
