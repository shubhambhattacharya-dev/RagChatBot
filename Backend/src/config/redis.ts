import {Redis} from "ioredis"
import {Queue, Worker} from 'bullmq'
import {env} from './env'
import logger from '../logger'

/** Build an ioredis client. Managed Redis (Upstash, Redis Cloud) requires
 *  TLS even on the `redis://` scheme, so enable it automatically for
 *  Upstash hosts and for explicit `rediss://` URLs.
 *  Local/dev Redis (redis://localhost:6379) stays plaintext. */
export function createRedis(url: string): Redis {
  const parsed = new URL(url);
  const needsTls =
    parsed.protocol === "rediss:" || parsed.hostname.endsWith("upstash.io");
  const redis = new Redis(url.replace(/^rediss:/, "redis:"), {
    maxRetriesPerRequest: null,
    ...(needsTls ? { tls: {} } : {}),
  });

  redis.on("connect", () => {
    redis.config("SET", "maxmemory-policy", "noeviction").catch(() => {
      // Non-fatal: managed Redis providers often disallow CONFIG SET.
    });
  });

  return redis;
}

export const redis = createRedis(env.REDIS_URL)

export const documentQueue=new Queue("document-processing",{
    connection:redis,
    defaultJobOptions:{
        attempts:3,
        backoff:{type:"exponential",delay:2000},
        // Don't keep completed/failed job records: in-container Redis is
        // ephemeral anyway, and stale records would make a boot re-queue
        // with the same jobId a silent no-op (stranding the document).
        removeOnComplete:true,
        removeOnFail:true,
    }
})

export function createWorker(
    name:string,
    processor:(job: { data: { documentId: string; fileKey: string } })=>Promise<void>
){
    return new Worker(name,processor,{connection:redis,concurrency:5})
}
