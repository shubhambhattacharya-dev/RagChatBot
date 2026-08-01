import {z} from 'zod'


export const EnvSchema=z.object({
   LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    PORT:z.coerce.number().positive().max(65535).default(3000),
    DATABASE_URL:z.string().min(1),
    OPENROUTER_API:z.string().min(1),
    GEMINI_API:z.string().min(1),
    GROQ_API:z.string().min(1),
    REDIS_URL:z.string().default("redis://localhost:6379"),
    // Full S3-compatible endpoint URL:
    //   local MinIO   -> http://localhost:9000
    //   Supabase      -> https://<ref>.supabase.co/storage/v1/s3
    //   Cloudflare R2 -> https://<accountid>.r2.cloudflarestorage.com
    MINIO_ENDPOINT:z.string().min(1),
    MINIO_ACCESS_KEY:z.string().min(1),
    MINIO_SECRET_KEY:z.string().min(1),
    MINIO_BUCKET: z.string().default("rag-files"),
})

const Parsed=EnvSchema.safeParse(process.env);

if(!Parsed.success){
    console.error("Invalid env:",Parsed.error.flatten().fieldErrors),
    process.exit(1)
}

export const env=Parsed.data

