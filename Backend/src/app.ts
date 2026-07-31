import fastify from "fastify";
import cors from '@fastify/cors'
import multipart from "@fastify/multipart"
import staticFiles from '@fastify/static'
import { fileURLToPath } from "node:url";
import {env} from './config/env'
import { ensureBucket } from "./config/minio";
import { uploadRoutes } from "./modules/upload/router";
import { statusRoutes } from "./modules/upload/status";
import { chatRoutes } from "./modules/chat/routes";

export async function buildApp(){
    const app=fastify({logger:{level:env.LOG_LEVEL}})
    //plugin
await app.register(cors,{origin:true, methods:['GET','HEAD','POST','PUT','PATCH','DELETE']})
await app.register(multipart,{limits:{fileSize:20*1024*1024}});
// serve frontend from ../Frontend (same origin — no CORS)
await app.register(staticFiles, {
  root: fileURLToPath(new URL("../../Frontend", import.meta.url)),
  prefix: "/",
});
await app.register(uploadRoutes)
await app.register(statusRoutes)
await app.register(chatRoutes)
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
