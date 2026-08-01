import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { env } from "./env";

// S3-compatible client — works with local MinIO, Cloudflare R2, Supabase Storage.
// MINIO_ENDPOINT is a FULL URL:
//   local MinIO   -> http://localhost:9000
//   Supabase      -> https://<ref>.supabase.co/storage/v1/s3
//   Cloudflare R2 -> https://<accountid>.r2.cloudflarestorage.com
const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: "us-east-1", // MinIO / Supabase / R2 accept any region
  forcePathStyle: true, // path-style: <endpoint>/<bucket>/<key> — required by MinIO & Supabase
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
});

// Same surface the upload modules already use — callers unchanged.
export const minio = {
  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    _size: number,
    meta: Record<string, string>
  ) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: meta["Content-Type"],
      })
    );
  },

  async getObject(bucket: string, key: string): Promise<Buffer> {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return bodyToBuffer(res.Body);
  },

  async removeObject(bucket: string, key: string) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },

  async bucketExists(bucket: string): Promise<boolean> {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch {
      return false;
    }
  },

  async makeBucket(bucket: string) {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  },
};

export async function ensureBucket() {
  const exists = await minio.bucketExists(env.MINIO_BUCKET);

  if (!exists) {
    await minio.makeBucket(env.MINIO_BUCKET);
    console.log(`Create bucket: ${env.MINIO_BUCKET}`);
  }
}

// Convert S3 Body (Blob / web stream / Node Readable) to a Buffer.
async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof Uint8Array) return Buffer.from(body);

  const anyBody = body as { getReader?: () => unknown; on?: (e: string, cb: unknown) => unknown };

  // Web ReadableStream (default AWS SDK runtime)
  if (typeof anyBody.getReader === "function") {
    const reader = anyBody.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  // Node.js Readable
  if (typeof anyBody.on === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported S3 Body type");
}
