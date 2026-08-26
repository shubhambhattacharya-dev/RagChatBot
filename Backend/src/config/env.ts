import {z} from 'zod'


export const EnvSchema=z.object({
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT:z.coerce.number().positive().max(65535).default(3000),
    DATABASE_URL:z.string().default(""),
    OPENROUTER_API:z.string().default(""),
    GEMINI_API:z.string().default(""),
    GROQ_API:z.string().default(""),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
    // Langfuse observability (optional — gracefully disabled when empty)
    LANGFUSE_PUBLIC_KEY: z.string().default(""),
    LANGFUSE_SECRET_KEY: z.string().default(""),
    LANGFUSE_BASE_URL: z.string().default("https://cloud.langfuse.com"),
    REDIS_URL:z.string().default("redis://localhost:6379"),
    // Full S3-compatible endpoint URL:
    //   local MinIO   -> http://localhost:9000
    //   Supabase      -> https://<ref>.supabase.co/storage/v1/s3
    //   Cloudflare R2 -> https://<accountid>.r2.cloudflarestorage.com
    MINIO_ENDPOINT:z.string().default(""),
    MINIO_ACCESS_KEY:z.string().default(""),
    MINIO_SECRET_KEY:z.string().default(""),
    MINIO_BUCKET: z.string().default("rag-files"),
    // CORS: empty string = allow all origins (dev). Set to your prod domain in production.
    CORS_ORIGIN: z.string().default(""),
})

const Parsed=EnvSchema.safeParse(process.env);

if(!Parsed.success){
    console.error("Invalid env:",Parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const env=Parsed.data

/** Fail fast for the actual server while keeping offline unit tests provider-independent. */
export function assertRuntimeConfig(): void {
  const required = [
    "DATABASE_URL", "GEMINI_API", "GROQ_API", "MINIO_ENDPOINT",
    "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY",
  ] as const;
  const missing = required.filter((key) => !env[key].trim());
  if (missing.length > 0) {
    throw new Error(`Missing required runtime configuration: ${missing.join(", ")}`);
  }
}
