import {z} from 'zod'


export const EnvSchema=z.object({
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT:z.coerce.number().positive().max(65535).default(3000),
    DATABASE_URL:z.string().default(""),
    GEMINI_API:z.string().default(""),
    GROQ_API:z.string().default(""),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),
    REDIS_URL:z.string().default("redis://localhost:6379"),
    MINIO_ENDPOINT:z.string().default(""),
    MINIO_ACCESS_KEY:z.string().default(""),
    MINIO_SECRET_KEY:z.string().default(""),
    MINIO_BUCKET: z.string().default("rag-files"),
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
