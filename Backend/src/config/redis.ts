import {Redis} from "ioredis"
import {Job, Queue, Worker} from 'bullmq'
import {env} from './env'

export const redis= new Redis(env.REDIS_URL,{
    maxRetriesPerRequest:null
})

export const documentQueue=new Queue("document-processing",{
    connection:redis,
    defaultJobOptions:{
        attempts:3,
        backoff:{type:"exponential",delay:2000},

    }
})

export function createWorker(
    name:string,
    processor:(job:any)=>Promise<void>
){
    return new Worker(name,processor,{connection:redis,concurrency:5})
}