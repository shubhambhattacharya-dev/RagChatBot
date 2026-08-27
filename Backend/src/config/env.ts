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
    SESSION_SECRET: z.string().default("development-only-change-this-session-secret"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().max(10_000).default(120),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().max(3_600_000).default(60_000),
    LANGFUSE_PUBLIC_KEY: z.string().default(""),
    LANGFUSE_SECRET_KEY: z.string().default(""),
    LANGFUSE_BASE_URL: z.string().url().default("https://cloud.langfuse.com"),
    LANGFUSE_ENVIRONMENT: z.string().default(""),
    OTEL_SERVICE_NAME: z.string().default("rag-chatbot"),
    JAEGER_ENDPOINT: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
    METRICS_ENABLED: z.preprocess((value) => value === undefined || value === "" ? true : value === true || value === "true" || value === "1", z.boolean()).default(true),
    ALERT_WEBHOOK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
    CHAT_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().max(10_000).default(30),
    UPLOAD_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().max(10_000).default(10),
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
  if (env.NODE_ENV === "production" && (env.SESSION_SECRET.length < 32 || env.SESSION_SECRET.startsWith("development-only"))) {
    throw new Error("SESSION_SECRET must be a unique random value of at least 32 characters in production");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required runtime configuration: ${missing.join(", ")}`);
  }
}
