import {Client as MinioClient} from "minio"
import {env} from "./env"

export const minio=new MinioClient({
    endPoint:env.MINIO_ENDPOINT,
    port:env.MINIO_PORT,
    useSSL:false,
    accessKey:env.MINIO_ACCESS_KEY,
    secretKey:env.MINIO_SECRET_KEY,

})

export async function ensureBucket(){
    const exists=await minio.bucketExists(env.MINIO_BUCKET)
    if(!exists){
        await minio.makeBucket(env.MINIO_BUCKET);
        console.log(`Create bucket: ${env.MINIO_BUCKET}`)
    }
}