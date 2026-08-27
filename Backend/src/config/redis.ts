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
        removeOnComplete:true,
        removeOnFail:{ age: 7 * 24 * 60 * 60, count: 1000 },
    }
})

export async function enqueueDocument(documentId: string, fileKey: string): Promise<void> {
  const existing = await documentQueue.getJob(documentId);
  if (existing) {
    const jobState = await existing.getState();
    if (["waiting", "delayed", "active", "paused"].includes(jobState)) return;
    await existing.remove().catch(() => undefined);
  }
  await documentQueue.add("index-document", { documentId, fileKey }, { jobId: documentId });
}

export function createWorker(
    name:string,
    processor:(job: { data: { documentId: string; fileKey: string } })=>Promise<void>
){
    return new Worker(name,processor,{connection:redis,concurrency:5, stalledInterval:30_000, maxStalledCount:2})
}
