import type { FastifyInstance } from "fastify";
import { handleUpload } from "./handler";
import { requireUser } from "../auth/routes";


export async function uploadRoutes(app:FastifyInstance){
    app.post("/upload", { preHandler: requireUser }, handleUpload);
}
