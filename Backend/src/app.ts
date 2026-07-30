import fastify from "fastify";
import cors from '@fastify/cors'
import multipart from "@fastify/multipart"
import {env} from './config/env'
import { ensureBucket } from "./config/minio";

export async function buildApp(){
    const app=fastify({logger:{level:env.LOG_LEVEL}})
    //plugin
await app.register(cors,{origin:true})
await app.register(multipart,{limits:{fileSize:20*1024*1024}});

app.get("/health", async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
});

//ensure minio bucket exsit
await ensureBucket();

return app;

}

const app=await buildApp();
await app.listen({port:env.PORT,host:"0.0.0.0"});
console.log(`🚀 Server running on http://localhost:${env.PORT}`);

//graceful shutdown

const listeners=["SIGINT","SIGTERM"] as const ;
for(const signal of listeners){
    process.on(signal,async()=>{
        console.log(`\n${signal} received — shutting down gracefully...`)
        await app.close()
        //for redis
        const {redis}=await import ("./config/redis");
        await redis.quit();
        //for prisma
        const prisma=(await import("./config/prisma")).default;
        await prisma.$disconnect();
        process.exit(0)
    })
}
