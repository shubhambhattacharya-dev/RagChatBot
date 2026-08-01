import type { FastifyInstance } from "fastify";
import { handleUpload } from "./handler";


export async function uploadRoutes(app:FastifyInstance){
    app.post("/upload",handleUpload);
}
